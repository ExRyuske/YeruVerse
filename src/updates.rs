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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

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
    cached: Mutex<Option<(Instant, Value)>>,
    http: reqwest::Client,
}

impl Default for Updates {
    fn default() -> Self {
        Self::new()
    }
}

impl Updates {
    pub fn new() -> Self {
        Updates {
            cached: Mutex::new(None),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("YeruVerse")
                .build()
                .expect("http client"),
        }
    }

    /// Последняя выпущенная версия и ссылка на APK. Пустой объект означает
    /// «не знаем»: страница в этом случае просто молчит про обновления.
    pub async fn latest(&self) -> Value {
        if let Some(fresh) = self.fresh() {
            return fresh;
        }
        match self.fetch().await {
            Ok(found) => {
                *self.cached.lock().unwrap() = Some((Instant::now(), found.clone()));
                found
            }
            Err(e) => {
                warn!("не удалось узнать последнюю версию: {e}");
                // Протухший ответ лучше пустого: версия меняется редко.
                self.cached.lock().unwrap().as_ref().map(|(_, v)| v.clone()).unwrap_or(json!({}))
            }
        }
    }

    fn fresh(&self) -> Option<Value> {
        let guard = self.cached.lock().unwrap();
        let (at, value) = guard.as_ref()?;
        (at.elapsed() < REFRESH_AFTER).then(|| value.clone())
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

    /// Пока ответа нет, кэш пуст — и отдавать из него нечего.
    #[test]
    fn empty_cache_has_nothing_fresh() {
        assert!(Updates::new().fresh().is_none());
    }

    /// Свежий ответ отдаётся из кэша, протухший — нет.
    #[test]
    fn cache_expires() {
        let updates = Updates::new();
        let answer = json!({ "version": "1.2.3" });
        *updates.cached.lock().unwrap() = Some((Instant::now(), answer.clone()));
        assert_eq!(updates.fresh(), Some(answer.clone()));

        let stale = Instant::now() - REFRESH_AFTER - Duration::from_secs(1);
        *updates.cached.lock().unwrap() = Some((stale, answer));
        assert!(updates.fresh().is_none());
    }

    /// В манифесте от `release.py` заметок может не быть вовсе.
    #[test]
    fn manifest_without_notes_still_parses() {
        let m: Manifest = serde_json::from_value(json!({ "version": "0.1.7" })).unwrap();
        assert_eq!(m.version, "0.1.7");
        assert_eq!(m.notes, "");
    }
}
