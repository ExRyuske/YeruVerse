//! Какая версия приложения вышла последней.
//!
//! Настольная сборка спрашивает об этом сама — там плагин обновлений, который
//! ещё и проверяет подпись пакета. Android так не умеет: APK ставит система, и
//! приложению остаётся открыть ссылку. Но чтобы узнать, что обновляться вообще
//! есть куда, нужен номер последней версии, а ходить за ним со страницы прямо
//! на GitHub нельзя: политика содержимого разрешает странице только свой
//! сервер, и ослаблять её ради одного числа не стоит.
//!
//! Поэтому за манифестом ходит сервер и держит ответ в кэше: версия выходит раз
//! в дни, а спрашивают её все клиенты сразу.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::cache::{http_client, Cache};

/// Репозиторий, из релизов которого берутся сборки.
const REPO: &str = "ExRyuske/YeruVerse";

/// Манифест обновления лежит по постоянному адресу — его собирает
/// `scripts/release.py manifest` и публикует тот же релиз.
const MANIFEST: &str = "releases/latest/download/latest.json";

/// Имя пакета Android в релизе. Ставится системой, поэтому это просто ссылка.
const APK: &str = "releases/latest/download/yeruverse.apk";

/// Номер версии меняется раз в дни — чаще ходить к GitHub незачем.
const REFRESH_AFTER: Duration = Duration::from_secs(60 * 30);

#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
}

pub struct Updates {
    cached: Cache,
    http: reqwest::Client,
}

impl Default for Updates {
    fn default() -> Self {
        Self::new()
    }
}

impl Updates {
    pub fn new() -> Self {
        Updates { cached: Cache::new(REFRESH_AFTER), http: http_client() }
    }

    /// Последняя выпущенная версия и ссылка на APK. Пустой объект означает
    /// «не знаем»: страница в этом случае просто молчит про обновления.
    pub async fn latest(&self) -> Value {
        self.cached.get("номер последней версии", json!({}), || self.fetch()).await
    }

    async fn fetch(&self) -> Result<Value, String> {
        let url = format!("https://github.com/{REPO}/{MANIFEST}");
        let resp = self.http.get(&url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("{}: {url}", resp.status()));
        }
        let manifest: Manifest = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json!({
            "version": manifest.version,
            "notes": manifest.notes,
            "apk": format!("https://github.com/{REPO}/{APK}"),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// В манифесте от `release.py` заметок может не быть вовсе.
    #[test]
    fn manifest_without_notes_still_parses() {
        let m: Manifest = serde_json::from_value(json!({ "version": "0.1.7" })).unwrap();
        assert_eq!(m.version, "0.1.7");
        assert_eq!(m.notes, "");
    }
}
