//! Сервер целиком: поднимается на случайном порту и отвечает по-настоящему.
//!
//! Заголовки проверяются здесь, а не глазами: `no-referrer` и политика
//! содержимого — единственное, что держит код комнаты внутри страницы, и
//! потерять их правкой роутера легче всего.

use yeruverse::turn::Provider;
use yeruverse::{start, Config};

async fn serve(web_dir: Option<&str>) -> (String, tokio::task::JoinHandle<()>) {
    let handle = start(Config {
        port: 0, // порт выбирает система: тесты идут параллельно
        web_dir: web_dir.map(Into::into),
        turn: Provider::None,
    })
    .await
    .expect("сервер не поднялся");
    (format!("http://127.0.0.1:{}", handle.addr.port()), handle.task)
}

#[tokio::test]
async fn empty_server_reports_no_rooms() {
    let (base, task) = serve(None).await;

    let stats: serde_json::Value =
        reqwest::get(format!("{base}/healthz")).await.unwrap().json().await.unwrap();
    assert_eq!(stats["rooms"], 0);
    assert_eq!(stats["peers"], 0);

    task.abort();
}

/// Без TURN страница должна об этом узнать: половина зрителей за симметричным
/// NAT не соединится, и молчать об этом хуже всего.
#[tokio::test]
async fn config_tells_whether_turn_is_configured() {
    let (base, task) = serve(None).await;

    let config: serde_json::Value =
        reqwest::get(format!("{base}/config.json")).await.unwrap().json().await.unwrap();
    assert_eq!(config["turn"], false);
    assert_eq!(config["iceServers"].as_array().unwrap().len(), 0);

    task.abort();
}

#[tokio::test]
async fn every_answer_carries_the_security_headers() {
    let (base, task) = serve(None).await;

    let res = reqwest::get(format!("{base}/config.json")).await.unwrap();
    let headers = res.headers();
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert_eq!(headers["x-content-type-options"], "nosniff");

    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("script-src 'self'"));
    assert!(csp.contains("frame-ancestors 'none'"));
    // Без этой директивы Chromium не даёт собрать WebAssembly, и шумодав
    // замолкает — тихо, без единой ошибки на стороне собеседников.
    assert!(csp.contains("'wasm-unsafe-eval'"));

    task.abort();
}

/// Шумодав живёт файлами в репозитории и грузится с нашего же сервера. Тип
/// содержимого важен не меньше самого файла: по нему браузер решает, можно ли
/// собирать модуль на лету.
#[tokio::test]
async fn denoiser_models_are_served_as_wasm() {
    let (base, task) = serve(Some("web")).await;

    for model in ["rnnoise/rnnoise.wasm", "deepfilternet/deepfilter.wasm"] {
        let res = reqwest::get(format!("{base}/vendor/{model}")).await.unwrap();
        assert!(res.status().is_success(), "{model} не отдаётся");
        assert_eq!(res.headers()["content-type"], "application/wasm", "{model}");
    }

    task.abort();
}

/// Документ не кэшируем вовсе, остальное — с обязательной ревалидацией: иначе
/// после выката к новой разметке приезжает старый скрипт из чужого кэша.
#[tokio::test]
async fn documents_are_never_cached_and_assets_are_revalidated() {
    let (base, task) = serve(Some("web")).await;

    let page = reqwest::get(&base).await.unwrap();
    assert!(page.status().is_success());
    assert_eq!(page.headers()["cache-control"], "no-store");

    let script = reqwest::get(format!("{base}/js/app.js")).await.unwrap();
    assert!(script.status().is_success());
    assert_eq!(script.headers()["cache-control"], "no-cache");

    // Неизвестный путь — это адрес комнаты, а не потерянный файл: страница
    // разбирает его сама, поэтому отдаём ей же документ.
    let deep = reqwest::get(format!("{base}/никакой-такой-страницы")).await.unwrap();
    assert!(deep.status().is_success());
    assert_eq!(deep.headers()["cache-control"], "no-store");

    task.abort();
}
