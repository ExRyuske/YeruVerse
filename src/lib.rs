//! Сервер комнат YeruVerse: список участников, их присутствие и транзит
//! WebRTC-сигналинга. Ни видео, ни голос, ни файлы через него не идут.

pub mod cache;
pub mod hub;
pub mod protocol;
pub mod server;
pub mod turn;
pub mod updates;

pub use server::{start, Config, Handle};
