// Горячие клавиши. Сочетания хранятся по физическому положению клавиши
// (`event.code`), а не по символу: иначе назначенное на латинице переставало
// работать при переключении на кириллицу.
//
// Кнопки мыши участвуют наравне с клавишами: боковые кнопки (`Mouse3`, `Mouse4`)
// — самый удобный способ отключить микрофон, не отрываясь от игры. Их можно
// сочетать с модификаторами: `Ctrl+Mouse4`.
//
// Сочетание сериализуется строкой вида `Ctrl+Shift+KeyM` — её же кладём в
// настройки, поэтому переназначение переживает перезагрузку.

/**
 * Действия, которым можно назначить клавиши. Порядок — как в настройках.
 *
 * `hold` — действие живёт, пока клавиша зажата: обработчик получает true при
 * нажатии и false при отпускании. Отпускание ловим по самой клавише, без
 * модификаторов: их отпускают первыми, и иначе действие бы залипло.
 */
export const ACTIONS = [
  { id: 'mic', title: 'Вкл/Выкл микрофон' },
  { id: 'push-mute', title: 'Молчать, пока зажато', hold: true },
  { id: 'deafen', title: 'Вкл/Выкл звук' },
  { id: 'takeover', title: 'Перехватить управление у гостя' },
];

const HOLD = new Set(ACTIONS.filter((a) => a.hold).map((a) => a.id));

/** Сама клавиша сочетания, без модификаторов: `Ctrl+KeyM` → `KeyM`. */
const tail = (combo) => combo.split('+').pop();

// По умолчанию ничего не занято: сочетание вешает сам человек. Так мы не
// отбираем комбинации у игры и у других программ.
const DEFAULT_HOTKEYS = Object.fromEntries(ACTIONS.map((a) => [a.id, '']));

const mods = (e) => {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  return parts;
};

/** Сочетание из события клавиатуры. Для чистого модификатора вернёт null. */
function fromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  return [...mods(e), e.code].join('+');
}

/** Сочетание из события мыши: кнопки нумеруются как в DOM. */
function fromMouse(e) {
  return [...mods(e), `Mouse${e.button}`].join('+');
}

const MOUSE_NAMES = {
  Mouse0: 'ЛКМ',
  Mouse1: 'СКМ',
  Mouse2: 'ПКМ',
  Mouse3: 'Мышь 4',
  Mouse4: 'Мышь 5',
};

/** Человекочитаемая запись: `Ctrl+Shift+KeyM` → `Ctrl + Shift + M`. */
export function label(combo) {
  if (!combo) return 'не назначено';
  const parts = combo.split('+');
  const code = parts.pop();
  const key =
    MOUSE_NAMES[code] ??
    code
      .replace(/^Key/, '')
      .replace(/^Digit/, '')
      .replace(/^Arrow/, '')
      .replace(/^Numpad/, 'Num ');
  return [...parts, key].join(' + ');
}

/**
 * Диспетчер: держит текущие назначения и вызывает обработчики.
 * Пока идёт запись нового сочетания, обычная обработка выключена.
 */
export class Hotkeys {
  constructor(settings) {
    this.settings = settings;
    this.handlers = new Map();
    this.recording = null;
    this.onChange = null;   // список изменился — надо перерегистрировать в системе
    this.holding = new Map();   // id действия -> клавиша, которой его держат

    document.addEventListener('keydown', (e) => this._handle(e, fromEvent(e)), true);
    document.addEventListener('mousedown', (e) => this._handle(e, fromMouse(e)), true);
    document.addEventListener('keyup', (e) => this._release(e.code), true);
    document.addEventListener('mouseup', (e) => this._release(`Mouse${e.button}`), true);
    // Клавишу можно отпустить уже за пределами окна — иначе микрофон остался бы
    // выключенным навсегда.
    window.addEventListener('blur', () => this.releaseAll());
    // Боковые кнопки в браузере листают историю — если они назначены, навигацию
    // надо погасить отдельно, mousedown её не отменяет.
    document.addEventListener('auxclick', (e) => this._guard(e), true);
    document.addEventListener('contextmenu', (e) => this._guard(e), true);
  }

  get map() {
    return { ...DEFAULT_HOTKEYS, ...(this.settings.get('hotkeys') ?? {}) };
  }

  get(id) { return this.map[id] ?? ''; }

  set(id, combo) {
    this.settings.set('hotkeys', { ...(this.settings.get('hotkeys') ?? {}), [id]: combo ?? '' });
    this.onChange?.(this.map);
  }

  /** Снять назначение. Умолчаний нет, поэтому это просто «ничего не занято». */
  reset(id) {
    this.set(id, '');
  }

  /** Только клавиатурные сочетания: кнопки мыши система глобально не отдаёт. */
  globalCombos() {
    return Object.entries(this.map).filter(([, c]) => c && !c.includes('Mouse'));
  }

  on(id, fn) { this.handlers.set(id, fn); }

  /**
   * Вызов действия по имени — для системных сочетаний, приходящих извне.
   * `down` важен только удерживаемым действиям, остальные срабатывают на нажатии.
   */
  fire(id, down = true) {
    if (!HOLD.has(id)) return void (down && this.handlers.get(id)?.());
    if (down === this.holding.has(id)) return;   // повтор нажатия не в счёт
    if (down) this.holding.set(id, tail(this.get(id)));
    else this.holding.delete(id);
    this.handlers.get(id)?.(down);
  }

  /** Отпустить всё удерживаемое: окно потеряло фокус или комната закрылась. */
  releaseAll() {
    for (const id of [...this.holding.keys()]) {
      this.holding.delete(id);
      this.handlers.get(id)?.(false);
    }
  }

  /** Клавишу отпустили: снимаем те действия, которые ею держали. */
  _release(key) {
    for (const [id, held] of this.holding) {
      if (held !== key) continue;
      this.holding.delete(id);
      this.handlers.get(id)?.(false);
    }
  }

  /** Ждёт следующее сочетание — с клавиатуры или с мыши. Escape отменяет. */
  record() {
    return new Promise((resolve) => (this.recording = resolve));
  }

  cancelRecording() {
    this.recording?.(null);
    this.recording = null;
  }

  /** Гасит стандартное поведение кнопки, если она занята под сочетание. */
  _guard(e) {
    const combo = e.type === 'contextmenu' ? null : fromMouse(e);
    if (this.recording || (combo && this._bound(combo))) e.preventDefault();
  }

  _bound(combo) {
    return [...this.handlers.keys()].some((id) => this.get(id) === combo);
  }

  _handle(e, combo) {
    if (this.recording) {
      if (!combo) return;          // ждём не модификатор, а саму клавишу
      e.preventDefault();
      e.stopPropagation();
      const done = this.recording;
      this.recording = null;
      done(e.code === 'Escape' ? null : combo);
      return;
    }
    if (!combo) return;

    // В поле ввода горячие клавиши без модификаторов только мешали бы.
    const tag = e.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
    if (typing && e.type === 'keydown' && !(e.ctrlKey || e.metaKey || e.altKey)) return;

    for (const id of this.handlers.keys()) {
      if (this.get(id) !== combo) continue;
      e.preventDefault();
      e.stopPropagation();
      this.fire(id, true);
      return;
    }
  }
}
