//! Клавиша и её номер в системе — в обе стороны.
//!
//! Страница называет клавиши так же, как их называет браузер: `KeyT`, `Digit1`,
//! `Minus` — это место на клавиатуре, а не буква на ней. Системе же нужен
//! номер, и у каждой свой: виртуальные коды Windows и `kVK_*` у macOS.
//!
//! Перевод нужен в обе стороны и в двух разных местах. Инжектор чужого ввода
//! (`input.rs`) идёт от названия к номеру: пришло `KeyT` — нажать эту клавишу.
//! Слежение за клавиатурой (`keys.rs`) идёт обратно: система сообщила номер —
//! какая это клавиша по-нашему. Таблица при этом одна: разъехавшись, они дали
//! бы сочетание, которое срабатывает не на ту клавишу, которую назначили.

/// Клавиши основного блока: буквы, цифры и знаки препинания.
///
/// Пар здесь ровно столько, сколько нужно: остальное на клавиатуре — это
/// именованные клавиши из `NAMED`, а всё, чего нет ни там, ни там, сочетанием
/// быть не может и назначено не будет.
#[cfg(target_os = "windows")]
const MAIN: &[(&str, u32)] = &[
    // У букв и цифр виртуальные коды Windows совпадают с их ASCII — эту часть
    // таблицы считает `letters_and_digits`, здесь только всё остальное.
    ("Semicolon", 0xBA),    // VK_OEM_1
    ("Equal", 0xBB),        // VK_OEM_PLUS
    ("Comma", 0xBC),        // VK_OEM_COMMA
    ("Minus", 0xBD),        // VK_OEM_MINUS
    ("Period", 0xBE),       // VK_OEM_PERIOD
    ("Slash", 0xBF),        // VK_OEM_2
    ("Backquote", 0xC0),    // VK_OEM_3
    ("BracketLeft", 0xDB),  // VK_OEM_4
    ("Backslash", 0xDC),    // VK_OEM_5
    ("BracketRight", 0xDD), // VK_OEM_6
    ("Quote", 0xDE),        // VK_OEM_7
];

/// То же для macOS: `kVK_ANSI_*` из HIToolbox. Порядок здесь исторический — он
/// повторяет разводку первых клавиатур Apple, а не алфавит.
#[cfg(target_os = "macos")]
const MAIN: &[(&str, u32)] = &[
    ("KeyA", 0x00),
    ("KeyS", 0x01),
    ("KeyD", 0x02),
    ("KeyF", 0x03),
    ("KeyH", 0x04),
    ("KeyG", 0x05),
    ("KeyZ", 0x06),
    ("KeyX", 0x07),
    ("KeyC", 0x08),
    ("KeyV", 0x09),
    ("KeyB", 0x0B),
    ("KeyQ", 0x0C),
    ("KeyW", 0x0D),
    ("KeyE", 0x0E),
    ("KeyR", 0x0F),
    ("KeyY", 0x10),
    ("KeyT", 0x11),
    ("Digit1", 0x12),
    ("Digit2", 0x13),
    ("Digit3", 0x14),
    ("Digit4", 0x15),
    ("Digit6", 0x16),
    ("Digit5", 0x17),
    ("Equal", 0x18),
    ("Digit9", 0x19),
    ("Digit7", 0x1A),
    ("Minus", 0x1B),
    ("Digit8", 0x1C),
    ("Digit0", 0x1D),
    ("BracketRight", 0x1E),
    ("KeyO", 0x1F),
    ("KeyU", 0x20),
    ("BracketLeft", 0x21),
    ("KeyI", 0x22),
    ("KeyP", 0x23),
    ("KeyL", 0x25),
    ("KeyJ", 0x26),
    ("Quote", 0x27),
    ("KeyK", 0x28),
    ("Semicolon", 0x29),
    ("Backslash", 0x2A),
    ("Comma", 0x2B),
    ("Slash", 0x2C),
    ("KeyN", 0x2D),
    ("KeyM", 0x2E),
    ("Period", 0x2F),
    ("Backquote", 0x32),
];

/// Клавиши со своим именем: те, что ничего не печатают. Инжектору они не нужны
/// — там их знает сама enigo, — а слежению нужны: сочетание на F9 или на Pause
/// должно узнаваться так же, как на букве.
#[cfg(target_os = "windows")]
const NAMED: &[(&str, u32)] = &[
    ("Escape", 0x1B),
    ("Enter", 0x0D),
    ("Tab", 0x09),
    ("Space", 0x20),
    ("Backspace", 0x08),
    ("Delete", 0x2E),
    ("Insert", 0x2D),
    ("Home", 0x24),
    ("End", 0x23),
    ("PageUp", 0x21),
    ("PageDown", 0x22),
    ("ArrowLeft", 0x25),
    ("ArrowUp", 0x26),
    ("ArrowRight", 0x27),
    ("ArrowDown", 0x28),
    ("CapsLock", 0x14),
    ("Pause", 0x13),
    ("ScrollLock", 0x91),
];

#[cfg(target_os = "macos")]
const NAMED: &[(&str, u32)] = &[
    ("Escape", 0x35),
    ("Enter", 0x24),
    ("Tab", 0x30),
    ("Space", 0x31),
    ("Backspace", 0x33),
    ("Delete", 0x75),
    ("Home", 0x73),
    ("End", 0x77),
    ("PageUp", 0x74),
    ("PageDown", 0x79),
    ("ArrowLeft", 0x7B),
    ("ArrowRight", 0x7C),
    ("ArrowDown", 0x7D),
    ("ArrowUp", 0x7E),
    ("CapsLock", 0x39),
    ("NumpadEnter", 0x4C),
];

/// Функциональный ряд. На Windows он идёт подряд от F1, на macOS — вразнобой,
/// поэтому там это просто список.
#[cfg(target_os = "macos")]
const FUNCTION: &[(&str, u32)] = &[
    ("F1", 0x7A),
    ("F2", 0x78),
    ("F3", 0x63),
    ("F4", 0x76),
    ("F5", 0x60),
    ("F6", 0x61),
    ("F7", 0x62),
    ("F8", 0x64),
    ("F9", 0x65),
    ("F10", 0x6D),
    ("F11", 0x67),
    ("F12", 0x6F),
    ("F13", 0x69),
    ("F14", 0x6B),
    ("F15", 0x71),
    ("F16", 0x6A),
    ("F17", 0x40),
    ("F18", 0x4F),
    ("F19", 0x50),
    ("F20", 0x5A),
];

/// Буква или цифра по коду Windows: `KeyT` — это VK 'T', `Digit1` — VK '1'.
#[cfg(target_os = "windows")]
fn letters_and_digits(code: &str) -> Option<u32> {
    let one = |s: &str| {
        let mut it = s.chars();
        let c = it.next()?;
        it.next().is_none().then_some(c)
    };
    if let Some(letter) = code.strip_prefix("Key") {
        return one(letter)
            .filter(char::is_ascii_alphabetic)
            .map(|c| c.to_ascii_uppercase() as u32);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return one(digit).filter(char::is_ascii_digit).map(|c| c as u32);
    }
    None
}

/// Номер клавиши в системе по её месту на клавиатуре. `None` — такого места мы
/// не знаем, и трогать его не будем.
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn number_of(code: &str) -> Option<u32> {
    #[cfg(target_os = "windows")]
    if let Some(vk) = letters_and_digits(code) {
        return Some(vk);
    }
    MAIN.iter().find(|(name, _)| *name == code).map(|(_, number)| *number)
}

/// Обратный путь: система назвала номер — как эта клавиша зовётся у нас.
///
/// Функциональный ряд и именованные клавиши сюда входят, а вот модификаторы
/// нет: они приходят отдельным набором и сочетанием сами по себе не бывают.
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn code_of(number: u32) -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        // Буквы и цифры: обратный ход той же формулы.
        if (0x41..=0x5A).contains(&number) {
            return Some(LETTERS[(number - 0x41) as usize]);
        }
        if (0x30..=0x39).contains(&number) {
            return Some(DIGITS[(number - 0x30) as usize]);
        }
        // Функциональный ряд идёт подряд от VK_F1.
        if (0x70..=0x87).contains(&number) {
            return Some(FUNCTION_NAMES[(number - 0x70) as usize]);
        }
    }
    #[cfg(target_os = "macos")]
    if let Some((name, _)) = FUNCTION.iter().find(|(_, n)| *n == number) {
        return Some(name);
    }

    let mut known = MAIN.iter().chain(NAMED.iter());
    known.find(|(_, n)| *n == number).map(|(name, _)| *name)
}

/// Имена, которые считаются формулой, — списком: собирать строку на каждое
/// нажатие клавиши значило бы выделять память в обработчике системного хука,
/// а он обязан возвращаться немедленно.
#[cfg(target_os = "windows")]
const LETTERS: [&str; 26] = [
    "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL",
    "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX",
    "KeyY", "KeyZ",
];

#[cfg(target_os = "windows")]
const DIGITS: [&str; 10] = [
    "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
    "Digit9",
];

#[cfg(target_os = "windows")]
const FUNCTION_NAMES: [&str; 24] = [
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15",
    "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
];

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::*;

    /// Перевод в обе стороны должен сходиться сам с собой: иначе сочетание
    /// назначается на одну клавишу, а срабатывает на другой.
    #[test]
    fn the_two_directions_agree() {
        for (name, _) in MAIN {
            let number = number_of(name).expect("место без номера");
            assert_eq!(code_of(number), Some(*name), "{name}");
        }
    }

    /// Буквы и цифры считаются формулой — она тоже должна сходиться.
    #[test]
    fn letters_and_digits_survive_the_round_trip() {
        for name in ["KeyA", "KeyM", "KeyZ", "Digit0", "Digit9"] {
            let number = number_of(name).expect("буква без номера");
            assert_eq!(code_of(number), Some(name));
        }
    }

    /// Клавиша, которой мы не знаем, не должна превращаться в чужую.
    #[test]
    fn the_unknown_stays_unknown() {
        assert_eq!(number_of("Ключ"), None);
        assert_eq!(number_of("Key"), None);
        assert_eq!(number_of("KeyАБ"), None);
    }
}
