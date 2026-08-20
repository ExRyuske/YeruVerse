// Мелочи, нужные всем модулям интерфейса. Держим их отдельно, чтобы модули
// не тянули друг друга ради одной функции форматирования.

import { icon } from './icons.js';
import { native } from './native.js';

/**
 * Поиск по разметке. Возвращает `null`, если элемента нет, — этим `$` и
 * отличается от `ui`: сюда обращаются за тем, чего может не быть.
 */
export const $ = (sel) => document.querySelector(sel);

/**
 * То же, что $, но для обязательных элементов: развеска обработчиков и любая
 * запись в узел. Если элемента нет — вернём пустышку и предупредим. Так
 * рассинхрон разметки и скрипта (браузер отдал из кэша старый app.js к новому
 * index.html) ломает одну кнопку, а не весь интерфейс: остальные обработчики
 * продолжают вешаться.
 */
let missingWarned = false;
export function ui(sel) {
  const el = $(sel);
  if (el) return el;
  console.warn(`YeruVerse: нет элемента ${sel} — разметка и скрипт разъехались`);
  if (!missingWarned) {
    missingWarned = true;
    recoverFromStale();
  }
  return document.createElement('div');
}

const RECOVERED = 'yeruverse:recovered';

/**
 * Разметка и скрипт разъехались — почти всегда виноват промежуточный кэш,
 * отдавший старый файл. Перезагружаемся один раз с уникальным параметром:
 * такого адреса нет ни в браузере, ни у CDN, поэтому придёт свежая версия.
 * Второй попытки не делаем, иначе получится вечный цикл перезагрузок.
 */
function recoverFromStale() {
  let already = false;
  try {
    already = !!sessionStorage.getItem(RECOVERED);
    sessionStorage.setItem(RECOVERED, '1');
  } catch {}

  if (already) {
    setTimeout(() => toast('Страница загрузилась частично — обновите её'), 800);
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set('_', Date.now().toString(36));
  location.replace(url);
}

export function clearStaleFlag() {
  if (missingWarned) return;
  try { sessionStorage.removeItem(RECOVERED); } catch {}
}

/**
 * Собрать узел.
 *
 * Интерфейс здесь строится из узлов, а не из строк разметки, и это не вкус:
 * в комнату приходят чужие ники, чужие имена файлов и чужой текст, а узел
 * подставить в разметку нельзя — его можно только положить. Цена была в том,
 * что каждая кнопка занимала пять строк подряд — `createElement`, `type`,
 * `className`, `title`, `onclick`, — и таких мест по проекту набралось больше
 * тридцати, слово в слово.
 *
 * Свойства узнаются по имени: `text` — безопасный текст, `html` — заведомо
 * своя разметка (только `icon()`), `class` — класс, `style` — объект правил,
 * `on*` — обработчик, остальное кладётся в само свойство узла. Дети идут
 * следом и принимают как узлы, так и строки.
 */
export function make(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  // Кнопке без типа браузер даёт `submit`, и внутри формы чата любая из них
  // отправляла бы сообщение. Проставляем сами — забыть это можно ровно раз.
  if (tag === 'button') node.type = 'button';

  for (const [key, value] of Object.entries(props)) {
    // Пустое свойство просто не ставим: у свежего узла булевы и так ложны, а
    // необязательные — цвет, подсказка, обработчик — приходят сюда пустыми
    // сплошь и рядом, и городить условие вокруг каждого пришлось бы на месте.
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else node[key] = value;
  }

  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

/**
 * Сменить значок у уже стоящей кнопки.
 *
 * Кнопки микрофона, звука и полного экрана меняют значок, а не пересоздаются:
 * они стоят в разметке, и у них своё место, свой фокус и свои обработчики.
 * Способ положить значок в узел должен быть один и тот же — что при сборке
 * узла (`make(..., { html: icon(...) })`), что здесь.
 */
export function setIcon(el, name, title = null) {
  el.innerHTML = icon(name);
  if (title != null) el.title = title;
}

/**
 * Значок-выключатель в строке участника: замок, микрофон, трансляция, камера.
 *
 * Все они выглядят и ведут себя одинаково — квадрат со значком, который
 * подсвечен или перечёркнут, — и собирались в трёх модулях по отдельности.
 * Без обработчика получается не кнопка, а просто метка: у выключенного
 * микрофона собеседника нажимать нечего.
 */
export function markButton({ glyph, title, on = false, off = false, onclick = null }) {
  const cls = `mark${on ? ' on' : ''}${off ? ' off' : ''}`;
  return make(onclick ? 'button' : 'span', { class: cls, title, html: icon(glyph), onclick });
}

/** Экранов ровно два: вход и комната. Возврат на вход снимает прошлую ошибку. */
export function showScreen(name) {
  ui('#screen-join').hidden = name !== 'join';
  ui('#screen-room').hidden = name !== 'room';
  if (name === 'join') ui('#join-error').hidden = true;
}

/**
 * Куда вешать то, что должно быть поверх всего.
 *
 * В полноэкранном режиме браузер рисует только поддерево занявшего его
 * элемента: узел, добавленный к body, существует, но не виден. Поэтому во
 * весь экран поверх видео открывается только то, что живёт внутри него.
 */
function overlayHost() {
  return document.fullscreenElement ?? document.body;
}

let toastTimer;

/** Показать подсказку с готовым содержимым и погасить её через `ms`. */
function showToast(ms, ...content) {
  const el = ui('#toast');
  // Тот же случай, что и с увеличением: из body подсказку в полном экране не
  // видно — она живёт вне поддерева, которое браузер рисует.
  if (el.parentElement !== overlayHost()) overlayHost().appendChild(el);
  el.replaceChildren(...content);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/** Подсказка внизу экрана. Длинным советам нужно больше времени на чтение. */
export function toast(text, ms = 3500) {
  showToast(ms, text);
}

/**
 * Копирование с запасным вариантом. prompt() здесь не годится: системный webview
 * приложения его не показывает — вместо этого выводим текст в подсказке,
 * откуда его можно выделить и скопировать руками.
 */
export function copy(text, ok, label) {
  const fallback = () => showCopyFallback(label, text);
  try {
    navigator.clipboard?.writeText(text).then(() => toast(ok), fallback) ?? fallback();
  } catch {
    fallback();
  }
}

function showCopyFallback(label, text) {
  // Дольше обычной подсказки: этот текст не читают, а переписывают руками.
  showToast(
    15000,
    make('div', { class: 'muted small', text: label }),
    make('code', { class: 'pick', text })
  );
}

/**
 * Увеличение поверх всего: щелчок или Escape закрывают.
 *
 * Одно на картинку и на живой поток — отличались они только содержимым и тем,
 * что видео надо ещё и остановить, а кода было по тридцать строк на каждое,
 * слово в слово. Своё окно, а не `window.open`: тот в приложении открывает
 * системный браузер, а на телефоне — новую вкладку, из которой ещё надо
 * возвращаться.
 *
 * Возвращает само окно: закрывать его приходится не только человеку. Поток
 * кончается сам собой — камеру выключили, участник ушёл, — и тогда убирать
 * увеличение будет тот, кто про это узнал.
 */
function lightbox(where, cls, child, onClose = null) {
  // Полоса камер остаётся на виду поверх увеличенной, и с неё можно сразу
  // открыть другую. Значит, второе увеличение должно заменять первое, а не
  // ложиться поверх него стопкой.
  where.querySelector(':scope > .lightbox')?.close?.();

  const close = () => {
    onClose?.();
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();      // иначе Escape уйдёт дальше и закроет что-то ещё
    close();
  };

  const box = make('div', { class: cls, onclick: close }, child);
  box.close = close;      // чтобы следующее увеличение закрыло это, а не спрятало
  document.addEventListener('keydown', onKey, true);
  where.appendChild(box);
  return box;
}

/** Картинка во весь экран. */
export function showImage(src, name = '') {
  return lightbox(overlayHost(), 'lightbox', make('img', { src, alt: name }));
}

/**
 * Живой поток крупно.
 *
 * По умолчанию — поверх всего окна, но камеру разворачивают внутри сцены:
 * `host` для того и нужен. Тогда рядом остаётся и чат, и список участников —
 * увеличенное лицо собеседника не повод убирать со стола всё остальное.
 */
export function showVideo(stream, host = null, { mirror = false } = {}) {
  if (!stream) return;

  const video = make('video', {
    autoplay: true,
    playsInline: true,
    muted: true,        // звук уже идёт своим путём, второй раз не нужен
    srcObject: stream,
  });

  const box = lightbox(
    host ?? overlayHost(),
    `${host ? 'lightbox inside' : 'lightbox'}${mirror ? ' mirror' : ''}`,
    video,
    // Иначе декодер продолжит работать в оторванном от документа узле.
    () => (video.srcObject = null)
  );
  video.play().catch(() => {});
  return box;
}

/**
 * Компактный ползунок громкости: кнопка-выключатель и шкала рядом.
 *
 * Один на два случая — голос участника и звук трансляции. Отличались они только
 * пределом и тем, куда сохранять значение, а кода было по тридцать строк на
 * каждый, слово в слово.
 */
export function volumeSlider({ max, label, get, set }) {
  const btn = make('button', { class: 'mark' });
  const slider = make('input', { type: 'range', min: 0, max });
  const wrap = make('span', { class: 'pv-mini' }, btn, slider);

  const show = () => {
    const v = Number(slider.value);
    setIcon(btn, v === 0 ? 'speaker-off' : 'speaker');
    wrap.title = `${label} ${v}%`;
  };

  slider.oninput = () => {
    set(Number(slider.value) / 100);
    show();
  };

  let before = 1;
  btn.onclick = () => {
    const now = Number(slider.value);
    if (now > 0) before = now;
    slider.value = now > 0 ? 0 : before;
    slider.oninput();
  };

  /**
   * Подтянуть сохранённое значение. Шкалу под пальцем не трогаем: громкость
   * могла обновиться из-за чужого события ровно в этот момент, и дёрнуть её
   * назад было бы хуже, чем показать на кадр устаревшее число.
   */
  wrap.sync = () => {
    if (document.activeElement === slider) return;
    slider.value = Math.round(get() * 100);
    show();
  };

  wrap.sync();
  return wrap;
}

/**
 * Внешняя ссылка. В приложении её открывает система: переход внутри окна увёл
 * бы человека из комнаты, а вернуться оттуда нечем.
 */
export function openExternal(url) {
  if (native.available) native.openUrl(url).catch(() => window.open(url, '_blank'));
  else window.open(url, '_blank', 'noopener');
}

export function fmtSize(b) {
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * Час и минуты — всегда в двадцатичетырёхчасовом виде.
 *
 * `toLocaleTimeString` без указаний берёт формат системы, а у неё он бывает
 * двенадцатичасовым: в чате это давало «03:18 PM» — вдвое длиннее нужного и не
 * на том языке, на котором всё остальное. Час здесь стоит ради порядка строк, а
 * не ради локали, и «15:18» отвечает на этот вопрос короче.
 */
export function fmtClock(at) {
  return new Date(at ?? Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
