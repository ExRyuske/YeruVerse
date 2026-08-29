// Сцена: что показано крупно, какие есть переключатели и полоса камер.
//
// Смотреть в комнате можно только живые трансляции участников — своя сюда не
// попадает: она и так перед глазами, а декодировать собственный захват значит
// греть процессор ради картинки, которую человек уже видит.

import { control, mesh, pointers, settings } from './core.js';
import { hidden, isSelf, state, viewKey, viewKind, viewPeer } from './state.js';
import { painter, render } from './render.js';
import { icon } from './icons.js';
import { make, showVideo, ui, volumeSlider } from './ui.js';
import { StreamPlayer } from './players.js';

painter('stage', renderStage);
painter('views', renderViews);
painter('cams', renderCams);

// Живой поток не должен оставаться на паузе, чем бы её ни вызвали.
setInterval(() => state.player?.resume(), 2000);

// Зритель выключил у себя нашу трансляцию — снимаем дорожку именно с его
// соединения, не трогая остальных.
mesh.on('message', ({ id, msg }) => {
  if (msg?.ns === 'pause') mesh.pauseFor(id, msg.kind, !!msg.on);
});

/** Единственное место, где решается, что показано на сцене. */
function renderStage() {
  // Курсоры привязаны к тому, что показано, — обновляем до проверки на «ничего
  // не изменилось», иначе после переключения обратно метки не возвращаются.
  pointers.setContext(state.view);
  pointers.setSharing(!!state.view);
  control.target = viewKind(state.view) === 'screen' ? viewPeer(state.view) : null;
  render('control');

  if (state.mounted === state.view) {
    applyStreamVolume();
    return;
  }
  state.mounted = state.view;
  destroyPlayer();

  const stream = state.view && state.screens.get(state.view);
  if (!stream) {
    showEmpty();
    return;
  }
  ui('#stage-empty').hidden = true;
  state.player = new StreamPlayer(ui('#stage'), stream);
  applyStreamVolume();
}

function destroyPlayer() {
  state.player?.destroy();
  state.player = null;
}

/**
 * Комната кончилась: плеер погашен, сцена пуста, плитки камер убраны.
 *
 * Раньше сцену просто оставляли как есть, и следующая пустая комната встречала
 * чёрным прямоугольником без единой надписи: подсказку «смотреть нечего» рисует
 * только сама отрисовка сцены, а звать её было некому.
 */
export function resetStage() {
  destroyPlayer();
  closeZoom();
  state.screens.clear();
  state.view = null;
  state.mounted = null;
  showEmpty();
  render('views', 'cams');
}

/** Громкость текущей трансляции — своя у каждой и запоминается по имени. */
function applyStreamVolume() {
  state.player?.setVolume(settings.streamVolumeOf(streamName(state.view)));
}

/**
 * Имя, под которым запоминается громкость трансляции. Идентификаторы участников
 * выдаются заново на каждый вход, а имя у человека постоянное — как и с
 * персональной громкостью голоса.
 */
function streamName(key) {
  const peer = state.peers.get(viewPeer(key));
  return `${peer?.name ?? viewPeer(key) ?? ''}:${viewKind(key) ?? ''}`;
}

function showEmpty() {
  const el = ui('#stage-empty');
  el.hidden = false;
  el.replaceChildren(
    make('p', {
      class: 'muted',
      text: state.shares.size
        ? 'Вы транслируете — на своём экране это и так видно'
        : 'Пока смотреть нечего',
    })
  );
}

/** Переключатели «что смотреть»: трансляции экранов участников. */
function renderViews() {
  const host = ui('#views');
  const chips = [];

  for (const key of state.screens.keys()) {
    if (viewKind(key) === 'cam' || hidden.has(key)) continue;   // камеры на своей полосе
    const peer = state.peers.get(viewPeer(key));
    chips.push({ id: key, label: peer?.name ?? 'Участник', color: peer?.color });
  }

  // Ряд нужен и когда трансляция одна: переключать нечего, но в том же ряду
  // живёт её громкость, и вместе с рядом она пропадала.
  host.hidden = !chips.length;

  const vol = host.querySelector('.pv-mini');
  for (const el of [...host.children]) if (el !== vol) el.remove();

  for (const c of chips) {
    const active = c.id === state.view;
    const button = make(
      'button',
      {
        class: `ghost${active ? ' active' : ''}`,
        html: icon('screen'),
        // Цвет ника — только у неактивных: у выбранной кнопки свой фон, и
        // цветной текст на нём читается хуже обычного.
        style: c.color && !active ? { color: c.color } : null,
        onclick: () => {
          state.view = c.id;
          render('views', 'stage');
        },
      },
      make('span', { text: c.label })
    );
    host.insertBefore(button, vol);
  }
  if (!state.view) vol?.remove();
  else if (vol) vol.sync();
  else host.appendChild(streamVolumeSlider());
}

/** Громкость трансляции, которая сейчас на сцене. Запоминается по имени. */
function streamVolumeSlider() {
  return volumeSlider({
    max: 200,
    label: 'Громкость трансляции',
    get: () => settings.streamVolumeOf(streamName(state.view)),
    set: (v) => {
      settings.setStreamVolume(streamName(state.view), v);
      applyStreamVolume();
    },
  });
}

// ---------------------------------------------------------------- потоки

/**
 * Пришла чужая трансляция. Вид потока приходит подписью от отправителя: по
 * составу дорожек экран и камеру не различить.
 */
export function acceptScreen(id, stream, kind) {
  const key = viewKey(id, kind);
  addScreen(key, stream);
  if (hidden.has(key)) mesh.send(id, { ns: 'pause', kind, on: true });
}

export function addScreen(key, stream) {
  // Тот же поток мог уже лечь под другим ключом: подпись отправителя приходит
  // отдельно от дорожек, и до неё вид приходится угадывать. Старую запись
  // снимаем — иначе камера остаётся в списке ещё и как демонстрация экрана,
  // и переключиться на эту пустышку можно, а смотреть в ней нечего.
  for (const [other, known] of [...state.screens]) {
    if (known === stream && other !== key) removeScreen(other);
  }

  state.screens.set(key, stream);

  // Поток может смениться (перезапустили демонстрацию) — обновим плеер на месте.
  if (state.view === key && state.player instanceof StreamPlayer) {
    state.player.setStream(stream);
  } else if (state.view === key) {
    // Сцена уже числится за этим ключом, а плеера на ней нет: поток приехал
    // позже, чем сцена его хватилась, и `state.mounted` успел сравняться с
    // `state.view`. Отрисовка по этому признаку решает, что делать нечего, и
    // сцена осталась бы пустой навсегда. Сбрасываем метку — пусть соберётся.
    state.mounted = null;
  } else if (!state.view && viewKind(key) === 'screen') {
    state.view = key;          // смотреть всё равно нечего — покажем сразу
  }
  render('views', 'cams', 'stage');
}

export function removeScreen(key) {
  if (!state.screens.delete(key)) return;
  if (state.view === key) state.view = firstScreen();
  render('views', 'cams', 'stage');
}

/**
 * Убрать всё, чей владелец больше не в комнате.
 *
 * Обычно трансляцию снимает `peer_leave`, но приходит он только тем, чей сокет
 * в этот момент жив. Пока наш лежал, участник мог выйти и вернуться — сервер
 * выдаёт id на соединение, а не на человека, — и вернулся он уже под другим.
 * Прежний ключ при этом остаётся здесь навсегда: `peer_leave` о нём не придёт
 * уже никогда.
 *
 * Стоит он дорого. Сцена продолжает показывать мёртвый поток, а пришедший
 * следом живой её не занимает — она ведь не пуста, — и висит безымянным
 * переключателем. Снаружи это и выглядит как «после переподключения трансляции
 * пропали».
 *
 * Сверка та же, что делает с соединениями `Mesh.sync`, и по тому же списку:
 * тому, что сервер только что прислал в `welcome`.
 */
export function syncScreens() {
  for (const key of [...state.screens.keys()]) {
    if (state.peers.has(viewPeer(key))) continue;
    // Выключенное у себя помнится тем же ключом и протухает вместе с ним.
    hidden.delete(key);
    removeScreen(key);
  }
}

/** Первая доступная демонстрация экрана — камеры сцену не занимают. */
function firstScreen() {
  return [...state.screens.keys()].find((k) => viewKind(k) === 'screen' && !hidden.has(k)) ?? null;
}

/** Показывать этот поток или нет. Решение личное и другим зрителям не видно. */
export function setHidden(key, on) {
  if (on) hidden.add(key);
  else hidden.delete(key);
  // Просьба идёт владельцу потока. Свой прячем только локально: соединения с
  // самим собой нет, да и захват всё равно продолжается ради остальных.
  if (!isSelf(viewPeer(key))) {
    mesh.send(viewPeer(key), { ns: 'pause', kind: viewKind(key), on });
  }

  if (on && state.view === key) state.view = firstScreen();
  // Вернули демонстрацию, а сцена пуста — показываем её, иначе выглядит так,
  // будто включение не сработало.
  if (!on && !state.view && viewKind(key) === 'screen') state.view = key;
  render('views', 'cams', 'stage', 'peers');
}

/** Что выключено у себя — строкой для диагностики. */
export function hiddenLabels() {
  return [...hidden].map(
    (k) =>
      `${state.peers.get(viewPeer(k))?.name ?? '?'} (${viewKind(k) === 'cam' ? 'камера' : 'экран'})`
  );
}

// ---------------------------------------------------------------- камеры

// Плитки камер переживают перерисовку: пересоздать <video> значит заново
// запустить декодирование и моргнуть картинкой на ровном месте.
const camTiles = new Map();   // ключ трансляции -> плитка

// Какая камера сейчас увеличена: { key, box }. Само окно про поток ничего не
// знает и закрыться по его концу не может — помним за него.
let zoomed = null;

function zoomCam(key, mirror) {
  const box = showVideo(state.screens.get(key), ui('#stage'), { mirror });
  zoomed = box ? { key, box } : null;
}

/** Закрыть увеличение. Повторный вызов безвреден: окна может уже не быть. */
function closeZoom() {
  zoomed?.box.close?.();
  zoomed = null;
}

/**
 * Камеры видны всегда и одновременно — независимо от того, чей экран на сцене.
 * Свою в полосу не берём: собственное лицо и так знакомо, а лишний декодер на
 * своей же машине не бесплатен.
 */
function renderCams() {
  const host = ui('#cams');
  const live = [...state.screens.keys()].filter(
    (k) => viewKind(k) === 'cam' && !hidden.has(k)
  );

  for (const [key, tile] of camTiles) {
    if (live.includes(key)) continue;
    tile.remove();
    camTiles.delete(key);
  }

  // Увеличение живёт поверх сцены и перерисовку переживает — значит, и убирать
  // его надо самим. Поток кончается без всякого нажатия: камеру выключили,
  // участник ушёл, — а окно оставалось висеть последним кадром поверх всего,
  // и закрыть его человек не догадывался.
  if (zoomed && !live.includes(zoomed.key)) closeZoom();

  for (const key of live) {
    let tile = camTiles.get(key);
    if (!tile) {
      tile = newCamTile(key);
      host.appendChild(tile);
      camTiles.set(key, tile);
    }
    const video = tile.querySelector('video');
    const stream = state.screens.get(key);
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    const mine = isSelf(viewPeer(key));
    tile.classList.toggle('mine', mine);
    // Зеркалим только себя: у собеседника на плитке не ваше лицо, и переворот
    // там означал бы зеркальные надписи на его фоне без всякой причины.
    tile.classList.toggle('mirror', mine && settings.get('mirrorCam'));
    tile.querySelector('span').textContent = mine
      ? 'Вы'
      : (state.peers.get(viewPeer(key))?.name ?? 'Участник');
  }
  host.hidden = !live.length;
}

function newCamTile(key) {
  const video = make('video', {
    autoplay: true,
    playsInline: true,
    muted: true,      // звук камеры не захватывается, он идёт голосом
    title: 'Развернуть на всё окно трансляции',
    // Разворачиваем в пределах сцены, а не на весь экран: камера — часть
    // разговора, и ради неё незачем убирать со стола всё остальное.
    onclick: () => zoomCam(key, tile.classList.contains('mirror')),
  });

  // Выключателя на самой плитке нет: тот же переключатель уже стоит возле
  // ника в списке участников, и две кнопки на одно действие только путают.
  const tile = make('div', { class: 'cam-tile' }, video, make('span'));
  return tile;
}
