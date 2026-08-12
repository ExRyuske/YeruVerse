//! Оболочка YeruVerse для настольных систем и Android.
//!
//! Окно грузится прямо с сервера комнат по HTTPS, а не из локальных файлов:
//! микрофон и захват экрана браузерный движок отдаёт только в защищённом
//! контексте, и `tauri://` таковым не считается. Побочная польза — фронтенд
//! обновляется вместе с сервером, без переустановки приложения.
//!
//! Оболочка добавляет ровно то, чего у страницы быть не может: выбор сервера
//! комнат, системные сочетания клавиш, прозрачное окно с курсорами поверх всех
//! приложений, мост к Sunshine и приём чужого ввода (см. `input`).
//!
//! Путей управления чужим компьютером два, и они не конкурируют. Простой —
//! наш собственный, через WebRTC: зритель сидит в браузере, ничего не ставит и
//! тыкает в демонстрацию экрана. Для игр — Sunshine (или его форк Apollo) с
//! Moonlight: они работают на уровне системы, с захватом полноэкранного режима
//! и виртуальным геймпадом, чего браузерная связка не может в принципе.
//!
//! Окна поверх других приложений и глобальные сочетания существуют только в
//! настольной сборке: на Android таких прав у обычного приложения нет, и
//! соответствующие плагины Tauri там не собираются. Поэтому эти куски отрезаны
//! через `cfg(desktop)`, а `capabilities()` честно сообщает фронтенду, чего в
//! этой сборке нет.

mod input;

use std::time::Duration;

#[cfg(desktop)]
use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder};
use tauri::{Manager, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const DEFAULT_SERVER: &str = "https://verse.yeru.cc";

// ---------------------------------------------------------------- сервер

/// Адрес, на который смотрит окно. Хранится рядом с настройками приложения:
/// localStorage тут не годится, он привязан к origin, а origin мы и меняем.
fn server_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("server.txt"))
}

/// Отвечает ли адрес.
///
/// Смотрим соединением, а не строкой: `http://localhost.8080` — точка вместо
/// двоеточия — разбирается безупречно, это правильный адрес узла с именем
/// «localhost.8080». Просто такого узла нет.
fn reachable(url: &tauri::Url) -> bool {
    use std::net::ToSocketAddrs;

    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false; // имя не разрешилось — идти некуда
    };
    addrs
        .take(2)
        .any(|a| std::net::TcpStream::connect_timeout(&a, Duration::from_millis(1200)).is_ok())
}

fn saved_server(app: &tauri::AppHandle) -> String {
    server_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER.to_string())
}

#[tauri::command]
fn current_server(app: tauri::AppHandle) -> String {
    saved_server(&app)
}

/// Сменить сервер: сохраняем и уводим окно на новый адрес.
#[tauri::command]
fn set_server(app: tauri::AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    let url = url.trim().trim_end_matches('/').to_string();

    // Пустое поле — не ошибка, а «вернуться к серверу по умолчанию». Заодно это
    // способ выбраться, не трогая файлы, если сохранён адрес, который молчит.
    let url = if url.is_empty() { DEFAULT_SERVER.to_string() } else { url };

    let parsed: tauri::Url = url.parse().map_err(|_| "не похоже на адрес".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("нужен http или https".into());
    }
    if let Some(path) = server_file(&app) {
        if url == DEFAULT_SERVER {
            let _ = std::fs::remove_file(path);
        } else {
            let _ = std::fs::write(path, &url);
        }
    }
    window.navigate(parsed).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- Sunshine

/// Порт, на котором Sunshine и Apollo держат свой HTTP, — достаточный признак
/// того, что хост готов принимать Moonlight.
const SUNSHINE_PORT: u16 = 47989;

/// Запущен ли на этой машине Sunshine (или Apollo), по какому адресу к нему
/// идти и можно ли подтверждать сопряжение без человека. Фронтенд спрашивает
/// это сам — нажимать «объявить» не нужно.
#[tauri::command]
fn sunshine(app: tauri::AppHandle) -> serde_json::Value {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], SUNSHINE_PORT));
    let running = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok();
    serde_json::json!({
        "running": running,
        "address": local_ip(),
        "canPair": creds_file(&app).map(|p| p.exists()).unwrap_or(false),
    })
}

/// Логин и пароль веб-панели Sunshine. Лежат рядом с настройками приложения, а
/// не в localStorage: тот привязан к origin страницы, то есть к чужому серверу,
/// и хранить там доступ к своему компьютеру не годится.
fn creds_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("sunshine.txt"))
}

#[tauri::command]
fn sunshine_creds(app: tauri::AppHandle, user: String, password: String) -> Result<(), String> {
    let path = creds_file(&app).ok_or("некуда сохранить")?;
    if user.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if user.contains(':') || user.contains('\n') || password.contains('\n') {
        return Err("двоеточие и перевод строки в логине недопустимы".into());
    }
    std::fs::write(&path, format!("{user}:{password}")).map_err(|e| e.to_string())
}

/// Подтвердить сопряжение: отдать PIN своему Sunshine за человека.
///
/// Иначе PIN пришлось бы переписывать руками из окна Moonlight в веб-панель
/// Sunshine — единственный ручной шаг во всей цепочке, и как раз тот, на
/// котором всё бросают. Панель говорит по HTTPS с самоподписанным сертификатом
/// и требует Basic-авторизацию; проще всего это делает `curl`, который есть и в
/// macOS, и в Windows 10+, и в любом Linux — ради одного запроса тянуть в
/// приложение целый HTTP-клиент с TLS ни к чему.
#[tauri::command]
async fn sunshine_pin(app: tauri::AppHandle, pin: String) -> Result<(), String> {
    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN — это четыре цифры".into());
    }
    let creds = creds_file(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .ok_or("не задан доступ к веб-панели Sunshine")?;

    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new("curl")
            .args(["--silent", "--show-error", "--insecure", "--max-time", "10"])
            .args(["--user", creds.trim()])
            .args(["--header", "Content-Type: application/json"])
            .args(["--data", &format!(r#"{{"pin":"{pin}","name":"YeruVerse"}}"#)])
            .arg(format!("https://localhost:{}/api/pin", SUNSHINE_PORT + 1))
            .output()
            .map_err(|e| format!("не нашли curl: {e}"))?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        // Sunshine отвечает 200 и на неверный PIN — смотрим на само тело.
        // Пробелы убираем: в разных версиях статус то булев, то строкой.
        let body = String::from_utf8_lossy(&out.stdout);
        let flat: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        if flat.contains("\"status\":true") || flat.contains("\"status\":\"true\"") {
            Ok(())
        } else {
            Err(format!("Sunshine не принял PIN: {}", body.trim()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Адрес этой машины в локальной сети. Пакетов сокет не шлёт — соединение без
/// обмена данными нужно только чтобы система выбрала исходящий интерфейс.
fn local_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

/// Системный обработчик ссылок для текущей платформы.
fn opener() -> std::process::Command {
    #[cfg(target_os = "macos")]
    return std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        return c;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    return std::process::Command::new("xdg-open");
}

/// Открыть ссылку системой — для страниц загрузки Sunshine и Moonlight.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Наружу уходит только то, что мы сами и показываем: чужая строка не должна
    // превратиться в аргументы команды.
    if !url.starts_with("https://") || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("недопустимая ссылка".into());
    }
    opener().arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Где искать Moonlight. Схемы `moonlight://` в системе не существует — ни на
/// macOS, ни где-либо ещё её никто не регистрирует, поэтому единственный способ
/// его запустить — позвать исполняемый файл напрямую.
fn moonlight_binary() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();

    #[cfg(target_os = "macos")]
    let candidates = [
        "/Applications/Moonlight.app/Contents/MacOS/Moonlight".to_string(),
        format!("{home}/Applications/Moonlight.app/Contents/MacOS/Moonlight"),
        "/opt/homebrew/bin/moonlight".to_string(),
        "/usr/local/bin/moonlight".to_string(),
    ];
    #[cfg(target_os = "windows")]
    let candidates = [
        r"C:\Program Files\Moonlight Game Streaming\Moonlight.exe".to_string(),
        r"C:\Program Files (x86)\Moonlight Game Streaming\Moonlight.exe".to_string(),
    ];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates = [
        "/usr/bin/moonlight".to_string(),
        "/usr/local/bin/moonlight".to_string(),
        "/var/lib/flatpak/exports/bin/com.moonlight_stream.Moonlight".to_string(),
        format!("{home}/.local/share/flatpak/exports/bin/com.moonlight_stream.Moonlight"),
    ];

    let _ = &home;
    candidates.iter().map(std::path::PathBuf::from).find(|p| p.exists())
}

/// Запустить Moonlight на указанном адресе.
///
/// `action` — то же, что в его собственной командной строке: `pair` знакомит с
/// компьютером и показывает PIN, `stream` сразу открывает рабочий стол. Первый
/// раз нужен `pair`, дальше только `stream`; кто из них нужен, решает фронтенд
/// по своему списку уже сопряжённых адресов.
#[tauri::command]
fn moonlight(host: String, action: String, pin: Option<String>) -> Result<(), String> {
    if host.is_empty() || host.chars().any(|c| !(c.is_ascii_alphanumeric() || ".:-_".contains(c))) {
        return Err("странный адрес".into());
    }
    let exe =
        moonlight_binary().ok_or("Moonlight не найден — установите его с moonlight-stream.org")?;
    let mut cmd = std::process::Command::new(exe);

    if action == "pair" {
        cmd.arg("pair").arg(&host);
        // PIN задаём мы: тот же код уходит хозяину, и подтверждать сопряжение
        // человеку не придётся.
        if let Some(pin) = pin.filter(|p| p.len() == 4 && p.chars().all(|c| c.is_ascii_digit())) {
            cmd.args(["--pin", &pin]);
        }
    } else {
        // Sunshine всегда отдаёт «Desktop» — это весь экран целиком.
        cmd.args(["stream", &host, "Desktop"]);
    }

    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- сочетания

/// Разбирает наш формат (`Ctrl+Shift+KeyM`) в сочетание для системы. Мышь
/// сюда не попадает: глобально её кнопки перехватить нельзя.
#[cfg(desktop)]
fn parse_shortcut(combo: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code = None;

    for part in combo.split('+') {
        match part {
            "Ctrl" => mods |= Modifiers::CONTROL,
            "Alt" => mods |= Modifiers::ALT,
            "Shift" => mods |= Modifiers::SHIFT,
            "Meta" => mods |= Modifiers::SUPER,
            other => code = other.parse::<Code>().ok(),
        }
    }
    Some(Shortcut::new(Some(mods), code?))
}

/// Регистрирует сочетания системно — они срабатывают, даже когда окно свёрнуто
/// и человек в игре. Список приходит целиком: так проще держать его в согласии
/// с настройками, чем ловить отдельные добавления и удаления.
#[cfg(desktop)]
#[tauri::command]
fn set_hotkeys(app: tauri::AppHandle, hotkeys: Vec<(String, String)>) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    for (id, combo) in hotkeys {
        let Some(shortcut) = parse_shortcut(&combo) else { continue };
        let app = app.clone();
        manager
            .on_shortcut(shortcut, move |_, _, event| {
                // Отдаём и нажатие, и отпускание: действиям вроде «молчать,
                // пока зажато» нужно знать, когда клавишу отпустили.
                let down = event.state() == ShortcutState::Pressed;
                let _ = app.emit("hotkey", serde_json::json!({ "id": &id, "down": down }));
            })
            .map_err(|e| format!("{combo}: {e}"))?;
    }
    Ok(())
}

/// На мобильных системный перехват клавиш недоступен — сочетания остаются
/// внутристраничными, и звать эту команду фронтенду незачем.
#[cfg(not(desktop))]
#[tauri::command]
fn set_hotkeys(_hotkeys: Vec<(String, String)>) -> Result<(), String> {
    Err("системные сочетания недоступны на этой платформе".into())
}

// ---------------------------------------------------------------- обновления

/// Есть ли версия свежее. Возвращает её номер или `null`.
///
/// Приложение забирает `latest.json` из релизов GitHub, сверяет версию и
/// проверяет подпись пакета встроенным публичным ключом. Без верной подписи
/// установка не начнётся: иначе перехваченный ответ означал бы подменённое
/// приложение.
#[cfg(desktop)]
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let found =
        app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|u| u.version))
}

/// Скачать, поставить и перезапуститься.
#[cfg(desktop)]
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("обновлений нет")?;

    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

/// Android обновляется своим APK, а не через нас.
#[cfg(not(desktop))]
#[tauri::command]
async fn update_check() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(desktop))]
#[tauri::command]
async fn update_install() -> Result<(), String> {
    Err("обновление недоступно на этой платформе".into())
}

/// Полный экран средствами окна, а не страницы.
///
/// В Android-вебвью Fullscreen API для обычных элементов не работает — там нет
/// обработчика, который показывал бы их поверх приложения. На настольных
/// системах разворачиваем само окно, и с точки зрения человека это то же самое.
#[cfg(desktop)]
#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// На мобильных окном управляет система: размера окна там нет как понятия, и
/// метода тоже. Страница узнаёт об отказе и разворачивает сцену сама.
#[cfg(not(desktop))]
#[tauri::command]
fn set_fullscreen(_on: bool) -> Result<(), String> {
    Err("окном на этой платформе управляет система".into())
}

// ---------------------------------------------------------------- указатели

/// Прозрачное окно поверх всех приложений, в котором рисуются курсоры зрителей.
/// Без него указка видна только внутри окна YeruVerse, а транслирующий смотрит
/// в игру и её не видит.
#[cfg(desktop)]
#[tauri::command]
async fn overlay(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        if !enabled {
            let _ = win.close();
            return Ok(());
        }
        // Окно уже есть — просто напоминаем системе, где ему место: чужое
        // полноэкранное приложение могло перекрыть его, пока мы не смотрели.
        let _ = win.set_always_on_top(true);
        let _ = win.set_visible_on_all_workspaces(true);
        return Ok(());
    }
    if !enabled {
        return Ok(());
    }

    let monitor =
        app.primary_monitor().map_err(|e| e.to_string())?.ok_or("не нашли основной экран")?;
    let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let pos = monitor.position().to_logical::<f64>(monitor.scale_factor());

    let win = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("YeruVerse — указатели")
        .inner_size(size.width, size.height)
        .position(pos.x, pos.y)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        // Без этого окно живёт только в своём рабочем столе: стоит игре уйти в
        // полноэкранный режим — а на macOS это отдельное пространство, — и
        // курсоры зрителей остаются на брошенном экране. Разрешение «быть на
        // всех рабочих столах» — единственное, чем это лечится снаружи.
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Окно не должно перехватывать ни клики, ни фокус: под ним работают.
    win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
async fn overlay(_enabled: bool) -> Result<(), String> {
    Err("окно поверх других приложений недоступно на этой платформе".into())
}

/// Что умеет эта сборка — фронтенд прячет по ней недоступные кнопки.
#[tauri::command]
fn capabilities() -> serde_json::Value {
    serde_json::json!({
        "platform": std::env::consts::OS,
        "overlay": cfg!(desktop),
        "globalHotkeys": cfg!(desktop),
        "remoteControl": cfg!(desktop),
        "updates": cfg!(desktop),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "yeruverse_desktop=info".into()),
        )
        .init();

    let builder = tauri::Builder::default();
    // Плагина системных сочетаний на мобильных платформах просто не существует.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(input::Input::start())
        .invoke_handler(tauri::generate_handler![
            capabilities,
            overlay,
            set_hotkeys,
            current_server,
            set_server,
            sunshine,
            sunshine_creds,
            sunshine_pin,
            open_url,
            moonlight,
            set_fullscreen,
            update_check,
            update_install,
            input::set_control,
            input::input_pause,
            input::input_move,
            input::input_button,
            input::input_scroll,
            input::input_key,
            input::input_release,
        ])
        .setup(|app| {
            // Уходим на сохранённый сервер, только если он отвечает. Молчит —
            // остаёмся на адресе по умолчанию: сервер мог переехать, лечь или
            // оказаться опечаткой, и во всех трёх случаях белое окно без единой
            // кнопки — худший из возможных исходов. Поле «Сервер комнат» тогда
            // на виду, и адрес можно поправить или стереть.
            let url = saved_server(app.handle());
            if url == DEFAULT_SERVER {
                return Ok(());
            }
            let Ok(parsed) = url.parse::<tauri::Url>() else {
                return Ok(());
            };
            // Проверка стучится в сеть, поэтому уходит в свой поток: иначе окно
            // не показалось бы, пока она не закончится.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if !reachable(&parsed) {
                    return;
                }
                let win = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(w) = win.get_webview_window("main") {
                        let _ = w.navigate(parsed);
                    }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
