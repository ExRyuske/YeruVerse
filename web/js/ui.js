// Мелочи, нужные всем модулям интерфейса. Держим их отдельно, чтобы модули
// не тянули друг друга ради одной функции форматирования.

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

/**
 * Куда вешать то, что должно быть поверх всего.
 *
 * В полноэкранном режиме браузер рисует только поддерево занявшего его
 * элемента: узел, добавленный к body, существует, но не виден. Поэтому во
 * весь экран поверх видео открывается только то, что живёт внутри него.
 */
export function overlayHost() {
  return document.fullscreenElement ?? document.body;
}

let toastTimer;

/** Подсказка внизу экрана. Длинным советам нужно больше времени на чтение. */
export function toast(text, ms = 3500) {
  const el = $('#toast');
  // Тот же случай: из body подсказку в полном экране не видно.
  if (el.parentElement !== overlayHost()) overlayHost().appendChild(el);
  el.innerHTML = '';
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
  document.addEventListener('keydown', onKey, true);
  box.append(img);
  overlayHost().appendChild(box);
}

/** Живой поток во весь экран. Закрывается щелчком или Escape, как и картинка. */
export function showVideo(stream) {
  if (!stream) return;
  const box = document.createElement('div');
  box.className = 'lightbox';

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
  document.addEventListener('keydown', onKey, true);
  box.append(video);
  overlayHost().appendChild(box);
  video.play().catch(() => {});
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
