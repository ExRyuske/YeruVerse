//! Откуда брать TURN.
//!
//! Вариантов ровно два: Cloudflare — или ничего, только STUN. Своего coturn нет
//! и не предвидится: у Cloudflare TURN бесплатен до 1000 ГБ в месяц и раздаёт
//! короткоживущие учётки, которые не страшно отдавать в браузер. Поддержка
//! произвольного провайдера со статическими учётками отсюда убрана намеренно:
//! постоянные логин и пароль всё равно уезжают в чужой браузер, где их может
//! прочитать кто угодно, а починить это, не выпуская короткоживущих ключей,
//! нельзя.
//!
//! Список STUN зашит на стороне страницы: это открытые серверы Cloudflare и
//! Google, учётных данных им не нужно.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::cache::{http_client, Cache};

/// Как долго держим выданные учётки, прежде чем просить новые.
const REFRESH_BEFORE: Duration = Duration::from_secs(60 * 30);

/// Адрес, по которому Cloudflare выпускает учётки.
const CF_ENDPOINT: &str = "https://rtc.live.cloudflare.com/v1/turn/keys";

#[derive(Debug, Clone, Default)]
pub enum Provider {
    /// Только STUN: прямое соединение или ничего.
    #[default]
    None,
    Cloudflare {
        key_id: String,
        token: String,
        ttl: u64,
    },
}

impl Provider {
    pub fn from_env() -> Self {
        let key_id = std::env::var("CF_TURN_KEY_ID").ok().filter(|s| !s.is_empty());
        let token = std::env::var("CF_TURN_API_TOKEN").ok().filter(|s| !s.is_empty());
        let (Some(key_id), Some(token)) = (key_id, token) else {
            return Provider::None;
        };
        let ttl = std::env::var("TURN_TTL").ok().and_then(|t| t.parse().ok()).unwrap_or(86400);
        Provider::Cloudflare { key_id, token, ttl }
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Provider::None => "нет (только STUN — часть зрителей не соединится)",
            Provider::Cloudflare { .. } => "Cloudflare, короткоживущие учётки",
        }
    }
}

/// Кэш выданных серверов: дёргать API на каждую загрузку страницы незачем.
pub struct Turn {
    provider: Provider,
    cached: Cache,
    http: Option<reqwest::Client>,
}

impl Turn {
    pub fn new(provider: Provider) -> Self {
        let http = matches!(provider, Provider::Cloudflare { .. }).then(http_client);
        Turn { provider, cached: Cache::new(REFRESH_BEFORE), http }
    }

    pub fn describe(&self) -> &'static str {
        self.provider.describe()
    }

    /// Список ICE-серверов в том виде, в каком его ждёт RTCPeerConnection.
    /// Пустой список — не ошибка: STUN страница добавляет сама.
    pub async fn ice_servers(&self) -> Value {
        let Provider::Cloudflare { key_id, token, ttl } = &self.provider else {
            return json!([]);
        };
        self.cached.get("TURN у Cloudflare", json!([]), || self.fetch(key_id, token, *ttl)).await
    }

    async fn fetch(&self, key_id: &str, token: &str, ttl: u64) -> Result<Value, String> {
        let http = self.http.as_ref().ok_or("http-клиент не создан")?;
        let url = format!("{CF_ENDPOINT}/{key_id}/credentials/generate-ice-servers");

        let resp = http
            .post(&url)
            .bearer_auth(token)
            .json(&json!({ "ttl": ttl }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("{code}: {}", body.chars().take(200).collect::<String>()));
        }

        let parsed: Shape = resp.json().await.map_err(|e| e.to_string())?;
        Ok(parsed.into_list())
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Shape {
    // Новый эндпоинт отдаёт массив, старый — один объект.
    List {
        #[serde(rename = "iceServers")]
        ice_servers: Vec<Value>,
    },
    One {
        #[serde(rename = "iceServers")]
        ice_servers: Value,
    },
}

impl Shape {
    fn into_list(self) -> Value {
        match self {
            Shape::List { ice_servers } => Value::Array(ice_servers),
            Shape::One { ice_servers } => json!([ice_servers]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Без ключей Cloudflare сервер не выдумывает ничего: STUN живёт на странице.
    #[tokio::test]
    async fn without_keys_there_are_no_ice_servers() {
        let turn = Turn::new(Provider::None);
        assert_eq!(turn.ice_servers().await, json!([]));
        assert!(turn.describe().contains("только STUN"));
    }

    /// Ответы обоих поколений эндпоинта приводятся к одному виду — списку.
    #[test]
    fn both_cloudflare_shapes_become_a_list() {
        let list: Shape = serde_json::from_value(json!({
            "iceServers": [{ "urls": "turn:a" }, { "urls": "turn:b" }]
        }))
        .unwrap();
        assert_eq!(list.into_list().as_array().unwrap().len(), 2);

        let one: Shape = serde_json::from_value(json!({
            "iceServers": { "urls": "turn:a", "username": "u", "credential": "c" }
        }))
        .unwrap();
        let list = one.into_list();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["username"], "u");
    }
}
