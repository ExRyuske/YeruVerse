// Оболочка окна: боковая панель, всплывающие настройки у кнопок и полный экран.
// Всё это про то, как расставлено, а не про то, что показано.

import { native, settings } from './core.js';
import { $, ui } from './ui.js';
import { icon } from './icons.js';

export function wireLayout() {
  wireSidebar();
  wirePopovers();
  ui('#btn-full').onclick = toggleFullscreen;
}

/**
 * Настройки, привязанные к кнопке: раскрываются над ней и закрываются от
 * любого щелчка мимо. Всё, что не относится ни к одной кнопке — ник, цвет,
 * сочетания, диагностика, — осталось в общем окне настроек.
 */
function wirePopovers() {
  const pops = [...document.querySelectorAll('.pop')];
  const carets = [...document.querySelectorAll('[data-pop]')];

  const close = (except = null) => {
    for (const pop of pops) {
      if (pop === except) continue;
      pop.hidden = true;
      document.querySelector(`[data-pop="${pop.id}"]`)?.classList.remove('open');
    }
  };

  for (const caret of carets) {
    caret.onclick = (e) => {
      e.stopPropagation();      // иначе тот же щелчок тут же и закроет панель
      const pop = $(`#${caret.dataset.pop}`);
      const show = pop.hidden;
      close();
      pop.hidden = !show;
      caret.classList.toggle('open', show);
      // Панель у правого края не должна уезжать за границу окна.
      pop.style.left = '';
      pop.style.right = '';
      if (show && pop.getBoundingClientRect().right > window.innerWidth - 8) {
        pop.style.left = 'auto';
        pop.style.right = '0';
      }
    };
  }

  document.addEventListener('click', (e) => !e.target.closest('.pop') && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

/**
 * Боковую панель тянут за край: чат кому-то нужен пошире, кому-то не нужен
 * вовсе. Размер запоминается — на узком экране это высота, на широком ширина.
 */
function wireSidebar() {
  const grip = ui('#sidebar-grip');
  const bar = $('#sidebar');
  const vertical = () => window.matchMedia('(max-width: 860px)').matches;

  const apply = (px) => {
    if (!px) return;
    // Панель не должна ни исчезнуть, ни съесть сцену целиком.
    const room = (vertical() ? window.innerHeight : window.innerWidth) - 260;
    const size = Math.max(200, Math.min(px, Math.max(200, room)));
    bar.style[vertical() ? 'height' : 'width'] = `${size}px`;
    bar.style[vertical() ? 'width' : 'height'] = '';
  };
  apply(settings.get('sidebarSize'));
  window.addEventListener('resize', () => apply(settings.get('sidebarSize')));

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('resizing');

    const start = vertical() ? e.clientY : e.clientX;
    const was = vertical() ? bar.offsetHeight : bar.offsetWidth;

    const move = (ev) => {
      // Панель справа и снизу, поэтому движение к ней уменьшает размер.
      const delta = start - (vertical() ? ev.clientY : ev.clientX);
      apply(was + delta);
    };
    const stop = () => {
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      settings.set('sidebarSize', vertical() ? bar.offsetHeight : bar.offsetWidth);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop, { once: true });
    grip.addEventListener('pointercancel', stop, { once: true });
  });
}

// ---------------------------------------------------------------- полный экран

/**
 * Полный экран разворачивает всю сцену вместе с переключателями трансляций и
 * кнопками — иначе в нём нельзя ни переключиться, ни поставить паузу.
 * На iPhone Fullscreen API для обычных элементов нет, там остаётся только
 * системный полноэкранный режим самого видео.
 */
function fullscreenEl() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function fullscreenOn() {
  return !!fullscreenEl() || document.body.classList.contains('fullscreen');
}

/**
 * Полный экран.
 *
 * В приложении разворачиваем само окно: в Android-вебвью Fullscreen API для
 * обычных элементов не работает — показывать их поверх приложения там некому.
 * С точки зрения человека разницы нет, но класс на body в этом случае ставим
 * сами: событие fullscreenchange при таком развороте не приходит.
 */
async function toggleFullscreen() {
  const on = !fullscreenOn();

  if (native.available) {
    try {
      await native.setFullscreen(on);
      applyFullscreen(on);
      return;
    } catch {}   // не вышло — пробуем обычным путём
  }

  // Развернули без Fullscreen API — свернуть можно только тем же способом.
  const el = fullscreenEl();
  if (!on && !el) return applyFullscreen(false);

  const host = $('.stage-wrap');
  try {
    if (el) {
      await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
      return;
    }
    // Safari до 16.4 и системный вебвью знают только версию с приставкой.
    const request = host.requestFullscreen ?? host.webkitRequestFullscreen;
    if (!request) throw new Error('нет Fullscreen API');
    await request.call(host, { navigationUI: 'hide' });
  } catch {
    // iPhone и Android-вебвью разворачивать элементы не умеют. Сцену всё равно
    // растягиваем на всё окно: системные панели останутся, но шапка, чат и
    // список комнат уйдут, и смотреть станет заметно удобнее.
    applyFullscreen(on);
  }
}

function applyFullscreen(on) {
  const btn = $('#btn-full');
  btn.innerHTML = icon(on ? 'collapse' : 'expand');
  btn.title = on ? 'Выйти из полного экрана' : 'Во весь экран';
  document.body.classList.toggle('fullscreen', on);
  wakeControls();
}

for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => applyFullscreen(!!fullscreenEl()));
}

/**
 * В полном экране панель воспроизведения и переключатели прячутся, пока мышь
 * стоит: они перекрывают нижнюю часть кадра. Раньше это держалось на `:hover`,
 * а неподвижный курсор над сценой — это вечное наведение, и панель не гасла.
 */
let idleTimer;
function wakeControls() {
  clearTimeout(idleTimer);
  document.body.classList.remove('idle');
  if (!fullscreenOn()) return;
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
}

for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
  document.addEventListener(ev, wakeControls, true);
}
