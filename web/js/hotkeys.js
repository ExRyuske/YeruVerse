// Горячие клавиши: назначения, их запись и разбор того, что сработало.
//
// Саму клавиатуру этот модуль больше не слушает. Срабатывание приходит снаружи,
// от оболочки приложения: она смотрит за клавиатурой на уровне системы (см.
// `keys.rs`) и присылает готовое имя действия. Так сочетание работает и из
// полноэкранной игры, где окно приложения не в фокусе, — ради чего его и
// назначают.
//
// Своя обработка в окне была вторым путём к тому же самому. Пока системная
// забирала клавишу себе, до окна нажатие просто не доходило и пути не
// пересекались; как только клавиша осталась общей, оба стали срабатывать разом,
// и нажатие в окне переключало микрофон дважды — то есть не переключало вовсе.
// Поэтому путь остался один.
//
// Кнопки мыши участвуют наравне с клавишами и ловятся тем же слежением. Раньше
// они работали только в окне приложения — то есть везде, кроме игры, ради
// которой их и назначают: боковую кнопку нажимают, не снимая руки с мыши.
//
// Клавиатура нужна здесь ещё в одном месте — когда сочетание записывают: его
// для того и нажимают, чтобы мы его увидели. Слушатель на это время и живёт.
//
// Сочетание хранится строкой вида `Ctrl+Shift+KeyM` — по физическому положению
// клавиши, а не по символу: иначе назначенное на латинице переставало бы
// работать на кириллице. Эта же строка уходит в настройки, поэтому назначения
// переживают перезагрузку.

/**
 * Действия, которым можно назначить клавиши. Порядок — как в настройках.
 *
 * `hold` — действие живёт, пока клавиша зажата: обработчик получает `true` при
 * нажатии и `false` при отпускании. Отпускание приходит оттуда же, откуда и
 * нажатие, и ловится по самой клавише, без модификаторов: их отпускают
 * первыми, и иначе действие бы залипло.
 */
export const ACTIONS = [
  { id: 'mic', title: 'Вкл/Выкл микрофон' },
  { id: 'push-mute', title: 'Молчать, пока зажато', hold: true },
  { id: 'deafen', title: 'Вкл/Выкл звук' },
  { id: 'takeover', title: 'Перехватить управление у гостя' },
];

const HOLD = new Set(ACTIONS.filter((a) => a.hold).map((a) => a.id));

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

/**
 * Кнопки, которые сами по себе сочетанием быть не могут.
 *
 * Левая и правая нажимаются по сотне раз на дню и означают «выбрать» и «меню» —
 * везде, во всей системе. Назначенные без модификатора, они дёргали бы действие
 * на каждый щелчок, где бы человек ни щёлкал. Со Ctrl или Alt — пожалуйста:
 * такое сочетание он нажимает намеренно.
 */
const BARE = new Set(['Mouse0', 'Mouse2']);

const usable = (combo) => !BARE.has(combo);

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
 * Назначения и обработчики к ним.
 *
 * Откуда пришло срабатывание, здесь неважно: и слежение за клавиатурой, и
 * запасная регистрация у системы зовут один и тот же `fire`. Разница между ними
 * — в том, забирается ли клавиша у остальных программ, и живёт она целиком в
 * оболочке.
 */
export class Hotkeys {
  constructor(settings) {
    this.settings = settings;
    this.handlers = new Map();
    this.recording = null;
    this.onChange = null;   // список изменился — надо передать его оболочке
    this.held = new Set();  // действия, которые сейчас держат нажатыми
  }

  get map() {
    return { ...DEFAULT_HOTKEYS, ...(this.settings.get('hotkeys') ?? {}) };
  }

  get(id) { return this.map[id] ?? ''; }

  set(id, combo) {
    // Держать действие стало нечем: клавиша, которой его держали, только что
    // перестала быть назначенной, и отпускание по ней уже не придёт.
    this.releaseAll();
    this.settings.set('hotkeys', { ...(this.settings.get('hotkeys') ?? {}), [id]: combo ?? '' });
    this.onChange?.(this.map);
  }

  /** Снять назначение. Умолчаний нет, поэтому это просто «ничего не занято». */
  reset(id) {
    this.set(id, '');
  }

  /** Что назначено — списком для оболочки. Пустые места ей не нужны. */
  combos() {
    return Object.entries(this.map).filter(([, combo]) => combo);
  }

  on(id, fn) { this.handlers.set(id, fn); }

  /**
   * Действие сработало. `down` важен только удерживаемым действиям, остальные
   * срабатывают на нажатии.
   */
  fire(id, down = true) {
    if (!HOLD.has(id)) return void (down && this.handlers.get(id)?.());
    if (down === this.held.has(id)) return;   // повтор нажатия не в счёт
    if (down) this.held.add(id);
    else this.held.delete(id);
    this.handlers.get(id)?.(down);
  }

  /** Отпустить всё удерживаемое: назначения сменились или комната закрылась. */
  releaseAll() {
    for (const id of [...this.held]) {
      this.held.delete(id);
      this.handlers.get(id)?.(false);
    }
  }

  /**
   * Ждёт следующее сочетание с клавиатуры. Escape отменяет.
   *
   * Слушатель живёт ровно столько, сколько идёт запись: в остальное время
   * клавиатура этому модулю не нужна, и висеть на ней незачем.
   *
   * Начатая запись отменяет предыдущую. Ждёт их всегда ровно одна кнопка, но
   * нажать «изменить» можно и у второй строки, не тронув клавиш в первой: пока
   * прежнее обещание просто затиралось, оно не разрешалось никогда, и брошенная
   * строка навсегда оставалась с надписью «нажмите клавиши…».
   */
  record() {
    this.cancelRecording();
    return new Promise((resolve) => {
      const finish = (combo) => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onMouse, true);
        this.recording = null;
        resolve(combo);
      };
      const onKey = (e) => {
        const combo = fromEvent(e);
        if (!combo) return;      // ждём не модификатор, а саму клавишу
        e.preventDefault();
        e.stopPropagation();     // иначе Escape уйдёт дальше и закроет настройки
        finish(e.code === 'Escape' ? null : combo);
      };
      const onMouse = (e) => {
        const combo = fromMouse(e);
        // Голый щелчок мимо: он не назначение, а обычный щелчок — им человек
        // и отменяет запись, ткнув в сторону.
        if (!usable(combo)) return;
        e.preventDefault();
        e.stopPropagation();
        finish(combo);
      };
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onMouse, true);
      this.recording = finish;
    });
  }

  cancelRecording() {
    this.recording?.(null);
  }
}
