//! Системные сочетания, которые не отбирают клавишу у остальных.
//!
//! Раньше сочетания регистрировались у системы обычным способом — тем самым,
//! которым их регистрирует любое приложение. Способ этот у Windows один и
//! работает он жёстко: клавиша целиком уходит владельцу регистрации, и до всех
//! прочих окон больше не доходит. Для `Ctrl+Shift+M` это незаметно, а вот
//! назначенная одиночная клавиша просто исчезала из системы: в игре, в браузере
//! и в блокноте она переставала работать вовсе, пока приложение запущено.
//!
//! Поэтому мы не забираем клавишу, а смотрим на неё. Система показывает нам
//! нажатия по мере того, как они происходят, а мы сверяем их с назначенными
//! сочетаниями и **всегда** пропускаем событие дальше — в игру, в браузер, куда
//! оно и шло. Так же устроены Discord и OBS, и по той же причине.
//!
//! Слежение это по своей природе видит всю клавиатуру, включая чужие пароли,
//! поэтому здесь важно не только что делается, но и чего не делается: нажатия
//! не пишутся ни в файл, ни в лог, никуда не отправляются и нигде не копятся.
//! Единственное, что происходит с нажатием, — сравнение с назначенным списком;
//! наружу уходит имя действия («выключить микрофон») и только если оно совпало.
//! По этой же причине сюда не попадает ввод, синтезированный нами самими: чужая
//! рука, управляющая этим компьютером из комнаты, не должна щёлкать
//! выключателями хозяина.
//!
//! Где так не выходит — на Linux и там, где человек не выдал разрешения, —
//! остаётся прежний путь с захватом клавиши: см. `set_hotkeys` в `lib.rs`.

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::codes;

/// Модификаторы одним набором битов: их сравнивают целиком, а не по одному.
const CTRL: u8 = 1 << 0;
const ALT: u8 = 1 << 1;
const SHIFT: u8 = 1 << 2;
const META: u8 = 1 << 3;

/// Кнопки мыши по нумерации браузера — той же, в которой их называет страница
/// при назначении: левая, средняя, правая, а дальше боковые.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const MOUSE: [&str; 5] = ["Mouse0", "Mouse1", "Mouse2", "Mouse3", "Mouse4"];

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn mouse_name(button: usize) -> Option<&'static str> {
    MOUSE.get(button).copied()
}

/// Разобранное сочетание: `Ctrl+Shift+KeyM` — это два модификатора и место
/// клавиши на клавиатуре. Кнопка мыши занимает в нём то же место, что и
/// клавиша: `Ctrl+Mouse3` разбирается ровно так же.
struct Combo {
    mods: u8,
    code: String,
}

fn parse(combo: &str) -> Option<Combo> {
    let mut mods = 0;
    let mut code = None;
    for part in combo.split('+') {
        match part {
            "Ctrl" => mods |= CTRL,
            "Alt" => mods |= ALT,
            "Shift" => mods |= SHIFT,
            "Meta" => mods |= META,
            other => code = Some(other.to_string()),
        }
    }
    // Пустое место — это «сочетание не назначено», а не клавиша без имени:
    // именно так выглядит действие, которому человек ничего не назначал.
    Some(Combo { mods, code: code.filter(|c| !c.is_empty())? })
}

/// Что делать с увиденным нажатием.
///
/// Живёт весь век процесса и достаётся обработчику по статической ссылке:
/// системный хук Windows — это обычная функция без всякого контекста, передать
/// в неё что-либо иначе нечем.
struct Dispatch {
    /// Назначенные сочетания. Меняются редко — когда человек их правит, —
    /// а читаются на каждое нажатие, поэтому замок именно на чтение.
    combos: RwLock<Vec<(String, Combo)>>,
    /// Чем сейчас держат какое действие: клавиша -> действие. Отпускание
    /// ищется по самой клавише, без модификаторов: их отпускают первыми, и
    /// «молчать, пока зажато» иначе залипало бы навсегда.
    held: Mutex<HashMap<String, String>>,
    /// Куда сообщить о совпадении. Отправка — не наше дело: обработчик обязан
    /// вернуться немедленно, а разговор с вебвью быстрым не бывает.
    tx: Mutex<Sender<(String, bool)>>,
}

impl Dispatch {
    fn new(tx: Sender<(String, bool)>) -> Self {
        Dispatch {
            combos: RwLock::new(Vec::new()),
            held: Mutex::new(HashMap::new()),
            tx: Mutex::new(tx),
        }
    }

    fn set(&self, list: Vec<(String, String)>) {
        let parsed = list.into_iter().filter_map(|(id, c)| Some((id, parse(&c)?))).collect();
        if let Ok(mut combos) = self.combos.write() {
            *combos = parsed;
        }
        // Сочетания сменились — прежде зажатое отпускать некому. Отпускаем за
        // него: иначе действие, которое держали старой клавишей, осталось бы
        // включённым, а выключить его стало бы нечем.
        self.release_all();
    }

    fn fire(&self, id: String, down: bool) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send((id, down));
        }
    }

    fn release_all(&self) {
        let Ok(mut held) = self.held.lock() else { return };
        for (_, id) in held.drain() {
            self.fire(id, false);
        }
    }

    /// Система показала нажатие. Всё, что здесь происходит, — сравнение;
    /// событие в любом случае идёт дальше своим ходом.
    fn key(&self, code: &str, mods: u8, down: bool) {
        if !down {
            let released = self.held.lock().ok().and_then(|mut held| held.remove(code));
            if let Some(id) = released {
                self.fire(id, false);
            }
            return;
        }

        // Уже держим этой клавишей — значит это автоповтор, а не новое нажатие.
        if self.held.lock().map(|held| held.contains_key(code)).unwrap_or(true) {
            return;
        }
        let Ok(combos) = self.combos.read() else { return };
        let Some((id, _)) = combos.iter().find(|(_, c)| c.code == code && c.mods == mods) else {
            return;
        };
        let id = id.clone();
        drop(combos);

        if let Ok(mut held) = self.held.lock() {
            held.insert(code.to_string(), id.clone());
        }
        self.fire(id, true);
    }
}

/// Слежение за клавиатурой — или его отсутствие, если система не дала.
pub struct Keys {
    dispatch: Option<&'static Dispatch>,
}

impl Keys {
    /// Поднимает слежение. Возвращается сразу: если система его не дала —
    /// нет разрешения, не та платформа, — `watching()` честно скажет «нет», и
    /// вызывающий уйдёт на запасной путь.
    pub fn start(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<(String, bool)>();

        // Разговор с вебвью — в своём потоке. В обработчике системного хука
        // задерживаться нельзя: Windows молча снимает хук, который не ответил
        // вовремя, и сочетания перестают работать без единого слова.
        let sender = std::thread::Builder::new()
            .name("hotkeys".into())
            .spawn(move || {
                for (id, down) in rx {
                    let _ = app.emit("hotkey", serde_json::json!({ "id": id, "down": down }));
                }
            })
            .is_ok();
        if !sender {
            return Keys { dispatch: None };
        }

        let dispatch: &'static Dispatch = Box::leak(Box::new(Dispatch::new(tx)));
        Keys { dispatch: watch(dispatch).then_some(dispatch) }
    }

    /// Смотрим ли мы за клавиатурой сами. Если нет — сочетания придётся
    /// регистрировать у системы, забирая клавишу у всех остальных.
    pub fn watching(&self) -> bool {
        self.dispatch.is_some()
    }

    /// Новый список сочетаний. `false` — слежения нет, и список некому отдать.
    pub fn set(&self, list: Vec<(String, String)>) -> bool {
        let Some(dispatch) = self.dispatch else { return false };
        // Хук мыши — самый дорогой из двух: система будит нас на каждое её
        // движение, а это до тысячи событий в секунду при обычной игровой мыши.
        // Кнопки при этом назначают редко, поэтому держим его ровно тогда,
        // когда назначили, и снимаем, как только перестали.
        want_mouse(list.iter().any(|(_, combo)| combo.contains("Mouse")));
        dispatch.set(list);
        true
    }
}

// ---------------------------------------------------------------- Windows

/// Общее на весь процесс: диспетчер, до которого дотягивается обработчик хука,
/// и поток, в котором эти хуки живут. Обработчик системного хука — обычная
/// функция без всякого контекста, и другого способа передать в неё что-либо нет.
#[cfg(target_os = "windows")]
static SHARED: std::sync::OnceLock<&'static Dispatch> = std::sync::OnceLock::new();
#[cfg(target_os = "windows")]
static HOOK_THREAD: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

/// Нужен ли нам сейчас хук мыши. Ставит и снимает его сам поток хуков: хук
/// принадлежит потоку, который его завёл, и трогать его со стороны — значит
/// зависеть от того, чего система не обещала.
#[cfg(target_os = "windows")]
fn want_mouse(on: bool) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_APP};

    let Some(thread) = HOOK_THREAD.get() else { return };
    let _ = unsafe { PostThreadMessageW(*thread, WM_APP, WPARAM(on as usize), LPARAM(0)) };
}

#[cfg(not(target_os = "windows"))]
fn want_mouse(_on: bool) {}

/// Хук на всю систему — единственный способ увидеть клавишу, не забирая её.
///
/// Хук ставится в своём потоке, и поток этот обязан разбирать очередь
/// сообщений: без неё система хук не зовёт вовсе. Возвращаем не «поток
/// запустился», а «хук встал»: поставить его может и не выйти, и знать об этом
/// нужно здесь, а не при первом нажатии.
#[cfg(target_os = "windows")]
fn watch(dispatch: &'static Dispatch) -> bool {
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, HHOOK,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN,
        WM_XBUTTONUP, XBUTTON1,
    };

    if SHARED.set(dispatch).is_err() {
        return false;
    }

    /// Какие модификаторы зажаты прямо сейчас. Спрашиваем систему, а не копим
    /// сами: свои подсчёты разъезжаются с ней на первом же переключении окна,
    /// где клавишу отпустили мимо нас.
    fn mods_now() -> u8 {
        let held = |vk: VIRTUAL_KEY| unsafe { GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000 != 0 };
        let mut mods = 0;
        if held(VK_CONTROL) {
            mods |= CTRL;
        }
        if held(VK_MENU) {
            mods |= ALT;
        }
        if held(VK_SHIFT) {
            mods |= SHIFT;
        }
        if held(VK_LWIN) || held(VK_RWIN) {
            mods |= META;
        }
        mods
    }

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let kind = wparam.0 as u32;
            let down = kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN;
            let up = kind == WM_KEYUP || kind == WM_SYSKEYUP;
            // Синтезированное нами же — мимо: это чужая рука, управляющая
            // столом хозяина, и его собственные выключатели ей не принадлежат.
            let injected = event.flags.0 & LLKHF_INJECTED.0 != 0;

            if (down || up) && !injected {
                if let (Some(dispatch), Some(name)) = (SHARED.get(), codes::code_of(event.vkCode)) {
                    dispatch.key(name, mods_now(), down);
                }
            }
        }
        // Что бы ни случилось выше, нажатие идёт дальше своим ходом — в этом и
        // весь смысл: клавиша остаётся клавишей для всей остальной системы.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// То же самое для мыши, вторым хуком.
    ///
    /// Боковая кнопка — самый удобный выключатель микрофона в игре: до неё
    /// дотягиваются, не снимая руки с мыши. Раньше кнопки мыши ловились только
    /// в окне приложения, то есть везде, кроме игры, ради которой их и
    /// назначали: система их не отдаёт никому и никогда. Смотреть за ними она,
    /// однако, позволяет — тем же способом, что и за клавиатурой.
    ///
    /// Движение и колесо сюда не попадают: сочетанием они не бывают, а звать
    /// диспетчер на каждое движение мыши — это тысячи вызовов в минуту впустую.
    unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let kind = wparam.0 as u32;
            // У боковых кнопок общее сообщение на двоих, а какая именно нажата
            // — в старшей половине `mouseData`.
            let side = (event.mouseData >> 16) as u16;
            let button = match kind {
                WM_LBUTTONDOWN | WM_LBUTTONUP => Some(0),
                WM_MBUTTONDOWN | WM_MBUTTONUP => Some(1),
                WM_RBUTTONDOWN | WM_RBUTTONUP => Some(2),
                WM_XBUTTONDOWN | WM_XBUTTONUP => Some(if side == XBUTTON1 { 3 } else { 4 }),
                _ => None,
            };
            let down =
                matches!(kind, WM_LBUTTONDOWN | WM_MBUTTONDOWN | WM_RBUTTONDOWN | WM_XBUTTONDOWN);
            let injected = event.flags & LLMHF_INJECTED != 0;

            if !injected {
                if let (Some(dispatch), Some(name)) = (SHARED.get(), button.and_then(mouse_name)) {
                    dispatch.key(name, mods_now(), down);
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    let (ready, done) = mpsc::channel();
    let started = std::thread::Builder::new()
        .name("keys".into())
        .spawn(move || {
            let installed = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) };
            // Свой номер — чтобы было куда прислать просьбу про мышь. Ставим до
            // ответа наверх: к первому же списку сочетаний он должен быть на
            // месте, иначе просьба уйдёт в никуда.
            let _ = HOOK_THREAD.set(unsafe { GetCurrentThreadId() });
            let _ = ready.send(installed.is_ok());
            if installed.is_err() {
                return;
            }

            // Очередь сообщений нужна прежде всего самим хукам: без неё система
            // их не зовёт. Заодно по ней приходит и единственная наша просьба —
            // завести хук мыши или убрать его.
            let mut mouse_hook: Option<HHOOK> = None;
            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
                if msg.message != WM_APP {
                    continue;
                }
                match (msg.wParam.0 != 0, mouse_hook) {
                    (true, None) => {
                        mouse_hook =
                            unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), None, 0) }.ok();
                        if mouse_hook.is_none() {
                            tracing::warn!("кнопки мыши не отслеживаются: система не дала хук");
                        }
                    }
                    (false, Some(hook)) => {
                        let _ = unsafe { UnhookWindowsHookEx(hook) };
                        mouse_hook = None;
                    }
                    _ => {}
                }
            }
        })
        .is_ok();

    started && done.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
}

// ---------------------------------------------------------------- macOS

/// То же самое на macOS: подсматриваем за событиями, ничего не меняя.
///
/// `ListenOnly` — это не оговорка, а заявление системе: этот наблюдатель не
/// умеет ни менять события, ни задерживать их, и она обращается с ним
/// соответственно. Разрешение всё равно нужно — «Мониторинг ввода» в настройках
/// безопасности; без него наблюдатель просто не создастся, и мы честно скажем
/// «нет», а сочетания уйдут на запасной путь.
#[cfg(target_os = "macos")]
fn watch(dispatch: &'static Dispatch) -> bool {
    use core_foundation::runloop::CFRunLoop;
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult, EventField,
    };

    fn mods_of(flags: CGEventFlags) -> u8 {
        let mut mods = 0;
        if flags.contains(CGEventFlags::CGEventFlagControl) {
            mods |= CTRL;
        }
        if flags.contains(CGEventFlags::CGEventFlagAlternate) {
            mods |= ALT;
        }
        if flags.contains(CGEventFlags::CGEventFlagShift) {
            mods |= SHIFT;
        }
        if flags.contains(CGEventFlags::CGEventFlagCommand) {
            mods |= META;
        }
        mods
    }

    /// Кнопки у macOS в своём порядке: за левой идёт правая, а средняя третья.
    /// Наш формат повторяет браузерный, где средняя вторая, — переставляем.
    fn mouse_of(button: i64) -> Option<&'static str> {
        let index = match button {
            1 => 2,
            2 => 1,
            other => usize::try_from(other).ok()?,
        };
        mouse_name(index)
    }

    let (ready, done) = mpsc::channel();
    let failed = ready.clone();
    let started = std::thread::Builder::new()
        .name("keys".into())
        .spawn(move || {
            let tap = CGEventTap::with_enabled(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![
                    CGEventType::KeyDown,
                    CGEventType::KeyUp,
                    // Движение и колесо не берём: сочетанием они не бывают, а
                    // будить диспетчер на каждое движение мыши — тысячи вызовов
                    // в минуту впустую.
                    CGEventType::LeftMouseDown,
                    CGEventType::LeftMouseUp,
                    CGEventType::RightMouseDown,
                    CGEventType::RightMouseUp,
                    CGEventType::OtherMouseDown,
                    CGEventType::OtherMouseUp,
                ],
                move |_proxy, kind, event| {
                    let from_us = event
                        .get_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID)
                        == i64::from(std::process::id());
                    if !from_us {
                        let (name, down) = match kind {
                            CGEventType::KeyDown | CGEventType::KeyUp => {
                                let number = event
                                    .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                                (
                                    codes::code_of(number as u32),
                                    matches!(kind, CGEventType::KeyDown),
                                )
                            }
                            _ => {
                                let button = event
                                    .get_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER);
                                let pressed = matches!(
                                    kind,
                                    CGEventType::LeftMouseDown
                                        | CGEventType::RightMouseDown
                                        | CGEventType::OtherMouseDown
                                );
                                (mouse_of(button), pressed)
                            }
                        };
                        if let Some(name) = name {
                            dispatch.key(name, mods_of(event.get_flags()), down);
                        }
                    }
                    // Событие идёт дальше нетронутым — всегда и без условий.
                    CallbackResult::Keep
                },
                || {
                    let _ = ready.send(true);
                    // Отсюда мы уже не выходим: цикл событий и есть слежение.
                    CFRunLoop::run_current();
                },
            );
            if tap.is_err() {
                let _ = failed.send(false);
            }
        })
        .is_ok();

    started && done.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
}

// ---------------------------------------------------------------- остальные

/// На Linux смотреть за клавиатурой нечем: X11 и Wayland отдают чужой ввод
/// только через устройства ядра, а туда обычное приложение не пускают. Там
/// остаётся прежний путь — регистрация у системы с захватом клавиши.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn watch(_dispatch: &'static Dispatch) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сочетание разбирается на модификаторы и место клавиши.
    #[test]
    fn combos_parse() {
        let combo = parse("Ctrl+Shift+KeyM").unwrap();
        assert_eq!(combo.mods, CTRL | SHIFT);
        assert_eq!(combo.code, "KeyM");

        let bare = parse("F9").unwrap();
        assert_eq!(bare.mods, 0);
        assert_eq!(bare.code, "F9");
    }

    /// Одни модификаторы сочетанием не бывают: клавиши в них нет.
    #[test]
    fn modifiers_alone_are_not_a_combo() {
        assert!(parse("Ctrl+Shift").is_none());
        assert!(parse("").is_none());
    }

    /// Нажатие срабатывает один раз, автоповтор не в счёт, а отпускание
    /// находится по самой клавише — даже если модификатор уже отпустили.
    #[test]
    fn a_hold_starts_once_and_ends_with_the_key() {
        let (tx, rx) = mpsc::channel();
        let dispatch = Dispatch::new(tx);
        dispatch.set(vec![("push-mute".into(), "Ctrl+KeyM".into())]);

        dispatch.key("KeyM", CTRL, true);
        dispatch.key("KeyM", CTRL, true); // автоповтор
        dispatch.key("KeyM", 0, false); // Ctrl отпустили раньше клавиши

        assert_eq!(rx.try_recv().unwrap(), ("push-mute".to_string(), true));
        assert_eq!(rx.try_recv().unwrap(), ("push-mute".to_string(), false));
        assert!(rx.try_recv().is_err());
    }

    /// Кнопка мыши — такое же сочетание, как клавиша, и держится так же.
    #[test]
    fn a_mouse_button_is_a_combo_like_any_other() {
        let (tx, rx) = mpsc::channel();
        let dispatch = Dispatch::new(tx);
        dispatch
            .set(vec![("mic".into(), "Mouse3".into()), ("push-mute".into(), "Ctrl+Mouse4".into())]);

        dispatch.key("Mouse3", 0, true);
        assert_eq!(rx.try_recv().unwrap(), ("mic".to_string(), true));

        dispatch.key("Mouse4", CTRL, true);
        dispatch.key("Mouse4", 0, false); // Ctrl отпустили раньше кнопки
        assert_eq!(rx.try_recv().unwrap(), ("push-mute".to_string(), true));
        assert_eq!(rx.try_recv().unwrap(), ("push-mute".to_string(), false));

        // Та же кнопка без модификатора — чужое сочетание.
        dispatch.key("Mouse4", 0, true);
        assert!(rx.try_recv().is_err());
    }

    /// Чужая клавиша и чужие модификаторы не срабатывают.
    #[test]
    fn only_the_assigned_combo_fires() {
        let (tx, rx) = mpsc::channel();
        let dispatch = Dispatch::new(tx);
        dispatch.set(vec![("mic".into(), "Ctrl+KeyM".into())]);

        dispatch.key("KeyM", 0, true); // без модификатора
        dispatch.key("KeyN", CTRL, true); // не та клавиша
        dispatch.key("KeyM", CTRL | SHIFT, true); // лишний модификатор
        assert!(rx.try_recv().is_err());
    }

    /// Сменили назначения, пока клавишу держали, — действие надо отпустить за
    /// человека: отпускать его прежней клавишей уже некому.
    #[test]
    fn changing_the_list_releases_what_was_held() {
        let (tx, rx) = mpsc::channel();
        let dispatch = Dispatch::new(tx);
        dispatch.set(vec![("push-mute".into(), "F9".into())]);

        dispatch.key("F9", 0, true);
        assert_eq!(rx.try_recv().unwrap(), ("push-mute".to_string(), true));

        dispatch.set(vec![("push-mute".into(), "F10".into())]);
        assert_eq!(rx.try_recv().unwrap(), ("push-mute".to_string(), false));
    }
}
