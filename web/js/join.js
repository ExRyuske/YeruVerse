// Экран входа: код комнаты, цвет ника, сохранённые комнаты и загрузки.

import { native, net, serverBase, settings } from './core.js';
import { state } from './state.js';
import { painter, render } from './render.js';
import { PALETTE } from './settings.js';
import { icon } from './icons.js';
import { $, openExternal, toast, ui } from './ui.js';
import { join, leaveRoom } from './room.js';

painter('rooms', renderRooms);

export function wireJoin() {
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
  ui('#btn-update').onclick = installUpdate;

  buildPalette($('#join-palette'));
  buildPalette($('#set-palette'));
  render('rooms');

  checkUpdate();
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);
}

/** Код комнаты — он же её адрес. Ничего из него не выводится. */
export function joinByCode(code) {
  if (!code) return joinError('Нужен код комнаты или ссылка');
  join(code);
}

function joinError(text) {
  const err = $('#join-error');
  err.textContent = text;
  err.hidden = false;
}

/**
 * Код комнаты. В ссылке он живёт во фрагменте (`#код`) — фрагмент не уходит на
 * сервер в строке запроса и не оседает в логах прокси. Но принять надо и голый
 * код: его диктуют голосом и присылают сообщением, а не только ссылкой.
 *
 * Проверка одна на оба пути. Сервер оставляет от кода только латиницу, цифры,
 * дефис и подчёркивание, и «комната» из кириллицы превращалась у него в один
 * дефис — то есть в комнату, которую угадает кто угодно, тогда как человек
 * считал свой код секретом. Из ссылки такой код проходил молча.
 */
const CODE = /^[A-Za-z0-9_-]{1,96}$/;

export function parseInvite(text = location.href) {
  const raw = text.trim();
  if (!raw) return '';
  try {
    const hash = new URL(raw, location.origin).hash.replace(/^#/, '');
    if (hash) {
      const code = decodeURIComponent(hash);
      return CODE.test(code) ? code : '';
    }
  } catch {}
  // Не ссылка — значит, сам код.
  return CODE.test(raw) ? raw : '';
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
 * Тихая проверка обновлений: молчим, пока нечего сказать.
 *
 * Пути два, и различает их не система, а то, умеет ли сборка поставить пакет
 * сама. Настольная умеет: её плагин скачивает пакет и проверяет подпись
 * встроенным ключом. Android не умеет — APK ставит система, и приложению
 * остаётся открыть ссылку; номер последней версии для сравнения приходит от
 * сервера комнат, потому что ходить со страницы прямо на GitHub не даёт
 * политика содержимого. В обычном браузере обновлять нечего вовсе: страница и
 * так всегда свежая.
 */
async function checkUpdate() {
  const found = native.caps.updates
    ? await native.updateCheck().catch(() => null)
    : await releasedVersion();
  if (!found) return;

  $('#update-version').textContent = found;
  $('#update-notice').hidden = false;
  if (state.joined) toast(`Вышла версия ${found} — обновиться можно после выхода из комнаты`);
}

/** Что лежит в релизе, если это новее нас. Иначе — ничего. */
async function releasedVersion() {
  if (!native.available || !native.caps.version) return null;
  const release = await fetch(new URL('/update.json', serverBase()), { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({}));
  apkUrl = release.apk ?? '';
  return newer(release.version, native.caps.version) ? release.version : null;
}

/** Сравнение версий вида `1.2.3` по числам: «10» больше «9», а не меньше. */
function newer(there, here) {
  if (!there || !here) return false;
  const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(there), parts(here)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

let apkUrl = '';

async function installUpdate() {
  // Android: пакет ставит система. Открываем ссылку — дальше человек увидит
  // обычный вопрос «установить обновление?» от самой системы.
  if (!native.caps.updates) {
    if (!apkUrl) return toast('Не нашли, что скачивать — откройте страницу релизов вручную', 6000);
    toast('Скачиваем APK — система спросит про установку', 8000);
    return openExternal(apkUrl);
  }

  toast('Скачиваем обновление…', 30000);
  try {
    await native.updateInstall();
  } catch (e) {
    toast(`Обновиться не вышло: ${e.message ?? e}`, 8000);
  }
}

// ---------------------------------------------------------------- цвет ника

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

// ---------------------------------------------------------------- комнаты

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
  const onJoinScreen = host.id === 'rooms-join';
  host.innerHTML = '';

  if (onJoinScreen) {
    const title = document.createElement('h3');
    title.textContent = 'Ваши комнаты';
    host.appendChild(title);
  }

  for (const room of settings.rooms) {
    host.appendChild(roomTile(room, onJoinScreen));
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'room-add';
  add.title = 'Другая комната';
  add.textContent = '+';
  add.onclick = () => {
    if (!onJoinScreen) leaveRoom();
    $('#in-link').focus();
  };
  host.appendChild(add);
}

function roomTile(room, onJoinScreen) {
  const tile = document.createElement('div');
  tile.className = 'room-tile' + (!onJoinScreen && room.code === state.code ? ' active' : '');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'room-open';
  open.textContent = room.name;
  open.title = room.name;
  open.onclick = () => (onJoinScreen ? joinByCode(room.code) : switchRoom(room.code));

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
      render('rooms');
    };
    field.onkeydown = (e) => {
      if (e.key === 'Enter') field.blur();
      if (e.key === 'Escape') render('rooms');
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
    render('rooms');
  };

  tile.append(open, rename, forget);
  return tile;
}
