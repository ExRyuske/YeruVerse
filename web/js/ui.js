// Мелочи, нужные всем модулям интерфейса. Держим их отдельно, чтобы модули
// не тянули друг друга ради одной функции форматирования.

import { icon } from './icons.js';
import { native } from './native.js';

export const $ = (sel) => document.querySelector(sel);

/**
 * То же, что $, но для развески обработчиков. Если элемента нет — вернём
 * пустышку и предупредим. Так рассинхрон разметки и скрипта (браузер отдал из
 * кэша старый app.js к новому index.html) ломает одну кнопку, а не весь
 * интерфейс: остальные обработчики продолжают вешаться.
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

/** Экранов ровно два: вход и комната. Возврат на вход снимает прошлую ошибку. */
export function showScreen(name) {
  $('#screen-join').hidden = name !== 'join';
  $('#screen-room').hidden = name !== 'room';
  if (name === 'join') $('#join-error').hidden = true;
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

/** Подсказка внизу экрана. Длинным советам нужно больше времени на чтение. */
export function toast(text, ms = 3500) {
  const el = $('#toast');
  // Тот же случай: из body подсказку в полном экране не видно.
  if (el.parentElement !== overlayHost()) overlayHost().appendChild(el);
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
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
  const el = $('#toast');
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'muted small';
  title.textContent = label;
  const body = document.createElement('code');
  body.className = 'pick';
  body.textContent = text;
  el.append(title, body);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 15000);
}

/**
 * Картинка во весь экран.
 *
 * Своё окно, а не `window.open`: тот в приложении открывает системный браузер, а
 * на телефоне — новую вкладку, из которой ещё надо возвращаться. Закрывается
 * щелчком или Escape.
 */
export function showImage(src, name = '') {
  const box = document.createElement('div');
  box.className = 'lightbox';

  const img = document.createElement('img');
  img.src = src;
  img.alt = name;

  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();      // иначе Escape уйдёт дальше и закроет что-то ещё
    close();
  };

  box.onclick = close;
  box.close = close;
  document.addEventListener('keydown', onKey, true);
  box.append(img);
  overlayHost().appendChild(box);
}

/**
 * Живой поток крупно. Закрывается щелчком или Escape, как и картинка.
 *
 * По умолчанию — поверх всего окна, но камеру разворачивают внутри сцены:
 * `host` для того и нужен. Тогда рядом остаётся и чат, и список участников —
 * увеличенное лицо собеседника не повод убирать со стола всё остальное.
 */
export function showVideo(stream, host = null, { mirror = false } = {}) {
  if (!stream) return;
  const where = host ?? overlayHost();

  // Полоса камер остаётся на виду поверх увеличенной, и с неё можно сразу
  // открыть другую. Значит, второе увеличение должно заменять первое, а не
  // ложиться поверх него стопкой.
  where.querySelector(':scope > .lightbox')?.close?.();

  const box = document.createElement('div');
  box.className = `${host ? 'lightbox inside' : 'lightbox'}${mirror ? ' mirror' : ''}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;        // звук уже идёт своим путём, второй раз не нужен
  video.srcObject = stream;

  const close = () => {
    video.srcObject = null;  // иначе декодер продолжит работать в оторванном узле
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  box.onclick = close;
  box.close = close;      // чтобы следующее увеличение закрыло это, а не спрятало
  document.addEventListener('keydown', onKey, true);
  box.append(video);
  where.appendChild(box);
  video.play().catch(() => {});
}

/**
 * Компактный ползунок громкости: кнопка-выключатель и шкала рядом.
 *
 * Один на два случая — голос участника и звук трансляции. Отличались они только
 * пределом и тем, куда сохранять значение, а кода было по тридцать строк на
 * каждый, слово в слово.
 */
export function volumeSlider({ max, label, get, set }) {
  const wrap = document.createElement('span');
  wrap.className = 'pv-mini';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mark';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0;
  slider.max = max;

  const show = () => {
    const v = Number(slider.value);
    btn.innerHTML = icon(v === 0 ? 'speaker-off' : 'speaker');
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
  wrap.append(btn, slider);
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

export function fmtClock(at) {
  return new Date(at ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
