// Полносвязная WebRTC-сеть между зрителями. Через неё идут и куски файла,
// и демонстрация экрана — сервер видит только SDP/ICE.

// Собираем конфиг в момент создания соединения: TURN приезжает из /config.json
// уже после загрузки модуля, а у Cloudflare учётки ещё и короткоживущие.
const iceConfig = () => ({
  iceServers: [
    // Несколько STUN от разных операторов: один может быть недоступен из сети
    // конкретного зрителя, и тогда сработает следующий.
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ],
    },
    ...(window.YERUVERSE_ICE ?? []),
  ],
  bundlePolicy: 'max-bundle',
});

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

    const pc = new RTCPeerConnection(iceConfig());
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
      mesh.seen.set(stream.id, { peer: id, stream });
      // Подпись могла ещё не доехать — тогда угадываем по составу дорожек и
      // поправимся, когда она придёт.
      const kind = mesh.kinds.get(stream.id) ?? (stream.getVideoTracks().length ? 'screen' : 'mic');
      mesh.emit('stream', { id, stream, kind });
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
    for (const sender of senders) this.mesh.tune(sender, kind);
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

export class Mesh extends EventTarget {
  constructor(net) {
    super();
    this.net = net;
    this.conns = new Map();
    this.local = new Map();    // 'mic' | 'screen' | 'cam' -> MediaStream
    // Одна и та же дорожка видео может быть и экраном, и камерой — по составу
    // потока их не различить, поэтому отправитель подписывает свои потоки.
    this.kinds = new Map();    // id потока -> вид
    this.seen = new Map();     // id потока -> { peer, stream }, пришедшие раньше подписи
    this.videoBitrate = 8_000_000;   // потолок для трансляции, бит/с
    this.videoFramerate = 60;
    net.addEventListener('signal', (e) => {
      const { from, data } = e.detail;
      this._ensure(from).onSignal(data);
    });

    this.on('message', ({ id, msg }) => {
      if (msg?.ns !== 'media') return;
      this.kinds.set(msg.id, msg.kind);
      const seen = this.seen.get(msg.id);
      if (seen) this.emit('stream', { id: seen.peer, stream: seen.stream, kind: msg.kind });
    });
    // Новому участнику сразу рассказываем, что и чем является.
    this.on('peer-open', ({ id }) => {
      for (const [kind, stream] of this.local) {
        this.send(id, { ns: 'media', kind, id: stream.id });
      }
    });
  }

  get selfId() { return this.net.selfId; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }

  _ensure(id) {
    let c = this.conns.get(id);
    if (!c) {
      c = new Conn(this, id);
      this.conns.set(id, c);
    }
    return c;
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
      if (seen.peer === id) {
        this.seen.delete(streamId);
        this.kinds.delete(streamId);
      }
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
   * Настройка кодировщика под содержимое. Для игры важнее частота кадров, чем
   * детализация: лучше мыло на долю секунды в резком движении, чем слайд-шоу.
   * Браузер по умолчанию решает наоборот — режет fps, сохраняя картинку.
   */
  tune(sender, kind) {
    if (kind === 'mic' || !sender?.track) return;
    try {
      // Подсказка кодировщику: в потоке движение, а не статичный документ.
      sender.track.contentHint = kind === 'cam' ? 'motion' : 'motion';

      const params = sender.getParameters();
      params.encodings ??= [{}];
      params.degradationPreference = 'maintain-framerate';
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
      for (const [kind, senders] of c.senders) {
        for (const sender of senders) this.tune(sender, kind);
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
   * Срез состояния соединений для панели диагностики: что с ICE и через что
   * реально идёт трафик — напрямую (host/srflx) или через TURN (relay).
   */
  async diagnostics() {
    const out = [];
    for (const [id, c] of this.conns) {
      const row = {
        id,
        state: c.pc.connectionState,
        ice: c.pc.iceConnectionState,
        ctl: c.ctl?.readyState ?? '—',
        path: '—',
        tracks: c.pc.getReceivers().filter((r) => r.track?.readyState === 'live').length,
      };
      try {
        const stats = await c.pc.getStats();
        let pair = null;
        const local = new Map();
        stats.forEach((s) => {
          if (s.type === 'local-candidate') local.set(s.id, s);
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
        });
        if (pair) row.path = local.get(pair.localCandidateId)?.candidateType ?? 'unknown';
      } catch {}
      out.push(row);
    }
    return out;
  }

  destroy() {
    for (const id of [...this.conns.keys()]) this._drop(id);
  }
}
