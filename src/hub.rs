use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::mpsc::Sender;
use tokio::sync::Notify;

use crate::protocol::{PeerInfo, Presence};

/// Комнат сразу. Не рабочий потолок, а щит от заведомо чужого поведения: код
/// комнаты ничем не подтверждён, и открыть тысячи сокетов с уникальным кодом
/// в каждом — цена одного клиента, а не тысячи людей. Комната — это только
/// запись в `HashMap` да один канал на участника, но и у записи есть цена,
/// когда их пробуют завести без счёта.
const MAX_ROOMS: usize = 1000;

/// Участников в одной комнате. Комната здесь — это один разговор, а не
/// стадион: у видео полный меш P2P между всеми сразу, и раньше практического
/// потолка железа кто-то упрётся в этот.
const MAX_PEERS_PER_ROOM: usize = 64;

/// Через сколько миллисекунд молчания участник считается мёртвым и
/// убирается без ожидания TCP-таймаута.
///
/// Пинг идёт раз в пять секунд (`net.js`), значит это шесть пропущенных
/// подряд — не джиттер сети, а зависший клиент или переполненный `outbox`:
/// `post()` при переполнении сам отводит `last_seen` в прошлое, чтобы попасть
/// под этот же порог на ближайшем проходе `sweep`, не заводя для этого
/// отдельного пути.
const DROP_AFTER_MS: i64 = 30_000;

/// Время сервера в миллисекундах эпохи.
///
/// Часы, отведённые раньше эпохи, — не повод падать. Этим числом помечаются
/// только сообщения чата и карточки файлов (`srv`), и сдвинутая метка не
/// стоит оборванного разговора у всех, кто в этот момент был в комнате.
/// Отказ `duration_since` несёт в себе ту же разницу, только со знаком минус,
/// — берём её, и порядок сообщений остаётся верным даже с такими часами.
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

pub struct Peer {
    pub info: PeerInfo,
    pub tx: Sender<String>,
    /// Когда от этого участника в последний раз пришло хоть что-то живое —
    /// см. `Hub::touch` и `Hub::sweep`. Атомик, а не поле за тем же `Mutex`,
    /// нарочно не нужен: обновление и так идёт под общим замком комнат вместе
    /// со всем остальным, но отдельный тип точнее говорит о своей роли —
    /// это не часть карточки участника, а служебная метка сервера.
    last_seen: AtomicI64,
    /// Будит цикл чтения сокета, когда `sweep` решает, что участника пора
    /// убрать: сам сокет об этом не знает, пока ему не скажут явно.
    kill: Arc<Notify>,
}

impl Peer {
    pub fn new(info: PeerInfo, tx: Sender<String>, kill: Arc<Notify>) -> Self {
        Peer { info, tx, last_seen: AtomicI64::new(now_ms()), kill }
    }
}

/// Отправка одному. Очередь у каждого своя и конечная (см. `OUTBOX` в
/// `server.rs`): тот, кто перестал читать сокет, копил бы её без предела, а
/// платил бы за это сервер — и не своей памятью, а чужой.
///
/// Переполнение здесь равносильно потере связи: сотня непрочитанных сообщений
/// в протоколе, где обычный обмен — это пара строк в секунду, означает, что
/// собеседника уже нет. Само сообщение в таком случае теряется — отвечать
/// нечем и некому, — но участника это больше не оставляет висеть неопределённо
/// долго: `last_seen` тут же отводится в прошлое, и ближайший `sweep` (раз в
/// несколько секунд, см. `server.rs`) уберёт его и закроет сокет, а не будет
/// ждать, пока это когда-нибудь заметит TCP.
fn post(peer: &Peer, text: String) {
    if peer.tx.try_send(text).is_err() {
        peer.last_seen.store(now_ms() - DROP_AFTER_MS, Ordering::Relaxed);
    }
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
    ///
    /// Отказ — это `MAX_ROOMS`/`MAX_PEERS_PER_ROOM`: щит от заведомо чужого
    /// поведения, а не то, во что должен упираться обычный разговор. Комнату
    /// сверх предела не заводим вовсе, а не заводим и тут же убиваем пустой —
    /// иначе она осталась бы в счётчике до первого чужого запроса на выход.
    pub fn join(&self, room_id: &str, peer: Peer) -> Result<Value, &'static str> {
        let mut rooms = self.rooms.lock().unwrap();
        if !rooms.contains_key(room_id) && rooms.len() >= MAX_ROOMS {
            return Err("сервер сейчас занят — попробуйте позже");
        }
        let room = rooms.entry(room_id.to_string()).or_default();
        if room.peers.len() >= MAX_PEERS_PER_ROOM {
            return Err("комната заполнена");
        }

        let info = peer.info.clone();
        let welcome = json!({
            "t": "welcome",
            "you": info,
            "room": room_id,
            "peers": room.peers.values().map(|p| p.info.clone()).collect::<Vec<_>>(),
            "srv": now_ms(),
        });

        let joined = json!({ "t": "peer_join", "peer": info }).to_string();
        for p in room.peers.values() {
            post(p, joined.clone());
        }

        room.peers.insert(info.id.clone(), Peer { info, ..peer });
        Ok(welcome)
    }

    /// Отмечает живой сигнал от участника — любое сообщение, разобравшееся до
    /// конца, а не только `ping`. Не нашёлся — не беда: сообщение могло прийти
    /// в зазор между тем, как `sweep` уже убрал участника, и тем, как сокет
    /// это заметил.
    pub fn touch(&self, room_id: &str, peer_id: &str) {
        let rooms = self.rooms.lock().unwrap();
        if let Some(p) = rooms.get(room_id).and_then(|r| r.peers.get(peer_id)) {
            p.last_seen.store(now_ms(), Ordering::Relaxed);
        }
    }

    /// Убирает тех, кто не подавал признаков жизни дольше `DROP_AFTER_MS`, и
    /// будит их сокеты, чтобы они закрылись сами, — обычный уход, только не
    /// дождавшийся своей стороны. Зовётся периодически из `server.rs`.
    pub fn sweep(&self) {
        let now = now_ms();
        let mut rooms = self.rooms.lock().unwrap();

        rooms.retain(|_, room| {
            let dead: Vec<String> = room
                .peers
                .iter()
                .filter(|(_, p)| now - p.last_seen.load(Ordering::Relaxed) >= DROP_AFTER_MS)
                .map(|(id, _)| id.clone())
                .collect();

            for id in &dead {
                if let Some(p) = room.peers.remove(id) {
                    p.kill.notify_one();
                }
            }
            for id in &dead {
                let left = json!({ "t": "peer_leave", "id": id }).to_string();
                for p in room.peers.values() {
                    post(p, left.clone());
                }
            }

            !room.peers.is_empty()
        });
    }

    pub fn leave(&self, room_id: &str, peer_id: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get_mut(room_id) else { return };
        room.peers.remove(peer_id);

        if room.peers.is_empty() {
            rooms.remove(room_id);
            return;
        }

        let left = json!({ "t": "peer_leave", "id": peer_id }).to_string();
        for p in room.peers.values() {
            post(p, left.clone());
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
            post(p, msg.to_string());
        }
    }

    /// Всем в комнате, включая отправителя: чат и присутствие возвращаются и
    /// ему тоже — так у всех один и тот же список и один и тот же порядок строк.
    pub fn broadcast(&self, room_id: &str, msg: &Value) {
        let rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get(room_id) else { return };
        let text = msg.to_string();
        for p in room.peers.values() {
            post(p, text.clone());
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
    use std::time::Duration;
    use tokio::sync::mpsc::{self, Receiver};

    fn peer(id: &str, name: &str) -> (Peer, Receiver<String>) {
        let (tx, rx) = mpsc::channel(16);
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
        (Peer::new(info, tx, Arc::new(Notify::new())), rx)
    }

    /// Новичок узнаёт всех, кто уже сидит, а они — только про него.
    #[test]
    fn join_tells_both_sides() {
        let hub = Hub::new();
        let (first, mut first_rx) = peer("a", "Аня");
        let (second, _second_rx) = peer("b", "Боря");

        let welcome = hub.join("room", first).unwrap();
        assert_eq!(welcome["peers"].as_array().unwrap().len(), 0);

        let welcome = hub.join("room", second).unwrap();
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
        hub.join("room", a).unwrap();
        hub.join("room", b).unwrap();
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
        hub.join("room", a).unwrap();

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
        hub.join("room", a).unwrap();

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

    /// Комната не резиновая: сверх `MAX_PEERS_PER_ROOM` вход отклоняется, а
    /// не выдавливает кого-то уже сидящего.
    #[test]
    fn room_refuses_beyond_the_limit() {
        let hub = Hub::new();
        for i in 0..MAX_PEERS_PER_ROOM {
            let (p, _rx) = peer(&i.to_string(), "Участник");
            hub.join("room", p).unwrap();
        }
        let (over, _rx) = peer("over", "Лишний");
        assert_eq!(hub.join("room", over), Err("комната заполнена"));
        assert_eq!(hub.stats()["peers"], MAX_PEERS_PER_ROOM);
    }

    /// Уникальных комнат тоже не бесконечно много, но уже существующая не
    /// страдает от предела — вход в неё не спрашивает про новые комнаты.
    #[test]
    fn new_rooms_refused_beyond_the_limit_existing_ones_are_not() {
        let hub = Hub::new();
        for i in 0..MAX_ROOMS {
            let (p, _rx) = peer("a", "Участник");
            hub.join(&i.to_string(), p).unwrap();
        }
        let (over, _rx) = peer("a", "Участник");
        assert_eq!(hub.join("новая", over), Err("сервер сейчас занят — попробуйте позже"));

        // А в комнату номер 0, которая уже существует, вход по-прежнему открыт.
        let (second, _rx) = peer("b", "Ещё один");
        assert!(hub.join("0", second).is_ok());
    }

    /// `touch` держит участника живым, а без него `sweep` убирает по истечении
    /// `DROP_AFTER_MS` — и будит его сокет через `kill`.
    #[tokio::test]
    async fn sweep_drops_the_silent_and_wakes_their_socket() {
        let hub = Hub::new();
        let (a, _a_rx) = peer("a", "Аня");
        let kill = Arc::clone(&a.kill);
        let (b, mut b_rx) = peer("b", "Боря");
        hub.join("room", a).unwrap();
        hub.join("room", b).unwrap();
        let _ = b_rx.try_recv();

        // Свежий участник sweep не трогает.
        hub.sweep();
        assert_eq!(hub.stats()["peers"], 2);

        // Молчание дольше предела — участника нет, сокет разбужен, остальные
        // узнали об уходе.
        hub.touch("room", "a");
        {
            let rooms = hub.rooms.lock().unwrap();
            let p = &rooms["room"].peers["a"];
            p.last_seen.store(now_ms() - DROP_AFTER_MS - 1, Ordering::Relaxed);
        }
        hub.sweep();

        assert_eq!(hub.stats()["peers"], 1);
        let left: Value = serde_json::from_str(&b_rx.try_recv().unwrap()).unwrap();
        assert_eq!(left["t"], "peer_leave");
        assert_eq!(left["id"], "a");

        // `notify_one()` без ждущих запоминает разрешение — следующий `notified()`
        // возвращается сразу же, без реального ожидания.
        tokio::time::timeout(Duration::from_millis(50), kill.notified())
            .await
            .expect("sweep должен был разбудить сокет через kill");
    }

    /// Переполненный outbox — не молчаливая потеря без последствий: следующий
    /// `sweep` убирает участника, как будто тот отмолчал `DROP_AFTER_MS`.
    #[test]
    fn overflowing_outbox_marks_the_peer_for_the_next_sweep() {
        let hub = Hub::new();
        // Очередь на один — второе сообщение переполнит её гарантированно.
        let (tx, _rx) = mpsc::channel::<String>(1);
        let info = PeerInfo {
            id: "a".into(),
            name: "Аня".into(),
            color: "#5b8cff".into(),
            voice: false,
            muted: false,
            screen: false,
            camera: false,
            deaf: false,
        };
        let a = Peer::new(info, tx, Arc::new(Notify::new()));
        hub.join("room", a).unwrap();

        // Само сообщение уходит первым и садится в очередь, второе её топит.
        hub.broadcast("room", &json!({ "t": "chat" }));
        hub.broadcast("room", &json!({ "t": "chat" }));

        hub.sweep();
        assert_eq!(hub.stats()["peers"], 0);
    }
}
