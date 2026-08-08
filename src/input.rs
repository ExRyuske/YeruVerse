//! Приём чужого ввода: мышь и клавиатура зрителя на этом компьютере.
//!
//! Это **простой путь**, для которого ничего не надо ставить: зритель сидит в
//! браузере, видит демонстрацию экрана и тыкает в неё. Ни Moonlight, ни
//! Sunshine, ни драйверов — но и ни игр: событий здесь ровно столько, сколько
//! нужно, чтобы нажать кнопку в чужом окне и напечатать строку.
//!
//! Для игр есть Sunshine с Moonlight — они работают на уровне системы, с
//! захватом полноэкранного режима и виртуальным геймпадом. Гнаться за ними
//! браузерными средствами бессмысленно, и здесь этого никто не делает.
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
    tx: Mutex<Sender<Cmd>>,
}

impl Input {
    /// Создаёт состояние и поднимает поток ввода.
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let allowed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&allowed);
        std::thread::Builder::new()
            .name("input".into())
            .spawn(move || worker(rx, flag))
            .expect("поток ввода");
        Self { allowed, tx: Mutex::new(tx) }
    }

    fn sender(&self) -> Sender<Cmd> {
        self.tx.lock().unwrap().clone()
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        if !self.allowed.load(Ordering::SeqCst) {
            return Err("управление не разрешено".into());
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
fn worker(rx: Receiver<Cmd>, _allowed: Arc<AtomicBool>) {
    while let Ok(cmd) = rx.recv() {
        if let Cmd::Probe(reply) = cmd {
            let _ = reply.send(Err("управление вводом недоступно на этой платформе".into()));
        }
    }
}

#[cfg(desktop)]
fn worker(rx: Receiver<Cmd>, allowed: Arc<AtomicBool>) {
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
        let always = matches!(cmd, Cmd::Probe(_) | Cmd::ReleaseAll);
        if !always && !allowed.load(Ordering::SeqCst) {
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

#[cfg(desktop)]
fn press(e: &mut Enigo, code: Option<&str>, text: Option<&str>, down: bool) -> Result<(), String> {
    let single = |t: &str| t.chars().count() == 1;
    let key = code
        .and_then(key_of)
        .or_else(|| text.filter(|t| single(t)).and_then(|t| t.chars().next()).map(Key::Unicode));
    match key {
        Some(k) => e.key(k, dir(down)).map_err(|err| err.to_string()),
        None => Ok(()),
    }
}

/// Физическое положение клавиши → клавиша системы. Буквы и цифры отдаём
/// символом латинской раскладки: положение важнее того, что нарисовано на
/// клавише, иначе на кириллице ничего бы не работало.
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
        _ => return char_of(code).map(Key::Unicode),
    };
    Some(named)
}

/// Символ латинской раскладки для клавиши основного блока.
#[cfg(desktop)]
fn char_of(code: &str) -> Option<char> {
    if let Some(letter) = code.strip_prefix("Key") {
        let mut it = letter.chars();
        let c = it.next()?;
        return (it.next().is_none() && c.is_ascii_alphabetic()).then(|| c.to_ascii_lowercase());
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let mut it = digit.chars();
        let c = it.next()?;
        return (it.next().is_none() && c.is_ascii_digit()).then_some(c);
    }
    Some(match code {
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
    })
}
