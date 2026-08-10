//! HTTP + WebSocket сервер комнат. Живёт отдельно от `main`, чтобы его можно
//! было поднять внутри десктопного приложения, а не только как отдельный демон.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::header::{HeaderValue, CACHE_CONTROL, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::hub::{now_ms, Hub, Peer};
use crate::protocol::{ClientMsg, PeerInfo};
use crate::turn::{Provider, Turn};

/// Настройки запуска. `web_dir: None` — статику не отдаём (десктоп подаёт её сам).
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub port: u16,
    pub web_dir: Option<PathBuf>,
    pub turn: Provider,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            port: std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080),
            web_dir: Some(std::env::var("WEB_DIR").unwrap_or_else(|_| "web".into()).into()),
            turn: Provider::from_env(),
        }
    }
}

/// Запущенный сервер: известен реальный адрес (важно при `port: 0`).
pub struct Handle {
    pub addr: SocketAddr,
    pub task: JoinHandle<()>,
}

struct AppState {
    hub: Hub,
    turn: Turn,
}

/// Поднимает сервер и сразу возвращает управление.
pub async fn start(config: Config) -> std::io::Result<Handle> {
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], config.port))).await?;
    let addr = listener.local_addr()?;

    let web_dir = config.web_dir.clone();
    let turn = Turn::new(config.turn.clone());
    info!("TURN: {}", turn.describe());
    let state = Arc::new(AppState { hub: Hub::new(), turn });

    let mut app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/config.json", get(config_json))
        .route("/reach", get(reach))
        .route(
            "/healthz",
            get(|State(s): State<Arc<AppState>>| async move { Json(s.hub.stats()) }),
        );

    if let Some(dir) = web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }

    let app = app
        .layer(middleware::from_fn(secure_headers))
        .layer(middleware::from_fn(cache_headers))
        .layer(CorsLayer::permissive())
        .with_state(state);

    info!("YeruVerse слушает http://{addr}");
    let task = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("сервер остановлен: {e}");
        }
    });

    Ok(Handle { addr, task })
}

/// Публичная конфигурация для фронтенда: список ICE-серверов. У Cloudflare
/// учётки короткоживущие, поэтому страница берёт их при загрузке, а не из
/// зашитого конфига.
async fn config_json(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let ice = state.turn.ice_servers().await;
    let has_turn = ice
        .as_array()
        .map(|list| {
            list.iter()
                .any(|s| s.get("urls").map(|u| u.to_string().contains("turn:")).unwrap_or(false))
        })
        .unwrap_or(false);
    Json(json!({ "iceServers": ice, "turn": has_turn }))
}

/// Виден ли снаружи порт Sunshine у того, кто спрашивает.
///
/// Изнутри своей сети это не проверить: у себя всё открыто всегда. Сервер же
/// смотрит на клиента ровно так, как на него посмотрит зритель из интернета —
/// стучится в его публичный адрес и говорит, ответил тот или нет. Дальше уже
/// приложение решает, какой адрес раздавать: публичный или локальный.
async fn reach(
    headers: axum::http::HeaderMap,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    // За Caddy и Cloudflare настоящий адрес приезжает заголовком.
    let ip = headers
        .get("cf-connecting-ip")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
        })
        .map(|v| v.trim().to_string());

    let port: u16 = q.get("port").and_then(|p| p.parse().ok()).unwrap_or(47989);
    let open = match ip.as_deref().and_then(|ip| ip.parse::<std::net::IpAddr>().ok()) {
        Some(addr) => tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::net::TcpStream::connect(SocketAddr::new(addr, port)),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false),
        None => false,
    };
    Json(json!({ "ip": ip, "open": open }))
}

/// Без явных заголовков промежуточные кэши решают сами: Cloudflare, например,
/// по умолчанию держит `.js` и `.css` у себя, и после выката пользователи
/// получают старый скрипт к новой разметке — жёсткая перезагрузка тут не
/// помогает, она обходит только браузер.
///
/// Документ не кэшируем вовсе, остальное отдаём с обязательной проверкой:
/// файлы крошечные, а ревалидация по ETag отвечает пустым 304.
async fn cache_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let document = path == "/"
        || path.ends_with(".html")
        || !path.rsplit('/').next().unwrap_or("").contains('.');

    let mut res = next.run(req).await;
    res.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static(if document { "no-store" } else { "no-cache" }),
    );
    res
}

/// Заголовки, которые не стоят ничего, но закрывают целый класс утечек.
/// Главный здесь — `no-referrer`: без него код комнаты из адресной строки
/// уезжал бы в Referer на YouTube и любой другой внешний ресурс.
async fn secure_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert("X-Frame-Options", HeaderValue::from_static("SAMEORIGIN"));
    h.insert("Cross-Origin-Opener-Policy", HeaderValue::from_static("same-origin"));
    h.insert(
        "Permissions-Policy",
        HeaderValue::from_static("geolocation=(), payment=(), usb=(), interest-cohort=()"),
    );
    h.insert("Content-Security-Policy", HeaderValue::from_static(CSP));
    res
}

/// Что странице разрешено загружать и выполнять.
///
/// Главное здесь — `script-src 'self'`: в чат приходит чужой текст, и хотя мы
/// везде кладём его как текст, а не как разметку, одна невнимательная строка
/// однажды это нарушит. С такой политикой внедрённый скрипт просто не
/// запустится: ни встроенный, ни подключённый со стороны.
///
/// `blob:` нужен картинкам и видео: файлы из чата и потоки участников живут
/// именно так. `frame-ancestors 'none'` запрещает встраивать комнату в чужую
/// страницу — иначе её можно накрыть прозрачным слоем и ловить нажатия.
const CSP: &str = "default-src 'self'; \
base-uri 'none'; \
object-src 'none'; \
frame-ancestors 'none'; \
form-action 'none'; \
script-src 'self'; \
style-src 'self'; \
img-src 'self' data: blob:; \
media-src 'self' blob:; \
worker-src 'self' blob:; \
connect-src 'self' ws: wss:";

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client_loop(socket, state))
}

async fn client_loop(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Писатель: единственное место, где что-то уходит в сокет.
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let peer_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let mut room_id: Option<String> = None;

    while let Some(Ok(raw)) = stream.next().await {
        let text = match raw {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let msg: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(json!({ "t": "error", "message": e.to_string() }).to_string());
                continue;
            }
        };

        match msg {
            ClientMsg::Join { room, name, color } => {
                if room_id.is_some() {
                    continue; // повторный join в том же сокете игнорируем
                }
                let room = sanitize_room(&room);

                let display = clamp(name.unwrap_or_default().trim(), 32);
                let display = if display.is_empty() {
                    format!("Гость-{}", &peer_id[..4])
                } else {
                    display
                };

                let peer = Peer {
                    info: PeerInfo {
                        id: peer_id.clone(),
                        name: display,
                        color: sanitize_color(color.as_deref()),
                        voice: false,
                        muted: false,
                        screen: false,
                        camera: false,
                        deaf: false,
                    },
                    tx: tx.clone(),
                };
                let _ = tx.send(state.hub.join(&room, peer).to_string());
                info!(room = %tag(&room), %peer_id, "join");
                room_id = Some(room);
            }

            ClientMsg::Signal { to, data } => {
                let Some(room) = room_id.as_deref() else { continue };
                state.hub.send_to(
                    room,
                    &to,
                    &json!({ "t": "signal", "from": peer_id, "data": data }),
                );
            }

            ClientMsg::Ping { at } => {
                let _ = tx.send(json!({ "t": "pong", "at": at, "srv": now_ms() }).to_string());
            }

            ClientMsg::Chat { text } => {
                let Some(room) = room_id.as_deref() else { continue };
                let text = clamp(text.trim(), 500);
                if text.is_empty() {
                    continue;
                }
                state.hub.broadcast(
                    room,
                    &json!({ "t": "chat", "from": peer_id, "text": text, "srv": now_ms() }),
                    None,
                );
            }

            ClientMsg::Profile { name, color } => {
                let Some(room) = room_id.as_deref() else { continue };
                let name = name.map(|n| clamp(n.trim(), 32));
                let color = color.as_deref().map(|c| sanitize_color(Some(c)));
                if let Some(info) = state.hub.set_profile(room, &peer_id, name, color) {
                    state.hub.broadcast(room, &json!({ "t": "presence", "peer": info }), None);
                }
            }

            ClientMsg::File { meta } => {
                let Some(room) = room_id.as_deref() else { continue };
                // Карточка приходит от клиента и попадает в чужой интерфейс,
                // поэтому ограничиваем её размер; содержимое рисуется текстом.
                if meta.to_string().len() > 4096 {
                    continue;
                }
                state.hub.broadcast(
                    room,
                    &json!({ "t": "file", "from": peer_id, "meta": meta, "srv": now_ms() }),
                    None,
                );
            }

            ClientMsg::Presence(presence) => {
                let Some(room) = room_id.as_deref() else { continue };
                if let Some(info) = state.hub.set_presence(room, &peer_id, presence) {
                    state.hub.broadcast(room, &json!({ "t": "presence", "peer": info }), None);
                }
            }
        }
    }

    if let Some(room) = room_id.as_deref() {
        state.hub.leave(room, &peer_id);
        info!(room = %tag(room), %peer_id, "leave");
    }
    drop(tx);
    let _ = writer.await;
}

/// Метка комнаты для логов. Код комнаты — это секрет: попав в журнал, он даёт
/// доступ любому, кто журнал прочитает. В логе нужна лишь возможность отличить
/// одну комнату от другой, поэтому пишем короткий необратимый отпечаток.
fn tag(room: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in room.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{:08x}", h as u32)
}

/// Код комнаты приходит из ссылки и становится её идентификатором — оставляем
/// только то, что безопасно переживает URL.
fn sanitize_room(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(96)
        .collect();
    if cleaned.is_empty() {
        uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
    } else {
        cleaned.to_lowercase()
    }
}

fn clamp(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Цвет ника приходит от клиента и попадает в чужой DOM — пропускаем только
/// строгий `#rrggbb`, всё остальное заменяем цветом по умолчанию.
fn sanitize_color(raw: Option<&str>) -> String {
    const DEFAULT: &str = "#5b8cff";
    let Some(c) = raw else { return DEFAULT.to_string() };
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if ok {
        c.to_ascii_lowercase()
    } else {
        DEFAULT.to_string()
    }
}
