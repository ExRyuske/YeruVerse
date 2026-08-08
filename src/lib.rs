//! Сервер комнат YeruVerse: комната, синхронизация плеера и транзит
//! WebRTC-сигналинга. Видеотрафик через него не идёт.

pub mod hub;
pub mod protocol;
pub mod server;
pub mod turn;

pub use server::{start, Config, Handle};
