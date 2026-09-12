//! Оболочка YeruVerse для настольных систем и Android.
//!
//! Окно грузится прямо с сервера комнат по HTTPS, а не из локальных файлов:
//! микрофон и захват экрана браузерный движок отдаёт только в защищённом
//! контексте, и `tauri://` таковым не считается. Побочная польза — фронтенд
//! обновляется вместе с сервером, без переустановки приложения.
//!
//! Оболочка добавляет ровно то, чего у страницы быть не может: выбор сервера
//! комнат, системные сочетания клавиш, прозрачное окно с курсорами поверх всех
//! приложений и приём чужого ввода (см. `input`).
//!
//! Управление чужим компьютером здесь одно — своё, через WebRTC: зритель сидит
//! в браузере, ничего не ставит и тыкает в демонстрацию экрана. Моста к чужим
//! программам (Sunshine, Moonlight) больше нет: игровой режим — захват
//! полноэкранного окна, мышь без ускорения, виртуальный геймпад — предстоит
//! написать здесь же, своими руками, а не подкладывать под него чужой клиент.
//!
//! Окна поверх других приложений и глобальные сочетания существуют только в
//! настольной сборке: на Android таких прав у обычного приложения нет, и
//! соответствующие плагины Tauri там не собираются. Поэтому эти куски отрезаны
//! через `cfg(desktop)`, а `capabilities()` честно сообщает фронтенду, чего в
//! этой сборке нет.

mod codes;
mod input;
#[cfg(desktop)]
mod keys;
mod room;
mod sysaudio;

use std::time::Duration;

#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};
// Событие отсюда шлёт только захват сочетаний у системы, а его нет ни на
// мобильных, ни на Linux (см. `grab_hotkeys`). Слежение за клавиатурой в
// `keys.rs` своё событие шлёт само и берёт трейт себе.
#[cfg(all(desktop, not(target_os = "linux")))]
use tauri::Emitter;
use tauri::{Manager, WebviewWindow};
#[cfg(all(desktop, not(target_os = "linux")))]
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

/// Сменить сервер: сохраняем, обновляем `TrustedServer` и уводим окно на новый адрес.
#[tauri::command]
fn set_server(
    app: tauri::AppHandle,
    window: WebviewWindow,
    trusted: tauri::State<'_, TrustedServer>,
    url: String,
) -> Result<(), String> {
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
    trusted.set(url);
    window.navigate(parsed).map_err(|e| e.to_string())
}

/// Единственный адрес, которому доверены команды из `Trusted` ниже — то, что
/// сам человек сохранил через `set_server` (или адрес по умолчанию, пока он
/// им не пользовался). Кэш вокруг `saved_server`: без него каждое движение
/// мыши во время чужого управления читало бы `server.txt` с диска заново —
/// `input_move` идёт кадр за кадром, а не раз в разговор.
struct TrustedServer(std::sync::Mutex<String>);

impl TrustedServer {
    fn new(url: String) -> Self {
        Self(std::sync::Mutex::new(url))
    }
    fn set(&self, url: String) {
        *self.0.lock().unwrap() = url;
    }
    fn get(&self) -> String {
        self.0.lock().unwrap().clone()
    }
}

/// Смотрит ли `current` (обычно `window.url()`) туда же, куда указывает
/// `TrustedServer`.
///
/// ACL в `capabilities/*.json` разрешает `localhost`/`127.0.0.1` на любом
/// порту — это нужно ради самостоятельного хостинга сервера комнат, а не ради
/// того, чтобы приём ввода доставался первому процессу на компьютере, который
/// поднял HTTP хоть на каком-то порту. Статическая маска такого не различает:
/// она смотрит на схему и порт, а не на то, тот ли это адрес, который человек
/// сам сохранил. Общая для `Trusted` ниже и для ручной проверки в
/// `input::set_control`, у которой отказ нужен не всегда, а только при
/// включении приёма — `Trusted` в параметрах команды на это не годится, она
/// либо есть, либо отказ ещё до тела.
pub(crate) fn is_trusted(trusted: &TrustedServer, current: tauri::Result<tauri::Url>) -> bool {
    let Ok(current) = current else { return false };
    let Ok(trusted) = trusted.get().parse::<tauri::Url>() else { return false };
    current.origin() == trusted.origin()
}

/// Параметр команды, который можно получить, только пройдя `is_trusted` — не
/// ручная проверка в начале тела, а часть самой подписи. Опасная команда,
/// забывшая этот параметр в списке, не получает отказа во время выполнения —
/// она получает отказ на этапе вызова: тело просто не запускается, пока IPC не
/// соберёт все параметры, а этот не собирается ни для кого чужого.
pub(crate) struct Trusted;

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Trusted {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let webview = command.message.webview();
        let trusted = webview.state::<TrustedServer>();
        if is_trusted(&trusted, webview.url()) {
            Ok(Trusted)
        } else {
            Err(tauri::ipc::InvokeError::from(
                "действие разрешено только со своего сервера".to_string(),
            ))
        }
    }
}

// ---------------------------------------------------------------- ссылки

/// Открыть ссылку системой — страницу загрузки приложения, а на Android ещё и
/// сам APK с обновлением.
///
/// Раньше здесь звалась системная команда — `open`, `start`, `xdg-open`. На
/// Android такой команды нет ни одной, и всё, что вело наружу, там молча не
/// работало. Плагин Tauri знает, как это делается на каждой платформе.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    // Наружу уходит только то, что мы сами и показываем: чужая строка не должна
    // превратиться ни в аргументы команды, ни в чужую схему вроде `file:`.
    if !url.starts_with("https://") || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("недопустимая ссылка".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- сочетания

/// Разбирает наш формат (`Ctrl+Shift+KeyM`) в сочетание для системы. Мышь
/// сюда не попадает: глобально её кнопки перехватить нельзя.
#[cfg(all(desktop, not(target_os = "linux")))]
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

/// Новый список сочетаний. Приходит целиком: так проще держать его в согласии
/// с настройками, чем ловить отдельные добавления и удаления.
///
/// Путей два, и они не равнозначны. Обычно мы просто смотрим за клавиатурой
/// (см. `keys.rs`): клавиша срабатывает у нас и всё равно уходит дальше, в игру
/// или в браузер. Где смотреть нечем — на macOS, пока человек не разрешил
/// мониторинг ввода, — остаётся регистрация у системы, а она клавишу забирает
/// себе целиком. Об этом фронтенд узнаёт из `capabilities` и предупреждает,
/// когда назначают одиночную клавишу.
///
/// На Linux нет ни того, ни другого: под Wayland клавиатуру не подсмотреть и
/// не отобрать. Туда эта команда не приходит вовсе — `hotkeyMode: "none"`, и
/// страница настройку не показывает.
#[cfg(desktop)]
#[tauri::command]
fn set_hotkeys(
    app: tauri::AppHandle,
    watcher: tauri::State<'_, keys::Keys>,
    hotkeys: Vec<(String, String)>,
) -> Result<(), String> {
    if watcher.set(hotkeys.clone()) {
        return Ok(());
    }
    grab_hotkeys(app, hotkeys)
}

/// Запасной путь: отдать сочетания системе. Клавиша при этом достаётся нам
/// монопольно — другие приложения её больше не увидят.
#[cfg(all(desktop, not(target_os = "linux")))]
fn grab_hotkeys(app: tauri::AppHandle, hotkeys: Vec<(String, String)>) -> Result<(), String> {
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

/// На Wayland запасного пути нет вовсе.
///
/// Забрать клавишу у всей системы там нельзя в принципе: клавиатуру раздаёт
/// композитор, и просят его об этом порталом `GlobalShortcuts` — а он, в
/// отличие от X11, сам решает, показывать ли человеку окно с вопросом и
/// какие сочетания вообще позволить. Пути к нему у нас пока нет, и делать вид,
/// что сочетания назначены, нельзя: страница узнаёт правду из `capabilities`
/// (`hotkeyMode: "none"`) и настройку не показывает вовсе. Ошибка здесь — для
/// той сборки, что старее своей страницы.
#[cfg(all(desktop, target_os = "linux"))]
fn grab_hotkeys(_app: tauri::AppHandle, _hotkeys: Vec<(String, String)>) -> Result<(), String> {
    Err("системные сочетания под Wayland недоступны".into())
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
async fn update_install(_trusted: Trusted, app: tauri::AppHandle) -> Result<(), String> {
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
///
/// `hotkeyMode` — как достаются системные сочетания и достаются ли вообще.
/// Отдельного «умеем ли» рядом с ним больше нет: два поля про одно и то же
/// расходились бы ровно тогда, когда это важнее всего.
///
/// `updates` — умеет ли приложение обновиться само, не выходя наружу. Это
/// настольная сборка: там плагин скачивает пакет и проверяет его подпись. На
/// Android пакет ставит система, поэтому там страница сравнивает `version` с
/// той, что отдаёт сервер комнат, и открывает ссылку на APK.
///
/// `overlay` и `remoteControl` — про чужой рабочий стол: показать на нём
/// курсоры зрителей и дать по нему щёлкать. Щёлкать умеет вся настольная
/// сборка, показывать — все, кроме Linux: под Wayland порядок окон за
/// композитором, и окна поверх всех прочих у нас там пока нет.
///
/// `systemAudio` и `systemAudioMixesUs` — про звук компьютера: может ли
/// оболочка его снять и попадают ли в него наши собственные голоса.
#[tauri::command]
fn capabilities(app: tauri::AppHandle) -> serde_json::Value {
    let _ = &app;
    // Как достаются системные сочетания: `watch` — смотрим за клавиатурой, и
    // клавиша остаётся рабочей для всех остальных; `grab` — забираем её у
    // системы себе, и больше её никто не увидит. Страница по этому решает,
    // предупреждать ли о назначении одиночной клавиши.
    #[cfg(all(desktop, not(target_os = "linux")))]
    let hotkeys = if app.state::<keys::Keys>().watching() { "watch" } else { "grab" };
    // На Wayland третьего варианта нет: следить за клавиатурой нечем, забрать
    // её у системы тоже нечем — плагин снят вместе с X11. Пишем правду, и
    // страница просто не покажет настройку сочетаний.
    #[cfg(all(desktop, target_os = "linux"))]
    let hotkeys = if app.state::<keys::Keys>().watching() { "watch" } else { "none" };
    #[cfg(not(desktop))]
    let hotkeys = "none";

    // Окно поверх всех прочих на Wayland поставить нельзя: порядок окон там
    // целиком за композитором, и `always_on_top` у Tauri оборачивается тихой
    // пустышкой (tao#1134, tauri#3117, tauri#14913). Правильный протокол для
    // такого окна — wlr-layer-shell, но включают его до того, как окно создано,
    // а такого крючка Tauri не даёт (tao#925, tauri#14277 — оба открыты).
    // Значит курсоров зрителей поверх чужого экрана на Linux пока не будет, и
    // честнее сказать это сразу, чем показать кнопку, которая ничего не делает.
    let overlay = cfg!(desktop) && !cfg!(target_os = "linux");

    serde_json::json!({
        "platform": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
        "overlay": overlay,
        "hotkeyMode": hotkeys,
        // Ввод под Wayland идёт порталом или протоколами wlroots — см. enigo
        // в Cargo.toml. Спросить заранее, ответит ли композитор, нечем:
        // выясняется это только первой попыткой, и о неудаче узнаёт `input`.
        "remoteControl": cfg!(desktop),
        "updates": cfg!(desktop),
        // Умеет ли оболочка удержать комнату в фоне и не дать системе увести
        // звук в «разговорный» режим (см. `room.rs`). Это Android и только он:
        // настольным системам ни то, ни другое не нужно.
        "background": cfg!(target_os = "android"),
        // Может ли оболочка отдать звук самой системы. Нужно там, где движок
        // его не отдаёт сам: macOS и Linux. На Windows отдаёт, и мост не нужен.
        "systemAudio": cfg!(any(target_os = "macos", target_os = "linux")),
        // Попадают ли в этот звук наши собственные голоса. На macOS не
        // попадают — ScreenCaptureKit умеет выкинуть свой процесс. На Linux
        // попадают, и деться от этого некуда: монитор устройства вывода —
        // готовая смесь, разбирать её обратно нечем (см. `sysaudio.rs`).
        "systemAudioMixesUs": cfg!(target_os = "linux"),
    })
}

/// Главное окно закрыли — значит, приложения больше нет.
///
/// Окон у нас два, и второе человеку не видно вовсе: прозрачное окно с
/// курсорами зрителей живёт поверх всех приложений, без рамки и без строки в
/// панели задач. Для системы это всё равно окно, а приложение заканчивается
/// только вместе с последним из них — и, закрыв комнату во время трансляции,
/// человек оставлял процесс жить дальше. Увидеть его было негде.
///
/// Дороже всего это обходилось системным сочетаниям. Windows отдаёт
/// зарегистрированную клавишу владельцу монопольно и забирает регистрацию
/// только со смертью процесса: назначенная на перехват клавиша переставала
/// работать во всей системе — и «после выхода из YeruVerse» тоже, потому что
/// никакого выхода на самом деле не было.
///
/// Поэтому сочетания снимаем сами и закрываемся целиком, не дожидаясь, пока
/// закончатся окна.
#[cfg(desktop)]
fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" || !matches!(event, tauri::WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    // На Wayland снимать нечего: клавиши у системы мы там не забираем — см.
    // `grab_hotkeys`. Закрыться целиком всё равно надо: окно с курсорами
    // зрителей и без того держало бы процесс живым.
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister_all();
    }
    app.exit(0);
}

/// Wayland и только Wayland.
///
/// GTK знает оба сервера окон и выбирает сам — а выбирает он X11, стоит
/// найтись переменной `DISPLAY`. Под Wayland она есть всегда: её выставляет
/// XWayland, который запущен на любом нынешнем рабочем столе. То есть без
/// нашего слова сборка молча уезжала бы в XWayland — а там не работает ничего
/// из того, ради чего она и существует: ни ввод (портал и протоколы wlroots
/// говорят только с Wayland), ни демонстрация экрана порталом.
///
/// Выставляем изнутри процесса, а не в обёртке запуска: у AppImage обёртка
/// своя, и она выставляет `GDK_BACKEND` по-своему, затирая чужое
/// (tauri#15781). Отсюда это последнее слово — лишь бы до `gtk_init`.
///
/// Сеанса Wayland может и не оказаться. Уйти в X11 нам нечем, поэтому вместо
/// невнятного отказа GTK где-то в глубине говорим прямо и уходим сами.
#[cfg(target_os = "linux")]
fn wayland_only() {
    std::env::set_var("GDK_BACKEND", "wayland");
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return;
    }
    let msg = "YeruVerse работает только под Wayland, а сеанс не Wayland. \
               Выберите сеанс Wayland на экране входа: у каждой среды он свой, \
               но в списке сеансов подписан словом Wayland.";
    tracing::error!("{msg}");
    eprintln!("{msg}");
    std::process::exit(1);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "yeruverse_desktop=info".into()),
        )
        .init();

    #[cfg(target_os = "linux")]
    wayland_only();

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    // Плагина системных сочетаний нет ни на мобильных, ни на Linux: там он
    // держится на X11, а X11 отсюда убран целиком (см. Cargo.toml).
    #[cfg(all(desktop, not(target_os = "linux")))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(desktop)]
    let builder = builder.on_window_event(on_window_event);

    builder
        .manage(input::Input::start())
        .manage(sysaudio::Sound::new())
        // Страница уходит на перезагрузку — снимаем захват звука за неё.
        // Сама она об этом сказать уже не успеет, а переживший её захват
        // держит экран занятым: следующая демонстрация получит от системы
        // «The operation was aborted» и не начнётся вовсе.
        .on_page_load(|webview, payload| {
            use tauri::webview::PageLoadEvent;
            if payload.event() == PageLoadEvent::Started {
                sysaudio::stop(&webview.state::<sysaudio::Sound>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            capabilities,
            overlay,
            set_hotkeys,
            current_server,
            set_server,
            open_url,
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
            room::set_room,
            sysaudio::sound_start,
            sysaudio::sound_stop,
            sysaudio::sound_stats,
        ])
        .setup(|app| {
            // Слежение за клавиатурой поднимаем здесь: до появления `AppHandle`
            // сообщить о нажатии всё равно некому.
            #[cfg(desktop)]
            app.manage(keys::Keys::start(app.handle().clone()));

            // Уходим на сохранённый сервер, только если он отвечает. Молчит —
            // остаёмся на адресе по умолчанию: сервер мог переехать, лечь или
            // оказаться опечаткой, и во всех трёх случаях белое окно без единой
            // кнопки — худший из возможных исходов. Поле «Сервер комнат» тогда
            // на виду, и адрес можно поправить или стереть.
            let url = saved_server(app.handle());
            // До первого `set_server` доверенный адрес — этот же: окно либо уже
            // на нём (адрес по умолчанию), либо вот-вот попробует на него уйти.
            app.manage(TrustedServer::new(url.clone()));
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
