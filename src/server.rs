//! HTTP + WebSocket сервер комнат. Живёт отдельно от `main` и умеет слушать
//! порт 0: так его поднимают тесты (см. `tests/server.rs`), и так же его можно
//! запустить внутри другого приложения, а не только отдельным демоном.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Request, State};
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
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::hub::{now_ms, Hub, Peer};
use crate::protocol::{ClientMsg, PeerInfo};
use crate::turn::{Provider, Turn};
use crate::updates::Updates;

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
    updates: Updates,
}

/// Поднимает сервер и сразу возвращает управление.
pub async fn start(config: Config) -> std::io::Result<Handle> {
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], config.port))).await?;
    let addr = listener.local_addr()?;

    let web_dir = config.web_dir.clone();
    let turn = Turn::new(config.turn.clone());
    info!("TURN: {}", turn.describe());
    let state = Arc::new(AppState { hub: Hub::new(), turn, updates: Updates::new() });

    let mut app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/config.json", get(config_json))
        .route("/update.json", get(update_json))
        .route("/reach", get(reach))
        .route(
            "/healthz",
            get(|State(s): State<Arc<AppState>>| async move { Json(s.hub.stats()) }),
        );

    if let Some(dir) = web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }

    // Заголовков CORS здесь нет намеренно: страница всегда лежит на том же
    // сервере, к которому обращается (`serverBase()` в `web/js/core.js` — это
    // `location.origin` и ничто иное), а разрешение «пусть спрашивает кто
    // угодно» открывало чужим страницам и `/healthz` со счётчиком комнат.
    let app = app
        .layer(middleware::from_fn(secure_headers))
        .layer(middleware::from_fn(cache_headers))
        .with_state(state);

    info!("YeruVerse слушает http://{addr}");
    // Адрес соединения нужен `/reach`: это единственный источник, который
    // спрашивающий не может подделать.
    let app = app.into_make_service_with_connect_info::<SocketAddr>();
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

/// Последняя выпущенная версия приложения — для тех сборок, которые не умеют
/// обновляться сами. Настольная спрашивает свой плагин обновлений и сюда не
/// ходит; Android узнаёт версию отсюда и открывает ссылку на APK системой.
async fn update_json(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(state.updates.latest().await)
}

/// Порт, на котором Sunshine держит свой HTTP, — единственная цель, ради
/// которой эта проверка вообще существует, и единственная, которую здесь можно
/// назвать. Раньше порт приезжал в запросе, но никто его туда не клал:
/// страница спрашивает просто `/reach` (см. `pollSunshine` в
/// `web/js/sunshine.js`), а вот подставить туда чужой мог кто угодно.
const SUNSHINE_PORT: u16 = 47989;

/// Виден ли снаружи порт Sunshine у того, кто спрашивает.
///
/// Изнутри своей сети это не проверить: у себя всё открыто всегда. Сервер же
/// смотрит на клиента ровно так, как на него посмотрит зритель из интернета —
/// стучится в его публичный адрес и говорит, ответил тот или нет. Дальше уже
/// приложение решает, какой адрес раздавать: публичный или локальный.
///
/// Здесь сервер ходит по сети сам, а значит ни адрес, ни порт цели не могут
/// браться со слов спрашивающего: иначе открытый всем эндпоинт превращается в
/// сканер портов той сети, в которой стоит сервер, — а из контейнера видны и
/// соседние сервисы, и сам хост. Поэтому порт зашит, а адрес проходит через
/// `client_ip` и `is_public`.
async fn reach(
    ConnectInfo(conn): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> Json<serde_json::Value> {
    let ip = client_ip(&headers, conn.ip()).filter(is_public);
    let open = match ip {
        Some(addr) => tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::net::TcpStream::connect(SocketAddr::new(addr, SUNSHINE_PORT)),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false),
        None => false,
    };
    Json(json!({ "ip": ip.map(|a| a.to_string()), "open": open }))
}

/// Настоящий адрес спрашивающего.
///
/// Заголовок здесь — не подсказка от прокси, а вход от кого угодно: прокси его
/// не проверяет, он его дописывает. `X-Forwarded-For` Caddy именно дописывает —
/// присланное клиентом остаётся в голове списка, а настоящий адрес оказывается
/// в хвосте, поэтому берём последний элемент, а не первый. `X-Real-IP` в нашей
/// цепочке не ставит никто, так что доверять там нечему, и мы его больше не
/// читаем вовсе. `CF-Connecting-Ip` Cloudflare перезаписывает своим значением;
/// без Cloudflare впереди он приедет прямо от клиента — и от произвольной цели
/// нас страхует уже `is_public`.
///
/// Прямое соединение — десктоп, отладка, своя сеть — заголовков не несёт вовсе,
/// и тогда адрес берётся у самого сокета: единственный источник, который
/// подделать нельзя.
fn client_ip(headers: &axum::http::HeaderMap, socket: IpAddr) -> Option<IpAddr> {
    let head = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let forwarded = head("x-forwarded-for").and_then(|v| v.rsplit(',').next());
    head("cf-connecting-ip").or(forwarded).and_then(|v| v.trim().parse().ok()).or(Some(socket))
}

/// Годится ли адрес как цель для стука наружу.
///
/// Наружу — значит в интернет. Всё остальное — петля, частные сети, докерная
/// сеть с соседями по `compose.yaml`, канальные адреса — цели, до которых
/// спрашивающему нет дела, а нам нельзя ходить туда по его просьбе.
///
/// `IpAddr::is_global` в стандартной библиотеке до сих пор нестабилен, поэтому
/// перечисляем сами. Ошибаться тут безопаснее в сторону запрета: непубличный
/// адрес означает всего лишь «снаружи не видно», а это ровно тот ответ, который
/// и должен получить сидящий в своей сети без проброса портов.
fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || a == 0                                  // 0.0.0.0/8
                || a >= 240                                // 240.0.0.0/4, зарезервировано
                || (a == 100 && (64..128).contains(&b))    // 100.64.0.0/10, общий NAT провайдера
                || (a == 192 && b == 0)                    // 192.0.0.0/24, служебное
                || (a == 198 && (18..20).contains(&b))) // 198.18.0.0/15, замеры
        }
        IpAddr::V6(v6) => {
            // Адрес IPv4 в обёртке IPv6 — это тот же самый адрес, и проверять
            // надо его: иначе `::ffff:127.0.0.1` прошёл бы мимо всех запретов.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(&IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || seg[0] & 0xfe00 == 0xfc00        // fc00::/7, локальные
                || seg[0] & 0xffc0 == 0xfe80        // fe80::/10, канальные
                || seg[..2] == [0x2001, 0x0db8]) // 2001:db8::/32, документация
        }
    }
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
/// `wasm-unsafe-eval` — про шумодав, и без него он молчал. Chromium (а значит и
/// вебвью Android) считает сборку WebAssembly генерацией кода и запрещает её,
/// если политика этого прямо не разрешила. Ломалось это тихо: узел обработки в
/// графе есть, дорожка живая, присутствие говорит «микрофон включён» — а
/// собеседники слышат тишину, потому что модель внутри так и не поднялась.
/// Разрешение касается только WebAssembly: `eval` для JS по-прежнему закрыт.
///
/// `blob:` нужен картинкам и видео: файлы из чата и потоки участников живут
/// именно так. `frame-ancestors 'none'` запрещает встраивать комнату в чужую
/// страницу — иначе её можно накрыть прозрачным слоем и ловить нажатия.
const CSP: &str = "default-src 'self'; \
base-uri 'none'; \
object-src 'none'; \
frame-ancestors 'none'; \
form-action 'none'; \
script-src 'self' 'wasm-unsafe-eval'; \
style-src 'self'; \
img-src 'self' data: blob:; \
media-src 'self' blob:; \
worker-src 'self' blob:; \
connect-src 'self' ws: wss:";

/// Предел на одно входящее сообщение.
///
/// Всё, что ходит по этому сокету, — короткие JSON-строки; самое большое из
/// них, описание WebRTC с полным набором кандидатов, укладывается в единицы
/// килобайт. По умолчанию же движок сокетов принимает до 64 МиБ, и разобрать
/// такое он попробует раньше, чем мы успеем сказать хоть слово.
const MAX_FRAME: usize = 32 * 1024;

/// Сколько неотправленных сообщений держим для одного участника.
///
/// Очередь была без предела, и это перекладывало чужую беду на сервер: клиент,
/// переставший читать сокет (уснувший телефон, зависшая вкладка), продолжал
/// копить всё, что ему шлёт комната, пока операционная система не заметит
/// обрыв. Сотня строк — это заведомо больше, чем бывает в живом разговоре.
const OUTBOX: usize = 128;

/// Сколько сообщений в секунду принимаем от одного сокета и на сколько разом
/// разрешаем эту скорость превысить.
///
/// В обычной жизни здесь единицы сообщений в секунду: `ping` раз в пять секунд,
/// строка чата, смена присутствия. Всплеск бывает ровно один, зато крупный —
/// вход в полную комнату: на каждого из уже сидящих уходит своё описание и по
/// десятку с лишним кандидатов ICE, и в комнате на десятерых это под две сотни
/// сообщений за считанные секунды. Отброшенный кандидат виден не сразу и не
/// как ошибка, а как «у одного участника почему-то нет звука», поэтому запас
/// взят с таким расчётом, чтобы вход не задевал его даже краем.
///
/// Ровный поток сверх `RATE` — это уже не разговор, а попытка занять собой и
/// разбор на сервере, и очереди всей комнаты: каждая строка чата уходит каждому.
const RATE: f64 = 40.0;
const BURST: f64 = 200.0;

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| client_loop(socket, state))
}

async fn client_loop(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(OUTBOX);

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
    let mut budget = Budget::new();

    while let Some(Ok(raw)) = stream.next().await {
        let text = match raw {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        // Счёт идёт до разбора: сам разбор JSON — тоже работа, и оплачивать её
        // за того, кто шлёт без остановки, незачем.
        if !budget.allow() {
            continue;
        }

        let msg: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.try_send(json!({ "t": "error", "message": e.to_string() }).to_string());
                continue;
            }
        };

        // Пока комната не названа, разговаривать не о чем: единственное, что
        // принимается до входа, — это сам вход и замер задержки.
        match msg {
            ClientMsg::Join { room, name, color } => {
                if room_id.is_some() {
                    continue; // повторный join в том же сокете игнорируем
                }
                let room = sanitize_room(&room);
                let peer = Peer {
                    info: PeerInfo {
                        id: peer_id.clone(),
                        name: display_name(name, &peer_id),
                        color: sanitize_color(color.as_deref()),
                        voice: false,
                        muted: false,
                        screen: false,
                        camera: false,
                        deaf: false,
                    },
                    tx: tx.clone(),
                };
                let _ = tx.try_send(state.hub.join(&room, peer).to_string());
                info!(room = %tag(&room), %peer_id, "join");
                room_id = Some(room);
            }

            ClientMsg::Ping { at } => {
                let _ = tx.try_send(json!({ "t": "pong", "at": at }).to_string());
            }

            in_room => {
                let Some(room) = room_id.as_deref() else { continue };
                handle_in_room(&state, room, &peer_id, in_room);
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

/// Дырявое ведро на входе сокета: `RATE` сообщений в секунду ровным потоком и
/// `BURST` про запас на всплеск. Считаем по часам, а не по таймеру: тик здесь
/// не нужен, а сокет и так просыпается ровно тогда, когда что-то пришло.
struct Budget {
    left: f64,
    at: std::time::Instant,
}

impl Budget {
    fn new() -> Self {
        Budget { left: BURST, at: std::time::Instant::now() }
    }

    fn allow(&mut self) -> bool {
        let now = std::time::Instant::now();
        self.left = (self.left + now.duration_since(self.at).as_secs_f64() * RATE).min(BURST);
        self.at = now;
        if self.left < 1.0 {
            return false;
        }
        self.left -= 1.0;
        true
    }
}

/// Всё, что имеет смысл только внутри комнаты. Сюда попадает уже вошедший
/// участник: проверку «а в комнате ли он» делает вызывающий, один раз на все
/// сообщения сразу.
fn handle_in_room(state: &AppState, room: &str, peer_id: &str, msg: ClientMsg) {
    match msg {
        ClientMsg::Signal { to, data } => {
            state.hub.send_to(room, &to, &json!({ "t": "signal", "from": peer_id, "data": data }));
        }

        ClientMsg::Chat { text } => {
            let text = limit(text.trim(), 500);
            if text.is_empty() {
                return;
            }
            let msg = json!({ "t": "chat", "from": peer_id, "text": text, "srv": now_ms() });
            state.hub.broadcast(room, &msg);
        }

        ClientMsg::Profile { name, color } => {
            let name = name.map(|n| limit(n.trim(), 32));
            let color = color.as_deref().map(|c| sanitize_color(Some(c)));
            if let Some(info) = state.hub.set_profile(room, peer_id, name, color) {
                state.hub.broadcast(room, &json!({ "t": "presence", "peer": info }));
            }
        }

        ClientMsg::File { meta } => {
            // Карточка приходит от клиента и попадает в чужой интерфейс,
            // поэтому ограничиваем её размер; содержимое рисуется текстом.
            if meta.to_string().len() > 4096 || !sane_file_meta(&meta) {
                return;
            }
            let msg = json!({ "t": "file", "from": peer_id, "meta": meta, "srv": now_ms() });
            state.hub.broadcast(room, &msg);
        }

        ClientMsg::Presence(presence) => {
            if let Some(info) = state.hub.set_presence(room, peer_id, presence) {
                state.hub.broadcast(room, &json!({ "t": "presence", "peer": info }));
            }
        }

        // Вход и замер задержки разобраны до комнаты.
        ClientMsg::Join { .. } | ClientMsg::Ping { .. } => {}
    }
}

/// Предел на размер файла — тот же, что в `sendFile` (`web/js/chat.js`), и то
/// же число кусков, что считает `offer` (`web/js/swarm.js`). Три константы
/// связаны: два гигабайта кусками по 64 КиБ — это тридцать две тысячи кусков.
const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
const CHUNK: u64 = 64 * 1024;
/// Нижний предел не менее важен верхнего: без него два гигабайта кусками по
/// байту дают два миллиарда кусков, и всё ограничение обходится арифметикой.
const MIN_CHUNK: u64 = 4 * 1024;

/// Похожа ли карточка файла на карточку файла.
///
/// Размера в байтах тут мало. Получатель разворачивает по этому описанию свои
/// структуры — массив кусков и битовое поле на каждый из них, — и число кусков
/// в нём приходит от чужого клиента. Одно число в сотню миллионов, и вкладка
/// того, кому карточка пришла, укладывается на попытке выделить под неё
/// память: карточка с картинкой начинает качаться сама, не спрашивая (см.
/// `addAttachment` в `web/js/chat.js`).
///
/// Поэтому число кусков не просто ограничивается сверху, а сверяется с
/// размером: они не независимы, и любая пара, которая не сходится, — заведомо
/// не то, что мог прислать наш же клиент. Ту же проверку делает и получатель:
/// сервер может быть чужим ровно так же, как участник.
fn sane_file_meta(meta: &serde_json::Value) -> bool {
    let text = |key: &str, max: usize| {
        meta.get(key).and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty() && v.len() <= max)
    };
    let Some(size) = meta.get("size").and_then(|v| v.as_u64()) else { return false };
    let Some(chunk_size) = meta.get("chunkSize").and_then(|v| v.as_u64()) else { return false };
    let Some(chunks) = meta.get("chunks").and_then(|v| v.as_u64()) else { return false };

    text("id", 64)
        && text("name", 260)
        && text("mime", 128)
        && (1..=MAX_FILE).contains(&size)
        && (MIN_CHUNK..=CHUNK).contains(&chunk_size)
        && chunks == size.div_ceil(chunk_size)
}

/// Имя в списке участников. Пустое поле — не ошибка: человек мог войти по
/// ссылке, ни о чём не спрашивая, и в комнате его всё равно надо как-то звать.
fn display_name(name: Option<String>, peer_id: &str) -> String {
    let given = limit(name.unwrap_or_default().trim(), 32);
    if given.is_empty() {
        format!("Гость-{}", &peer_id[..4])
    } else {
        given
    }
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

/// Обрезка по символам, а не по байтам: в кириллице их по два на букву, и по
/// байтам ник обрывался бы вдвое раньше — а то и посреди символа.
fn limit(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Палитра ников — та же, что в `web/js/settings.js`. Свой цвет человек
/// выбирает там, здесь она нужна только для клиента, который цвета не прислал.
const NICK_PALETTE: [&str; 10] = [
    "#5b8cff", "#3ecf8e", "#f0a020", "#ff6b6b", "#c586ff", "#ff8bd0", "#4ecdc4", "#ffd93d",
    "#9aa5b1", "#ff7043",
];

/// Цвет ника приходит от клиента и попадает в чужой DOM — пропускаем только
/// строгий `#rrggbb`.
///
/// Не прошедшему замена — случайный цвет из палитры, а не один и тот же на
/// всех: цвет ника нужен, чтобы участники различались, и одинаковый запасной
/// ровно эту работу и отменял бы. Клиент на первом запуске выбирает так же.
fn sanitize_color(raw: Option<&str>) -> String {
    fn random() -> String {
        let n = uuid::Uuid::new_v4().as_bytes()[0] as usize;
        NICK_PALETTE[n % NICK_PALETTE.len()].to_string()
    }
    let Some(c) = raw else { return random() };
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if ok {
        c.to_ascii_lowercase()
    } else {
        random()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Код комнаты становится ключом в памяти и меткой в логе: всё, что могло
    /// бы значить в них что-то своё, до нас доезжать не должно.
    #[test]
    fn room_code_survives_only_as_plain_text() {
        assert_eq!(sanitize_room("Комната/../etc"), "etc");
        assert_eq!(sanitize_room("My-Room_1"), "my-room_1");
        assert_eq!(sanitize_room("a b c"), "abc");
        assert_eq!(sanitize_room(&"x".repeat(200)).len(), 96);
        // Пустой код — это не ошибка входа, а новая случайная комната.
        assert_eq!(sanitize_room("://?#").len(), 8);
    }

    /// Цвет уезжает в чужой style — только строгий `#rrggbb`. Остальному
    /// замена из палитры, а какой именно — дело случая, поэтому сверяем
    /// принадлежность, а не значение.
    #[test]
    fn color_is_either_a_hex_triplet_or_one_from_the_palette() {
        assert_eq!(sanitize_color(Some("#AABBCC")), "#aabbcc");
        for raw in [Some("red"), Some("#abc"), Some("#00ff00;x"), None] {
            assert!(NICK_PALETTE.contains(&sanitize_color(raw).as_str()), "{raw:?}");
        }
    }

    /// Случайный — значит разный: на сотне подряд одинаковый цвет означал бы,
    /// что выбор сломан и все такие участники слились в один.
    #[test]
    fn fallback_color_is_not_always_the_same() {
        let seen: std::collections::HashSet<String> =
            (0..100).map(|_| sanitize_color(None)).collect();
        assert!(seen.len() > 1, "выпал один цвет на сто попыток: {seen:?}");
    }

    /// Метка для логов должна отличать комнаты и не выдавать их кодов.
    #[test]
    fn log_tag_hides_the_code() {
        let tagged = tag("секретная-комната");
        assert_eq!(tagged.len(), 8);
        assert!(tagged.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(tagged, tag("секретная-комната"));
        assert_ne!(tagged, tag("другая-комната"));
    }

    /// Адрес спрашивающего — это вход, а не подсказка. Голова
    /// `X-Forwarded-For` набирается клиентом, хвост дописывает прокси; читать
    /// надо хвост. `X-Real-IP` не ставит никто из нашей цепочки, поэтому его
    /// не должно быть слышно вовсе.
    #[test]
    fn forwarding_headers_do_not_choose_the_target() {
        let socket: IpAddr = "8.8.4.4".parse().unwrap();
        let ask = |name: &'static str, value: &str| {
            let mut h = axum::http::HeaderMap::new();
            h.insert(name, HeaderValue::from_str(value).unwrap());
            client_ip(&h, socket)
        };

        // Так Caddy передаёт присланное клиентом: своё он дописывает следом.
        assert_eq!(
            ask("x-forwarded-for", "10.0.0.5, 93.184.216.34").unwrap().to_string(),
            "93.184.216.34"
        );
        // Клиент прислал заголовок сам, прокси впереди нет — берём что дали, а
        // непубличный адрес отсеет `is_public`, не `client_ip`.
        assert_eq!(ask("x-forwarded-for", "127.0.0.1").unwrap().to_string(), "127.0.0.1");
        // Этого заголовка для нас больше не существует.
        assert_eq!(ask("x-real-ip", "127.0.0.1").unwrap(), socket);
        // Ни одного заголовка — остаётся сокет, его подделать нечем.
        assert_eq!(client_ip(&axum::http::HeaderMap::new(), socket).unwrap(), socket);
    }

    /// Куда серверу можно стучаться по чужой просьбе, а куда нельзя. Список
    /// длинный, и ошибка в любой строке возвращает сканер портов внутренней
    /// сети — того самого хоста и тех самых соседних контейнеров.
    #[test]
    fn only_the_open_internet_is_a_valid_target() {
        for public in ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public(&public.parse().unwrap()), "{public}");
        }
        for private in [
            "127.0.0.1",        // петля
            "0.0.0.0",          // «этот хост»
            "10.1.2.3",         // частная
            "172.16.0.1",       // частная
            "192.168.1.1",      // частная
            "169.254.1.1",      // канальная
            "100.64.0.1",       // общий NAT провайдера
            "192.0.0.1",        // служебная
            "198.18.0.1",       // замеры
            "224.0.0.1",        // многоадресная
            "240.0.0.1",        // зарезервировано
            "255.255.255.255",  // широковещательная
            "192.0.2.1",        // из тех, что заведены для примеров в документации
            "203.0.113.1",      // и эти тоже
            "::1",              // петля IPv6
            "fd00::1",          // локальная IPv6
            "fe80::1",          // канальная IPv6
            "::ffff:127.0.0.1", // петля в обёртке IPv6 — тот же адрес
        ] {
            assert!(!is_public(&private.parse().unwrap()), "{private}");
        }
    }

    /// Число кусков решает, сколько памяти развернёт у себя получатель, и
    /// приходит оно от чужого клиента. Значит, оно не бывает «просто числом»:
    /// оно обязано сходиться с размером и длиной куска.
    #[test]
    fn file_card_numbers_have_to_add_up() {
        let card = |size: u64, chunk: u64, chunks: u64| {
            json!({ "id": "a", "name": "f", "mime": "image/png",
                    "size": size, "chunkSize": chunk, "chunks": chunks })
        };
        assert!(sane_file_meta(&card(1, CHUNK, 1)));
        assert!(sane_file_meta(&card(CHUNK + 1, CHUNK, 2)));
        assert!(sane_file_meta(&card(MAX_FILE, CHUNK, MAX_FILE / CHUNK)));

        // Ровно то, чем клали вкладку: одно число, ни с чем не связанное.
        assert!(!sane_file_meta(&card(1, CHUNK, 1_000_000_000)));
        // Мелкий кусок делает число кусков огромным честной арифметикой.
        assert!(!sane_file_meta(&card(MAX_FILE, 1, MAX_FILE)));
        assert!(!sane_file_meta(&card(MAX_FILE + 1, CHUNK, MAX_FILE / CHUNK + 1)));
        assert!(!sane_file_meta(&card(0, CHUNK, 0)));
        // Не числа и вовсе отсутствующие поля — тоже не карточка.
        assert!(!sane_file_meta(&json!({ "id": "a", "name": "f", "mime": "x",
                                         "size": "10", "chunkSize": CHUNK, "chunks": 1 })));
        assert!(!sane_file_meta(&json!({ "size": 10, "chunkSize": CHUNK, "chunks": 1 })));
    }

    /// Всплеск пропускаем целиком, ровный поток сверх скорости — нет. Иначе
    /// один сокет занимает собой и разбор на сервере, и очереди всей комнаты:
    /// каждое сообщение чата уходит каждому.
    #[test]
    fn a_burst_gets_through_and_a_flood_does_not() {
        let mut b = Budget::new();
        for i in 0..BURST as usize {
            assert!(b.allow(), "запас кончился на {i}-м из {BURST}");
        }
        assert!(!b.allow(), "поток сверх запаса надо останавливать");

        // Запас возвращается со временем, а не по звонку: подводим часы назад.
        b.at -= std::time::Duration::from_secs(1);
        for _ in 0..RATE as usize {
            assert!(b.allow());
        }
        assert!(!b.allow());
    }

    /// Обрезаем по символам: в кириллице их по два байта.
    #[test]
    fn limit_counts_characters() {
        assert_eq!(limit("Вячеслав", 4), "Вяче");
        assert_eq!(limit("abc", 10), "abc");
        assert_eq!(limit("", 10), "");
    }

    #[test]
    fn nameless_guest_still_gets_a_name() {
        assert_eq!(display_name(None, "abcdef123456"), "Гость-abcd");
        assert_eq!(display_name(Some("   ".into()), "abcdef123456"), "Гость-abcd");
        assert_eq!(display_name(Some("  Аня ".into()), "abcdef123456"), "Аня");
        assert_eq!(display_name(Some("и".repeat(50)), "abcdef123456").chars().count(), 32);
    }
}
