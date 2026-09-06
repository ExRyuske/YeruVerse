// Указки и управление чужим компьютером — со стороны интерфейса.
//
// Мышь над сценой всегда указка; она же становится настоящим курсором хозяина,
// как только зритель возьмёт управление сам. Клавиатура уходит туда же, пока
// фокус не в поле ввода.
//
// Здесь же живёт замок возле ника: кого пускать за свой компьютер, решает его
// хозяин и решает поимённо.

import { control, hotkeys, native, pointers } from './core.js';
import { isSelf, state, viewPeer } from './state.js';
import { reason } from './errors.js';
import { painter, render } from './render.js';
import { markButton, toast, ui } from './ui.js';

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

  // Что происходит с моим компьютером, я должен видеть у себя, а не догадываться
  // по дёргающемуся курсору.
  control.on('taken', ({ id }) => {
    toast(`${peerName(id)} взял управление вашим компьютером`, 5000);
  });
  control.on('locked', ({ id, why }) => {
    // Замок закрыли мы сами, и об этом уже сказано у самой кнопки. Второй раз
    // теми же словами — это шум, а не новость.
    if (why === 'revoked') return;
    toast(lockedText(peerName(id), why), 7000);
  });

  // А это уже про наше управление чужим компьютером: тот его запер, потому что
  // наша страница слишком долго молчала.
  control.on('lost', ({ from }) =>
    toast(
      `${peerName(from)} запер управление: ваше окно перестало отвечать. ` +
        'Нажмите кнопку с курсором, чтобы взять управление снова',
      8000
    )
  );

  watchWindow();

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
        ? 'Управление у вас: мышь и клавиатура уходят на чужой компьютер. ' +
            'Свернёте окно — управление вернётся хозяину'
        : 'Управление возвращено — ваша мышь снова просто указка',
      on ? 6000 : 3500
    );
  };

  render('control');
}

const peerName = (id) => state.peers.get(id)?.name ?? 'Участник';

/** Почему управление заперлось — словами хозяину компьютера. */
function lockedText(who, why) {
  switch (why) {
    case 'hidden':
      return `${who} свернул YeruVerse — управление заперто до его возвращения`;
    // Окно не свернули, а просто перестало отвечать: усыпили, выгрузили,
    // потеряли связь. Снаружи это то же самое, и молчать об этом нельзя.
    case 'silent':
      return `${who} перестал отвечать — управление заперто`;
    case 'gone':
      return `${who} вышел — управление заперто`;
    case 'switched':
      return `${who} перешёл на другую трансляцию — управление заперто`;
    default:
      return `${who} вернул вам управление`;
  }
}

/**
 * Свёрнутое окно управления не держит.
 *
 * Взявший управление уходит в свою игру или в другую программу, а на том конце
 * его компьютер остаётся открытым настежь: замок-то открыт, взятое управление
 * никто не отдавал. Мышь при этом продолжает работать — свёрнутое окно не
 * получает клавиатуру, но `pointermove` над сценой ему приходит и в
 * невидимом состоянии, — и получается ввод вслепую: человек уже не смотрит на
 * чужой экран, а тыкает в него по-прежнему.
 *
 * Поэтому управление здесь возвращается хозяину само, и взять его снова нужно
 * тем же нажатием, что и в первый раз. Второй замок — на стороне хозяина: он
 * перестаёт принимать ввод, если биение прекратилось (см. `control.js`), и
 * этого хватает даже там, где страницу усыпили, не дав ей сказать ни слова.
 */
function watchWindow() {
  let lockedHere = false;

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Сказать об этом можно только вернувшемуся: подсказка, показанная
      // свёрнутому окну, гаснет по таймеру, и человек её не увидит никогда.
      if (lockedHere) {
        lockedHere = false;
        toast(
          'Окно было свёрнуто, и управление вернулось хозяину — ' +
            'нажмите кнопку с курсором, чтобы взять его снова',
          8000
        );
      }
      return;
    }
    if (!control.controlling) return;
    control.setTaking(false, 'hidden');
    lockedHere = true;
  });
}

/**
 * Замок возле ника: этому человеку можно за мой компьютер.
 *
 * Список тех, кому разрешено, — это и есть `control.granted`: держать рядом
 * второй, «интерфейсный», значило бы завести два ответа на один вопрос и
 * когда-нибудь получить разные.
 */
export function allowButton(id) {
  const on = control.granted.has(id);
  return markButton({
    glyph: on ? 'unlock' : 'lock',
    on,
    title: on
      ? 'Забрать доступ к моему компьютеру'
      : 'Разрешить управлять моим компьютером',
    onclick: () => setAllowed(id, !on),
  });
}

async function setAllowed(id, on) {
  const who = peerName(id);
  try {
    await control.grant(id, on);
  } catch (e) {
    return toast(`Управление не включилось: ${reason(e)}`, 7000);
  }
  render('peers');
  toast(
    on
      ? `${who} пущен за ваш компьютер — управление он берёт сам`
      : `${who} больше не может управлять вашим компьютером`
  );
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
