// Голосовой чат: микрофон уходит в ту же WebRTC-сеть, что и видео, поэтому
// сервер голос не слышит и не платит за него трафиком. Плюс индикатор того,
// кто сейчас говорит.

import { playback, meter, canChooseOutput, setOutput } from './audio.js';

const HOLD_MS = 400;       // сколько держим индикатор после конца фразы

// Пороги «говорит / молчит» по среднеквадратичному уровню. Настраивать их
// руками было нечем: RNNoise и так отдаёт в паузах почти тишину, а ползунок
// лишь сбивал с толку.
// Пороги низкие намеренно: индикатор должен загораться на любом звуке, а не
// только на уверенной речи. Ниже — уже цифровая тишина и шум самого тракта.
const SPEAK_ON = 0.012;
const SPEAK_OFF = 0.006;

/**
 * Подавление шума нейросетью RNNoise: та же модель, что в Mumble и Jitsi.
 * Она отличает голос от всего остального гораздо лучше любых фильтров —
 * клавиатура, вентилятор и шелест бумаги пропадают, речь остаётся.
 *
 * Модель работает строго на 48 кГц, поэтому для микрофона заводится свой
 * аудиоконтекст с такой частотой: системный может оказаться 44.1 кГц.
 */
class Denoiser {
  static async create(raw) {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const base = new URL('../vendor/rnnoise/', import.meta.url);

    const [{ RnnoiseWorkletNode, loadRnnoise }] = await Promise.all([
      import(new URL('index.js', base).href),
      ctx.audioWorklet.addModule(new URL('workletProcessor.js', base).href),
    ]);
    const wasmBinary = await loadRnnoise({
      url: new URL('rnnoise.wasm', base).href,
      simdUrl: new URL('rnnoise_simd.wasm', base).href,
    });

    return new Denoiser(ctx, raw, new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary }));
  }

  constructor(ctx, raw, node) {
    this.ctx = ctx;
    this.node = node;
    this.source = ctx.createMediaStreamSource(raw);
    this.out = ctx.createMediaStreamDestination();
    this.source.connect(node);
    node.connect(this.out);

    // Уровень меряем до подавления: индикатор должен показывать, что микрофон
    // вообще что-то слышит, даже когда RNNoise признал это шумом.
    this.meter = meter(raw);
  }

  get stream() { return this.out.stream; }

  level() { return this.meter?.level() ?? 0; }

  close() {
    try {
      this.node.destroy?.();
      this.meter?.close();
      this.source.disconnect();
      this.node.disconnect();
      this.ctx.close();
    } catch {}
  }
}

export class Voice extends EventTarget {
  constructor(mesh, settings) {
    super();
    this.mesh = mesh;
    this.settings = settings;
    this.stream = null;
    this.enabled = false;
    this.muted = false;
    this.deafened = false;
    this.remotes = new Map();   // peerId -> { audio, meter }
    this.speaking = new Set();
    this.level = 0;             // текущий уровень своего микрофона, 0..1


    settings.on(({ key }) => {
      if (key === 'voiceVolume' || key === 'peerVolume') this.applyVolumes();
      if (key === 'outputDevice') this.applySink();
      if (['micDevice', 'echoCancellation', 'autoGainControl', 'denoise'].includes(key)) {
        this.reload().catch(() => this.emit('blocked', {}));
      }
    });

    // Выбранное устройство вывода должно действовать с первой секунды, а не
    // только после того, как настройку тронут ещё раз.
    this.applySink();

    mesh.on('peer-close', ({ id }) => this.detach(id));
    // Замер уровня — единственное, что мы делаем постоянно. Пока окно не
    // смотрят, показывать индикатор некому: не считаем и не будим процессор.
    setInterval(() => document.hidden || this._sample(), 120);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }

  async enable() {
    if (this.enabled) return;
    // echoCancellation по умолчанию включён: иначе в разговор возвращается
    // звук самого фильма из динамиков.
    this.raw = await navigator.mediaDevices.getUserMedia({
      audio: this.settings.audioConstraints(),
    });
    this.enabled = true;
    this.muted = false;
    this.stream = await this._process(this.raw);
    this.mesh.setStream('mic', this.stream);
    this.emit('change', this.status());
    this.emit('devices', {});
  }

  /** Перезахват микрофона после смены устройства или обработки звука. */
  async reload() {
    if (!this.enabled) return;
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: this.settings.audioConstraints(),
    });
    fresh.getAudioTracks().forEach((t) => (t.enabled = !this.muted));

    const oldRaw = this.raw;
    const oldChain = this.chain;
    this.raw = fresh;
    this.stream = await this._process(fresh);
    // replaceTrack меняет дорожку без пересогласования SDP — собеседники не
    // слышат щелчка и разрыва.
    await this.mesh.replaceStream('mic', this.stream);
    oldChain?.close();
    oldRaw?.getTracks().forEach((t) => t.stop());
  }

  /**
   * Пропускает микрофон через RNNoise. Если модель не поднялась — нет
   * AudioWorklet, не отдался wasm — отдаём сырой поток: лучше шумный голос,
   * чем никакого.
   */
  async _process(raw) {
    this._rawMeter?.close();
    this._rawMeter = null;

    const bare = () => {
      // Без модели уровень всё равно нужен — иначе индикатор молчит и не
      // понять, слышит ли микрофон хоть что-то.
      this._rawMeter = meter(raw);
      this.chain = null;
      return raw;
    };

    if (this.settings.get('denoise') !== 'rnnoise') return bare();
    try {
      this.chain = await Denoiser.create(raw);
      return this.chain.stream;
    } catch (e) {
      console.warn('RNNoise недоступен, идём без подавления шума:', e);
      return bare();
    }
  }

  /** Список микрофонов; метки доступны только после выданного разрешения. */
  async devices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  disable() {
    if (!this.enabled) return;
    this.mesh.setStream('mic', null);
    this.raw?.getTracks().forEach((t) => t.stop());
    this.chain?.close();
    this.chain = null;
    this._rawMeter?.close();
    this._rawMeter = null;
    this.raw = null;
    this.stream = null;
    this.enabled = false;
    this.muted = false;
    this.speaking.delete('self');
    this.emit('change', this.status());
  }

  /** Заглушить свой микрофон, не разрывая соединение. */
  setMuted(muted) {
    this.muted = muted;
    this.raw?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (muted) this.speaking.delete('self');
    this.emit('change', this.status());
  }

  /** Заглушить всех остальных. */
  setDeafened(deaf) {
    this.deafened = deaf;
    this.applyVolumes();
    this.emit('change', this.status());
  }

  /** Поддерживает ли движок выбор устройства вывода. */
  get canChooseOutput() {
    return canChooseOutput();
  }

  /** Список устройств вывода; метки видны только после доступа к микрофону. */
  async outputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audiooutput');
  }

  /** Направляет звук в выбранное устройство — сразу весь, контекст общий. */
  applySink() {
    return setOutput(this.settings.get('outputDevice'));
  }

  /**
   * Общая громкость × персональная. Выше ста процентов элемент сам не умеет —
   * там подключается усилитель. Потолок всё же есть: за ним начинается не
   * громче, а грязнее.
   */
  applyVolumes() {
    const master = this.settings.get('voiceVolume');
    for (const [id, r] of this.remotes) {
      r.sound.set(this.deafened ? 0 : master * this.settings.peerVolumeOf(id));
    }
  }

  status() {
    return { enabled: this.enabled, muted: this.muted, deafened: this.deafened };
  }

  /** Голос участника: свой элемент воспроизведения и громкость поверх него. */
  attach(id, stream) {
    this.detach(id);
    const sound = playback(stream);
    sound.play().catch(() => this.emit('blocked', {}));
    stream.addEventListener('removetrack', () => {
      if (!stream.getAudioTracks().length) this.detach(id);
    });

    this.remotes.set(id, { sound, meter: meter(stream) });
    this.applyVolumes();
    this.emit('change', this.status());
  }

  detach(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.sound.close();
    r.meter?.close();
    this.remotes.delete(id);
    this.speaking.delete(id);
    this.emit('change', this.status());
  }

  _sample() {
    const now = Date.now();
    this._until ??= new Map();
    let changed = false;

    const check = (id, meter, live) => {
      if (!meter || !live) {
        if (id === 'self') this.level = 0;
        if (this.speaking.delete(id)) changed = true;
        return;
      }
      const level = meter.level();
      if (id === 'self') this.level = level;
      if (level > SPEAK_ON) this._until.set(id, now + HOLD_MS);
      const on = level > SPEAK_OFF && (this._until.get(id) ?? 0) > now;
      if (on && !this.speaking.has(id)) { this.speaking.add(id); changed = true; }
      else if (!on && this.speaking.has(id)) { this.speaking.delete(id); changed = true; }
    };

    // Свой уровень берём до подавления — иначе индикатор молчал бы вместе
    // с RNNoise, и было бы не понять, слышит ли микрофон вообще что-нибудь.
    const meter = this.chain ?? this._rawMeter;
    if (meter) {
      const level = this.enabled && !this.muted ? meter.level() : 0;
      this.level = level;
      if (level > SPEAK_ON) this._until.set('self', now + HOLD_MS);
      const on = level > SPEAK_OFF && (this._until.get('self') ?? 0) > now;
      if (on !== this.speaking.has('self')) {
        on ? this.speaking.add('self') : this.speaking.delete('self');
        changed = true;
      }
    }

    for (const [id, r] of this.remotes) check(id, r.meter, !this.deafened);

    if (changed) this.emit('speaking', { ids: [...this.speaking] });
  }
}
