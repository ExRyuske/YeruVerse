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

/**
 * Чего мы хотим от Opus — и просим об этом собеседника.
 *
 * По умолчанию движок настраивает звук на разговор по телефону: моно и около
 * тридцати килобит. Голосу этого хватает впритык, а звуку игры — нет вовсе:
 * музыка и взрывы превращаются в шипение, стерео теряется целиком, и слышно
 * это сразу.
 *
 * Настройка живёт в SDP, потому что решает её принимающая сторона: `stereo=1`
 * значит «шли мне стерео», `maxaveragebitrate` — «можно вот столько». Читает
 * это кодировщик собеседника, поэтому обе стороны просят одинаково.
 *
 * `usedtx=0` — не выключать передачу в тишине: в разговоре пауза это пауза, а
 * в игре тихое место — это тихое место, и обрывать его нельзя.
 *
 * Сколько на самом деле уйдёт байтов, решает не этот потолок, а `tuneAudio` —
 * там у голоса и у звука игры разные пределы.
 */
const OPUS = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;maxplaybackrate=48000;useinbandfec=1;usedtx=0;ptime=20;maxptime=60';
const OPUS_KEYS = new Set(OPUS.split(';').map((p) => p.split('=')[0]));

// Базовый запас джиттер-буфера для звука (голоса и трансляции) и потолок при лагах сети.
const MIN_VOICE_BUFFER_MS = 60;
const MAX_VOICE_BUFFER_MS = 400;
const ADAPT_INTERVAL_MS = 1500;

function setAudioBuffer(receiver, ms) {
  const clamped = Math.round(Math.min(MAX_VOICE_BUFFER_MS, Math.max(MIN_VOICE_BUFFER_MS, ms)));
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = clamped;
  } catch {}
  try {
    if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = clamped / 1000;
  } catch {}
}

/**
 * Вписать эту просьбу в описание, которое уходит собеседнику.
 *
 * Правится именно отправляемое описание, а не своё собственное: своему
 * соединению эти строчки не нужны — принятый Opus всё равно декодируется хоть
 * в моно, хоть в стерео, — а править описание до `setLocalDescription` значит
 * встать между `createOffer` и установкой и сломать разбор столкновений
 * предложений, на котором всё здесь держится.
 *
 * Старая версия на том конце ничего не заметит: не поймёт просьбу — пришлёт
 * звук по-прежнему, и разговор от этого не развалится.
 */
function askForGoodSound({ type, sdp }) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const out = [];
  let pt = null;    // номер полезной нагрузки Opus в текущей m-секции
  let fmtp = -1;    // куда вписать параметры, если своей строки у него нет

  // Секция кончилась, а параметров у Opus так и не было — добавляем свои.
  const close = () => {
    if (fmtp >= 0) out.splice(fmtp, 0, `a=fmtp:${pt} ${OPUS}`);
    pt = null;
    fmtp = -1;
  };

  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) close();

    const opus = /^a=rtpmap:(\d+) opus\/48000\/2/i.exec(line);
    if (opus) {
      pt = opus[1];
      out.push(line);
      fmtp = out.length;   // сразу за строкой кодека
      continue;
    }

    const params = pt && new RegExp(`^a=fmtp:${pt} (.*)$`).exec(line);
    if (params) {
      // Своё дописываем к чужому, а не поверх: там `minptime` и прочее, о чём
      // движок договорился сам.
      const keep = params[1].split(';').filter((p) => p && !OPUS_KEYS.has(p.split('=')[0]));
      out.push(`a=fmtp:${pt} ${[...keep, OPUS].join(';')}`);
      fmtp = -1;
      continue;
    }

    out.push(line);
  }
  close();

  return { type, sdp: out.join(eol) };
}

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
    this.audioRecv = new Map(); // track.id -> { receiver, targetMs, prevSamples, prevConcealed }

    const pc = new RTCPeerConnection(mesh.iceConfig());
    this.pc = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) mesh.net.signal(id, { candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        mesh.net.signal(id, { description: askForGoodSound(pc.localDescription) });
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
      // Список участников красит строку тем же состоянием — см. `link-state`
      // в `peers.js`. Эмитим на каждую смену, а не только на «плохие»: строке
      // так же важно узнать, что связь вернулась, как и что она пропала.
      mesh.emit('link-state', { id, state: st });
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

      // Всем входящим аудиодорожкам (голосу и звуку трансляции) задаём стартовый
      // запас буфера и включаем адаптацию под джиттер. Видео оставляем под
      // штатный буфер движка, чтобы не ломать синхронизацию и не рвать кадры.
      if (event.track.kind === 'audio') {
        setAudioBuffer(event.receiver, MIN_VOICE_BUFFER_MS);
        this.audioRecv.set(event.track.id, {
          receiver: event.receiver,
          targetMs: MIN_VOICE_BUFFER_MS,
          prevSamples: null,
          prevConcealed: null,
        });
      }
      mesh._sawStream(id, stream);
    };

    // Согласование закончилось. Только теперь у отправителей есть то, чему
    // можно ставить пределы: до первого обмена описаниями движок отдаёт их без
    // единого слоя, а самим слой не добавить — на попытку изменить их число он
    // отвечает отказом. Пока пределы ставились один раз, сразу за `addTrack`,
    // та сторона, что подключалась второй, нередко оставалась вовсе без них:
    // и без потолка звука, и без потолка картинки.
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') this.retune();
      this._chase();
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
   * сам, вежливая сторона ждёт его предложения.
   *
   * Не сдаёмся, пока человек в комнате. Раньше после трёх попыток — это
   * секунд двадцать пять — соединение бросали насовсем: считалось, что дальше
   * уже не сеть моргнула, а человека действительно нет. Но есть ли он, знает
   * сервер и сам скажет об уходе (`peer_leave`), а двадцать пять секунд без
   * связи на мобильном интернете — обычное дело: тоннель, лифт, переход между
   * вышками. Брошенное соединение не поднималось уже ничем: связь у человека
   * возвращалась, в списке он оставался, а слышно его больше не было.
   */
  _recover(delay) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (this.pc.connectionState === 'connected') return;
      this.retries = (this.retries ?? 0) + 1;
      try {
        if (this.initiator) this.pc.restartIce();
        else this.mesh.net.signal(this.id, { iceRestart: true });
      } catch (e) {
        console.warn('перезапуск ICE не удался', e);
      }
      // Не помогло — попробуем ещё раз, с паузой побольше, но не бесконечной:
      // связь может вернуться в любую секунду, и ждать её дольше нельзя.
      this._recover(Math.min(4000 * this.retries, 15000));
    }, delay);
  }

  /**
   * Повторять своё предложение, пока на него не ответят.
   *
   * Сигналинг ходит через сервер, а сокет до него на мобильном интернете
   * рвётся, и всё, что ушло в эту секунду, пропадает — предложение или ответ
   * на него. Соединение после этого ждёт ответа вечно: нового предложения
   * движок не сделает, пока не получит ответ на старое, и ни перезапуск ICE,
   * ни новая дорожка его с места не сдвинут.
   *
   * Повтор того же предложения безвреден: получивший его второй раз просто
   * ответит снова, а лишний ответ мы пропустим (см. `onSignal`). Он же чинит и
   * потерянный ответ — на повтор придёт новый. Собранные к этому времени
   * кандидаты едут внутри самого описания, так что и они не теряются насовсем.
   * Шлём редко и всё реже: это несколько килобайт, и только пока соединение
   * стоит.
   */
  _chase(wait = 5000) {
    clearTimeout(this._chaser);
    if (this.pc.signalingState !== 'have-local-offer') return;
    this._chaser = setTimeout(() => {
      if (this.pc.signalingState !== 'have-local-offer') return;
      this.mesh.net.signal(this.id, { description: askForGoodSound(this.pc.localDescription) });
      this._chase(Math.min(wait * 2, 20000));
    }, wait);
  }

  addStream(kind, stream) {
    this.removeStream(kind);
    const senders = stream.getTracks().map((t) => this.pc.addTrack(t, stream));
    this.senders.set(kind, senders);
    for (const sender of senders) this.mesh.tune(sender, kind);
  }

  /** Дописать дорожку к уже раздаваемому потоку, не трогая остальные. */
  addTrack(kind, stream, track) {
    const sender = this.pc.addTrack(track, stream);
    this.senders.set(kind, [...(this.senders.get(kind) ?? []), sender]);
    this.mesh.tune(sender, kind);
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
      // Отказ виден: сюда приходят по живому каналу — зритель выключил наш
      // поток у себя, — и молча уйти значило бы продолжать слать ему байты,
      // от которых он отказался.
      try { await sender.replaceTrack(track); }
      catch (e) { console.warn('pauseStream', e); }
    }
  }

  removeStream(kind) {
    for (const s of this.senders.get(kind) ?? []) {
      try { this.pc.removeTrack(s); } catch {}
    }
    this.senders.delete(kind);
  }

  /** Заново проставить пределы всему, что уходит этому собеседнику. */
  retune() {
    for (const [kind, senders] of this.senders) {
      for (const sender of senders) this.mesh.tune(sender, kind);
    }
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
      if (data.iceRestart) {
        if (this.initiator) {
          this.retries = 0;
          try { pc.restartIce(); } catch {}
          if (pc.connectionState !== 'connected') this._recover(4000);
        }
        return;
      }
      if (data.description) {
        const collision =
          data.description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        // Ответ, когда мы ничего не ждём, — ответ на повтор уже согласованного
        // предложения (см. `_chase`). Применять его некуда.
        if (data.description.type === 'answer' && pc.signalingState === 'stable') return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.mesh.net.signal(this.id, { description: askForGoodSound(pc.localDescription) });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('signal', e);
    }
  }

  /** Подстроить буфер джиттера входящего звука (голоса и стрима) под потери и разброс пакетов. */
  async adaptAudio() {
    if (!this.audioRecv.size || this.pc.connectionState !== 'connected') return;

    for (const [trackId, entry] of this.audioRecv) {
      if (entry.receiver.track?.readyState !== 'live') {
        this.audioRecv.delete(trackId);
      }
    }
    if (!this.audioRecv.size) return;

    let stats;
    try {
      stats = await this.pc.getStats();
    } catch {
      return;
    }

    const tracks = new Map();
    const inbound = [];
    stats.forEach((s) => {
      if (s.type === 'track' && s.trackIdentifier) tracks.set(s.id, s.trackIdentifier);
      if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound.push(s);
    });

    const liveAudioCount = this.pc
      .getReceivers()
      .filter((r) => r.track?.kind === 'audio' && r.track.readyState === 'live').length;

    for (const s of inbound) {
      const trackId = s.trackIdentifier ?? tracks.get(s.trackId);
      let entry = trackId ? this.audioRecv.get(trackId) : null;
      if (!entry && !trackId && this.audioRecv.size === 1 && liveAudioCount === 1) {
        entry = this.audioRecv.values().next().value;
      }
      if (!entry) continue;

      const hasSamples =
        Number.isFinite(s.totalSamplesReceived) && Number.isFinite(s.concealedSamples);
      let concealRatio = 0;
      let hasDelta = false;
      if (hasSamples) {
        const prevSamples = entry.prevSamples;
        const prevConcealed = entry.prevConcealed;
        entry.prevSamples = s.totalSamplesReceived;
        entry.prevConcealed = s.concealedSamples;
        if (prevSamples !== null) {
          const deltaSamples = s.totalSamplesReceived - prevSamples;
          if (deltaSamples <= 0) continue;
          const deltaConcealed = Math.max(0, s.concealedSamples - prevConcealed);
          concealRatio = deltaConcealed / deltaSamples;
          hasDelta = true;
        }
      }

      const jitterMs = Number.isFinite(s.jitter) ? s.jitter * 1000 : 0;
      let next = entry.targetMs;

      if (concealRatio > 0.015 || jitterMs * 3 > entry.targetMs) {
        const stepUp = concealRatio > 0.05 ? 100 : concealRatio > 0.015 ? 60 : 0;
        next = Math.min(
          MAX_VOICE_BUFFER_MS,
          Math.max(entry.targetMs + stepUp, jitterMs * 3.5, MIN_VOICE_BUFFER_MS)
        );
      } else if ((!hasSamples || hasDelta) && concealRatio < 0.005 && jitterMs * 3 <= entry.targetMs - 20) {
        next = Math.max(MIN_VOICE_BUFFER_MS, entry.targetMs - 20);
      }

      next = Math.round(next);
      if (next !== entry.targetMs) {
        entry.targetMs = next;
        setAudioBuffer(entry.receiver, next);
      }
    }
  }

  close() {
    clearTimeout(this._timer);
    clearTimeout(this._chaser);
    this.audioRecv.clear();
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
    // Потолки звука. Речь при 96 кбит/с даёт кодировщику запас для стерео и
    // In-Band FEC (`useinbandfec=1`), а звуку игры нужно больше.
    this.voiceBitrate = 96_000;
    this.soundBitrate = 128_000;
    // Отправители, у которых просьба к движку сейчас в пути, и те, кому надо
    // будет повторить её следом: см. `apply`.
    this.applying = new WeakSet();
    this.waiting = new WeakSet();
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

    this._adapting = false;
    setInterval(() => this.adaptAudio(), ADAPT_INTERVAL_MS);
  }

  async adaptAudio() {
    if (this._adapting || !this.conns.size) return;
    this._adapting = true;
    try {
      await Promise.all([...this.conns.values()].map((c) => c.adaptAudio()));
    } finally {
      this._adapting = false;
    }
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

  /**
   * Пересобрать сеть под состав комнаты, который только что назвал сервер.
   *
   * Вернулись после обрыва тем же участником (`Hub::resume` на сервере) —
   * соединения целы: сокет до сервера и звонок — разные дороги, и звонок
   * обрыв сокета обычно переживает. Комната нашего ухода не видела, и
   * трогать нечего, кроме разницы в составе: кто вышел — уходит, кто пришёл —
   * добавляется.
   *
   * Вернуться тем же не вышло — значит, id у нас новый, и тогда старые
   * соединения не просто бесполезны, они вредны. От нашего id зависит роль в
   * каждой паре, а `Conn.initiator` считается один раз, при создании.
   * Собеседник, увидев наш `peer_leave`, свою половину уже закрыл и поднимает
   * новую, пересчитав роль от нашего нового id; наша половина роль не
   * пересчитывает. Стороны договариваются каждая о своём, обе могут оказаться
   * невежливыми и взаимно проигнорировать предложения друг друга (см.
   * `onSignal`) — и участник пропадает до перезахода в комнату. Поэтому всё
   * пересоздаётся: всё, что на соединениях держалось, — трансляции, рой,
   * разрешения, — заново объявляется по `peer-open`.
   *
   * И в том и в другом случае уходят те, кто вышел, пока наш сокет лежал:
   * `peer_leave` о них не приезжал, и без сверки со списком их соединения жили
   * бы вечно, собирая рассылки и показываясь в диагностике живыми.
   */
  sync(ids) {
    const same = this._syncedAs === this.selfId;
    this._syncedAs = this.selfId;
    for (const id of [...this.conns.keys()]) {
      if (!same || !ids.includes(id)) this._drop(id);
    }
    for (const id of ids) this.add(id);
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
      try {
        if (c.initiator) c.pc.restartIce();
        else c.mesh.net.signal(c.id, { iceRestart: true });
      } catch {}
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
  tune(sender, kind) {
    // У звука свои пределы и свои подсказки: потолок в восемь мегабит и частота
    // кадров ему не просто не нужны — движок на такой набор отвечает отказом от
    // всего вызова разом, то есть заодно теряется и настройка картинки.
    if (!sender?.track) return;
    if (sender.track.kind === 'audio') return this.tuneAudio(sender, kind);
    try {
      // Подсказка кодировщику: в потоке движение, а не статичный документ.
      sender.track.contentHint = 'motion';

      const params = this.layers(sender);
      if (!params) return;
      params.degradationPreference = this.degradation;
      for (const e of params.encodings) {
        e.maxBitrate = this.videoBitrate;
        e.maxFramerate = this.videoFramerate;
        e.networkPriority = 'medium';
        e.priority = 'medium';
      }
      this.apply(sender, params, () => this.tune(sender, kind));
    } catch (e) {
      console.warn('не удалось настроить отправителя', e);
    }
  }

  /**
   * Настройка звука.
   *
   * Голос и звук игры — разные задачи, и потолок у них разный. Речь при
   * шестидесяти килобитах уже не отличить от студийной, и брать больше незачем;
   * музыке и стерео этого мало — им отдаём вдвое.
   *
   * Выше не поднимаем: сеть тут полносвязная, и каждый слушатель получает свою
   * копию. Вчетвером один только звук — это три потока туда и три обратно.
   *
   * Приоритет высокий у обоих, и это важнее самих чисел. Когда канала не
   * хватает, движок делит его между дорожками, и картинка с потолком в восемь
   * мегабит забирает всё: звук проседает первым и первым же становится слышно.
   * А терпят люди ровно наоборот — рассыпающуюся картинку терпят, пропадающий
   * голос нет.
   *
   * Про стерео и потолок повыше собеседник узнаёт из SDP: см. `askForGoodSound`.
   */
  tuneAudio(sender, kind) {
    try {
      // Подсказка кодировщику: голос можно ужимать по-речевому, музыку нельзя.
      sender.track.contentHint = kind === 'mic' ? 'speech' : 'music';

      const params = this.layers(sender);
      if (!params) return;
      for (const e of params.encodings) {
        e.maxBitrate = kind === 'mic' ? this.voiceBitrate : this.soundBitrate;
        e.networkPriority = 'high';
        e.priority = 'high';
      }
      this.apply(sender, params, () => this.tune(sender, kind));
    } catch (e) {
      console.warn('не удалось настроить звук', e);
    }
  }

  /**
   * Параметры отправителя — или ничего, если ставить их ещё некуда.
   *
   * До первого обмена описаниями слоёв у отправителя нет вовсе, а добавить их
   * самим нельзя: движок отвечает отказом на любую попытку изменить их число.
   * Молча пропускаем — за нас это повторят, когда согласование дойдёт до
   * `stable`.
   */
  layers(sender) {
    const params = sender.getParameters();
    params.encodings ??= [{}];
    return params.encodings.length ? params : null;
  }

  /**
   * Отправить параметры, не наступив на предыдущую такую же просьбу.
   *
   * Каждая пара «прочитал — записал» помечена своим номером, и вторая запись
   * обесценивает первую: движок отвечает отказом. Поэтому пока одна просьба в
   * пути, вторую не шлём, а запоминаем — и повторяем её потом целиком, вместе с
   * чтением: старый номер к тому времени уже ничего не значит, да и значения
   * могли смениться.
   */
  apply(sender, params, redo) {
    if (this.applying.has(sender)) return void this.waiting.add(sender);
    this.applying.add(sender);
    sender
      .setParameters(params)
      .catch((err) => console.warn('параметры кодека', err))
      .finally(() => {
        this.applying.delete(sender);
        if (this.waiting.delete(sender)) redo();
      });
  }

  /** Перенастроить уже идущие трансляции — например, после смены качества. */
  retune() {
    for (const c of this.conns.values()) c.retune();
  }

  /**
   * Дописать дорожку в поток, который уже раздаётся.
   *
   * Нужно ровно для одного: звук компьютера на macOS приходит не вместе с
   * картинкой, а позже — его добирает оболочка через ScreenCaptureKit, и до
   * первого отсчёта проходит доля секунды (а в первый раз ещё и запрос
   * разрешения). Пересобирать ради этого весь поток нельзя: `setStream` снимает
   * старые дорожки и ставит новые, и у зрителей на это время пропадает
   * картинка. Одна лишняя дорожка обходится пересогласованием SDP, которое
   * зрителю не видно вовсе.
   *
   * Дорожка ложится и в сам поток: из него собирается всё, что уходит
   * соединениям, поднятым позже, — новичку в комнате и любому, с кем мы
   * пересоединились после обрыва. Пока она жила только в уже открытых
   * соединениях, звук компьютера с macOS и Linux пропадал у зрителей после
   * первого же переподключения, а картинка оставалась.
   */
  addTrack(kind, track) {
    const stream = this.local.get(kind);
    if (!stream) return;
    stream.addTrack(track);
    for (const c of this.conns.values()) c.addTrack(kind, stream, track);
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
          // Подсказка кодировщику живёт на самой дорожке, а дорожка теперь
          // другая: без этого сменённый микрофон уходил бы уже без неё.
          this.tune(senders[0], kind);
          continue;
        } catch {}
      }
      c.addStream(kind, stream);   // запасной путь — через пересогласование
    }
  }

  /**
   * `connectionState` соединения с пиром без похода в асинхронный `getStats()`
   * — списку участников (`peers.js`) на каждую перерисовку нужен только он, а
   * не путь и не RTT, которые есть в `diagnostics()` ниже. Соединения ещё нет —
   * например, только что вошли, — и это не беда: список ничего не покажет.
   */
  linkState(id) {
    return this.conns.get(id)?.pc.connectionState;
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
