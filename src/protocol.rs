use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Сообщения клиент -> сервер.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Первое сообщение в сокете: вход в комнату.
    Join {
        room: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        color: Option<String>,
    },
    /// Смена ника или его цвета.
    Profile {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        color: Option<String>,
    },
    /// Транзит WebRTC-сигналинга конкретному пиру.
    Signal {
        to: String,
        data: Value,
    },
    /// Замер смещения часов относительно сервера.
    Ping {
        at: f64,
    },
    Chat {
        text: String,
    },
    /// Вложение в чат: описание файла, который раздаётся роем. Байты идут
    /// между зрителями, сервер передаёт только карточку.
    File {
        meta: Value,
    },
    /// Состояние микрофона, трансляций и звука — чтобы список в комнате был
    /// честным даже у тех, с кем ещё не поднялось WebRTC-соединение.
    /// Присланы только изменившиеся поля, остальные остаются как были.
    Presence(Presence),
}

/// Изменения присутствия. Все поля необязательны: клиент присылает только то,
/// что поменялось, остальное на сервере остаётся прежним.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
pub struct Presence {
    #[serde(default)]
    pub voice: Option<bool>,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub screen: Option<bool>,
    #[serde(default)]
    pub camera: Option<bool>,
    #[serde(default)]
    pub deaf: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    /// Цвет ника, `#rrggbb`.
    pub color: String,
    /// Микрофон включён.
    pub voice: bool,
    /// Микрофон включён, но заглушён самим участником.
    pub muted: bool,
    /// Транслирует экран. Трансляций может быть несколько одновременно.
    pub screen: bool,
    /// Транслирует камеру — независимо от экрана, можно оба сразу.
    pub camera: bool,
    /// Заглушил всех остальных — его не имеет смысла звать голосом.
    pub deaf: bool,
}
