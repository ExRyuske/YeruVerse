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

use crate::cache::{http_client, why, Cache};

/// Репозиторий, из релизов которого берутся сборки.
const REPO: &str = "ExRyuske/YeruVerse";

/// Манифест обновления лежит по постоянному адресу — его собирает
/// `scripts/release.py manifest` и публикует тот же релиз.
const MANIFEST: &str = "releases/latest/download/latest.json";

/// Запасной источник того же числа — API GitHub.
///
/// Нужен потому, что адрес манифеста выше отдаёт не файл, а два редиректа
/// подряд, и последний уводит на совсем другой хост — CDN релизов. Там, где
/// наружу выпускают не всё подряд, до него не дойти: сервер при этом прекрасно
/// ходит к Cloudflare за учётками TURN, и со стороны это выглядит как «сеть
/// работает, а обновлений нет». У API редиректов нет вовсе, зато есть предел в
/// шестьдесят запросов в час — с нашим получасовым кэшем это два.
const API: &str = "https://api.github.com/repos/ExRyuske/YeruVerse/releases/latest";

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

/// Ответ API GitHub — из него нужен только тег.
#[derive(Deserialize)]
struct Release {
    tag_name: String,
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

    /// Сначала манифест, при неудаче — API. Причину первой неудачи не теряем:
    /// если не выйдет и вторая, в логе будут обе, и по ним видно, отказала
    /// сеть целиком или только дорога до CDN релизов.
    async fn fetch(&self) -> Result<Value, String> {
        let first = match self.by_manifest().await {
            Ok(found) => return Ok(found),
            Err(e) => e,
        };
        self.by_api().await.map_err(|e| format!("манифест — {first}; API — {e}"))
    }

    async fn by_manifest(&self) -> Result<Value, String> {
        let url = format!("https://github.com/{REPO}/{MANIFEST}");
        let resp = self.http.get(&url).send().await.map_err(|e| why(&e))?;
        if !resp.status().is_success() {
            return Err(format!("{}: {url}", resp.status()));
        }
        let manifest: Manifest = resp.json().await.map_err(|e| why(&e))?;
        Ok(self.answer(manifest.version, manifest.notes))
    }

    async fn by_api(&self) -> Result<Value, String> {
        let resp = self.http.get(API).send().await.map_err(|e| why(&e))?;
        if !resp.status().is_success() {
            return Err(format!("{}: {API}", resp.status()));
        }
        let release: Release = resp.json().await.map_err(|e| why(&e))?;
        // Тег выглядит как `v0.1.18`, а сравнивают его с `0.1.18` из сборки.
        let version = release.tag_name.trim_start_matches('v').to_string();
        Ok(self.answer(version, String::new()))
    }

    fn answer(&self, version: String, notes: String) -> Value {
        json!({
            "version": version,
            "notes": notes,
            "apk": format!("https://github.com/{REPO}/{APK}"),
        })
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

    /// Тег релиза приходит с буквой, а сравнивается с голым номером сборки.
    #[test]
    fn release_tag_loses_its_letter() {
        let r: Release = serde_json::from_value(json!({ "tag_name": "v0.1.18" })).unwrap();
        assert_eq!(r.tag_name.trim_start_matches('v'), "0.1.18");
    }
}
