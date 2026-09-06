//! Приём чужого ввода: мышь и клавиатура зрителя на этом компьютере.
//!
//! Ставить для этого ничего не надо: зритель сидит в браузере, видит
//! демонстрацию экрана и тыкает в неё. Событий здесь ровно столько, сколько
//! нужно, чтобы нажать кнопку в чужом окне и напечатать строку, — для игр
//! этого мало, и делать вид, что хватает, незачем: игровой режим ещё предстоит
//! написать здесь же, отдельным путём.
//!
//! Enigo на macOS держит `CGEventSource`, который нельзя передавать между
//! потоками, поэтому он живёт в одном выделенном потоке, а команды приходят по
//! каналу. Разрешение проверяется дважды: в интерфейсе и здесь — флаг мог
//! погаснуть, пока команда была в пути.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::State;

#[cfg(desktop)]
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

/// Команды потоку ввода.
#[cfg_attr(not(desktop), allow(dead_code))]
pub enum Cmd {
    /// Позиция в пикселях экрана.
    Move(i32, i32),
    /// Кнопка мыши раздельно: без этого не выйдет ни выделить текст, ни
    /// перетащить окно.
    Button(String, bool),
    Scroll(i32, i32),
    /// Физическое положение клавиши (`KeyW`) и символ на ней; раздельно
    /// нажатие и отпускание.
    Key(Option<String>, Option<String>, bool),
    /// Отпустить всё зажатое: зритель ушёл, потерял фокус или лишился доступа.
    ReleaseAll,
    /// Разбудить Enigo (на macOS это поднимает запрос «Универсальный доступ»)
    /// и вернуть размер основного экрана.
    Probe(Sender<Result<(i32, i32), String>>),
}

pub struct Input {
    /// Приём выключен, пока хозяин явно его не разрешил.
    allowed: Arc<AtomicBool>,
    /// Хозяин перехватил управление: гость временно замер.
    paused: Arc<AtomicBool>,
    tx: Mutex<Sender<Cmd>>,
}

impl Input {
    /// Создаёт состояние и поднимает поток ввода.
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let allowed = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let (a, p) = (Arc::clone(&allowed), Arc::clone(&paused));
        std::thread::Builder::new()
            .name("input".into())
            .spawn(move || worker(rx, a, p))
            .expect("поток ввода");
        Self { allowed, paused, tx: Mutex::new(tx) }
    }

    fn sender(&self) -> Sender<Cmd> {
        self.tx.lock().unwrap().clone()
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        if !self.allowed.load(Ordering::SeqCst) {
            return Err("управление не разрешено".into());
        }
        if self.paused.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.sender().send(cmd).map_err(|_| "поток ввода остановлен".to_string())
    }
}

/// Разрешить или запретить приём. При включении возвращает размер экрана —
/// фронтенд переводит по нему доли кадра в пиксели.
#[tauri::command]
pub async fn set_control(
    state: State<'_, Input>,
    enabled: bool,
) -> Result<Option<(i32, i32)>, String> {
    if !enabled {
        // Сначала отпускаем зажатое, потом закрываем дверь: иначе клавиша,
        // которую держал зритель, останется нажатой навсегда.
        let _ = state.sender().send(Cmd::ReleaseAll);
        state.allowed.store(false, Ordering::SeqCst);
        return Ok(None);
    }
    state.allowed.store(true, Ordering::SeqCst);
    // Пробуем сразу: лучше увидеть отказ в правах при включении, чем при первом
    // чужом клике.
    let size = probe(state.sender()).await.inspect_err(|_| {
        state.allowed.store(false, Ordering::SeqCst);
    })?;
    Ok(Some(size))
}

/// Перехватить управление у гостя и вернуть обратно.
///
/// Один флаг вместо прежней слежки за курсором: та ошибалась на каждом кадре
/// игры, где курсор двигает сама игра, и лезла в системный API не из главного
/// потока — на macOS это роняло приложение целиком. Сочетание регистрируется
/// системно, поэтому работает и из полноэкранной игры.
#[tauri::command]
pub fn input_pause(state: State<'_, Input>, paused: bool) -> Result<(), String> {
    state.paused.store(paused, Ordering::SeqCst);
    if paused {
        // Гость мог замереть с зажатой клавишей — снимаем её за него.
        let _ = state.sender().send(Cmd::ReleaseAll);
    }
    Ok(())
}

#[tauri::command]
pub fn input_move(state: State<'_, Input>, x: i32, y: i32) -> Result<(), String> {
    state.send(Cmd::Move(x, y))
}

#[tauri::command]
pub fn input_button(state: State<'_, Input>, button: String, down: bool) -> Result<(), String> {
    state.send(Cmd::Button(button, down))
}

#[tauri::command]
pub fn input_scroll(state: State<'_, Input>, dx: i32, dy: i32) -> Result<(), String> {
    state.send(Cmd::Scroll(dx, dy))
}

#[tauri::command]
pub fn input_key(
    state: State<'_, Input>,
    code: Option<String>,
    text: Option<String>,
    down: bool,
) -> Result<(), String> {
    state.send(Cmd::Key(code, text, down))
}

/// Отпустить всё зажатое. Разрешена всегда: это откат чужого ввода, а не ввод.
#[tauri::command]
pub fn input_release(state: State<'_, Input>) -> Result<(), String> {
    state.sender().send(Cmd::ReleaseAll).map_err(|_| "поток ввода остановлен".to_string())
}

async fn probe(tx: Sender<Cmd>) -> Result<(i32, i32), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, rx) = mpsc::channel();
        tx.send(Cmd::Probe(reply)).map_err(|_| "поток ввода остановлен".to_string())?;
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "поток ввода не ответил".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- поток

/// На платформах без инжекта ввода поток просто отбрасывает команды: так
/// остальной код не обрастает `cfg`, а `capabilities()` честно говорит правду.
#[cfg(not(desktop))]
fn worker(rx: Receiver<Cmd>, _allowed: Arc<AtomicBool>, _paused: Arc<AtomicBool>) {
    while let Ok(cmd) = rx.recv() {
        if let Cmd::Probe(reply) = cmd {
            let _ = reply.send(Err("управление вводом недоступно на этой платформе".into()));
        }
    }
}

#[cfg(desktop)]
fn worker(rx: Receiver<Cmd>, allowed: Arc<AtomicBool>, paused: Arc<AtomicBool>) {
    use std::collections::HashSet;

    let mut enigo: Option<Enigo> = None;
    // Что сейчас зажато чужой рукой — чтобы отпустить, когда рука пропадёт.
    let mut keys: HashSet<String> = HashSet::new();
    let mut buttons: HashSet<String> = HashSet::new();

    while let Ok(cmd) = rx.recv() {
        if enigo.is_none() {
            match Enigo::new(&Settings::default()) {
                Ok(e) => enigo = Some(e),
                Err(err) => {
                    if let Cmd::Probe(reply) = cmd {
                        let _ = reply.send(Err(format!("нет доступа к вводу: {err}")));
                    }
                    continue;
                }
            }
        }
        let e = enigo.as_mut().unwrap();

        // Probe проверяет права, ReleaseAll убирает чужие пальцы с клавиш —
        // обе разрешены всегда.
        // Флаги могли погаснуть, пока команда была в пути.
        let always = matches!(cmd, Cmd::Probe(_) | Cmd::ReleaseAll);
        if !always && (!allowed.load(Ordering::SeqCst) || paused.load(Ordering::SeqCst)) {
            continue;
        }

        let result = match cmd {
            Cmd::Probe(reply) => {
                let _ = reply.send(e.main_display().map_err(|err| err.to_string()));
                Ok(())
            }
            Cmd::Move(x, y) => e.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string()),
            Cmd::Button(name, down) => {
                if down {
                    buttons.insert(name.clone());
                } else {
                    buttons.remove(&name);
                }
                e.button(button_of(&name), dir(down)).map_err(|e| e.to_string())
            }
            Cmd::Scroll(dx, dy) => {
                let mut r = Ok(());
                if dy != 0 {
                    r = e.scroll(dy, Axis::Vertical).map_err(|e| e.to_string());
                }
                if dx != 0 && r.is_ok() {
                    r = e.scroll(dx, Axis::Horizontal).map_err(|e| e.to_string());
                }
                r
            }
            Cmd::Key(code, text, down) => {
                if let Some(c) = code.clone() {
                    if down {
                        keys.insert(c);
                    } else {
                        keys.remove(&c);
                    }
                }
                press(e, code.as_deref(), text.as_deref(), down)
            }
            Cmd::ReleaseAll => {
                for name in buttons.drain() {
                    let _ = e.button(button_of(&name), Direction::Release);
                }
                for code in keys.drain() {
                    let _ = press(e, Some(&code), None, false);
                }
                Ok(())
            }
        };

        if let Err(err) = result {
            tracing::warn!("ввод не прошёл: {err}");
        }
    }
}

#[cfg(desktop)]
fn dir(down: bool) -> Direction {
    if down {
        Direction::Press
    } else {
        Direction::Release
    }
}

#[cfg(desktop)]
fn button_of(name: &str) -> Button {
    match name {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}

/// Нажать или отпустить клавишу.
///
/// Клавиша ищется по своему месту на клавиатуре, а символ на ней — запасной
/// путь для того, чему места в таблице не нашлось. Символ система вставляет
/// текстом, а текст вставляется целиком, вместе с отпусканием: поэтому на
/// отпускании этот путь молчит, иначе буква уходила бы дважды.
#[cfg(desktop)]
fn press(e: &mut Enigo, code: Option<&str>, text: Option<&str>, down: bool) -> Result<(), String> {
    if let Some(key) = code.and_then(key_of) {
        return e.key(key, dir(down)).map_err(|err| err.to_string());
    }
    let typed =
        text.filter(|t| t.chars().count() == 1).and_then(|t| t.chars().next()).filter(|_| down);
    match typed {
        Some(c) => e.key(Key::Unicode(c), Direction::Click).map_err(|err| err.to_string()),
        None => Ok(()),
    }
}

/// Физическое положение клавиши → клавиша системы. Положение важнее того, что
/// на клавише нарисовано: на кириллице буква другая, а место то же.
#[cfg(desktop)]
fn key_of(code: &str) -> Option<Key> {
    let named = match code {
        "Escape" => Key::Escape,
        "Enter" | "NumpadEnter" => Key::Return,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Space" => Key::Space,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "CapsLock" => Key::CapsLock,
        "ShiftLeft" | "ShiftRight" => Key::Shift,
        "ControlLeft" | "ControlRight" => Key::Control,
        "AltLeft" | "AltRight" => Key::Alt,
        "MetaLeft" | "MetaRight" => Key::Meta,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => return main_block(code),
    };
    Some(named)
}

/// Клавиша основного блока — номером, каким её знает система.
///
/// Раньше отсюда уходил символ латинской раскладки: `KeyT` превращался в «t», а
/// систему просили найти клавишу, которая этот символ печатает. Пока раскладка
/// на том конце латинская, клавиша находится и всё сходится. На кириллице
/// клавиши с «t» нет, и обе системы отвечают на это по-своему, но одинаково
/// плохо.
///
/// Windows перестаёт нажимать клавишу и вставляет символ текстом — а текст она
/// вставляет целиком, не разбирая, нажатие пришло или отпускание. Буква уходила
/// дважды: вместо «тест» получалось «ттеесстт». macOS клавиши не находит и
/// берёт нулевой номер, а это «A», — и любое нажатие печатало одну и ту же
/// букву.
///
/// Поэтому раскладку не спрашиваем вовсе. Номер клавиши от языка не зависит, и
/// нажатие получается ровно тем же, каким было бы рукой на этом месте: что
/// напечатать, решит раскладка того компьютера — как и должно быть. Таблица
/// номеров общая со слежением за клавиатурой (`codes.rs`): разъехавшись, они
/// дали бы сочетание, которое срабатывает не на ту клавишу, что назначили.
#[cfg(all(desktop, any(target_os = "windows", target_os = "macos")))]
fn main_block(code: &str) -> Option<Key> {
    crate::codes::number_of(code).map(Key::Other)
}

/// Там, где номера клавиш зависят от драйвера и сервера окон, остаётся прежний
/// путь — символ латинской раскладки. Нажатие и отпускание он различает, и
/// двойных букв здесь не бывало.
#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos"))))]
fn main_block(code: &str) -> Option<Key> {
    if let Some(c) = ascii_of(code) {
        return Some(Key::Unicode(c));
    }
    let c = match code {
        "Minus" => '-',
        "Equal" => '=',
        "BracketLeft" => '[',
        "BracketRight" => ']',
        "Backslash" => '\\',
        "Semicolon" => ';',
        "Quote" => '\'',
        "Backquote" => '`',
        "Comma" => ',',
        "Period" => '.',
        "Slash" => '/',
        _ => return None,
    };
    Some(Key::Unicode(c))
}

/// Буква или цифра, нарисованная на клавише в латинской раскладке.
#[cfg(all(desktop, not(any(target_os = "windows", target_os = "macos"))))]
fn ascii_of(code: &str) -> Option<char> {
    let one = |s: &str| {
        let mut it = s.chars();
        let c = it.next()?;
        it.next().is_none().then_some(c)
    };
    if let Some(letter) = code.strip_prefix("Key") {
        return one(letter).filter(char::is_ascii_alphabetic).map(|c| c.to_ascii_lowercase());
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return one(digit).filter(char::is_ascii_digit);
    }
    None
}
