// Настройки пользователя: живут в localStorage и переживают перезаход в комнату.
// Громкости отдельных участников не сохраняем — id выдаются заново на каждый вход.

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
  outputDevice: '',   // куда выводить звук; пусто = системное по умолчанию
  denoise: 'rnnoise', // подавление шума: rnnoise | browser | off
  quality: 'medium',  // выбранный профиль; custom — свои значения ниже
  streamHeight: 1080, // высота кадра, ширину подберёт браузер
  streamFps: 30,
  streamBitrate: 4,   // Мбит/с
  hotkeys: {},        // переназначенные сочетания; остальное — из умолчаний
  peerVolumeByName: {},
  streamVolumeByName: {},   // громкость трансляций, тоже по имени
  echoCancellation: true,
  autoGainControl: true,
  pairedHosts: [],         // адреса, с которыми Moonlight уже сопряжён
};

/**
 * Сохранённые настройки переживают обновления приложения, поэтому старые
 * значения нужно приводить к новому виду. Без этого `denoise: true` из прошлой
 * версии не совпадал ни с одним режимом, и подавление шума молча выключалось.
 */
function migrate(values) {
  if (typeof values.denoise === 'boolean') {
    values.denoise = values.denoise ? 'rnnoise' : 'off';
  }
  if (!['rnnoise', 'browser', 'off'].includes(values.denoise)) {
    values.denoise = 'rnnoise';
  }
  if (!(values.quality in PRESETS)) values.quality = 'medium';

  // Цвет ника не спрашиваем на входе: если человек его не трогал, берём
  // случайный из палитры — так участники различаются с первой секунды.
  if (!PALETTE.includes(values.color)) {
    values.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  }
  return values;
}

export class Settings extends EventTarget {
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
  }

  /** Связывает id участника с ником, чтобы поднять сохранённую громкость. */
  trackPeer(id, name) {
    if (!name) return;
    this.names.set(id, name);
    if (this.byName.has(name) && !this.peerVolume.has(id)) {
      this.peerVolume.set(id, this.byName.get(name));
      this.dispatchEvent(new CustomEvent('change', { detail: { key: 'peerVolume', value: id } }));
    }
  }

  get(k) { return this.values[k]; }

  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: v } }));
  }

  setPeerVolume(id, v) {
    this.peerVolume.set(id, v);
    const name = this.names.get(id);
    if (name) {
      this.byName.set(name, v);
      this.values.peerVolumeByName = Object.fromEntries(this.byName);
      this._save();
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { key: 'peerVolume', value: id } }));
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

  on(fn) { this.addEventListener('change', (e) => fn(e.detail)); }

  /**
   * Ограничения захвата микрофона. Браузерное подавление включаем только когда
   * выбрано именно оно: вместе с RNNoise два шумодава подряд съедают согласные
   * и делают голос ватным.
   */
  audioConstraints() {
    const c = {
      echoCancellation: this.values.echoCancellation,
      noiseSuppression: this.values.denoise === 'browser',
      autoGainControl: this.values.autoGainControl,
    };
    if (this.values.micDevice) c.deviceId = { exact: this.values.micDevice };
    return c;
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch {}
  }
}
