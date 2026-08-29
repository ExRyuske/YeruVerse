//! Ответ, за которым сервер ходит наружу: со сроком годности и с запасом на
//! неудачу.
//!
//! Таких ответов ровно два — учётки TURN у Cloudflare и номер последней версии
//! у GitHub, — и оба вели себя одинаково: держать ответ столько-то, при отказе
//! отдавать протухший, при отказе без кэша отдавать пустоту и написать в лог.
//! Правило это неочевидное и стоит того, чтобы жить в одном месте: протухшие
//! учётки живут дольше, чем интервал обновления, а версия меняется раз в дни —
//! в обоих случаях старый ответ полезнее честной пустоты.
//!
//! Значение — `serde_json::Value`, потому что оба ответа ровно им и отдаются
//! наружу, без промежуточного вида.

use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tracing::warn;

/// Столько ждёт любой запрос наружу. Внешний сервис не должен уметь подвесить
/// выдачу страницы: без TURN и без номера версии комната работает, а без
/// ответа `/config.json` не открывается вовсе.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Почему не вышло — со всей цепочкой причин.
///
/// `reqwest` в `to_string()` показывает только верхний слой: «error sending
/// request for url (…)». Что именно случилось — не разрешилось имя, не пустили
/// на порт, истекло время — лежит в источнике ошибки, и без него запись в логе
/// сообщает лишь то, что мы и так знаем. Один раз это уже стоило разбирательства
/// вслепую: сервер прекрасно ходил к Cloudflare и молча не мог достучаться до
/// GitHub, а лог об этом не говорил ничего.
pub fn why(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(next) = source {
        out.push_str(" ← ");
        out.push_str(&next.to_string());
        source = next.source();
    }
    out
}

/// HTTP-клиент для походов наружу — один и тот же у всех.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent("YeruVerse")
        .build()
        .expect("http client")
}

pub struct Cache {
    ttl: Duration,
    slot: Mutex<Option<(Instant, Value)>>,
}

impl Cache {
    pub fn new(ttl: Duration) -> Self {
        Cache { ttl, slot: Mutex::new(None) }
    }

    /// Что лежит в кэше, если оно ещё не протухло.
    pub fn fresh(&self) -> Option<Value> {
        let guard = self.slot.lock().unwrap();
        let (at, value) = guard.as_ref()?;
        (at.elapsed() < self.ttl).then(|| value.clone())
    }

    /// Свежий ответ, а если его нет — сходить за ним.
    ///
    /// `what` попадает в лог при отказе и отвечает на вопрос «что не удалось
    /// получить»; `empty` отдаётся только когда не вышло и показать нечего.
    pub async fn get<F>(&self, what: &str, empty: Value, fetch: impl FnOnce() -> F) -> Value
    where
        F: Future<Output = Result<Value, String>>,
    {
        if let Some(fresh) = self.fresh() {
            return fresh;
        }
        match fetch().await {
            Ok(found) => {
                *self.slot.lock().unwrap() = Some((Instant::now(), found.clone()));
                found
            }
            Err(e) => {
                warn!("не удалось получить {what}: {e}");
                // Протухший ответ лучше пустоты: он был верен полчаса назад, а
                // пустота не верна никогда.
                self.stale().unwrap_or(empty)
            }
        }
    }

    /// То, что лежит в кэше, — независимо от срока годности.
    fn stale(&self) -> Option<Value> {
        self.slot.lock().unwrap().as_ref().map(|(_, v)| v.clone())
    }

    /// Положить ответ, минуя поход наружу. Нужно тестам.
    #[cfg(test)]
    pub fn put(&self, at: Instant, value: Value) {
        *self.slot.lock().unwrap() = Some((at, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TTL: Duration = Duration::from_secs(60);

    /// Пока ответа нет, кэш пуст — и отдавать из него нечего.
    #[test]
    fn empty_cache_has_nothing_fresh() {
        assert!(Cache::new(TTL).fresh().is_none());
    }

    /// Свежий ответ отдаётся из кэша, протухший — нет.
    #[test]
    fn cache_expires() {
        let cache = Cache::new(TTL);
        let answer = json!({ "version": "1.2.3" });

        cache.put(Instant::now(), answer.clone());
        assert_eq!(cache.fresh(), Some(answer.clone()));

        cache.put(Instant::now() - TTL - Duration::from_secs(1), answer);
        assert!(cache.fresh().is_none());
    }

    /// За свежим ответом наружу не ходят вовсе.
    #[tokio::test]
    async fn fresh_answer_skips_the_fetch() {
        let cache = Cache::new(TTL);
        cache.put(Instant::now(), json!("из кэша"));

        let answer = cache
            .get("что-нибудь", json!(null), || async {
                panic!("ходить наружу не пришлось бы")
            })
            .await;
        assert_eq!(answer, json!("из кэша"));
    }

    /// Отказ отдаёт протухшее, а когда протухшего нет — заготовленную пустоту.
    #[tokio::test]
    async fn failure_falls_back_to_stale_then_to_empty() {
        let cache = Cache::new(TTL);
        let fails = || async { Err::<Value, String>("сеть молчит".into()) };

        assert_eq!(cache.get("что-нибудь", json!([]), fails).await, json!([]));

        cache.put(Instant::now() - TTL - Duration::from_secs(1), json!(["протухшее"]));
        assert_eq!(cache.get("что-нибудь", json!([]), fails).await, json!(["протухшее"]));
    }

    /// Удачный поход кладёт ответ в кэш — следующий раз наружу уже не идёт.
    #[tokio::test]
    async fn success_is_remembered() {
        let cache = Cache::new(TTL);
        let answer =
            cache.get("что-нибудь", json!(null), || async { Ok(json!({ "ok": true })) }).await;
        assert_eq!(answer, json!({ "ok": true }));
        assert_eq!(cache.fresh(), Some(json!({ "ok": true })));
    }
}
