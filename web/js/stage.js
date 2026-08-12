// Сцена: что показано крупно, какие есть переключатели и полоса камер.
//
// Смотреть в комнате можно только живые трансляции участников — своя сюда не
// попадает: она и так перед глазами, а декодировать собственный захват значит
// греть процессор ради картинки, которую человек уже видит.

import { control, mesh, pointers, settings } from './core.js';
import { hidden, isSelf, state, viewKey, viewKind, viewPeer } from './state.js';
import { painter, render } from './render.js';
import { icon } from './icons.js';
import { $, showVideo, volumeSlider } from './ui.js';
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
  $('#stage-empty').hidden = true;
  state.player = new StreamPlayer($('#stage'), stream);
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
  const el = $('#stage-empty');
  el.hidden = false;
  el.innerHTML = state.shares.size
    ? '<p class="muted">Вы транслируете — на своём экране это и так видно</p>'
    : '<p class="muted">Пока смотреть нечего</p>';
}

/** Переключатели «что смотреть»: трансляции экранов участников. */
function renderViews() {
  const host = $('#views');
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
    const b = document.createElement('button');
    b.className = 'ghost' + (c.id === state.view ? ' active' : '');
    b.innerHTML = icon('screen');
    const text = document.createElement('span');
    text.textContent = c.label;
    b.appendChild(text);
    if (c.color && c.id !== state.view) b.style.color = c.color;
    b.onclick = () => {
      state.view = c.id;
      render('views', 'stage');
    };
    host.insertBefore(b, vol);
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
  state.screens.set(key, stream);

  // Поток может смениться (перезапустили демонстрацию) — обновим плеер на месте.
  if (state.view === key && state.player instanceof StreamPlayer) {
    state.player.setStream(stream);
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

/**
 * Камеры видны всегда и одновременно — независимо от того, чей экран на сцене.
 * Свою в полосу не берём: собственное лицо и так знакомо, а лишний декодер на
 * своей же машине не бесплатен.
 */
function renderCams() {
  const host = $('#cams');
  const live = [...state.screens.keys()].filter(
    (k) => viewKind(k) === 'cam' && !hidden.has(k)
  );

  for (const [key, tile] of camTiles) {
    if (live.includes(key)) continue;
    tile.remove();
    camTiles.delete(key);
  }

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
  const tile = document.createElement('div');
  tile.className = 'cam-tile';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;      // звук камеры не захватывается, он идёт голосом
  video.title = 'Развернуть на всё окно трансляции';
  // Разворачиваем в пределах сцены, а не на весь экран: камера — часть
  // разговора, и ради неё незачем убирать со стола всё остальное.
  video.onclick = () =>
    showVideo(state.screens.get(key), $('#stage'), {
      mirror: tile.classList.contains('mirror'),
    });

  // Выключателя на самой плитке нет: тот же переключатель уже стоит возле
  // ника в списке участников, и две кнопки на одно действие только путают.
  tile.append(video, document.createElement('span'));
  return tile;
}
