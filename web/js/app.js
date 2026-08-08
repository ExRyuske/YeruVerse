import { Net } from './net.js';
import { Mesh } from './mesh.js';
import { Swarm } from './swarm.js';
import { Voice } from './voice.js';
import { Settings, PALETTE } from './settings.js';
import { Pointers } from './pointers.js';
import { icon } from './icons.js';
import { Hotkeys, ACTIONS, label as hotkeyLabel } from './hotkeys.js';
import {
  $, ui, toast, copy, fmtSize, clearStaleFlag,
} from './ui.js';
import {
  initChat, clearChat, addChat, sysMsg, renderAttachProgress, finishAttach,
} from './chat.js';
import { initSettingsPanel, wireHotkeys, refreshDevices } from './settings-panel.js';
import { native } from './native.js';
import { RemoteControl } from './control.js';
import { StreamPlayer } from './players.js';


const settings = new Settings();
const net = new Net();
const mesh = new Mesh(net);
const swarm = new Swarm(mesh);
const voice = new Voice(mesh, settings);
const hotkeys = new Hotkeys(settings);
const control = new RemoteControl(mesh, native);

/** Текущие настройки трансляции — из своих значений, а не из заготовки. */
function streamSettings() {
  return {
    height: settings.get('streamHeight'),
    fps: settings.get('streamFps'),
    bitrate: Math.round(settings.get('streamBitrate') * 1_000_000),
  };
}

// Кодировщик настраивается отсюда — mesh про настройки ничего не знает.
function applyQuality() {
  const q = streamSettings();
  mesh.videoBitrate = q.bitrate;
  mesh.videoFramerate = q.fps;
  mesh.retune();
}
settings.on(({ key }) => key.startsWith('stream') && applyQuality());
applyQuality();
let pointers = null;   // создаётся после появления сцены в DOM

const state = {
  self: null,
  peers: new Map(),
  peerEls: new Map(),
  player: null,
  shares: new Map(),   // 'screen' | 'cam' -> наш собственный поток
  screens: new Map(),  // 'peerId:screen' | 'peerId:cam' -> MediaStream
  view: null,          // null = синхронное видео, иначе id транслирующего
  mounted: null,       // что сейчас в сцене, чтобы не пересоздавать зря
  everJoined: false,
  recentLeaves: new Map(),
  config: {},
  draggingVolume: false,
  joined: false,
  code: '',          // единственный секрет комнаты; на сервер уходит производное
  sunshine: null,       // адрес нашего Sunshine, если он запущен
  sunshineOpen: false,  // виден ли он из интернета
  paused: false,        // мы перехватили управление у гостей
};

// ---------------------------------------------------------------- запуск

init();

async function init() {
  if (native.available) {
    await native.load();
    $('#server-row').hidden = false;
    $('#in-server').value = await native.currentServer().catch(() => location.origin);
  }
  await loadServerConfig();
  setInterval(() => loadServerConfig(), 20 * 60 * 1000);
  pollSunshine();
  setInterval(pollSunshine, 30 * 1000);

  const code = parseInvite();
  const nameField = $('#in-name');
  nameField.value = settings.get('name');
  // Запоминаем сразу, а не только при входе: человек мог представиться и уйти
  // читать ссылку, а вернувшись — обнаружить пустое поле.
  nameField.oninput = () => settings.set('name', nameField.value.trim());

  pointers = new Pointers(mesh, $('#stage'));
  pointers.peerOf = (id) => (id === 'self' ? state.self : state.peers.get(id));

  // Пока идёт наша трансляция, чужие курсоры дублируются в прозрачное окно
  // поверх всех приложений: транслирующий смотрит в игру, а не в YeruVerse.
  pointers.onMove = (x, y) => control.sendMove(x, y);
  pointers.onButton = (button, down, at) => control.sendButton(button, down, at);
  pointers.onScroll = (dx, dy) => control.sendScroll(dx, dy);

  // Клавиатура уходит хосту, пока фокус не в поле ввода. Отправляем физическое
  // положение клавиши: на кириллице буква другая, а место то же.
  const relayKey = (e, down) => {
    if (!control.controlling) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    e.preventDefault();
    if (e.repeat) return;          // автоповтор: клавиша и так зажата на хосте
    control.sendKey(e.code, e.key.length === 1 ? e.key : null, down);
  };
  document.addEventListener('keydown', (e) => relayKey(e, true));
  document.addEventListener('keyup', (e) => relayKey(e, false));
  // Ушли из окна — отпускаем всё, иначе на чужом компьютере залипнет клавиша.
  window.addEventListener('blur', () => control.sendRelease());

  control.on('change', () => {
    pointers.grabInput = control.controlling;
    renderPeers();
  });
  control.on('granted-to-me', ({ from, on }) => {
    const who = state.peers.get(from)?.name ?? 'Участник';
    toast(on ? `${who} пустил вас за свой компьютер` : `${who} забрал управление`);
  });
  control.on('error', ({ message }) => toast(`Управление: ${message}`));

  // Перехват управления. Глобальное сочетание работает и из игры, и из любого
  // другого окна — в отличие от прежней затеи следить за курсором, которая
  // ошибалась на каждом кадре и лезла в системный API не из того потока.
  hotkeys.on('takeover', () => {
    state.paused = !state.paused;
    native.inputPause(state.paused).catch(() => {});
    toast(state.paused ? 'Управление перехвачено — гости замерли' : 'Управление возвращено гостям');
    renderPeers();
  });

  pointers.onRemote = (id, msg, peer) => {
    // Своя трансляция на сцене не показывается, поэтому курсоры зрителей рисует
    // прозрачное окно поверх всех приложений — прямо на том экране, на который
    // и показывают. Какая трансляция открыта у самого стримера, роли не играет.
    if (!state.shares.size || !native.caps.overlay) return;
    if (msg.gone) return native.cursor({ id, gone: true }).catch(() => {});
    if (viewPeer(msg.v) !== state.self?.id) return;   // показывают не на нас
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
  };

  // Телефон усыпляет свёрнутое приложение и рвёт соединения. Возвращаемся —
  // будим всё сразу, не дожидаясь очередной попытки по таймеру, и заново
  // спрашиваем микрофон: разрешение могло не пережить паузу.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.joined) return;
    net.wake();
    mesh.wake();
    enableMic();
  });

  // Статические кнопки получают иконки из того же набора, что и динамические.
  for (const el of document.querySelectorAll('[data-icon]')) {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  }

  buildPalette($('#join-palette'));
  buildPalette($('#set-palette'));
  wireJoin();
  wireRoom();
  initSettingsPanel({
    settings,
    voice,
    mesh,
    net,
    native,
    hotkeys,
    toast,
    peers: () => state.peers,
    config: () => state.config,
    sunshine: () => state.sunshine,
    sunshineHint,
    enableMic,
  });
  wireHotkeys();
  initChat({
    ui,
    net,
    swarm,
    self: () => state.self,
    peer: (id) => state.peers.get(id),
  });

  // Захват экрана есть не в каждом окружении: системный WebView в приложении
  // может его не поддерживать. Лучше честно погасить кнопку, чем ронять запрос.
  if (!navigator.mediaDevices?.getDisplayMedia) {
    const btn = $('#btn-screen');
    btn.disabled = true;
    btn.title = window.isSecureContext
      ? 'Захват экрана недоступен в этом браузере: на телефонах его нет почти нигде'
      : 'Захват экрана требует https';
  }

  // Интерфейс собрался целиком — прошлое аварийное обновление можно забыть.
  clearStaleFlag();

  // Ссылка-приглашение открывается сразу в комнате; если ключа в ней нет,
  // сервер попросит пароль и мы вернёмся на экран входа.
  if (code) joinByCode(code);
}

/**
 * Код комнаты. В ссылке он живёт во фрагменте (`#код`) — фрагмент не уходит на
 * сервер в строке запроса и не оседает в логах прокси. Но принять надо и голый
 * код: его диктуют голосом и присылают сообщением, а не только ссылкой.
 */
function parseInvite(text = location.href) {
  const raw = text.trim();
  if (!raw) return '';
  try {
    const hash = new URL(raw, location.origin).hash.replace(/^#/, '');
    if (hash) return decodeURIComponent(hash);
  } catch {}
  // Не ссылка — значит, сам код. Отсекаем то, что сервер всё равно отбросит.
  return /^[\w-]{1,96}$/.test(raw) ? raw : '';
}

function buildPalette(host) {
  host.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', `Цвет ${c}`);
    b.onclick = () => {
      settings.set('color', c);
      syncPalettes();
      if (state.joined) net.profile(undefined, c);
    };
    host.appendChild(b);
  }
  syncPalettes();
}

function syncPalettes() {
  for (const host of [$('#join-palette'), $('#set-palette')]) {
    for (const b of host?.querySelectorAll('button') ?? []) {
      b.setAttribute('aria-pressed', String(b.title === settings.get('color')));
    }
  }
}

/**
 * Адрес сервера — это всегда origin страницы: в приложении окно тоже грузится
 * прямо с сервера, иначе браузерный движок не даёт ни микрофон, ни захват экрана.
 */
function serverBase() {
  return location.origin;
}

/**
 * Список ICE-серверов приходит с того же сервера. У Cloudflare учётки живут
 * ограниченное время, поэтому обновляем их периодически: они нужны в момент
 * установки соединения, а не постоянно.
 */
async function loadServerConfig() {
  state.config = await fetch(new URL('/config.json', serverBase()), { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({}));
  window.YERUVERSE_ICE = state.config.iceServers ?? [];
}

function wireJoin() {
  const openLink = () => joinByCode(parseInvite(ui('#in-link').value));
  ui('#btn-link').onclick = openLink;
  ui('#in-link').addEventListener('keydown', (e) => e.key === 'Enter' && openLink());

  // Смена сервера меняет origin страницы, поэтому это нативная операция:
  // приложение сохраняет адрес и переоткрывает окно уже на нём.
  ui('#in-server').onchange = async () => {
    try {
      await native.setServer(ui('#in-server').value.trim());
    } catch (e) {
      joinError(`Не вышло: ${e.message ?? e}`);
    }
  };

  ui('#btn-create').onclick = () => joinByCode(randomCode());

  // Подсказка про Sunshine и Moonlight висит постоянно: связка не очевидна, а
  // прятать её после одного показа — значит прятать от тех, кто вернулся к ней
  // через неделю.
  ui('#stream-tools').hidden = false;
  const open = (url) => () => {
    if (native.available) native.openUrl(url).catch(() => window.open(url, '_blank'));
    else window.open(url, '_blank', 'noopener');
  };
  ui('#btn-get-sunshine').onclick = open('https://github.com/LizardByte/Sunshine/releases/latest');
  ui('#btn-get-moonlight').onclick = open('https://moonlight-stream.org/');

  // Обновления предлагаем на экране входа, а не посреди разговора.
  ui('#btn-update-later').onclick = () => ($('#update-notice').hidden = true);
  ui('#btn-update').onclick = async () => {
    toast('Скачиваем обновление…', 30000);
    try {
      await native.updateInstall();
    } catch (e) {
      toast(`Обновиться не вышло: ${e.message ?? e}`, 8000);
    }
  };
  checkUpdate();
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);
}

/**
 * Код новой комнаты: 100 бит из криптографического источника, без словарных
 * частей — их подбирают в первую очередь. Строчные буквы и цифры, чтобы код
 * переживал копирование и адресную строку без сюрпризов.
 */
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

/** Тихая проверка обновлений: молчим, пока нечего сказать. */
async function checkUpdate() {
  if (!native.caps.updates) return;
  const version = await native.updateCheck().catch(() => null);
  if (!version) return;
  $('#update-version').textContent = version;
  $('#update-notice').hidden = false;
  if (state.joined) toast(`Вышла версия ${version} — обновиться можно после выхода из комнаты`);
}

/** Код комнаты — он же её адрес. Ничего из него не выводится. */
function joinByCode(code) {
  if (!code) return joinError('Нужен код комнаты или ссылка');
  state.code = code;
  return join(code);
}

function join(code) {
  if (state.joined) return;      // второй клик не должен плодить комнаты

  const base = serverBase();
  state.joined = true;
  const name = $('#in-name').value.trim();
  settings.set('name', name);

  net.connect({ base, room: code, name, color: settings.get('color') });
  // Просим микрофон прямо здесь: это ещё контекст пользовательского клика,
  // а значит запрос разрешения не будет отклонён браузером автоматически.
  enableMic();
  $('#join-error').hidden = true;
  $('#screen-join').hidden = true;
  $('#screen-room').hidden = false;
  $('#room-name').textContent = state.code;
  // Ключ в адресной строке — чтобы перезагрузка страницы не выкидывала из комнаты.
  // В адресной строке держим код: перезагрузка вернёт в ту же комнату.
  history.replaceState(null, '', `${location.pathname}#${encodeURIComponent(state.code)}`);
}

/** Полный выход: рвём сокет, гасим WebRTC, забываем комнату. */
function leaveRoom() {
  for (const kind of [...state.shares.keys()]) stopShare(kind);
  control.revokeAll().catch(() => {});
  voice.disable();
  for (const id of [...voice.remotes.keys()]) voice.detach(id);
  swarm.clear();
  mesh.destroy();
  destroyPlayer();
  net.reset();

  state.joined = false;
  state.everJoined = false;
  state.self = null;
  state.code = '';
  state.view = null;
  state.mounted = null;
  state.screens.clear();
  state.peers.clear();
  state.peerEls.clear();
  state.recentLeaves.clear();
  sunshineHosts.clear();
  renderViews();

  $('#peer-list').innerHTML = '';
  $('#peer-count').textContent = '0';
  clearChat();
  $('#settings').hidden = true;
  $('#room-name').classList.remove('revealed');

  $('#screen-room').hidden = true;
  $('#screen-join').hidden = false;
  $('#join-error').hidden = true;
  history.replaceState(null, '', location.pathname);
}

/**
 * Включение микрофона.
 *
 * Само приложение включает его при входе, после переподключения и при
 * возвращении из фона — но спрашивать разрешение можно только один раз.
 * Получив отказ, мы запоминаем это и больше не лезем: повторный запрос всё
 * равно вернёт отказ, зато человек получит ещё одно системное окно и ещё одно
 * сообщение об ошибке. Дальше — только по нажатию на кнопку микрофона.
 */
let micDenied = false;

async function enableMic({ manual = false } = {}) {
  if (voice.enabled) return;
  if (micDenied && !manual) return;

  // Браузер знает состояние разрешения точнее нас: если доступ закрыт, вызов
  // захвата только выдаст ошибку, а окна с вопросом не будет.
  if (!manual) {
    const state = await navigator.permissions
      ?.query({ name: 'microphone' })
      .then((p) => p.state)
      .catch(() => null);
    if (state === 'denied') {
      micDenied = true;
      return;
    }
  }

  try {
    await voice.enable();
    micDenied = false;
  } catch (e) {
    if (e?.name === 'NotAllowedError') micDenied = true;
    toast(`Микрофон недоступен: ${micProblem(e)}`);
  }
}

/**
 * Полный экран разворачивает всю сцену вместе с переключателями трансляций и
 * кнопками — иначе в нём нельзя ни переключиться, ни поставить паузу.
 * На iPhone Fullscreen API для обычных элементов нет, там остаётся только
 * системный полноэкранный режим самого видео.
 */
async function toggleFullscreen() {
  const host = $('.stage-wrap');
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (host.requestFullscreen) {
      await host.requestFullscreen({ navigationUI: 'hide' });
    } else {
      const video = $('#stage video');
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else toast('Полный экран здесь недоступен');
    }
  } catch (e) {
    toast(`Полный экран недоступен: ${e?.message ?? e}`);
  }
}

document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  const btn = $('#btn-full');
  btn.innerHTML = icon(on ? 'collapse' : 'expand');
  btn.title = on ? 'Выйти из полного экрана' : 'Во весь экран';
  document.body.classList.toggle('fullscreen', on);
  wakeControls();
});

/**
 * В полном экране панель воспроизведения и переключатели прячутся, пока мышь
 * стоит: они перекрывают нижнюю часть кадра. Раньше это держалось на `:hover`,
 * а неподвижный курсор над сценой — это вечное наведение, и панель не гасла.
 */
let idleTimer;
function wakeControls() {
  clearTimeout(idleTimer);
  document.body.classList.remove('idle');
  if (!document.fullscreenElement) return;
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
  document.addEventListener(ev, wakeControls, true);
}

function joinError(text) {
  const err = $('#join-error');
  err.textContent = text;
  err.hidden = false;
}

// ---------------------------------------------------------------- сеть

net.addEventListener('welcome', ({ detail }) => {
  state.self = detail.you;


  state.peers.clear();
  state.peers.set(detail.you.id, detail.you);
  for (const p of detail.peers) {
    state.peers.set(p.id, p);
    settings.trackPeer(p.id, p.name);
    mesh.add(p.id);
  }
  renderPeers();

  // Переподключение — это тоже welcome, но сообщать о входе повторно незачем.
  sysMsg(state.everJoined ? 'Соединение восстановлено' : 'Вы вошли в комнату');
  state.everJoined = true;

  // Свою трансляцию после обрыва надо объявить заново.
  for (const kind of state.shares.keys()) net.send({ t: 'presence', [SHARES[kind].presence]: true });
  if (voice.enabled) net.send({ t: 'presence', voice: true, muted: voice.muted });
  if (voice.deafened) net.send({ t: 'presence', deaf: true });
  else enableMic();   // микрофон включён по умолчанию
});

net.addEventListener('peer_join', ({ detail }) => {
  state.peers.set(detail.peer.id, detail.peer);
  settings.trackPeer(detail.peer.id, detail.peer.name);
  mesh.add(detail.peer.id);
  renderPeers();

  // После обрыва человек возвращается с новым id: не объявляем его заново.
  const left = state.recentLeaves.get(detail.peer.name);
  state.recentLeaves.delete(detail.peer.name);
  if (!left || Date.now() - left > 15000) sysMsg(`${detail.peer.name} присоединился`);
});

net.addEventListener('peer_leave', ({ detail }) => {
  const gone = state.peers.get(detail.id);
  state.peers.delete(detail.id);
  for (const kind of ['screen', 'cam']) removeScreen(viewKey(detail.id, kind));
  mesh.remove(detail.id);
  renderPeers();
  renderViews();
  if (gone) state.recentLeaves.set(gone.name, Date.now());
  // Сообщаем о выходе с задержкой: если это был обрыв связи, человек вернётся
  // раньше, и в чате не появится лишней пары «вышел / присоединился».
  setTimeout(() => {
    if (gone && state.recentLeaves.get(gone.name)) {
      state.recentLeaves.delete(gone.name);
      sysMsg(`${gone.name} вышел`);
    }
  }, 15000);

});

net.addEventListener('presence', ({ detail }) => {
  // Про трансляции сообщаем по присутствию, а не по приходу потока: поток
  // доедет не до всех сразу, а сообщение в чате должно быть у всех.
  const was = state.peers.get(detail.peer.id);
  if (detail.peer.screen && !was?.screen && detail.peer.id !== state.self?.id) {
    sysMsg(`${detail.peer.name} включил трансляцию`);
  }
  if (!detail.peer.screen && was?.screen && detail.peer.id !== state.self?.id) {
    sysMsg(`${detail.peer.name} выключил трансляцию`);
  }
  if (detail.peer.camera && !was?.camera && detail.peer.id !== state.self?.id) {
    sysMsg(`${detail.peer.name} включил камеру`);
  }
  state.peers.set(detail.peer.id, detail.peer);
  settings.trackPeer(detail.peer.id, detail.peer.name);
  // Выключенный микрофон убирает дорожку молча — снимаем приёмник по присутствию.
  if (!detail.peer.voice) voice.detach(detail.peer.id);
  if (!detail.peer.screen) removeScreen(viewKey(detail.peer.id, 'screen'));
  if (!detail.peer.camera) removeScreen(viewKey(detail.peer.id, 'cam'));
  renderPeers();
  renderViews();
});

net.addEventListener('chat', ({ detail }) => {
  const from = state.peers.get(detail.from);
  addChat(from?.name ?? 'Гость', detail.text, detail.from === state.self?.id, detail.srv, from?.color);
});

net.addEventListener('error', ({ detail }) => toast(detail.message));

net.addEventListener('status', ({ detail }) => {
  const dot = $('#conn-dot');
  dot.className = `dot ${detail.online ? 'on' : 'off'}`;
  dot.title = detail.online ? `RTT ${Math.round(detail.rtt ?? 0)} мс` : 'Переподключение…';
});

// ---------------------------------------------------------------- источники

/**
 * Единственное место, где решается, что показано на сцене. Смотреть в комнате
 * можно только живые трансляции участников — своя сюда не попадает: она и так
 * перед глазами, а декодировать собственный захват значит греть процессор ради
 * картинки, которую человек уже видит.
 */
function renderStage() {
  // Курсоры привязаны к тому, что показано, — обновляем до проверки на «ничего
  // не изменилось», иначе после переключения обратно метки не возвращаются.
  pointers?.setContext(state.view);
  pointers?.setSharing(!!state.view);
  control.target = viewKind(state.view) === 'screen' ? viewPeer(state.view) : null;

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

/** Переключатели «что смотреть»: общее видео и трансляции участников. */
function renderViews() {
  const host = $('#views');
  const chips = [];

  for (const key of state.screens.keys()) {
    const peer = state.peers.get(viewPeer(key));
    chips.push({
      id: key,
      icon: viewKind(key) === 'cam' ? 'camera' : 'screen',
      label: peer?.name ?? 'Участник',
      color: peer?.color,
    });
  }

  host.hidden = chips.length < 2;
  host.innerHTML = '';
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = 'ghost' + (c.id === state.view ? ' active' : '');
    b.innerHTML = icon(c.icon, { size: 16 });
    const text = document.createElement('span');
    text.textContent = c.label;
    b.appendChild(text);
    if (c.color && c.id !== state.view) b.style.color = c.color;
    b.onclick = () => {
      state.view = c.id;
      renderViews();
      renderStage();
    };
    host.appendChild(b);
  }
  if (state.view) host.appendChild(streamVolumeSlider());
}

/** Громкость трансляции, которая сейчас на сцене. Запоминается по имени. */
function streamVolumeSlider() {
  const wrap = document.createElement('span');
  wrap.className = 'pv-mini';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pv-icon';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0;
  slider.max = 200;
  slider.value = Math.round(settings.streamVolumeOf(streamName(state.view)) * 100);

  const show = () => {
    const v = Number(slider.value);
    btn.innerHTML = icon(v === 0 ? 'speaker-off' : 'speaker', { size: 14 });
    wrap.title = `Громкость трансляции ${v}%`;
  };
  slider.oninput = () => {
    settings.setStreamVolume(streamName(state.view), Number(slider.value) / 100);
    applyStreamVolume();
    show();
  };

  let before = 1;
  btn.onclick = () => {
    const now = Number(slider.value);
    if (now > 0) before = now;
    slider.value = now > 0 ? 0 : before;
    slider.oninput();
  };

  show();
  wrap.append(btn, slider);
  return wrap;
}

// Готовое вложение чата: рой собрал файл целиком.
// угодно, а подписки накапливаться не должны.
swarm.on('ready', ({ id, url, meta }) => finishAttach(id, url, meta));

// ---------------------------------------------------------------- Sunshine

// Полноэкранную игру браузер не захватывает, а инжектировать ввод в чужую
// систему не имеет права — и то, и другое умеет Sunshine (либо его форк
// Apollo) в паре с Moonlight. Наше дело маленькое: заметить, что он запущен, и
// разнести адрес по комнате, чтобы подключение было в одно нажатие.
//
// Адрес идёт по WebRTC напрямую зрителям — сервер его не видит.
const SUN = 'sun';
const sunshineHosts = new Map();   // id участника -> адрес его Sunshine
const allowed = new Set();         // кому я разрешил подключаться к моему ПК

mesh.on('message', async ({ id, msg }) => {
  if (msg?.ns !== SUN) return;

  // Сопряжение: зритель прислал PIN, который показал его Moonlight. Отдаём
  // своему Sunshine — иначе этот PIN пришлось бы переписывать руками в
  // веб-панель, и это единственный шаг, на котором всё бросают.
  if (msg.type === 'pin') {
    if (!allowed.has(id)) return;
    try {
      await native.sunshinePin(String(msg.pin));
      mesh.send(id, { ns: SUN, type: 'paired', ok: true });
      toast(`${state.peers.get(id)?.name ?? 'Участник'} сопряжён с вашим Sunshine`);
    } catch (e) {
      mesh.send(id, { ns: SUN, type: 'paired', ok: false, why: String(e?.message ?? e) });
    }
    return;
  }
  if (msg.type === 'paired') {
    toast(
      msg.ok
        ? 'Сопряжение прошло — Moonlight подключается'
        : `Хост не подтвердил PIN: ${msg.why ?? 'нет доступа к его Sunshine'}. Введите PIN у него в панели вручную`,
      12000
    );
    return;
  }

  if (msg.host) sunshineHosts.set(id, msg.host);
  else sunshineHosts.delete(id);
  renderPeers();
});
mesh.on('peer-open', ({ id }) => tellSunshine(id));
mesh.on('peer-close', ({ id }) => {
  allowed.delete(id);
  if (sunshineHosts.delete(id)) renderPeers();
});

/**
 * Свой адрес получает только тот, кому его дали. Пускать за свой компьютер всю
 * комнату разом — не то согласие, которое можно выдать один раз и забыть.
 */
function tellSunshine(id) {
  mesh.send(id, { ns: SUN, host: allowed.has(id) ? state.sunshine : null });
}

/**
 * Разрешить или забрать доступ к своему компьютеру.
 *
 * Замок один на оба пути: и на простое управление по WebRTC, и на адрес
 * Sunshine для Moonlight. Разделять их значило бы спрашивать согласие дважды за
 * одно и то же — «пусти меня за свой компьютер».
 */
async function setAllowed(id, on) {
  if (on) allowed.add(id);
  else allowed.delete(id);
  tellSunshine(id);

  try {
    if (native.caps.remoteControl) await control.grant(id, on);
  } catch (e) {
    toast(`Управление не включилось: ${e.message ?? e}`);
  }
  renderPeers();

  const who = state.peers.get(id)?.name ?? 'Участник';
  toast(on ? `${who} пущен за ваш компьютер` : `${who} больше не может подключаться`);
}

/**
 * Ищем Sunshine и заодно выясняем, как до него добраться снаружи.
 *
 * Локальный адрес работает только в своей сети. Из интернета нужен публичный, и
 * он же должен быть открыт: Moonlight ходит по своим портам напрямую, никакой
 * ретрансляции у него нет. Проверить это изнутри своей сети нельзя — у себя всё
 * открыто всегда, — поэтому спрашиваем сервер комнат: он смотрит на нас ровно
 * так, как посмотрит зритель из интернета.
 */
async function pollSunshine() {
  if (!native.available) return;
  const { running, address } = await native.sunshine().catch(() => ({}));
  if (!running || !address) {
    if (state.sunshine) {
      state.sunshine = null;
      for (const id of allowed) tellSunshine(id);
      renderPeers();
    }
    return;
  }

  const reach = await fetch(new URL('/reach', serverBase()), { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({}));
  // Наружу отдаём публичный адрес, только если он и правда отвечает; иначе
  // локальный — в своей сети он рабочий, а из интернета не сработает ничего.
  const host = reach.open && reach.ip ? reach.ip : address;

  if (host === state.sunshine) return;
  state.sunshine = host;
  state.sunshineOpen = !!reach.open;
  for (const id of allowed) tellSunshine(id);
  renderPeers();
}

/** Что сказать про доступность Sunshine снаружи — по-русски и по делу. */
function sunshineHint() {
  if (!state.sunshine) return '';
  return state.sunshineOpen
    ? `Sunshine виден из интернета: ${state.sunshine}`
    : 'Sunshine виден только в вашей сети. Чтобы пускать друзей из интернета, ' +
        'пробросьте на роутере порты 47984–47990 TCP и 47998–48010 UDP на этот ' +
        'компьютер — либо соедините машины через Tailscale или ZeroTier, тогда ' +
        'пробрасывать ничего не нужно.';
}

/**
 * Запуск Moonlight.
 *
 * Ссылок вида `moonlight://` не существует — такую схему в системе никто не
 * регистрирует, поэтому запускать нужно сам исполняемый файл, и делает это
 * оболочка. У Moonlight две команды: `pair` знакомит с компьютером и показывает
 * PIN, `stream` сразу открывает рабочий стол. Первая нужна ровно один раз на
 * адрес, поэтому сопряжённые адреса мы помним.
 */
async function openMoonlight(id, host) {
  if (!host) return;

  // Без нашего приложения запустить процесс нельзя — пробуем схему (вдруг
  // клиент её всё-таки зарегистрировал) и показываем адрес, чтобы его можно
  // было просто вставить в уже установленный Moonlight.
  if (!native.available) {
    location.href = `moonlight://${host}`;
    return copy(host, `Адрес скопирован — вставьте в Moonlight`, 'Адрес для Moonlight:');
  }

  const paired = settings.get('pairedHosts') ?? [];
  if (paired.includes(host)) {
    return native
      .moonlight(host, 'stream')
      .then(() => toast(`Moonlight подключается к ${host}`))
      .catch((e) => toast(`${e.message ?? e}`, 9000));
  }

  // Первое подключение. PIN придумываем сами и отдаём обеим сторонам: Moonlight
  // получает его аргументом, хозяин — сообщением, которое его приложение само
  // отнесёт в Sunshine.
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  try {
    await native.moonlight(host, 'pair', pin);
  } catch (e) {
    return toast(`${e.message ?? e}`, 9000);
  }
  settings.set('pairedHosts', [...paired, host]);
  mesh.send(id, { ns: SUN, type: 'pin', pin });
  toast('Сопрягаемся: PIN ушёл хозяину компьютера, подтверждать вручную не нужно', 10000);
}

// Вид потока приходит подписью от отправителя: по составу дорожек экран и
// камеру не различить.
mesh.on('stream', ({ id, stream, kind }) => {
  if (kind === 'mic') {
    voice.attach(id, stream);
    return;
  }
  addScreen(viewKey(id, kind), stream);
});

/** Ключ трансляции одинаков у владельца и у зрителей — на нём сходятся курсоры. */
const viewKey = (peer, kind) => `${peer}:${kind}`;
const viewPeer = (key) => key?.split(':')[0] ?? null;
const viewKind = (key) => key?.split(':')[1] ?? null;

function addScreen(key, stream) {
  state.screens.set(key, stream);

  // Поток может смениться (перезапустили демонстрацию) — обновим плеер на месте.
  if (state.view === key && state.player instanceof StreamPlayer) {
    state.player.setStream(stream);
  } else if (!state.view) {
    state.view = key;          // смотреть всё равно нечего — покажем сразу
  }
  renderViews();
  renderStage();
}

function removeScreen(key) {
  if (!state.screens.delete(key)) return;
  if (state.view === key) state.view = state.screens.keys().next().value ?? null;
  renderViews();
  renderStage();
}

// ---------------------------------------------------------------- голос

voice.on('speaking', () => applySpeaking());

/** Обе кнопки звука выглядят и ведут себя одинаково: перечёркнута — выключено. */
function soundButton(sel, name, off, label) {
  const btn = ui(sel);
  btn.classList.toggle('off', off);
  btn.innerHTML = icon(off ? `${name}-off` : name);
  btn.title = off ? `${label} выключен — включить` : `${label} включён — выключить`;
}

voice.on('change', ({ enabled, muted, deafened }) => {
  soundButton('#btn-mute', 'mic', !enabled || muted, 'Микрофон');
  soundButton('#btn-deafen', 'speaker', deafened, 'Звук');
  net.send({ t: 'presence', voice: enabled, muted, deaf: deafened });
});

voice.on('blocked', () => toast('Нажмите в любом месте страницы, чтобы включить звук'));

// ---------------------------------------------------------------- управление

voice.on('devices', () => refreshDevices());
// Ползунки громкости живут в списке участников — там же, где ники.
voice.on('change', () => renderPeers());


function destroyPlayer() {
  state.player?.destroy();
  state.player = null;
}

// ---------------------------------------------------------------- элементы управления

function wireRoom() {
  ui('#btn-screen').onclick = () => toggleShare('screen');
  ui('#btn-camera').onclick = () => toggleShare('cam');

  // Код виден размытым: в трансляции и через плечо его не прочитать. Нажатие
  // показывает его и сразу копирует — это два действия, которые всегда нужны
  // вместе. Повторное нажатие прячет обратно.
  ui('#room-name').onclick = () => {
    const el = $('#room-name');
    const reveal = !el.classList.contains('revealed');
    el.classList.toggle('revealed', reveal);
    if (reveal) copy(state.code, 'Код скопирован', 'Код комнаты:');
  };

  // Обе кнопки — обычные выключатели: нажали и звук пропал, нажали и вернулся.
  ui('#btn-mute').onclick = () =>
    voice.enabled ? voice.setMuted(!voice.muted) : enableMic({ manual: true });
  ui('#btn-deafen').onclick = () => voice.setDeafened(!voice.deafened);

  ui('#btn-pointer').onclick = () => {
    const on = !pointers.enabled;
    pointers.setEnabled(on);
    ui('#btn-pointer').classList.toggle('active', on);

    if (native.caps.overlay && state.shares.has('screen')) {
      native.setOverlay(on).catch(() => {});
      if (!on) native.clearCursors().catch(() => {});
    }
    toast(
      on
        ? 'Курсоры участников видны' +
            (state.shares.has('screen') && native.caps.overlay ? ' — и поверх других окон' : '')
        : 'Курсоры скрыты'
    );
  };

  ui('#btn-full').onclick = toggleFullscreen;

  ui('#btn-invite').onclick = invite;
  ui('#btn-leave').onclick = leaveRoom;
  ui('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const input = ui('#chat-input');
    if (input.value.trim()) net.chat(input.value.trim());
    input.value = '';
  };

  // Живой поток не должен оставаться на паузе, чем бы её ни вызвали.
  setInterval(() => state.player?.resume(), 2000);
}

/** Разбираем отказ микрофона: причина почти всегда в контексте, а не в коде. */
function micProblem(e) {
  if (!window.isSecureContext) {
    return `страница открыта по ${location.protocol.replace(':', '')} — нужен https`;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'браузер не даёт доступ к устройствам — откройте сайт в обычном браузере, а не во встроенном окне мессенджера';
  }
  switch (e?.name) {
    case 'NotAllowedError':
      return 'доступ запрещён — разрешите микрофон для сайта в настройках браузера';
    case 'NotFoundError':
      return 'микрофон не найден';
    case 'NotReadableError':
      return 'микрофон занят другим приложением';
    default:
      return e?.message ?? String(e);
  }
}

/**
 * Экран и камера отличаются только способом захвата и подписью — всё остальное
 * у них общее, поэтому и код общий.
 */
const SHARES = {
  screen: {
    button: '#btn-screen',
    presence: 'screen',
    capture: () => {
      const q = streamSettings();
      return navigator.mediaDevices.getDisplayMedia({
        // ideal, а не exact: если экран меньше или система не тянет, браузер
        // подберёт ближайшее вместо отказа в захвате.
        video: {
          frameRate: { ideal: q.fps, max: q.fps },
          height: { ideal: q.height },
          displaySurface: 'monitor',   // для игры нужен экран целиком
        },
        // Звук игры берём как есть: обработка, рассчитанная на речь, съедает
        // басы и приглушает тихие места.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',   // не предлагать транслировать сам YeruVerse
        surfaceSwitching: 'include',     // окно можно сменить, не пересоздавая поток
      });
    },
    missing: 'Захват экрана недоступен: нужен HTTPS и браузер с его поддержкой',
  },
  cam: {
    button: '#btn-camera',
    presence: 'camera',
    capture: () =>
      navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, frameRate: { ideal: 30 }, facingMode: 'user' },
        audio: false,          // звук идёт голосовым каналом, дублировать незачем
      }),
    missing: 'Камера недоступна: нужен https',
  },
};

async function toggleShare(kind) {
  if (state.shares.has(kind)) return stopShare(kind);

  const share = SHARES[kind];
  const capture = kind === 'screen' ? 'getDisplayMedia' : 'getUserMedia';
  if (!navigator.mediaDevices?.[capture]) return toast(share.missing);

  try {
    const stream = await share.capture();
    state.shares.set(kind, stream);
    mesh.setStream(kind, stream);
    net.send({ t: 'presence', [share.presence]: true });

    // Своя трансляция — такой же поток в общем списке, только без звука себе.
    //
    // Сцену она себе не забирает, если там уже что-то есть. Свой экран видно и
    // так, а вот занять им сцену значило бы потерять чужую трансляцию вместе с
    // курсорами на ней: указки рисуются только на том кадре, к которому
    // относятся, и при двух трансляциях каждый смотрел бы в свою — курсоров не
    // видел бы никто. Если смотреть было нечего, addScreen покажет её сам.
    addScreen(viewKey(state.self.id, kind), stream);
    renderViews();
    renderStage();
    renderPeers();
    $(share.button).classList.add('active');

    // Оверлей поднимаем вместе с трансляцией — и только если указка включена.
    if (native.caps.overlay && pointers.enabled) native.setOverlay(true).catch(() => {});
    if (kind === 'screen') watchFrames(stream);
    stream.getVideoTracks()[0].addEventListener('ended', () => stopShare(kind));
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast(`${share.missing}: ${micProblem(e)}`);
  }
}

/**
 * Присматриваем за собственной трансляцией экрана.
 *
 * Игра в настоящем полноэкранном режиме (и почти всё, что закрыто защитой от
 * записи) отдаёт захвату чёрный кадр: зрители видят пустоту, а транслирующий
 * об этом не догадывается — у него-то на экране игра. Раз в пару секунд
 * смотрим на собственный кадр и, если он мёртвый, говорим, что именно делать.
 */
function watchFrames(stream) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // Полностью скрытое видео браузер вправе не декодировать, поэтому оставляем
  // его в разметке невидимым пикселем.
  video.style.cssText =
    'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let dead = 0;
  let warned = false;
  const stop = () => {
    clearInterval(timer);
    video.srcObject = null;
    video.remove();
  };

  let silent = 0;
  const timer = setInterval(() => {
    if (state.shares.get('screen') !== stream) return stop();
    if (!video.videoWidth) {
      // Кадров нет вообще: захват согласился, но источник ничего не отдаёт.
      if (++silent === 5) {
        toast('Захват не отдаёт кадров — перезапустите трансляцию', 8000);
      }
      return;
    }
    silent = 0;

    let dark;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        max = Math.max(max, data[i], data[i + 1], data[i + 2]);
      }
      dark = max < 12;
    } catch {
      return stop();   // кадр прочитать нельзя — молча уходим, а не спамим
    }

    dead = dark ? dead + 1 : 0;
    if (!dark) warned = false;
    if (dead >= 3 && !warned) {
      warned = true;
      toast(
        'Зрители видят чёрный экран. Игры захватываются только в режиме ' +
          '«окно без рамок» — переключите его в настройках графики. ' +
          'Если включён HDR, выключите и его.',
        12000
      );
    }
  }, 2000);
}

function stopShare(kind) {
  const stream = state.shares.get(kind);
  if (!stream) return;

  if (kind === 'screen') control.revokeAll().catch(() => {});
  stream.getTracks().forEach((t) => t.stop());
  state.shares.delete(kind);
  mesh.setStream(kind, null);
  net.send({ t: 'presence', [SHARES[kind].presence]: false });
  removeScreen(viewKey(state.self?.id, kind));
  if (!state.shares.size && native.caps.overlay) native.setOverlay(false).catch(() => {});
  renderPeers();
  $(SHARES[kind].button).classList.remove('active');
}



// ---------------------------------------------------------------- UI-мелочи

function renderPeers() {
  if (state.draggingVolume) return;
  const list = $('#peer-list');
  list.innerHTML = '';
  state.peerEls.clear();

  for (const p of state.peers.values()) {
    const li = document.createElement('li');
    if (p.photo) {
      const img = document.createElement('img');
      img.src = p.photo;
      li.appendChild(img);
    }
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === state.self?.id ? ' (вы)' : '');
    name.style.color = p.color || 'inherit';
    li.appendChild(name);

    // Значок только у молчащих: включённый микрофон — это норма, и рисовать
    // его возле каждого ника значит показывать одно и то же по кругу.
    if (!p.voice || p.muted) {
      const mic = document.createElement('span');
      mic.className = 'off-mark';
      mic.innerHTML = icon('mic-off', { size: 14 });
      mic.title = p.voice ? 'Микрофон заглушён' : 'Микрофон выключен';
      li.appendChild(mic);
    }
    if (p.deaf) {
      const off = document.createElement('span');
      off.className = 'off-mark';
      off.innerHTML = icon('speaker-off', { size: 14 });
      off.title = 'Не слышит остальных: звук выключен';
      li.appendChild(off);
    }
    for (const [on, name, title] of [
      [p.screen, 'screen', 'Транслирует экран'],
      [p.camera, 'camera', 'Транслирует камеру'],
    ]) {
      if (!on) continue;
      const tag = document.createElement('span');
      tag.className = 'live-mark';
      tag.innerHTML = icon(name, { size: 14 });
      tag.title = title;
      li.appendChild(tag);
    }

    // Ползунок появляется у тех, кого мы реально слышим.
    if (p.id !== state.self?.id && voice.remotes.has(p.id)) {
      li.appendChild(peerVolumeSlider(p.id));
    }

    if (p.id !== state.self?.id) {
      // Кому можно за мой компьютер — решаю я, поимённо.
      if (state.sunshine) li.appendChild(allowButton(p.id));
      // А к кому можно мне — те, кто уже разрешил.
      if (sunshineHosts.has(p.id)) li.appendChild(moonlightButton(p.id));
      if (state.paused && control.granted.has(p.id)) {
        const tag = document.createElement('span');
        tag.className = 'tag warn';
        tag.textContent = 'на паузе';
        li.appendChild(tag);
      }
    }

    state.peerEls.set(p.id, li);
    list.appendChild(li);
  }
  $('#peer-count').textContent = state.peers.size;
  applySpeaking();
}

/** Кнопка «подключиться к этому компьютеру Moonlight'ом». */
function moonlightButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rc';
  btn.innerHTML = icon('gamepad', { size: 15 });
  btn.title = 'Экран и управление через Moonlight';
  btn.onclick = () => openMoonlight(id, sunshineHosts.get(id));
  return btn;
}

/** Переключатель «этому человеку можно подключаться к моему компьютеру». */
function allowButton(id) {
  const on = allowed.has(id);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rc' + (on ? ' on' : '');
  btn.innerHTML = icon(on ? 'unlock' : 'lock', { size: 15 });
  btn.title = on
    ? 'Забрать доступ к моему компьютеру'
    : 'Разрешить подключаться к моему компьютеру';
  btn.onclick = () => setAllowed(id, !on);
  return btn;
}

/** Компактный ползунок громкости участника рядом с его ником. */
function peerVolumeSlider(id) {
  const wrap = document.createElement('span');
  wrap.className = 'pv-mini';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pv-icon';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0;
  slider.max = 400;
  slider.value = Math.round(settings.peerVolumeOf(id) * 100);

  const show = () => {
    const v = Number(slider.value);
    btn.innerHTML = icon(v === 0 ? 'speaker-off' : 'speaker', { size: 14 });
    wrap.title = `Громкость ${v}%`;
  };

  // Перерисовка списка во время перетаскивания сбрасывала бы ползунок.
  slider.addEventListener('pointerdown', () => (state.draggingVolume = true));
  for (const ev of ['pointerup', 'pointercancel', 'blur']) {
    slider.addEventListener(ev, () => setTimeout(() => (state.draggingVolume = false), 100));
  }
  slider.oninput = () => {
    settings.setPeerVolume(id, Number(slider.value) / 100);
    show();
  };

  let before = 1;
  btn.onclick = () => {
    const now = Number(slider.value);
    if (now > 0) before = now;
    slider.value = now > 0 ? 0 : before;
    slider.oninput();
  };

  show();
  wrap.append(btn, slider);
  return wrap;
}

function applySpeaking() {
  for (const [id, li] of state.peerEls) {
    const key = id === state.self?.id ? 'self' : id;
    li.classList.toggle('speaking', voice.speaking.has(key));
  }
}

function inviteLink() {
  return `${new URL(net.base).origin}/#${encodeURIComponent(state.code)}`;
}

function invite() {
  copy(inviteLink(), 'Ссылка скопирована', 'Ссылка для друзей:');
}





