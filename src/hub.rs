use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::{PeerInfo, Presence};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

pub struct Peer {
    pub info: PeerInfo,
    pub tx: UnboundedSender<String>,
}

/// Комната — это только список участников. Ничего общего, что нужно было бы
/// хранить и синхронизировать, здесь больше нет: трансляции живые и идут между
/// зрителями напрямую.
#[derive(Default)]
pub struct Room {
    pub peers: HashMap<String, Peer>,
}

#[derive(Default)]
pub struct Hub {
    rooms: Mutex<HashMap<String, Room>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Регистрирует пира и рассылает уведомления. Возвращает `welcome` для новичка.
    ///
    /// Комната опознаётся своим кодом и ничем больше: код случаен и известен
    /// только тем, кому отправили ссылку, — отдельный пароль поверх него был бы
    /// вторым секретом ровно с тем же смыслом.
    pub fn join(&self, room_id: &str, peer: Peer) -> Value {
        let mut rooms = self.rooms.lock().unwrap();
        let room = rooms.entry(room_id.to_string()).or_default();

        let info = peer.info.clone();
        let welcome = json!({
            "t": "welcome",
            "you": info,
            "room": room_id,
            "peers": room.peers.values().map(|p| p.info.clone()).collect::<Vec<_>>(),
            "srv": now_ms(),
        });

        let joined = json!({ "t": "peer_join", "peer": info });
        for p in room.peers.values() {
            let _ = p.tx.send(joined.to_string());
        }

        room.peers.insert(info.id.clone(), Peer { info, ..peer });
        welcome
    }

    pub fn leave(&self, room_id: &str, peer_id: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get_mut(room_id) else { return };
        room.peers.remove(peer_id);

        if room.peers.is_empty() {
            rooms.remove(room_id);
            return;
        }

        let left = json!({ "t": "peer_leave", "id": peer_id });
        for p in room.peers.values() {
            let _ = p.tx.send(left.to_string());
        }
    }

    /// Меняет ник и/или цвет ника. Возвращает карточку участника для рассылки.
    pub fn set_profile(
        &self,
        room_id: &str,
        peer_id: &str,
        name: Option<String>,
        color: Option<String>,
    ) -> Option<PeerInfo> {
        let mut rooms = self.rooms.lock().unwrap();
        let p = rooms.get_mut(room_id)?.peers.get_mut(peer_id)?;
        if let Some(n) = name {
            if !n.is_empty() {
                p.info.name = n;
            }
        }
        if let Some(c) = color {
            p.info.color = c;
        }
        Some(p.info.clone())
    }

    /// Обновляет присутствие. Меняются только присланные поля.
    pub fn set_presence(&self, room_id: &str, peer_id: &str, p: Presence) -> Option<PeerInfo> {
        let mut rooms = self.rooms.lock().unwrap();
        let peer = rooms.get_mut(room_id)?.peers.get_mut(peer_id)?;
        let info = &mut peer.info;

        if let Some(v) = p.voice {
            info.voice = v;
        }
        if let Some(m) = p.muted {
            info.muted = m;
        }
        if let Some(s) = p.screen {
            info.screen = s;
        }
        if let Some(c) = p.camera {
            info.camera = c;
        }
        if let Some(d) = p.deaf {
            info.deaf = d;
        }
        Some(info.clone())
    }

    /// Одному участнику. Если его уже нет — сообщение просто пропадает: это
    /// нормальный исход, а не ошибка, отвечать на неё всё равно нечем.
    pub fn send_to(&self, room_id: &str, peer_id: &str, msg: &Value) {
        let rooms = self.rooms.lock().unwrap();
        if let Some(p) = rooms.get(room_id).and_then(|r| r.peers.get(peer_id)) {
            let _ = p.tx.send(msg.to_string());
        }
    }

    /// Всем в комнате, включая отправителя: чат и присутствие возвращаются и
    /// ему тоже — так у всех один и тот же список и один и тот же порядок строк.
    pub fn broadcast(&self, room_id: &str, msg: &Value) {
        let rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get(room_id) else { return };
        let text = msg.to_string();
        for p in room.peers.values() {
            let _ = p.tx.send(text.clone());
        }
    }

    pub fn stats(&self) -> Value {
        let rooms = self.rooms.lock().unwrap();
        json!({
            "rooms": rooms.len(),
            "peers": rooms.values().map(|r| r.peers.len()).sum::<usize>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::{self, UnboundedReceiver};

    fn peer(id: &str, name: &str) -> (Peer, UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let info = PeerInfo {
            id: id.to_string(),
            name: name.to_string(),
            color: "#5b8cff".into(),
            voice: false,
            muted: false,
            screen: false,
            camera: false,
            deaf: false,
        };
        (Peer { info, tx }, rx)
    }

    /// Новичок узнаёт всех, кто уже сидит, а они — только про него.
    #[test]
    fn join_tells_both_sides() {
        let hub = Hub::new();
        let (first, mut first_rx) = peer("a", "Аня");
        let (second, _second_rx) = peer("b", "Боря");

        let welcome = hub.join("room", first);
        assert_eq!(welcome["peers"].as_array().unwrap().len(), 0);

        let welcome = hub.join("room", second);
        assert_eq!(welcome["peers"].as_array().unwrap().len(), 1);
        assert_eq!(welcome["you"]["id"], "b");

        let seen: Value = serde_json::from_str(&first_rx.try_recv().unwrap()).unwrap();
        assert_eq!(seen["t"], "peer_join");
        assert_eq!(seen["peer"]["id"], "b");
    }

    /// Комната существует, пока в ней кто-то есть, и исчезает с последним.
    #[test]
    fn room_dies_with_last_peer() {
        let hub = Hub::new();
        let (a, _a_rx) = peer("a", "Аня");
        let (b, mut b_rx) = peer("b", "Боря");
        hub.join("room", a);
        hub.join("room", b);
        let _ = b_rx.try_recv();

        hub.leave("room", "a");
        assert_eq!(hub.stats()["peers"], 1);
        let left: Value = serde_json::from_str(&b_rx.try_recv().unwrap()).unwrap();
        assert_eq!(left["t"], "peer_leave");
        assert_eq!(left["id"], "a");

        hub.leave("room", "b");
        assert_eq!(hub.stats()["rooms"], 0);
    }

    /// Присланы только изменившиеся поля — остальные остаются как были.
    #[test]
    fn presence_updates_only_given_fields() {
        let hub = Hub::new();
        let (a, _rx) = peer("a", "Аня");
        hub.join("room", a);

        let info = hub
            .set_presence("room", "a", Presence { voice: Some(true), ..Presence::default() })
            .unwrap();
        assert!(info.voice && !info.muted);

        let info = hub
            .set_presence("room", "a", Presence { muted: Some(true), ..Presence::default() })
            .unwrap();
        assert!(info.voice && info.muted);
    }

    /// Пустое имя не должно стирать прежнее: клиент шлёт профиль целиком.
    #[test]
    fn empty_name_keeps_the_old_one() {
        let hub = Hub::new();
        let (a, _rx) = peer("a", "Аня");
        hub.join("room", a);

        let info = hub.set_profile("room", "a", Some(String::new()), None).unwrap();
        assert_eq!(info.name, "Аня");

        let info = hub.set_profile("room", "a", Some("Анна".into()), None).unwrap();
        assert_eq!(info.name, "Анна");
    }

    /// Ни рассылка, ни адресная отправка не должны падать на пустом месте.
    #[test]
    fn missing_room_or_peer_is_silent() {
        let hub = Hub::new();
        hub.broadcast("нет такой", &json!({ "t": "chat" }));
        hub.send_to("нет такой", "и такого", &json!({ "t": "signal" }));
        assert!(hub.set_presence("нет такой", "a", Presence::default()).is_none());
        assert_eq!(hub.stats()["rooms"], 0);
    }
}
