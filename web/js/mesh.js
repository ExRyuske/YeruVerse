// Полносвязная WebRTC-сеть между зрителями. Через неё идут и куски файла,
// и демонстрация экрана — сервер видит только SDP/ICE.

import { Emitter } from './events.js';

/**
 * Сколько ждать подпись отправителя, прежде чем гадать по составу дорожек.
 * Подпись уходит по управляющему каналу и обычно опережает дорожки; ожидание
 * здесь на случай, когда канал открылся позже них.
 */
const SIGN_WAIT = 2000;

// Несколько STUN от разных операторов: один может быть недоступен из сети
// конкретного зрителя, и тогда сработает следующий.
const STUN = {
  urls: [
    'stun:stun.cloudflare.com:3478',
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ],
};

class Conn {
  constructor(mesh, id) {
    this.mesh = mesh;
    this.id = id;
    // Детерминированные роли: кто «меньше» по id — тот инициатор и невежливый.
    this.initiator = mesh.selfId < id;
    this.polite = !this.initiator;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.ctl = null;
    this.data = null;
    this.senders = new Map();   // 'mic' | 'screen' -> RTCRtpSender[]

    const pc = new RTCPeerConnection(mesh.iceConfig());
    this.pc = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) mesh.net.signal(id, { candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        mesh.net.signal(id, { description: pc.localDescription });
      } catch (e) {
        console.warn('negotiation', e);
      } finally {
        this.makingOffer = false;
      }
    };

    // Обрыв — не приговор: сеть мигает, Wi-Fi переключается на другую точку,
    // мобильный оператор меняет адрес. Раньше первое же `failed` убивало
    // соединение навсегда, и участник пропадал до перезахода в комнату.
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        this.retries = 0;
        clearTimeout(this._timer);
        return;
      }
      if (st === 'closed') return mesh._drop(id);
      if (st === 'failed') return this._recover(0);
      if (st === 'disconnected') this._recover(3000);   // может починиться само
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      // Приёмник по умолчанию копит буфер ради плавности. В игре это
      // превращается в задержку в полсекунды и больше — просим минимум.
      try {
        if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
        if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
      } catch {}
      mesh._sawStream(id, stream);
    };

    pc.ondatachannel = ({ channel }) => this._bind(channel);

    if (this.initiator) {
      // Управляющий канал — упорядоченный; канал данных — без гарантии порядка,
      // чтобы медленный кусок не блокировал остальные.
      this._bind(pc.createDataChannel('ctl', { ordered: true }));
      this._bind(pc.createDataChannel('data', { ordered: false, maxRetransmits: 12 }));
    }

    // То, что мы уже раздаём (микрофон, экран), сразу отдаём новому участнику.
    for (const [kind, stream] of mesh.local) this.addStream(kind, stream);
  }

  /**
   * Пробуем поднять соединение заново перезапуском ICE. Инициатор делает это
   * сам, вежливая сторона ждёт его предложения. Сдаёмся после трёх попыток —
   * дальше уже не сеть моргнула, а человека действительно нет.
   */
  _recover(delay) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this.pc.connectionState === 'connected') return;
      if ((this.retries ?? 0) >= 3) return this.mesh._drop(this.id);
      this.retries = (this.retries ?? 0) + 1;
      try {
        if (this.initiator) this.pc.restartIce();
      } catch (e) {
        console.warn('перезапуск ICE не удался', e);
      }
      // Не помогло — попробуем ещё раз, с паузой побольше.
      this._recover(4000 * this.retries);
    }, delay);
  }

  addStream(kind, stream) {
    this.removeStream(kind);
    const senders = stream.getTracks().map((t) => this.pc.addTrack(t, stream));
    this.senders.set(kind, senders);
    for (const sender of senders) this.mesh.tune(sender);
  }

  /**
   * Приостановить или вернуть отправку этому собеседнику.
   *
   * `replaceTrack(null)` снимает дорожку с одного соединения, не трогая
   * остальные и не требуя пересогласования: тот, кто выключил чужую камеру у
   * себя, перестаёт получать её байты, а другие зрители ничего не замечают.
   */
  async pauseStream(kind, paused) {
    const senders = this.senders.get(kind);
    const stream = this.mesh.local.get(kind);
    if (!senders?.length) return;
    const track = paused ? null : (stream?.getVideoTracks()[0] ?? null);
    for (const sender of senders) {
      if (sender.track?.kind === 'audio') continue;    // голос глушат иначе
      try { await sender.replaceTrack(track); } catch {}
    }
  }

  removeStream(kind) {
    for (const s of this.senders.get(kind) ?? []) {
      try { this.pc.removeTrack(s); } catch {}
    }
    this.senders.delete(kind);
  }

  _bind(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'ctl') {
      this.ctl = ch;
      ch.onopen = () => this.mesh.emit('peer-open', { id: this.id });
      ch.onmessage = (e) => {
        try { this.mesh.emit('message', { id: this.id, msg: JSON.parse(e.data) }); } catch {}
      };
    } else {
      this.data = ch;
      ch.bufferedAmountLowThreshold = 512 * 1024;
      ch.onmessage = (e) => this.mesh.emit('binary', { id: this.id, buf: e.data });
    }
  }

  async onSignal(data) {
    const pc = this.pc;
    try {
      if (data.description) {
        const collision =
          data.description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.mesh.net.signal(this.id, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('signal', e);
    }
  }

  close() {
    clearTimeout(this._timer);
    try { this.ctl?.close(); this.data?.close(); this.pc.close(); } catch {}
  }
}

export class Mesh extends Emitter {
  constructor(net) {
    super();
    this.net = net;
    this.conns = new Map();
    this.local = new Map();    // 'mic' | 'screen' | 'cam' -> MediaStream
    // Одна и та же дорожка видео может быть и экраном, и камерой — по составу
    // потока их не различить, поэтому отправитель подписывает свои потоки.
    this.kinds = new Map();    // id потока -> вид
    // id потока -> { peer, stream, kind, timer }: чем поток оказался и не ждём
    // ли мы ещё подпись отправителя.
    this.seen = new Map();
    this.videoBitrate = 8_000_000;   // потолок для трансляции, бит/с
    this.videoFramerate = 60;
    // Что беречь, когда канала не хватает. Решает транслирующий: см. tune().
    this.degradation = 'maintain-resolution';
    // TURN приезжает из /config.json уже после загрузки модуля, а у Cloudflare
    // учётки ещё и короткоживущие: список обновляют снаружи, а читается он в
    // момент создания соединения.
    this.iceServers = [];
    net.on('signal', ({ from, data }) => this._ensure(from).onSignal(data));

    this.on('message', ({ id, msg }) => {
      if (msg?.ns !== 'media') return;
      this.kinds.set(msg.id, msg.kind);
      this._announce(msg.id);
    });
    // Новому участнику сразу рассказываем, что и чем является.
    this.on('peer-open', ({ id }) => {
      for (const [kind, stream] of this.local) {
        this.send(id, { ns: 'media', kind, id: stream.id });
      }
    });
  }

  get selfId() { return this.net.selfId; }

  /** Пришла дорожка. Их у потока несколько, и приезжают они по одной. */
  _sawStream(peer, stream) {
    const seen = this.seen.get(stream.id) ?? { peer, stream, kind: null, sent: null, timer: null };
    seen.peer = peer;
    seen.stream = stream;
    this.seen.set(stream.id, seen);
    this._announce(stream.id);
  }

  /**
   * Отдать поток наверх — но только когда известно, что это.
   *
   * Раньше вид угадывался по составу дорожек прямо в `ontrack`, а дорожки
   * приходят по одной и в любом порядке: у демонстрации экрана звук может
   * опередить картинку. «Видео пока нет» читалось как «микрофон», и чужой
   * экран уходил в голосовой тракт — вытесняя оттуда настоящий микрофон того
   * же участника. После этого его не было слышно вовсе, а выглядело это как
   * пропавший у собеседника звук.
   *
   * Поэтому ждём подпись отправителя; гадаем, только если её так и не
   * прислали — иначе поток не показался бы никогда.
   */
  _announce(streamId) {
    const seen = this.seen.get(streamId);
    if (!seen) return;

    const kind = this.kinds.get(streamId);
    if (!kind) {
      seen.timer ??= setTimeout(() => {
        seen.timer = null;
        this.kinds.set(streamId, seen.stream.getVideoTracks().length ? 'screen' : 'mic');
        this._announce(streamId);
      }, SIGN_WAIT);
      return;
    }

    clearTimeout(seen.timer);
    seen.timer = null;
    // Вторая дорожка того же потока — это тот же поток: наверху он уже есть.
    // Сравниваем не только вид, но и сам поток: при пересогласовании движок
    // отдаёт новый объект под прежним идентификатором, и пропустить его значит
    // оставить наверху мёртвый — со всеми признаками работающего.
    if (seen.kind === kind && seen.sent === seen.stream) return;
    seen.kind = kind;
    seen.sent = seen.stream;
    this.emit('stream', { id: seen.peer, stream: seen.stream, kind });
  }

  iceConfig() {
    return { iceServers: [STUN, ...this.iceServers], bundlePolicy: 'max-bundle' };
  }

  _ensure(id) {
    let c = this.conns.get(id);
    if (!c) {
      c = new Conn(this, id);
      this.conns.set(id, c);
    }
    return c;
  }

  /** Не присылать этому участнику наш поток — он выключил его у себя. */
  pauseFor(id, kind, paused) {
    this.conns.get(id)?.pauseStream(kind, paused);
  }

  /** Новый участник комнаты: соединение поднимает только инициатор. */
  add(id) {
    if (id === this.selfId || this.conns.has(id)) return;
    if (this.selfId < id) this._ensure(id);
  }

  remove(id) { this._drop(id); }

  _drop(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.close();
    this.conns.delete(id);

    // Карты потоков растут вместе с участниками — чистим за ушедшим, иначе за
    // долгую сессию они превращаются в утечку.
    for (const [streamId, seen] of this.seen) {
      if (seen.peer !== id) continue;
      clearTimeout(seen.timer);
      this.seen.delete(streamId);
      this.kinds.delete(streamId);
    }
    this.emit('peer-close', { id });
  }

  peers() { return [...this.conns.keys()]; }

  /**
   * Вернулись из фона. Пока приложение было свёрнуто, телефон мог оборвать и
   * WebRTC — но `disconnected` ждёт своей очереди на переподключение до
   * нескольких секунд. Раз мы точно знаем, что пауза кончилась, торопим ICE.
   */
  wake() {
    for (const c of this.conns.values()) {
      if (c.pc.connectionState === 'connected') continue;
      c.retries = 0;
      try { if (c.initiator) c.pc.restartIce(); } catch {}
    }
  }

  isOpen(id) { return this.conns.get(id)?.ctl?.readyState === 'open'; }

  send(id, msg) {
    const ch = this.conns.get(id)?.ctl;
    if (ch?.readyState === 'open') ch.send(JSON.stringify(msg));
  }

  broadcast(msg) { for (const id of this.conns.keys()) this.send(id, msg); }

  /** Бинарный кусок; false — если очередь переполнена (нужен backpressure). */
  sendBinary(id, buf) {
    const ch = this.conns.get(id)?.data;
    if (ch?.readyState !== 'open') return false;
    if (ch.bufferedAmount > 4 * 1024 * 1024) return false;
    ch.send(buf);
    return true;
  }

  /**
   * Начать/остановить раздачу потока. Микрофон и экран живут независимо:
   * выключенный микрофон не должен снимать демонстрацию и наоборот.
   */
  setStream(kind, stream) {
    if (stream) {
      this.local.set(kind, stream);
      this.broadcast({ ns: 'media', kind, id: stream.id });
      for (const c of this.conns.values()) c.addStream(kind, stream);
    } else {
      this.local.delete(kind);
      for (const c of this.conns.values()) c.removeStream(kind);
    }
  }

  /**
   * Настройка кодировщика.
   *
   * Когда канала не хватает, что-то придётся отдать, и правильного ответа тут
   * нет: в игре дороже плавность — лучше мыло на долю секунды в резком
   * движении, чем слайд-шоу; в чужом коде и таблицах дороже чёткость — там
   * важно прочитать буквы, а не увидеть плавную прокрутку. Поэтому приоритет
   * выбирает транслирующий, а `degradation` приезжает из его настроек.
   */
  tune(sender) {
    // Только видео. У демонстрации экрана дорожек две, и звуковая попадала
    // сюда наравне с картинкой: ей ставили `contentHint: 'motion'`, потолок в
    // восемь мегабит и частоту кадров — всё то, чего у звука не бывает. Движок
    // на такой набор отвечает отказом от всего вызова разом, то есть заодно
    // терялась и настройка самой картинки.
    if (sender?.track?.kind !== 'video') return;
    try {
      // Подсказка кодировщику: в потоке движение, а не статичный документ.
      sender.track.contentHint = 'motion';

      const params = sender.getParameters();
      params.encodings ??= [{}];
      params.degradationPreference = this.degradation;
      for (const e of params.encodings) {
        e.maxBitrate = this.videoBitrate;
        e.maxFramerate = this.videoFramerate;
        e.networkPriority = 'high';
        e.priority = 'high';
      }
      sender.setParameters(params).catch((err) => console.warn('параметры кодека', err));
    } catch (e) {
      console.warn('не удалось настроить отправителя', e);
    }
  }

  /** Перенастроить уже идущие трансляции — например, после смены качества. */
  retune() {
    for (const c of this.conns.values()) {
      for (const senders of c.senders.values()) {
        for (const sender of senders) this.tune(sender);
      }
    }
  }

  /**
   * Подменить дорожку уже раздаваемого потока (смена микрофона). В отличие от
   * setStream не требует пересогласования SDP — у собеседников не пропадает звук.
   */
  async replaceStream(kind, stream) {
    if (!this.local.has(kind)) return this.setStream(kind, stream);
    this.local.set(kind, stream);
    this.broadcast({ ns: 'media', kind, id: stream.id });
    const track = stream.getTracks()[0] ?? null;

    for (const c of this.conns.values()) {
      const senders = c.senders.get(kind);
      if (senders?.length && track) {
        try {
          await senders[0].replaceTrack(track);
          continue;
        } catch {}
      }
      c.addStream(kind, stream);   // запасной путь — через пересогласование
    }
  }

  /**
   * Срез состояния соединений для панели диагностики: через что реально идёт
   * трафик — напрямую (host/srflx/prflx) или через TURN (relay), — сколько до
   * человека миллисекунд и что от него вообще приходит.
   */
  async diagnostics() {
    const out = [];
    for (const [id, c] of this.conns) {
      const live = c.pc.getReceivers().filter((r) => r.track?.readyState === 'live');
      const row = {
        id,
        state: c.pc.connectionState,
        ctl: c.ctl?.readyState ?? '',
        path: '',                 // host | srflx | prflx | relay
        rtt: null,                // мс до участника по выбранной паре кандидатов
        audio: live.filter((r) => r.track.kind === 'audio').length,
        video: live.filter((r) => r.track.kind === 'video').length,
      };
      try {
        const stats = await c.pc.getStats();
        let pair = null;
        const local = new Map();
        stats.forEach((s) => {
          if (s.type === 'local-candidate') local.set(s.id, s);
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
        });
        if (pair) {
          row.path = local.get(pair.localCandidateId)?.candidateType ?? '';
          // Время туда-обратно приходит в секундах, а человеку понятны мс.
          if (pair.currentRoundTripTime > 0) row.rtt = pair.currentRoundTripTime * 1000;
        }
      } catch {}
      out.push(row);
    }
    return out;
  }

  destroy() {
    for (const id of [...this.conns.keys()]) this._drop(id);
  }
}
