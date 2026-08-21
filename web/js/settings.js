// Настройки пользователя: живут в localStorage и переживают перезаход в комнату.
// Громкости отдельных участников не сохраняем — id выдаются заново на каждый вход.

import { Emitter } from './events.js';
import { isModel } from './denoise.js';

const KEY = 'yeruverse:settings';

/**
 * Заготовки настроек трансляции. Для игры важна частота кадров: 60 кадров в
 * 1080p читаются глазом как «плавно», а 30 кадров в 1440p — как «дёргается»,
 * хотя битрейт тот же. Любую заготовку можно поправить руками — выбор тогда
 * переключится на «Свои настройки».
 */
export const PRESETS = {
  high: { title: 'Высокое — 1080p, 60 к/с', height: 1080, fps: 60, bitrate: 8 },
  medium: { title: 'Среднее — 720p, 60 к/с', height: 720, fps: 60, bitrate: 4 },
  low: { title: 'Низкое — 480p, 30 к/с', height: 480, fps: 30, bitrate: 1.5 },
  custom: { title: 'Своё' },
};

/** Высота кадра на выбор; ширину браузер подберёт по соотношению сторон экрана. */
export const HEIGHTS = [2160, 1440, 1080, 720, 480];

export const PALETTE = [
  '#5b8cff', '#3ecf8e', '#f0a020', '#ff6b6b', '#c586ff',
  '#ff8bd0', '#4ecdc4', '#ffd93d', '#9aa5b1', '#ff7043',
];

const DEFAULTS = {
  name: '',
  color: '',          // пустой — выберется случайный при первом запуске
  voiceVolume: 1,
  micDevice: '',
  camDevice: '',
  // Своё изображение привычнее видеть зеркальным — так же, как в зеркале.
  // Собеседникам оно уходит как есть: переворачивать картинку у них было бы
  // странно, там сидит не их лицо.
  mirrorCam: true,
  sidebarSize: 0,     // ширина боковой панели в пикселях; 0 — по умолчанию
  outputDevice: '',   // куда выводить звук; пусто = системное по умолчанию
  denoise: 'rnnoise', // подавление шума: rnnoise | deepfilter | off
  monitor: false,     // слышать себя — только в наушниках, иначе заведётся
  quality: 'medium',  // выбранный профиль; custom — свои значения ниже
  streamHeight: 1080, // высота кадра, ширину подберёт браузер
  streamFps: 30,
  streamBitrate: 4,   // Мбит/с
  // Что беречь, когда канала не хватает: sharp | smooth. По умолчанию
  // чёткость — читаемая картинка нужнее плавной чаще, чем наоборот.
  streamPriority: 'sharp',
  hotkeys: {},        // переназначенные сочетания; остальное — из умолчаний
  peerVolumeByName: {},
  streamVolumeByName: {},   // громкость трансляций, тоже по имени
  rooms: [],                // сохранённые комнаты: { code, name }
  pairedHosts: [],         // адреса, с которыми Moonlight уже сопряжён
};

/**
 * Сохранённые настройки переживают обновления приложения, поэтому старые
 * значения нужно приводить к новому виду. Без этого `denoise: true` из прошлой
 * версии не совпадал ни с одним режимом, и подавление шума молча выключалось.
 */
function migrate(values) {
  // Обработки движка в приложении больше нет — ни эхоподавления, ни
  // автоусиления, ни его шумодава. Вместе с настройками уходят и сохранённые
  // значения, иначе они остались бы в хранилище навсегда. `version` был заведён
  // ради разового сброса автоусиления и вместе с ним же не нужен.
  delete values.echoCancellation;
  delete values.autoGainControl;
  delete values.version;
  if (typeof values.denoise === 'boolean') {
    values.denoise = values.denoise ? 'rnnoise' : 'off';
  }
  // У кого стояло подавление движком — тому модель: выбор «шумодав нужен» он
  // уже сделал, и молча оставлять его без шумодава неправильно.
  if (values.denoise === 'browser') values.denoise = 'rnnoise';
  if (!isModel(values.denoise) && values.denoise !== 'off') values.denoise = 'rnnoise';
  if (!(values.quality in PRESETS)) values.quality = 'medium';
  if (!['sharp', 'smooth'].includes(values.streamPriority)) values.streamPriority = 'sharp';

  // Цвет ника не спрашиваем на входе: если человек его не трогал, берём
  // случайный из палитры — так участники различаются с первой секунды.
  if (!PALETTE.includes(values.color)) {
    values.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  }
  return values;
}

export class Settings extends Emitter {
  constructor() {
    super();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch {}
    this.values = migrate({ ...DEFAULTS, ...saved });
    // Миграция могла что-то поправить — например, выбрать случайный цвет ника.
    // Без записи он выбирался бы заново при каждой загрузке.
    this._save();

    // Идентификаторы участников выдаются заново на каждый вход, поэтому
    // персональную громкость помним по нику — он у человека постоянный.
    this.peerVolume = new Map();
    this.names = new Map();                 // id участника -> его ник
    this.byName = new Map(Object.entries(this.values.peerVolumeByName ?? {}));

    // Вкладку могут закрыть в те миллисекунды, пока запись отложена.
    // `pagehide` приходит и на телефоне, где `beforeunload` часто не приходит.
    for (const event of ['pagehide', 'beforeunload']) {
      window.addEventListener(event, () => this.flush());
    }
    document.addEventListener('visibilitychange', () => document.hidden && this.flush());
  }

  /** Связывает id участника с ником, чтобы поднять сохранённую громкость. */
  trackPeer(id, name) {
    if (!name) return;
    this.names.set(id, name);
    if (this.byName.has(name) && !this.peerVolume.has(id)) {
      this.peerVolume.set(id, this.byName.get(name));
      this.emit('change', { key: 'peerVolume', value: id });
    }
  }

  get(k) { return this.values[k]; }

  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    this._save();
    this.emit('change', { key: k, value: v });
  }

  setPeerVolume(id, v) {
    this.peerVolume.set(id, v);
    const name = this.names.get(id);
    if (name) {
      this.byName.set(name, v);
      this.values.peerVolumeByName = Object.fromEntries(this.byName);
      this._save();
    }
    this.emit('change', { key: 'peerVolume', value: id });
  }

  peerVolumeOf(id) { return this.peerVolume.get(id) ?? 1; }

  /**
   * Громкость трансляции. Ключ — имя участника и вид потока: идентификаторы
   * выдаются заново на каждый вход, а имя постоянное, как и с голосом.
   */
  setStreamVolume(key, v) {
    this.values.streamVolumeByName = { ...this.values.streamVolumeByName, [key]: v };
    this._save();
  }

  streamVolumeOf(key) { return this.values.streamVolumeByName?.[key] ?? 1; }

  /**
   * Сохранённые комнаты. Список личный и лежит рядом с остальными настройками:
   * на сервере комнаты не живут вовсе — там только те, в которых кто-то сейчас
   * сидит. Код и есть комната, поэтому сохранить её значит запомнить код.
   */
  get rooms() { return this.values.rooms ?? []; }

  saveRoom(code, name) {
    const rooms = this.rooms.filter((r) => r.code !== code);
    rooms.push({ code, name: name || `Комната ${rooms.length + 1}` });
    this.set('rooms', rooms);
  }

  forgetRoom(code) {
    this.set('rooms', this.rooms.filter((r) => r.code !== code));
  }

  roomName(code) { return this.rooms.find((r) => r.code === code)?.name ?? ''; }

  /**
   * Ограничения захвата микрофона — и только его.
   *
   * Обработки движка нет вовсе: ни эхоподавления, ни автоусиления, ни его
   * шумодава. Настройкой они тоже больше не являются, поэтому здесь три
   * постоянных «нет», а не чтение из значений.
   *
   * Так три отдельные истории оказались одной. Эхоподавление берёт микрофон в
   * «разговорном» режиме: полоса режется до телефонной, а всё, что похоже на
   * отражение, — второй голос в комнате, музыка, свой же звук из динамиков —
   * глушится вместе с эхом. Автоусиление ведёт уровень само: поднимает в паузах
   * шум до голоса и приседает на каждом громком слове, отчего собеседник слышит
   * дышащий микрофон. Шумодав движка рядом с нашей моделью съедает согласные и
   * делает голос ватным.
   *
   * И главное — просьба к движку никогда не остаётся при микрофоне. Стоит
   * попросить у него хоть что-нибудь, как телефон переводит в разговорный режим
   * весь звук разом, вместе с воспроизведением: собеседники начинают звучать
   * как из трубки, хотя обработку просили не для них. Наша модель живёт в своём
   * графе и такого не делает.
   *
   * Просить явным `false` приходится потому, что без просьбы движок включает
   * всё это сам.
   */
  micConstraints() {
    const c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (this.values.micDevice) c.deviceId = { exact: this.values.micDevice };
    return c;
  }

  /**
   * Запись откладывается на кадр.
   *
   * Ползунок громкости шлёт событие на каждый пиксель, и на каждом же шла
   * сериализация всех настроек и синхронная запись в хранилище — десятки
   * блокирующих записей за одно движение мыши. Ничего страшного не случится,
   * если состояние ляжет на диск на шестнадцать миллисекунд позже.
   */
  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 16);
  }

  /** Записать немедленно: перед уходом со страницы ждать кадр уже нечем. */
  flush() {
    clearTimeout(this._saveTimer);
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch {}
  }
}
