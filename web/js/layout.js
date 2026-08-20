// Оболочка окна: боковая панель, всплывающие настройки у кнопок и полный экран.
// Всё это про то, как расставлено, а не про то, что показано.

import { native, settings } from './core.js';
import { setIcon, ui } from './ui.js';

export function wireLayout() {
  wireSidebar();
  wirePopovers();
  trackBar();
  ui('#btn-full').onclick = toggleFullscreen;
}

/**
 * Высота полосы управления — в переменную, чтобы полоса камер поднималась над
 * настоящим её размером, а не над числом в стилях.
 *
 * В полном экране полоса бывает в одну строку и в две: переключатели трансляций
 * встают отдельной строкой, когда есть что переключать. Пока место под неё
 * отмерялось числом, на телефоне кнопки налезали на плитку камеры и закрывали
 * её нижнюю треть вместе с подписью — числа хватало на полосу в одну строку, а
 * она бывает выше.
 */
function trackBar() {
  const sources = ui('.sources');
  const sync = () => document.body.style.setProperty('--bar', `${sources.offsetHeight}px`);

  sync();
  // Переменная меняет положение полосы камер, но не размер самой полосы
  // управления, — обратной связи здесь нет, и наблюдатель сам себя не разбудит.
  new ResizeObserver(sync).observe(sources);
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
      const pop = ui(`#${caret.dataset.pop}`);
      const show = pop.hidden;
      close();
      pop.hidden = !show;
      caret.classList.toggle('open', show);
      if (show) fit(pop);
    };
  }

  document.addEventListener('click', (e) => !e.target.closest('.pop') && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  // Экран мог перевернуть или клавиатура могла вылезти — место под панелью
  // меняется, пока она открыта.
  window.addEventListener('resize', () => {
    for (const pop of pops) if (!pop.hidden) fit(pop);
  });
}

/** Отступ от краёв окна: панель не должна лежать вплотную к ним. */
const EDGE = 8;

/**
 * Вписать раскрытую панель в окно.
 *
 * Панель раскрывается вверх от своей кнопки, а кнопки живут у нижнего края
 * сцены — и на телефоне места над ними мало. Настройки микрофона занимают
 * триста пятьдесят точек, качества трансляции — под пятьсот: на экране 360×640
 * начало обеих оказывалось за верхним краем, вместе с выбором устройства, ради
 * которого их и открывают. Достать его было нечем — панель никуда не
 * прокручивалась, потому что целиком помещалась в разметку, просто выше окна.
 *
 * Поэтому меряем не панель, а место: сколько его есть над кнопкой, такой
 * высоты панель и будет, а остальное уедет в прокрутку внутри неё.
 */
function fit(pop) {
  // Считаем от чистого листа: прошлые правки сбивают замер.
  pop.style.left = '';
  pop.style.right = '';
  pop.style.maxHeight = '';

  const box = pop.getBoundingClientRect();
  if (box.right > window.innerWidth - EDGE) {
    pop.style.left = 'auto';
    pop.style.right = '0';
  }
  // Нижний край панели закреплён у кнопки, поэтому вся высота растёт вверх:
  // ограничив её, мы опускаем верх панели, а не двигаем низ.
  const room = box.bottom - EDGE;
  if (box.height > room) pop.style.maxHeight = `${Math.max(140, room)}px`;
}

/**
 * Боковую панель тянут за край: чат кому-то нужен пошире, кому-то не нужен
 * вовсе. Размер запоминается — на узком экране это высота, на широком ширина.
 */
function wireSidebar() {
  const grip = ui('#sidebar-grip');
  const bar = ui('#sidebar');
  // Панель ложится снизу только на вертикальном телефоне. Стоит его повернуть —
  // и она встаёт сбоку, как на большом экране; тянуть её тогда надо вбок, а не
  // вверх. Пока здесь стояла одна проверка ширины, в горизонтали полоска меняла
  // высоту панели, которая высоту и так занимала всю.
  const stacked = () =>
    window.matchMedia('(max-width: 860px) and (orientation: portrait)').matches;

  const apply = (px) => {
    if (!px) return;
    // Панель не должна ни исчезнуть, ни съесть сцену целиком.
    const room = (stacked() ? window.innerHeight : window.innerWidth) - 260;
    const size = Math.max(200, Math.min(px, Math.max(200, room)));
    bar.style[stacked() ? 'height' : 'width'] = `${size}px`;
    bar.style[stacked() ? 'width' : 'height'] = '';
  };
  apply(settings.get('sidebarSize'));
  window.addEventListener('resize', () => apply(settings.get('sidebarSize')));

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('resizing');

    const start = stacked() ? e.clientY : e.clientX;
    const was = stacked() ? bar.offsetHeight : bar.offsetWidth;

    const move = (ev) => {
      // Панель справа и снизу, поэтому движение к ней уменьшает размер.
      const delta = start - (stacked() ? ev.clientY : ev.clientX);
      apply(was + delta);
    };
    const stop = () => {
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      settings.set('sidebarSize', stacked() ? bar.offsetHeight : bar.offsetWidth);
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

  const host = ui('.stage-wrap');
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
  const btn = ui('#btn-full');
  setIcon(btn, on ? 'collapse' : 'expand', on ? 'Выйти из полного экрана' : 'Во весь экран');
  document.body.classList.toggle('fullscreen', on);
  wakeControls();
}

for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => applyFullscreen(!!fullscreenEl()));
}

/** Сколько полоса держится после того, как её перестали трогать. */
const IDLE_MS = 2500;

/**
 * Насколько близко к нижнему краю должна подойти мышь, чтобы полоса вышла.
 * Примерно её собственная высота: тянешься к кнопкам — она появляется.
 */
const NEAR_CONTROLS = 180;

/**
 * Будит ли это событие полосу управления.
 *
 * В полном экране полоса выходит навстречу мыши, а не на любое её шевеление.
 * Пока будило любое, она не гасла как раз там, где мешает больше всего: в игре
 * и при удалённом управлении курсор не стоит на месте ни секунды, и полоса
 * висела над кадром всё время, ради которого полный экран и включали.
 *
 * Палец, перо и клавиатура будят откуда угодно: тянуться пальцем «вниз» не к
 * чему — тач-экран не знает наведения, — а у нажатия клавиши места на экране
 * нет вовсе.
 */
function wakes(e) {
  if (!e || e.type === 'keydown') return true;
  if (!fullscreenOn()) return true;
  if (e.pointerType && e.pointerType !== 'mouse') return true;
  return window.innerHeight - e.clientY <= NEAR_CONTROLS;
}

/**
 * В полном экране полоса с кнопками прячется, пока к ней не тянутся: она
 * перекрывает нижнюю часть кадра. Раньше это держалось на `:hover`, а
 * неподвижный курсор над сценой — это вечное наведение, и панель не гасла.
 */
let idleTimer;
function wakeControls(e) {
  if (!wakes(e)) return;
  clearTimeout(idleTimer);
  document.body.classList.remove('idle');
  if (!fullscreenOn()) return;
  idleTimer = setTimeout(() => {
    // Раскрытую настройку не гасим. Она разворачивается вверх от своей кнопки,
    // то есть далеко от края, — по правилу выше курсор внутри неё полосу уже не
    // будит, и панель погасла бы прямо под ним. А при чтении мышь и вовсе не
    // двигают.
    if (document.querySelector('.pop:not([hidden])')) return wakeControls();
    document.body.classList.add('idle');
  }, IDLE_MS);
}

for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
  document.addEventListener(ev, wakeControls, true);
}
