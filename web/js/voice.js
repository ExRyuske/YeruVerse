// Голосовой чат: микрофон уходит в ту же WebRTC-сеть, что и видео, поэтому
// сервер голос не слышит и не платит за него трафиком. Плюс индикатор того,
// кто сейчас говорит.

import { Emitter } from './events.js';
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

export class Voice extends Emitter {
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

    settings.on('change', ({ key }) => {
      if (key === 'voiceVolume' || key === 'peerVolume') this.applyVolumes();
      if (key === 'outputDevice') this.applySink();
      if (key === 'monitor') this._applyMonitor();
      if (['micDevice', 'denoise'].includes(key)) this._micChanged();
    });

    // Выбранное устройство вывода должно действовать с первой секунды, а не
    // только после того, как настройку тронут ещё раз.
    this.applySink();

    mesh.on('peer-close', ({ id }) => this.detach(id));
    // Замер уровня — единственное, что мы делаем постоянно. Пока окно не
    // смотрят, показывать индикатор некому: не считаем и не будим процессор.
    setInterval(() => document.hidden || this._sample(), 120);
  }

  /**
   * Захват микрофона, который не сдаётся с первой попытки.
   *
   * `OverconstrainedError` значит «устройство не умеет то, что мы просим», и на
   * Android это обычное дело: сохранённого микрофона больше нет — в списке они
   * меняют идентификаторы от запуска к запуску. Раньше отсюда уходил отказ, и
   * человек оставался вовсе без голоса — с сообщением, которое ничего не
   * подсказывает.
   *
   * Поэтому отступаем: забываем выбранное устройство и просим любое. Отступать
   * дальше некуда и незачем — из всей просьбы остаются три «нет» обработке
   * (см. `micConstraints`), а их устройство отвергнуть не может: это не
   * требования к железу, а слова о том, чего мы от движка не хотим. Раньше
   * последним шагом стояла попытка «хоть как-нибудь», без этих трёх, — и
   * микрофон в ней возвращался уже с полной обработкой движка, той самой,
   * которую мы отовсюду убрали.
   */
  async _capture() {
    const wanted = this.settings.micConstraints();
    const attempt = async (audio) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      // Помним, о чём просили на самом деле: следующая настройка сверится с
      // этим и решит, нужно ли вообще трогать устройство.
      this._captured = JSON.stringify(audio);
      return stream;
    };

    try {
      return await attempt(wanted);
    } catch (e) {
      if (e?.name !== 'OverconstrainedError' || !wanted.deviceId) throw e;
    }

    // Выбранного микрофона нет. Оставить настройку значит получать этот же
    // отказ при каждом входе, поэтому забываем её насовсем.
    this.settings.set('micDevice', '');
    const { deviceId, ...rest } = wanted;
    return attempt(rest);
  }

  async enable() {
    if (this.enabled) return;
    this.raw = await this._capture();
    this.enabled = true;
    this.muted = false;
    this.stream = await this._process(this.raw);
    this.mesh.setStream('mic', this.stream);
    this._applyMonitor();
    this.emit('change', this.status());
    this.emit('devices', {});
  }

  /**
   * Слышать себя.
   *
   * Играем не сырой микрофон, а то, что уходит собеседникам: после шумодава.
   * Смысл именно в этом — услышать себя чужими ушами, а не проверить, что
   * микрофон подключён.
   *
   * Заглушённый микрофон не слышно и здесь: дорожка выключена, а значит через
   * обработку идёт тишина. Так и надо — иначе выходит, что тебя слышно тебе, а
   * больше никому.
   */
  _applyMonitor() {
    this._monitor?.close();
    this._monitor = null;
    if (!this.enabled || !this.stream || !this.settings.get('monitor')) return;

    const sound = playback(this.stream);
    sound.set(1);
    sound.play().catch(() => this.emit('blocked', {}));
    this._monitor = sound;
  }

  /**
   * Настройку микрофона тронули.
   *
   * Перезахватываем устройство, только если изменилось то, о чём просят само
   * устройство. Модель шумодава живёт в нашем графе, и ради неё дёргать систему
   * незачем: перезахват — это ещё один запрос к железу, а на телефоне он
   * переводит весь звук в разговорный режим. Вздрагивает при этом всё, что
   * играет, — и трансляция, и голоса собеседников, которые к микрофону
   * отношения не имеют вовсе.
   */
  _micChanged() {
    const same = JSON.stringify(this.settings.micConstraints()) === this._captured;
    this._rebuild(!same).catch(() => this.emit('blocked', {}));
  }

  /** Перезахват микрофона: устройство сменили или его настройки изменились. */
  reload() {
    return this._rebuild(true);
  }

  /**
   * Пересборка микрофонного тракта — одна на оба случая.
   *
   * `recapture` решает, спрашивать ли устройство заново или пересобрать только
   * обработку на уже захваченном потоке. Всё остальное одинаково: новый поток
   * уходит собеседникам подменой дорожки, старый разбирается после.
   *
   * Дважды разом сюда заходить нельзя: два захвата подряд — это два запроса к
   * одному устройству, и там, где оно одно, второй получает «занято другим
   * приложением». А заходить есть откуда: забыв пропавший микрофон, мы меняем
   * настройку, а на смену настройки подписана эта же пересборка. Поэтому
   * повторный вызов не отменяется, а откладывается до конца текущего — и если
   * хоть один из отложенных просил перезахват, он и случится.
   */
  async _rebuild(recapture) {
    if (!this.enabled) return;
    if (this._rebuilding) {
      // Перезахват «сильнее»: если его просил хоть кто-то из отложенных, он и
      // случится. Отложенное держим объектом, а не флагом: `false` — это тоже
      // просьба, и потеряться она не должна.
      this._pending = { recapture: recapture || !!this._pending?.recapture };
      return;
    }
    this._rebuilding = true;
    try {
      const fresh = recapture ? await this._capture() : this.raw;
      if (recapture) fresh.getAudioTracks().forEach((t) => (t.enabled = !this.muted));

      const oldRaw = recapture ? this.raw : null;
      const oldChain = this.chain;
      this.raw = fresh;
      this.stream = await this._process(fresh);
      // Выход собрался заново — заглушение на нём надо проставить снова, иначе
      // смена микрофона или шумодава молча включает голос обратно.
      this.stream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
      // replaceTrack меняет дорожку без пересогласования SDP — собеседники не
      // слышат щелчка и разрыва, а видео у них не вздрагивает вовсе.
      await this.mesh.replaceStream('mic', this.stream);
      this._applyMonitor();
      oldChain?.close();
      oldRaw?.getTracks().forEach((t) => t.stop());
      this.emit('change', this.status());
    } finally {
      this._rebuilding = false;
      // Отложенное запускаем и после неудачи: захват мог не выйти именно с теми
      // настройками, которые уже успели сменить.
      const again = this._pending;
      this._pending = null;
      if (again) this._rebuild(again.recapture).catch(() => this.emit('blocked', {}));
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
      // Модель не поднялась — голос идёт как есть. Запасным вариантом тут стоял
      // шумодав движка, но просьба к движку никогда не остаётся при микрофоне:
      // телефон на неё переводит в разговорный режим весь звук разом, вместе с
      // воспроизведением. Платить чужим голосом за свой шум не стоит — молчать
      // об этом тем более нельзя, поэтому человеку скажут.
      console.warn(`${modelTitle(kind)} недоступен — подавления шума не будет:`, e);
      this.denoising = 'off';
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
   * выходе пусто, и по их числу снимаем модель с тракта.
   *
   * Счёт идёт с перевесом, а не подряд и не насовсем — оба края уже стоили
   * своего. Сброс на каждом тихом замере не срабатывал никогда: тише порога
   * бывает любая пауза между словами, а речь из пауз и состоит. Счёт без
   * убыли срабатывал наоборот — где не надо: модель для того и нужна, чтобы
   * не выпускать наружу клавиатуру, вентилятор и чужой разговор, и «на входе
   * громко, на выходе тишина» — это её работа, а не поломка. Такие замеры
   * набирались сами собой, и через час подавление отваливалось у того, кто
   * просто сидел и печатал.
   *
   * Поэтому тихий замер накопленное списывает, а не обнуляет: перевесить
   * должна речь, а не шум, разбросанный по всей встрече.
   */
  _watchDenoiser() {
    if (!this.chain || this.muted) return void (this._deaf = 0);

    // Тракт мог уснуть — телефон усыпляет свёрнутое приложение вместе со
    // звуком. Снаружи это неотличимо от сломавшейся модели, но лечится
    // пробуждением, и менять шумодав тут не на что.
    if (!this.chain.awake()) return void (this._deaf = 0);

    // Выход живой — вопросов нет, и прошлые подозрения снимаются.
    if (this.chain.outLevel() > SILENT_OUT) return void (this._deaf = 0);
    // Молчат оба: это просто тишина. Она ни о чём не говорит и понемногу
    // списывает накопленное — иначе редкие шумы сложились бы в приговор.
    if (this.chain.level() < SPEAK_ON) {
      this._deaf = Math.max(0, (this._deaf ?? 0) - 1);
      return;
    }

    // Замер идёт каждые 120 мс; перевес в двадцать пять замеров — это добрый
    // десяток секунд речи, ушедшей в никуда.
    if ((this._deaf = (this._deaf ?? 0) + 1) < 25) return;
    this._deaf = 0;
    this._dropDenoiser().catch(() => {});
  }

  /** Снять модель с тракта и отдать голос как есть — шумный, но живой. */
  async _dropDenoiser() {
    const chain = this.chain;
    if (!chain) return;
    console.warn(`${modelTitle(chain.kind)} не отдаёт звук — снимаем подавление`);

    this.chain = null;
    this._rawMeter = meter(this.raw);
    this.stream = this.raw;
    this.denoising = 'off';
    await this.mesh.replaceStream('mic', this.stream);
    this._applyMonitor();
    chain.close();
    this.emit('denoise-fallback', { from: chain.kind, to: this.denoising });
    this.emit('change', this.status());
  }

  /**
   * Жив ли микрофон на самом деле.
   *
   * Свёрнутое приложение телефон вправе отобрать вместе с микрофоном: дорожка
   * уходит в `ended` и сама не возвращается. Со стороны всё как обычно —
   * кнопка нажата, присутствие говорит «микрофон включён», а собеседники не
   * слышат ничего и не знают об этом.
   */
  get alive() {
    const track = this.raw?.getAudioTracks()[0];
    return !!track && track.readyState === 'live';
  }

  /** Список микрофонов; метки доступны только после выданного разрешения. */
  async devices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  disable() {
    if (!this.enabled) return;
    this._monitor?.close();
    this._monitor = null;
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

  /**
   * Заглушить свой микрофон, не разрывая соединение.
   *
   * Глушим в двух местах, и это не перестраховка. Выключенная дорожка обязана
   * отдавать тишину, и на сыром микрофоне так и происходит — но между ним и
   * собеседниками стоит шумодав, то есть граф WebAudio, а движок WebKit
   * (Safari и окно приложения на macOS) с дорожками MediaStream внутри графа
   * дружит через раз: об этом в проекте уже спотыкались и в `audio.js`, и в
   * `denoise.js`. Там, где он не заметит выключения на входе, микрофон остаётся
   * слышен собеседникам, хотя у себя человек видит перечёркнутый значок — хуже
   * этого в разговоре нет ничего.
   *
   * Поэтому гасим ещё и то, что уходит в сеть. Эту дорожку читает уже не граф,
   * а сам WebRTC, и выключенную он передаёт тишиной без всяких «через раз».
   */
  setMuted(muted) {
    this.muted = muted;
    this.raw?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
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

  /**
   * Направляет звук в выбранное устройство — сразу весь.
   *
   * Это настройка воспроизведения, а не микрофона: она одинаково касается и
   * голосов, и звука трансляции, и тракт у них один. Голос просто оказался тем,
   * кто про неё знает.
   */
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
