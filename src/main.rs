use yeruverse::{start, Config};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "yeruverse=info,tower_http=warn".into()),
        )
        .init();

    let handle = start(Config::from_env()).await.expect("не удалось занять порт");
    stop_signal().await;
    handle.task.abort();
}

/// Дождаться просьбы остановиться — Ctrl+C или SIGTERM.
///
/// SIGTERM шлёт `docker stop`, и без своего обработчика процесс его не слышит
/// вовсе: в контейнере он первый (PID 1), а такому ядро не ставит действие по
/// умолчанию. Контейнер ждал свои десять секунд и убивался SIGKILL — на каждом
/// перезапуске и каждом обновлении.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
