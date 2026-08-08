//! Откуда брать TURN. Свой coturn держать не обязательно: у Cloudflare он
//! бесплатен до 1000 ГБ в месяц и раздаёт короткоживущие ключи, которые не
//! страшно отдавать в браузер.
//!
//! Поддерживаются три варианта:
//! * `cloudflare` — сервер сам просит у API свежие учётки и кэширует их;
//! * `static` — любой другой провайдер (Metered, Twilio, Xirsys, свой coturn),
//!   у которого учётки постоянные;
//! * ничего — работает только прямое соединение через STUN.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

/// Как долго держим выданные учётки, прежде чем просить новые.
const REFRESH_BEFORE: Duration = Duration::from_secs(60 * 30);

#[derive(Debug, Clone)]
pub struct Static {
    pub urls: String,
    pub username: String,
    pub credential: String,
}

#[derive(Debug, Clone, Default)]
pub enum Provider {
    #[default]
    None,
    Static(Static),
    Cloudflare {
        key_id: String,
        token: String,
        ttl: u64,
    },
}

impl Provider {
    /// Конфигурация читается из окружения; Cloudflare имеет приоритет.
    pub fn from_env() -> Self {
        let cf_key = std::env::var("CF_TURN_KEY_ID").ok().filter(|s| !s.is_empty());
        let cf_token = std::env::var("CF_TURN_API_TOKEN").ok().filter(|s| !s.is_empty());
        if let (Some(key_id), Some(token)) = (cf_key, cf_token) {
            let ttl = std::env::var("TURN_TTL").ok().and_then(|t| t.parse().ok()).unwrap_or(86400);
            return Provider::Cloudflare { key_id, token, ttl };
        }

        match std::env::var("TURN_URL").ok().filter(|s| !s.is_empty()) {
            Some(urls) => Provider::Static(Static {
                urls,
                username: std::env::var("TURN_USER").unwrap_or_default(),
                credential: std::env::var("TURN_PASS").unwrap_or_default(),
            }),
            None => Provider::None,
        }
    }

    pub fn describe(&self) -> &'static str {
        match self {
            Provider::None => "нет (только STUN — часть зрителей не соединится)",
            Provider::Static(_) => "статические учётные данные",
            Provider::Cloudflare { .. } => "Cloudflare, короткоживущие учётки",
        }
    }
}

/// Кэш выданных серверов: дёргать API на каждую загрузку страницы незачем.
#[derive(Default)]
pub struct Turn {
    provider: Provider,
    cached: Mutex<Option<(Instant, Value)>>,
    http: Option<reqwest::Client>,
}

impl Turn {
    pub fn new(provider: Provider) -> Self {
        let http = matches!(provider, Provider::Cloudflare { .. }).then(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("http client")
        });
        Turn { provider, cached: Mutex::new(None), http }
    }

    pub fn describe(&self) -> &'static str {
        self.provider.describe()
    }

    /// Список ICE-серверов в том виде, в каком его ждёт RTCPeerConnection.
    pub async fn ice_servers(&self) -> Value {
        match &self.provider {
            Provider::None => json!([]),
            Provider::Static(s) => json!([{
                "urls": s.urls,
                "username": s.username,
                "credential": s.credential,
            }]),
            Provider::Cloudflare { key_id, token, ttl } => {
                if let Some(cached) = self.fresh() {
                    return cached;
                }
                match self.fetch_cloudflare(key_id, token, *ttl).await {
                    Ok(servers) => {
                        *self.cached.lock().unwrap() = Some((Instant::now(), servers.clone()));
                        servers
                    }
                    Err(e) => {
                        warn!("не удалось получить TURN у Cloudflare: {e}");
                        // Протухший кэш лучше, чем пустота: учётки живут дольше,
                        // чем интервал обновления.
                        self.cached
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|(_, v)| v.clone())
                            .unwrap_or(json!([]))
                    }
                }
            }
        }
    }

    fn fresh(&self) -> Option<Value> {
        let guard = self.cached.lock().unwrap();
        let (at, value) = guard.as_ref()?;
        (at.elapsed() < REFRESH_BEFORE).then(|| value.clone())
    }

    async fn fetch_cloudflare(&self, key_id: &str, token: &str, ttl: u64) -> Result<Value, String> {
        let http = self.http.as_ref().ok_or("http-клиент не создан")?;
        let url = format!(
            "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
        );

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

        let parsed: Shape = resp.json().await.map_err(|e| e.to_string())?;
        Ok(match parsed {
            Shape::List { ice_servers } => Value::Array(ice_servers),
            Shape::One { ice_servers } => json!([ice_servers]),
        })
    }
}
