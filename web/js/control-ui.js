// Указки и управление чужим компьютером — со стороны интерфейса.
//
// Мышь над сценой всегда указка; она же становится настоящим курсором хозяина,
// как только зритель возьмёт управление сам. Клавиатура уходит туда же, пока
// фокус не в поле ввода.

import { control, hotkeys, native, pointers } from './core.js';
import { isSelf, state, viewPeer } from './state.js';
import { painter, render } from './render.js';
import { toast, ui } from './ui.js';

painter('control', renderControl);

export function wireControl() {
  pointers.peerOf = (id) => (id === 'self' ? state.self : state.peers.get(id));

  // Та же мышь, что рисует указку, ведёт и чужой курсор — если управление
  // взято. Решает это `control`, поэтому сюда уходит всё подряд.
  pointers.onMove = (x, y) => control.sendMove(x, y);
  pointers.onButton = (button, down, at) => control.sendButton(button, down, at);
  pointers.onScroll = (dx, dy) => control.sendScroll(dx, dy);
  pointers.onRemote = showOnOverlay;

  document.addEventListener('keydown', (e) => relayKey(e, true));
  document.addEventListener('keyup', (e) => relayKey(e, false));
  // Ушли из окна — отпускаем всё, иначе на чужом компьютере залипнет клавиша.
  window.addEventListener('blur', () => control.sendRelease());

  control.on('change', () => {
    pointers.grabInput = control.controlling;
    render('control', 'peers');
  });
  control.on('granted-to-me', ({ from, on }) => {
    const who = state.peers.get(from)?.name ?? 'Участник';
    toast(
      on
        ? `${who} пустил вас за свой компьютер — нажмите кнопку с курсором, чтобы взять управление`
        : `${who} забрал управление`,
      on ? 8000 : 3500
    );
  });
  control.on('error', ({ message }) => toast(`Управление: ${message}`));

  // Перехват управления. Глобальное сочетание работает и из игры, и из любого
  // другого окна — в отличие от прежней затеи следить за курсором, которая
  // ошибалась на каждом кадре и лезла в системный API не из того потока.
  hotkeys.on('takeover', () => {
    state.paused = !state.paused;
    native.inputPause(state.paused).catch(() => {});
    toast(state.paused ? 'Управление перехвачено — гости замерли' : 'Управление возвращено гостям');
    render('peers');
  });

  ui('#btn-control').onclick = () => {
    if (!control.canTake) {
      return toast(
        'Управлять можно только тем компьютером, хозяин которого вас пустил: ' +
          'попросите его открыть замок возле вашего ника',
        7000
      );
    }
    const on = !control.taking;
    control.setTaking(on);
    toast(
      on
        ? 'Управление у вас: мышь и клавиатура уходят на чужой компьютер'
        : 'Управление возвращено — ваша мышь снова просто указка'
    );
  };

  render('control');
}

/**
 * Клавиатура уходит хосту, пока фокус не в поле ввода. Отправляем физическое
 * положение клавиши: на кириллице буква другая, а место то же.
 */
function relayKey(e, down) {
  if (!control.controlling) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  e.preventDefault();
  if (e.repeat) return;          // автоповтор: клавиша и так зажата на хосте
  control.sendKey(e.code, e.key.length === 1 ? e.key : null, down);
}

/**
 * Своя трансляция на сцене не показывается, поэтому курсоры зрителей рисует
 * прозрачное окно поверх всех приложений — прямо на том экране, на который
 * и показывают. Какая трансляция открыта у самого стримера, роли не играет.
 */
function showOnOverlay(id, msg, peer) {
  if (!state.shares.size || !native.caps.overlay) return;
  if (msg.gone) return void native.cursor({ id, gone: true }).catch(() => {});
  if (!isSelf(viewPeer(msg.v))) return;   // показывают не на нас
  native
    .cursor({
      id,
      x: msg.x,
      y: msg.y,
      name: peer?.name ?? '',
      color: peer?.color ?? '#5b8cff',
      click: msg.type === 'click',
    })
    .catch(() => {});
}

/**
 * Кнопка управления. Она о зрителе, а не о хозяине: замок открывает хозяин, а
 * брать управление или оставить мышь указкой — решает тот, кто смотрит.
 */
function renderControl() {
  const btn = ui('#btn-control');
  const can = control.canTake;
  const on = can && control.taking;
  // Не гасим: погашенная кнопка в ряду одинаковых выглядит поломкой, а не
  // подсказкой. Нажатие и так объясняет, чего не хватает, — это полезнее.
  btn.classList.toggle('active', on);
  btn.title = !can
    ? 'Управление чужим компьютером — когда его хозяин откроет вам замок'
    : on
      ? 'Вы управляете чужим компьютером — вернуть управление'
      : 'Взять управление чужим компьютером';
}
