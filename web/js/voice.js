// Голосовой чат: микрофон уходит в ту же WebRTC-сеть, что и видео, поэтому
// сервер голос не слышит и не платит за него трафиком. Плюс индикатор того,
// кто сейчас говорит.

import { playback, meter, canChooseOutput, setOutput } from './audio.js';
import { Denoiser, SILENT_OUT, isModel, modelTitle, modelWeight } from './denoise.js';

/** Модели, которые в этой вкладке уже поднимались: про них молчим. */
const loaded = new Set();

const HOLD_MS = 400;       // сколько держим индикатор после конца фразы

// Пороги «говорит / молчит» по среднеквадратичному уровню. Настраивать их
// руками было нечем: RNNoise и так отдаёт в паузах почти тишину, а ползунок
// лишь сбивал с толку.
// Пороги низкие намеренно: индикатор должен загораться на любом звуке, а не
// только на уверенной речи. Ниже — уже цифровая тишина и шум самого тракта.
const SPEAK_ON = 0.012;
const SPEAK_OFF = 0.006;

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
    // Что подавляет шум на самом деле, а не что выбрано в настройках: модель
    // может не подняться, и знать об этом полезнее, чем верить настройке.
    this.denoising = 'off';

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

  /**
   * Захват микрофона, который не сдаётся с первой попытки.
   *
   * `OverconstrainedError` значит «устройство не умеет то, что мы просим», и на
   * Android это обычное дело: сохранённого микрофона больше нет (в списке они
   * меняют идентификаторы от запуска к запуску), либо движок не принимает
   * эхоподавление и автоусиление в том виде, в каком их просят. Раньше отсюда
   * уходил отказ, и человек оставался вовсе без голоса — с сообщением, которое
   * ничего не подсказывает.
   *
   * Поэтому отступаем по шагам: сначала забываем выбранное устройство, потом
   * отказываемся и от обработки. Микрофон без эхоподавления лучше молчания.
   */
  async _capture() {
    const wanted = this.settings.audioConstraints();
    const attempt = (audio) => navigator.mediaDevices.getUserMedia({ audio });

    try {
      return await attempt(wanted);
    } catch (e) {
      if (e?.name !== 'OverconstrainedError') throw e;
    }

    if (wanted.deviceId) {
      // Выбранного микрофона нет. Оставить настройку значит получать этот же
      // отказ при каждом входе, поэтому забываем её насовсем.
      this.settings.set('micDevice', '');
      const { deviceId, ...rest } = wanted;
      try {
        return await attempt(rest);
      } catch (e) {
        if (e?.name !== 'OverconstrainedError') throw e;
      }
    }

    return attempt(true);
  }

  async enable() {
    if (this.enabled) return;
    // echoCancellation по умолчанию включён: иначе в разговор возвращается
    // звук самого фильма из динамиков.
    this.raw = await this._capture();
    this.enabled = true;
    this.muted = false;
    this.stream = await this._process(this.raw);
    this.mesh.setStream('mic', this.stream);
    this.emit('change', this.status());
    this.emit('devices', {});
  }

  /**
   * Перезахват микрофона после смены устройства или обработки звука.
   *
   * Дважды разом сюда заходить нельзя: два захвата подряд — это два запроса к
   * одному устройству, и там, где оно одно, второй получает «занято другим
   * приложением». А заходить есть откуда: забыв пропавший микрофон, мы меняем
   * настройку, а на смену настройки подписан этот же перезахват. Поэтому
   * повторный вызов не отменяется, а откладывается до конца текущего.
   */
  async reload() {
    if (!this.enabled) return;
    if (this._reloading) {
      this._reloadAgain = true;
      return;
    }
    this._reloading = true;
    try {
      const fresh = await this._capture();
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
    } finally {
      this._reloading = false;
    }

    if (this._reloadAgain) {
      this._reloadAgain = false;
      await this.reload();
    }
  }

  /**
   * Пропускает микрофон через выбранную модель. Если она не поднялась — нет
   * AudioWorklet, движок не дал собрать WebAssembly, не отдался файл, — отдаём
   * сырой поток: лучше шумный голос, чем никакого.
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

    const kind = this.settings.get('denoise');
    if (!isModel(kind)) {
      this.denoising = kind;
      return bare();
    }

    try {
      // Тяжёлую модель качают один раз, но этот раз занимает секунды: пока она
      // едет, микрофон в эфир не уходит, и молчание надо объяснить.
      if (modelWeight(kind) && !loaded.has(kind)) this.emit('denoise-loading', { kind });
      this.chain = await Denoiser.create(kind, raw);
      loaded.add(kind);
      this.denoising = kind;
      return this.chain.stream;
    } catch (e) {
      // Модель не поднялась. Раньше отсюда уходили вовсе без подавления, молча:
      // человек выбрал шумодав, а его не было. Просим подавление у самого
      // движка — оно есть везде и работает тем лучше, чем хуже микрофон.
      console.warn(`${modelTitle(kind)} недоступен, просим подавление у движка:`, e);
      this.denoising = (await this._engineDenoise(raw)) ? 'browser' : 'off';
      this.emit('denoise-fallback', { from: kind, to: this.denoising });
      return bare();
    }
  }

  /**
   * Присмотр за шумодавом.
   *
   * Отказ, о котором не сказали, здесь стоит дороже всего: человек говорит,
   * видит свою полоску уровня и не догадывается, что собеседники слышат тишину.
   * Поэтому сверяем вход с выходом: копим замеры, где на входе голос, а на
   * выходе пусто, и по их числу уходим на подавление средствами движка.
   *
   * Копим, а не считаем подряд. Раньше счётчик сбрасывался на каждом замере,
   * где вход тише порога, — то есть на любой паузе между словами. Речь из пауз
   * и состоит, поэтому тридцати трёх замеров подряд не набиралось никогда, и
   * сторож, написанный ровно для этого случая, не срабатывал ни разу.
   */
  _watchDenoiser() {
    if (!this.chain || this.muted) return void (this._deaf = 0);

    // Выход живой — вопросов нет, и прошлые подозрения снимаются.
    if (this.chain.outLevel() > SILENT_OUT) return void (this._deaf = 0);
    // Молчат оба: это просто тишина, она ни о чём не говорит.
    if (this.chain.level() < SPEAK_ON) return;

    // Замер идёт каждые 120 мс; двадцать пять замеров с голосом на входе — это
    // около трёх секунд настоящей речи, ушедшей в никуда.
    if ((this._deaf = (this._deaf ?? 0) + 1) < 25) return;
    this._deaf = 0;
    this._dropDenoiser().catch(() => {});
  }

  /** Снять модель с тракта и отдать голос как есть, с подавлением от движка. */
  async _dropDenoiser() {
    const chain = this.chain;
    if (!chain) return;
    console.warn(`${modelTitle(chain.kind)} не отдаёт звук — переходим на подавление движком`);

    this.chain = null;
    this._rawMeter = meter(this.raw);
    this.stream = this.raw;
    this.denoising = (await this._engineDenoise(this.raw)) ? 'browser' : 'off';
    await this.mesh.replaceStream('mic', this.stream);
    chain.close();
    this.emit('denoise-fallback', { from: chain.kind, to: this.denoising });
    this.emit('change', this.status());
  }

  /**
   * Включить подавление шума средствами самого движка на живой дорожке.
   *
   * Ограничения аудио применяются без перезахвата: просить микрофон второй раз
   * значило бы отпустить его и получить отказ там, где устройство одно, — а это
   * ровно тот телефон, где всё и случилось.
   */
  async _engineDenoise(raw) {
    const track = raw.getAudioTracks()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({ ...this.settings.audioConstraints(), noiseSuppression: true });
      return track.getSettings().noiseSuppression !== false;
    } catch {
      return false;
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

    // Загорается по верхнему порогу, гаснет по нижнему и держится ещё HOLD_MS:
    // без этого метка мигала бы на каждой паузе между словами.
    const mark = (id, level) => {
      if (level > SPEAK_ON) this._until.set(id, now + HOLD_MS);
      const on = level > SPEAK_OFF && (this._until.get(id) ?? 0) > now;
      if (on === this.speaking.has(id)) return;
      if (on) this.speaking.add(id);
      else this.speaking.delete(id);
      changed = true;
    };

    this._watchDenoiser();

    // Свой уровень берём до подавления — иначе индикатор молчал бы вместе
    // с RNNoise, и было бы не понять, слышит ли микрофон вообще что-нибудь.
    const own = this.chain ?? this._rawMeter;
    this.level = own && this.enabled && !this.muted ? own.level() : 0;
    if (own) mark('self', this.level);

    // Заглушённых участников не слышим мы, а не они молчат: индикатор гаснет.
    for (const [id, r] of this.remotes) {
      mark(id, this.deafened ? 0 : (r.meter?.level() ?? 0));
    }

    if (changed) this.emit('speaking', { ids: [...this.speaking] });
  }
}
