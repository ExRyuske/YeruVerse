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
    let _ = tokio::signal::ctrl_c().await;
    handle.task.abort();
}
