// Экран входа: код комнаты, цвет ника, сохранённые комнаты и загрузки.

import { askServer, native, net, settings } from './core.js';
import { state } from './state.js';
import { reason } from './errors.js';
import { painter, render } from './render.js';
import { PALETTE } from './settings.js';
import { icon } from './icons.js';
import { make, openExternal, toast, ui } from './ui.js';
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
      joinError(`Не вышло: ${reason(e)}`);
    }
  };

  ui('#btn-create').onclick = () => joinByCode(randomCode());

  // Всё, что можно скачать, собрано в одну панель справа — как сохранённые
  // комнаты слева. Приложение предлагаем только тем, у кого его ещё нет.
  ui('#btn-get-app-join').hidden = native.available;
  ui('#btn-get-app-join').onclick = () =>
    openExternal('https://github.com/ExRyuske/YeruVerse/releases/latest');

  // Обновления предлагаем на экране входа, а не посреди разговора. Кнопки
  // «позже» нет: предложение и так стоит сбоку и ничего не загораживает, а
  // спрятать его можно, просто войдя в комнату.
  ui('#btn-update').onclick = installUpdate;

  buildPalette(ui('#join-palette'));
  buildPalette(ui('#set-palette'));
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
  const err = ui('#join-error');
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
    ? await native.updateCheck().catch(failedCheck)
    : await releasedVersion();
  if (!found) return;

  ui('#update-version').textContent = found;
  ui('#update-notice').hidden = false;
  if (state.joined) toast(`Вышла версия ${found} — обновиться можно после выхода из комнаты`);
}

/**
 * Молчим для человека, но не для того, кто чинит. Отказ проверки выглядит
 * снаружи ровно как «обновлений нет», и однажды так пропала целая платформа:
 * в манифесте не было записи под Windows, обновлятель отвечал ошибкой, а мы
 * её глотали. В консоли она теперь видна.
 */
function failedCheck(e) {
  console.warn('YeruVerse: не удалось проверить обновления —', reason(e));
  return null;
}

/** Что лежит в релизе, если это новее нас. Иначе — ничего. */
async function releasedVersion() {
  if (!native.available || !native.caps.version) return null;
  const release = await askServer('/update.json');
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
    toast(`Обновиться не вышло: ${reason(e)}`, 8000);
  }
}

// ---------------------------------------------------------------- цвет ника

function buildPalette(host) {
  host.replaceChildren(
    ...PALETTE.map((c) =>
      make('button', {
        title: c,
        style: { background: c },
        ariaLabel: `Цвет ${c}`,
        onclick: () => {
          settings.set('color', c);
          syncPalettes();
          if (state.joined) net.profile(undefined, c);
        },
      })
    )
  );
  syncPalettes();
}

function syncPalettes() {
  for (const host of [ui('#join-palette'), ui('#set-palette')]) {
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
  for (const host of [ui('#rooms'), ui('#rooms-join')]) {
    renderRoomList(host);
    host.hidden = empty;      // пустой столбец — только шум
  }
  const save = ui('#btn-save-room');
  const saved = !!settings.roomName(state.code);
  save.classList.toggle('active', saved);
  save.title = saved ? 'Забыть комнату' : 'Сохранить комнату';
}

function renderRoomList(host) {
  const onJoinScreen = host.id === 'rooms-join';

  host.replaceChildren(
    // Заголовок нужен только на входе: в комнате столбец и так стоит под
    // своим местом, и подписывать его второй раз незачем.
    ...(onJoinScreen ? [make('h3', { text: 'Ваши комнаты' })] : []),
    ...settings.rooms.map((room) => roomTile(room, onJoinScreen)),
    make('button', {
      class: 'room-add',
      title: 'Другая комната',
      text: '+',
      onclick: () => {
        if (!onJoinScreen) leaveRoom();
        ui('#in-link').focus();
      },
    })
  );
}

function roomTile(room, onJoinScreen) {
  const active = !onJoinScreen && room.code === state.code;

  /**
   * Переименование прямо на месте: prompt() системный вебвью не показывает,
   * и обработчик обрывался бы на нём молча.
   */
  const rename = () => {
    const field = make('input', {
      class: 'room-rename',
      value: room.name,
      maxLength: 24,
      onblur: () => {
        settings.saveRoom(room.code, field.value.trim() || room.name);
        render('rooms');
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') field.blur();
        if (e.key === 'Escape') render('rooms');
      },
    });
    tile.replaceChildren(field);
    field.focus();
    field.select();
  };

  const tile = make(
    'div',
    { class: `room-tile${active ? ' active' : ''}` },
    make('button', {
      class: 'room-open',
      text: room.name,
      title: room.name,
      onclick: () => (onJoinScreen ? joinByCode(room.code) : switchRoom(room.code)),
    }),
    make('button', {
      class: 'mark room-act',
      title: 'Переименовать',
      html: icon('pen'),
      onclick: rename,
    }),
    make('button', {
      class: 'mark room-act',
      title: 'Забыть комнату',
      html: icon('close'),
      onclick: () => {
        settings.forgetRoom(room.code);
        render('rooms');
      },
    })
  );
  return tile;
}
