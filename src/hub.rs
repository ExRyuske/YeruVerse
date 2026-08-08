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

    pub fn send_to(&self, room_id: &str, peer_id: &str, msg: &Value) -> bool {
        let rooms = self.rooms.lock().unwrap();
        match rooms.get(room_id).and_then(|r| r.peers.get(peer_id)) {
            Some(p) => p.tx.send(msg.to_string()).is_ok(),
            None => false,
        }
    }

    pub fn broadcast(&self, room_id: &str, msg: &Value, except: Option<&str>) {
        let rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get(room_id) else { return };
        let text = msg.to_string();
        for p in room.peers.values() {
            if Some(p.info.id.as_str()) == except {
                continue;
            }
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
