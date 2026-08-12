import { Net } from './net.js';
import { Mesh } from './mesh.js';
import { Swarm } from './swarm.js';
import { Voice } from './voice.js';
import { Settings, PALETTE } from './settings.js';
import { Pointers } from './pointers.js';
import { icon } from './icons.js';
import { Hotkeys } from './hotkeys.js';
import {
  $, ui, toast, copy, clearStaleFlag, showVideo,
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

/**
 * Новые настройки — на живую трансляцию, без перезапуска.
 *
 * Битрейт и частоту кадров задаёт кодировщик, и там они меняются на лету. А вот
 * разрешение — свойство самого захвата: пока дорожка отдаёт 1080 строк, никакие
 * настройки кодировщика не сделают из них 720. Поэтому разрешение просим у
 * дорожки отдельно.
 *
 * Если дорожка меняться отказалась — а это умеют не все движки, — захват
 * перезапускается целиком. Тогда система снова спросит, что показывать: обидно,
 * но лучше, чем настройка, которая молча ничего не делает.
 */
let retuneTimer;
function retuneCapture() {
  // Ползунок шлёт событие на каждый пиксель, а applyConstraints — операция не
  // из дешёвых: ждём, пока человек отпустит.
  clearTimeout(retuneTimer);
  retuneTimer = setTimeout(async () => {
    const track = state.shares.get('screen')?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    const q = streamSettings();
    try {
      await track.applyConstraints({
        height: { ideal: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      });
    } catch {
      restartScreen();
    }
  }, 400);
}

settings.on(({ key }) => {
  if (!key.startsWith('stream')) return;
  applyQuality();
  // Битрейт живёт только в кодировщике, дорожку он не касается.
  if (key !== 'streamBitrate') retuneCapture();
});

// Камеру меняют, когда она уже включена: перезапускаем захват и подменяем
// дорожку — собеседники не видят ни разрыва, ни пересогласования.
//
// Старый захват отпускаем до нового, а не после. Система не отдаёт одно и то же
// устройство дважды, и запрос поверх работающего падал с «занято другим
// приложением» — на телефоне, где камера всего одна, это значило, что сменить
// её нельзя вовсе.
settings.on(async ({ key }) => {
  if (key !== 'camDevice' || !state.shares.has('cam')) return;
  state.shares.get('cam').getTracks().forEach((t) => t.stop());
  try {
    const stream = await SHARES.cam.capture();
    state.shares.set('cam', stream);
    await mesh.replaceStream('cam', stream);
    addScreen(viewKey(state.self.id, 'cam'), stream);
  } catch (e) {
    // Прежний поток уже мёртв, поэтому камеру честно выключаем: оставить
    // остановленную дорожку значит показывать всем застывший кадр.
    stopShare('cam');
    toast(`Камера не включилась: ${deviceProblem(e)}`);
  }
});
// Зеркало — дело показа, а не захвата: перерисовать плитки достаточно.
settings.on(({ key }) => key === 'mirrorCam' && renderCams());

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
  joined: false,
  code: '',          // единственный секрет комнаты; на сервер уходит производное
  sunshine: null,       // адрес нашего Sunshine, если он запущен
  sunshineOpen: false,  // виден ли он из интернета
  paused: false,        // мы перехватили управление у гостей
};

// ---------------------------------------------------------------- запуск

init();

async function init() {
  $('#btn-get-app').hidden = native.available;
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
    renderControl();
    renderPeers();
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

  wireSidebar();
  wirePopovers();
  renderRooms();
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
    hidden: () => [...hidden].map((k) => `${state.peers.get(viewPeer(k))?.name ?? '?'} (${viewKind(k) === 'cam' ? 'камера' : 'экран'})`),
    sunshine: () => state.sunshine,
    sunshineHint,
    enableMic,
  });
  wireHotkeys();
  refreshDevices();
  // Наушники воткнули или камеру отключили — список должен это заметить сам.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());
  initChat({
    ui,
    net,
    swarm,
    self: () => state.self,
    peer: (id) => state.peers.get(id),
  });

  // Захвата экрана на телефоне нет ни у одного движка: ни Chrome для Android,
  // ни системный вебвью не отдают getDisplayMedia, а системный MediaProjection
  // в MediaStream страницы никак не превращается. Кнопку в таком окружении
  // убираем совсем — вместе с настройками качества, которые ей и служат:
  // погашенная кнопка обещает, что когда-нибудь заработает, а она не заработает.
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('#btn-screen').closest('.with-pick').hidden = true;
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

  // Всё, что можно скачать, собрано в одну панель справа — как сохранённые
  // комнаты слева. Приложение предлагаем только тем, у кого его ещё нет.
  ui('#btn-get-app-join').hidden = native.available;
  ui('#btn-get-app-join').onclick = () =>
    openExternal('https://github.com/ExRyuske/YeruVerse/releases/latest');
  ui('#btn-get-sunshine').onclick = () =>
    openExternal('https://github.com/LizardByte/Sunshine/releases/latest');
  ui('#btn-get-moonlight').onclick = () => openExternal('https://moonlight-stream.org/');

  // Обновления предлагаем на экране входа, а не посреди разговора. Кнопки
  // «позже» нет: предложение и так стоит сбоку и ничего не загораживает, а
  // спрятать его можно, просто войдя в комнату.
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

/**
 * Внешняя ссылка. В приложении её открывает система: переход внутри окна увёл
 * бы человека из комнаты, а вернуться оттуда нечем.
 */
function openExternal(url) {
  if (native.available) native.openUrl(url).catch(() => window.open(url, '_blank'));
  else window.open(url, '_blank', 'noopener');
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

  renderRooms();
  pollSunshine();
}

/**
 * Переход в другую сохранённую комнату: выходим из текущей и сразу входим в
 * выбранную, не показывая экран входа — он тут только мешал бы.
 */
function switchRoom(code) {
  if (code === state.code) return;
  leaveRoom();
  joinByCode(code);
}

/**
 * Список сохранённых комнат — и слева в комнате, и на экране входа: чаще всего
 * заходят именно в свои, а не вписывают код заново.
 */
function renderRooms() {
  const empty = !settings.rooms.length;
  for (const host of [$('#rooms'), $('#rooms-join')]) {
    renderRoomList(host);
    host.hidden = empty;      // пустой столбец — только шум
  }
  const save = $('#btn-save-room');
  const saved = !!settings.roomName(state.code);
  save.classList.toggle('active', saved);
  save.title = saved ? 'Забыть комнату' : 'Сохранить комнату';
}

function renderRoomList(host) {
  const join = host.id === 'rooms-join';
  host.innerHTML = '';

  if (join) {
    const title = document.createElement('h3');
    title.textContent = 'Ваши комнаты';
    host.appendChild(title);
  }

  for (const room of settings.rooms) {
    const tile = document.createElement('div');
    tile.className = 'room-tile' + (!join && room.code === state.code ? ' active' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'room-open';
    open.textContent = room.name;
    open.title = room.name;
    open.onclick = () => (join ? joinByCode(room.code) : switchRoom(room.code));

    // Переименование прямо на месте: prompt() системный вебвью не показывает,
    // и обработчик обрывался бы на нём молча.
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'mark room-act';
    rename.title = 'Переименовать';
    rename.innerHTML = icon('pen');
    rename.onclick = () => {
      const field = document.createElement('input');
      field.className = 'room-rename';
      field.value = room.name;
      field.maxLength = 24;
      field.onblur = () => {
        settings.saveRoom(room.code, field.value.trim() || room.name);
        renderRooms();
      };
      field.onkeydown = (e) => {
        if (e.key === 'Enter') field.blur();
        if (e.key === 'Escape') renderRooms();
      };
      tile.replaceChildren(field);
      field.focus();
      field.select();
    };

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'mark room-act';
    forget.title = 'Забыть комнату';
    forget.innerHTML = icon('close');
    forget.onclick = () => {
      settings.forgetRoom(room.code);
      renderRooms();
    };

    tile.append(open, rename, forget);
    host.appendChild(tile);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'room-add';
  add.title = 'Другая комната';
  add.textContent = '+';
  add.onclick = () => {
    if (!join) leaveRoom();
    $('#in-link').focus();
  };
  host.appendChild(add);
}

/** Полный выход: рвём сокет, гасим WebRTC, забываем комнату. */
function leaveRoom() {
  for (const kind of [...state.shares.keys()]) stopShare(kind);
  control.revokeAll().catch(() => {});
  // Взятое управление не должно переживать выход: иначе в следующей комнате
  // первый же открытый замок сразу отдал бы чужой компьютер нашей мыши.
  control.setTaking(false);
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
  // Кому я разрешил зайти на свой компьютер — вместе с комнатой и заканчивается.
  // Список переживал выход, хотя те люди остались в покинутой комнате.
  allowed.clear();
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
  renderRooms();
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
    toast(`Микрофон недоступен: ${deviceProblem(e)}`);
  }
}

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
  renderControl();

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
    if (viewKind(key) === 'cam' || hidden.has(key)) continue;   // камеры на своей полосе
    const peer = state.peers.get(viewPeer(key));
    chips.push({ id: key, icon: 'screen', label: peer?.name ?? 'Участник', color: peer?.color });
  }

  // Ряд нужен и когда трансляция одна: переключать нечего, но в том же ряду
  // живёт её громкость, и вместе с рядом она пропадала.
  host.hidden = !chips.length;

  const vol = host.querySelector('.pv-mini');
  for (const el of [...host.children]) if (el !== vol) el.remove();

  for (const c of chips) {
    const b = document.createElement('button');
    b.className = 'ghost' + (c.id === state.view ? ' active' : '');
    b.innerHTML = icon(c.icon);
    const text = document.createElement('span');
    text.textContent = c.label;
    b.appendChild(text);
    if (c.color && c.id !== state.view) b.style.color = c.color;
    b.onclick = () => {
      state.view = c.id;
      renderViews();
      renderStage();
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

// Ход загрузки вложения. Раньше на это событие никто не подписывался, и кнопка
// молчала до самого конца: на большом файле это выглядело как «ничего не
// происходит», хотя рой в этот момент качал вовсю.
swarm.on('progress', ({ id, have, total }) =>
  renderAttachProgress(id, Math.round((have / Math.max(1, total)) * 100))
);
// Рой собрал файл целиком — кнопка превращается в «Сохранить».
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
let reachedAt = 0;
let reached = {};

async function pollSunshine() {
  // Адрес Sunshine нужен только в комнате: вне её раздавать его некому, а мост
  // приложения незачем дёргать каждые полминуты просто так.
  if (!native.available || !state.joined) return;
  const { running, address } = await native.sunshine().catch(() => ({}));
  if (!running || !address) {
    if (state.sunshine) {
      state.sunshine = null;
      for (const id of allowed) tellSunshine(id);
      renderPeers();
    }
    return;
  }

  // Виден ли Sunshine снаружи, решают проброс портов на роутере и адрес
  // провайдера — они меняются раз в недели, а не раз в полминуты. Спрашиваем
  // сервер не чаще раза в пять минут, иначе это просто фоновый запрос по кругу.
  if (Date.now() - reachedAt > 5 * 60 * 1000) {
    reached = await fetch(new URL('/reach', serverBase()), { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({}));
    reachedAt = Date.now();
  }
  const reach = reached;
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
// Выключенные для себя трансляции: ключ вида `peer:kind`. Просьба уходит
// владельцу, и он снимает дорожку именно с нашего соединения — экономится не
// только процессор, но и канал.
const hidden = new Set();

mesh.on('message', ({ id, msg }) => {
  if (msg?.ns === 'pause') mesh.pauseFor(id, msg.kind, !!msg.on);
});

/** Показывать этот поток или нет. Решение личное и другим зрителям не видно. */
function setHidden(key, on) {
  if (on) hidden.add(key);
  else hidden.delete(key);
  // Просьба идёт владельцу потока. Свой прячем только локально: соединения с
  // самим собой нет, да и захват всё равно продолжается ради остальных.
  if (viewPeer(key) !== state.self?.id) {
    mesh.send(viewPeer(key), { ns: 'pause', kind: viewKind(key), on });
  }

  if (on && state.view === key) state.view = firstScreen();
  // Вернули демонстрацию, а сцена пуста — показываем её, иначе выглядит так,
  // будто включение не сработало.
  if (!on && !state.view && viewKind(key) === 'screen') state.view = key;
  renderViews();
  renderCams();
  renderStage();
  renderPeers();
}

mesh.on('stream', ({ id, stream, kind }) => {
  if (kind === 'mic') {
    voice.attach(id, stream);
    return;
  }
  const key = viewKey(id, kind);
  addScreen(key, stream);
  if (hidden.has(key)) mesh.send(id, { ns: 'pause', kind, on: true });
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
  } else if (!state.view && viewKind(key) === 'screen') {
    state.view = key;          // смотреть всё равно нечего — покажем сразу
  }
  renderViews();
  renderCams();
  renderStage();
}

function removeScreen(key) {
  if (!state.screens.delete(key)) return;
  if (state.view === key) state.view = firstScreen();
  renderViews();
  renderCams();
  renderStage();
}

/** Первая доступная демонстрация экрана — камеры сцену не занимают. */
function firstScreen() {
  return [...state.screens.keys()].find((k) => viewKind(k) === 'screen' && !hidden.has(k)) ?? null;
}

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
      tile = document.createElement('div');
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
      host.appendChild(tile);
      camTiles.set(key, tile);
    }
    const video = tile.querySelector('video');
    const stream = state.screens.get(key);
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    const mine = viewPeer(key) === state.self?.id;
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

  // Своё состояние ставим в списке сразу. Сервер вернёт ровно это же, но
  // круговым путём, и до ответа метка возле своего ника отставала бы от кнопки
  // внизу — а при обрыве связи не появилась бы вовсе.
  const me = state.peers.get(state.self?.id);
  if (me) Object.assign(me, { voice: enabled, muted, deaf: deafened });
  renderPeers();
});

voice.on('blocked', () => toast('Нажмите в любом месте страницы, чтобы включить звук'));

// Шумодав отвалился на ходу. Сказать об этом важнее, чем кажется: молча
// подменённая обработка звучит иначе, и человек ищет причину в микрофоне.
voice.on('denoise-fallback', ({ to }) =>
  toast(
    to === 'browser'
      ? 'Шумодав RNNoise замолчал — перешли на подавление средствами системы'
      : 'Шумодав RNNoise замолчал, подавления шума больше нет',
    8000
  )
);

// ---------------------------------------------------------------- управление

voice.on('devices', () => refreshDevices());


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

  ui('#btn-full').onclick = toggleFullscreen;

  ui('#btn-get-app').onclick = () =>
    openExternal('https://github.com/ExRyuske/YeruVerse/releases/latest');
  // Комната сохраняется по нажатию: заходят и в чужие, и по одному разу —
  // складывать в список всё подряд значит превратить его в свалку.
  ui('#btn-save-room').onclick = () => {
    if (settings.roomName(state.code)) {
      settings.forgetRoom(state.code);
    } else {
      settings.saveRoom(state.code, `Комната ${settings.rooms.length + 1}`);
      toast('Комната сохранена — переименовать можно карандашом в списке');
    }
    renderRooms();
  };
  renderControl();
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

/**
 * Разбираем отказ в захвате: причина почти всегда в контексте, а не в коде.
 *
 * Про устройство говорим безлично — «устройство занято», а не «микрофон занят».
 * Один и тот же разбор нужен и микрофону, и камере, а называть камеру
 * микрофоном хуже, чем не называть никак: человек начинает искать поломку не
 * там, где она есть.
 */
function deviceProblem(e) {
  if (!window.isSecureContext) {
    return `страница открыта по ${location.protocol.replace(':', '')} — нужен https`;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'браузер не даёт доступ к устройствам — откройте сайт в обычном браузере, а не во встроенном окне мессенджера';
  }
  switch (e?.name) {
    case 'NotAllowedError':
      return 'доступ запрещён — разрешите его для сайта в настройках браузера';
    case 'NotFoundError':
      return 'устройство не найдено';
    case 'NotReadableError':
      return 'устройство занято другим приложением';
    case 'OverconstrainedError':
      return 'устройство не умеет то, что мы просим';
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
    capture: async () => {
      const id = settings.get('camDevice');
      // Размер и частота — пожеланием: телефонная камера часто не умеет ровно
      // столько, и жёсткое требование обернулось бы отказом вместо картинки.
      const base = { width: { ideal: 1280 }, frameRate: { ideal: 30 } };
      // Не выбрана — берём фронтальную: на телефоне до первого доступа система
      // не называет камеры, и выбирать там пока не из чего.
      const video = id ? { ...base, deviceId: { exact: id } } : { ...base, facingMode: 'user' };

      // звук идёт голосовым каналом, дублировать незачем
      try {
        return await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        if (e?.name !== 'OverconstrainedError') throw e;
        // Запомненной камеры больше нет — берём любую. Оставить человека без
        // картинки из-за строчки в настройках хуже, чем взять не ту камеру.
        settings.set('camDevice', '');
        return navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      }
    },
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

    // Названия камер и микрофонов система показывает только после того, как
    // доступ уже выдан. До первого включения в списке голые «Камера 1».
    if (kind === 'cam') refreshDevices();

    // Оверлей поднимаем вместе с трансляцией — и только если указка включена.
    if (native.caps.overlay) native.setOverlay(true).catch(() => {});
    if (kind === 'screen') watchFrames(stream);
    stream.getVideoTracks()[0].addEventListener('ended', () => stopShare(kind));
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast(`${share.missing}: ${deviceProblem(e)}`);
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

/**
 * Перезапуск демонстрации с новыми настройками — запасной путь для движков, где
 * живой захват настройки менять не даёт. Система снова спросит, что показывать:
 * без этого вопроса захват экрана не начинается нигде и никогда.
 */
async function restartScreen() {
  if (!state.shares.has('screen')) return;
  stopShare('screen');
  // Про отказ toggleShare рассказывает сам, поэтому смотрим на итог, а не ловим
  // исключение: захват мог не начаться и молча — например, если окно выбора
  // закрыли.
  await toggleShare('screen');
  toast(
    state.shares.has('screen')
      ? 'Трансляция перезапущена с новыми настройками'
      : 'Настройки применятся, когда включите трансляцию заново',
    6000
  );
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

/**
 * Список участников.
 *
 * Строки переживают перерисовку, а не создаются заново. Раньше список стирался
 * целиком на каждое изменение присутствия, и ползунок громкости исчезал прямо
 * из-под пальца — ради этого стоял флаг «сейчас тянут», который просто отменял
 * перерисовку. Список замирал: пока крутишь громкость, в нём не видно ни кто
 * вошёл, ни кто выключил микрофон.
 */
function renderPeers() {
  const list = $('#peer-list');

  for (const [id, li] of state.peerEls) {
    if (state.peers.has(id)) continue;
    li.remove();
    state.peerEls.delete(id);
  }

  for (const p of state.peers.values()) {
    let li = state.peerEls.get(p.id);
    if (!li) {
      li = newPeerRow();
      state.peerEls.set(p.id, li);
      list.appendChild(li);
    }
    updatePeerRow(li, p);
  }

  $('#peer-count').textContent = state.peers.size;
  renderCams();          // на плитках подписаны ники — они могли смениться
  applySpeaking();
}

/**
 * Каркас строки. Значки внутри меняются часто, а сама строка и ползунок
 * громкости живут, пока человек в комнате. Обёртки прозрачны для раскладки
 * (`display: contents`), поэтому ряд выглядит так же, как если бы значки лежали
 * в строке сами по себе.
 */
function newPeerRow() {
  const li = document.createElement('li');
  for (const cls of ['peer-name', 'peer-marks', 'peer-acts']) {
    const part = document.createElement('span');
    part.className = cls;
    li.appendChild(part);
  }
  return li;
}

function updatePeerRow(li, p) {
  const mine = p.id === state.self?.id;
  const name = li.querySelector('.peer-name');
  const marks = li.querySelector('.peer-marks');
  const acts = li.querySelector('.peer-acts');

  const label = p.name + (mine ? ' (вы)' : '');
  if (name.textContent !== label) name.textContent = label;
  name.style.color = p.color || 'inherit';

  // Значок только у молчащих: включённый микрофон — это норма, и рисовать его
  // возле каждого ника значит показывать одно и то же по кругу. Своё состояние
  // показываем наравне с чужими: список должен читаться как список, а не как
  // «все, кроме меня», — и заодно видно, каким тебя видят остальные.
  const icons = [];
  for (const [show, glyph, title] of [
    [!p.voice || p.muted, 'mic-off', p.voice ? 'Микрофон заглушён' : 'Микрофон выключен'],
    [p.deaf, 'speaker-off', 'Звук выключен — участников не слышно'],
  ]) {
    if (!show) continue;
    const mark = document.createElement('span');
    mark.className = 'mark off';
    mark.innerHTML = icon(glyph);
    mark.title = title;
    icons.push(mark);
  }

  // Значок трансляции — заодно выключатель: чужую можно перестать получать
  // вовсе, чтобы не тратить ни канал, ни процессор.
  for (const [on, glyph, kind] of [
    [p.screen, 'screen', 'screen'],
    [p.camera, 'camera', 'cam'],
  ]) {
    if (!on) continue;
    const key = viewKey(p.id, kind);
    const off = hidden.has(key);
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'mark' + (off ? ' off' : '');
    tag.innerHTML = icon(glyph);
    tag.title = off
      ? 'Выключено у вас — вернуть'
      : mine
        ? 'Убрать у себя из виду (остальные продолжат видеть)'
        : 'Не получать эту трансляцию';
    tag.onclick = () => setHidden(key, !off);
    icons.push(tag);
  }
  marks.replaceChildren(...icons);

  // Ползунок появляется у тех, кого мы реально слышим, и живёт, пока слышим.
  const heard = !mine && voice.remotes.has(p.id);
  let vol = li.querySelector('.pv-mini');
  if (heard && !vol) li.insertBefore((vol = peerVolumeSlider(p.id)), acts);
  else if (!heard && vol) vol.remove();
  else vol?.sync();

  const actions = [];
  if (!mine) {
    // Кому можно за мой компьютер — решаю я, поимённо. Замок нужен и без
    // Sunshine: он же открывает простое управление по WebRTC.
    if (native.caps.remoteControl) actions.push(allowButton(p.id));
    // А к кому можно мне — те, кто уже разрешил.
    if (sunshineHosts.has(p.id)) actions.push(moonlightButton(p.id));
    if (state.paused && control.granted.has(p.id)) {
      const tag = document.createElement('span');
      tag.className = 'tag warn';
      tag.textContent = 'на паузе';
      actions.push(tag);
    }
  }
  acts.replaceChildren(...actions);
}

/** Кнопка «подключиться к этому компьютеру Moonlight'ом». */
function moonlightButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mark';
  btn.innerHTML = icon('gamepad');
  btn.title = 'Экран и управление через Moonlight';
  btn.onclick = () => openMoonlight(id, sunshineHosts.get(id));
  return btn;
}

/** Переключатель «этому человеку можно подключаться к моему компьютеру». */
function allowButton(id) {
  const on = allowed.has(id);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mark' + (on ? ' on' : '');
  btn.innerHTML = icon(on ? 'unlock' : 'lock');
  btn.title = on
    ? 'Забрать доступ к моему компьютеру'
    : 'Разрешить подключаться к моему компьютеру';
  btn.onclick = () => setAllowed(id, !on);
  return btn;
}

/**
 * Компактный ползунок громкости: кнопка-выключатель и шкала рядом.
 *
 * Один на два случая — голос участника и звук трансляции. Отличались они только
 * пределом и тем, куда сохранять значение, а кода было по тридцать строк на
 * каждый, слово в слово.
 */
function volumeSlider({ max, label, get, set }) {
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

/** Громкость голоса участника. Держится по нику, а не по идентификатору. */
function peerVolumeSlider(id) {
  return volumeSlider({
    max: 400,
    label: 'Громкость',
    get: () => settings.peerVolumeOf(id),
    set: (v) => settings.setPeerVolume(id, v),
  });
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





