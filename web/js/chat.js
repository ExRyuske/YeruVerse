// Чат: сообщения, системные строки и вложения. Через сервер идёт только текст
// и карточка файла — сами байты качаются роем напрямую между участниками.

import { icon } from './icons.js';
import { net, swarm } from './core.js';
import { isSelf, state } from './state.js';
import { fmtClock, fmtSize, make, openExternal, showImage, toast, ui } from './ui.js';

export function initChat() {
  ui('#btn-attach').onclick = () => ui('#in-attach').click();
  ui('#in-attach').onchange = (e) => {
    for (const file of e.target.files ?? []) sendFile(file);
    e.target.value = '';
  };
  net.on('file', ({ from, meta, srv }) => {
    if (isSelf(from)) return;   // свою карточку уже нарисовали
    addAttachment(state.peers.get(from), meta, false, srv);
  });

  initDrop();

  // Скриншот из буфера уходит в чат по Ctrl+V, где бы ни стоял курсор: искать
  // ради этого скрепку и сохранённый на диск файл — лишние три действия.
  document.addEventListener('paste', (e) => {
    if (!state.self) return;                      // ещё не в комнате
    const images = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (!images.length) return;                   // обычный текст вставляется как обычно

    e.preventDefault();
    for (const img of images) sendFile(named(img));
  });
}

/**
 * Файл, брошенный в окно комнаты, уходит в чат.
 *
 * Цель — вся комната, а не узкая полоска чата: попасть в неё мышью с файлом
 * труднее, чем кажется, а промах по умолчанию открывает файл вместо страницы —
 * то есть комната просто исчезает. Поэтому промах мы гасим отдельно, на всём
 * документе.
 */
function initDrop() {
  const room = ui('#screen-room');
  // dragenter и dragleave приходят и от вложенных элементов, поэтому считаем
  // вход и выход, а не переключаем подсветку на каждом.
  let depth = 0;
  const files = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const off = () => {
    depth = 0;
    room.classList.remove('dropping');
  };

  room.addEventListener('dragenter', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    depth++;
    room.classList.add('dropping');
  });
  room.addEventListener('dragover', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  room.addEventListener('dragleave', () => {
    if (--depth <= 0) off();
  });
  room.addEventListener('drop', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    off();
    for (const file of e.dataTransfer.files) sendFile(file);
  });

  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (e) => files(e) && e.preventDefault());
  }
}

/**
 * У картинки из буфера имени нет — браузер зовёт её `image.png`. Подставляем
 * время: в списке из десяти «image.png» ничего не найти.
 */
function named(file) {
  if (file.name && file.name !== 'image.png') return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  // Тот же час, что и в строке чата: имя файла и строка, рядом с которой он
  // лежит, должны сходиться. Заодно уходит «PM» из имени файла.
  return new File([file], `Снимок ${fmtClock().replace(':', '-')}.${ext}`, { type: file.type });
}

export function clearChat() {
  ui('#chat-log').replaceChildren();
  attachRows.clear();
}

const attachRows = new Map();   // id файла -> элементы строки в чате

/** Отправка файла: через сервер идёт только карточка, байты — роем. */
function sendFile(file) {
  if (file.size > 2 * 1024 ** 3) {
    return toast('Файл больше 2 ГБ — столько не удержит память браузера');
  }
  const meta = swarm.offer(file);
  net.send({ t: 'file', meta });
  addAttachment(state.self, meta, true);
}

/** Картинки показываем прямо в чате, всё остальное — карточкой с кнопкой. */
const isImage = (meta) => (meta.mime ?? '').startsWith('image/');

function addAttachment(peer, meta, mine, at) {
  const sub = make('span', { class: 'sub', text: fmtSize(meta.size) });

  const action = make('button', {
    text: mine ? 'Раздаётся' : 'Скачать',
    disabled: mine,
    onclick: () => {
      action.disabled = true;
      action.textContent = '0%';
      swarm.start(meta);
    },
  });

  const card = make(
    'div',
    { class: 'attach', html: isImage(meta) ? null : icon('file') },
    make(
      'div',
      { class: 'meta' },
      // Текстом: имя файла приходит от чужого клиента.
      make('span', { class: 'name', text: meta.name }),
      sub
    ),
    action
  );

  // Картинку показываем сразу: свою — из своей же копии, чужую качаем сами,
  // не дожидаясь нажатия. Ради снимка экрана жать «Скачать» никто не станет.
  let img = null;
  if (isImage(meta)) {
    img = make('img', {
      class: 'shot',
      alt: meta.name,
      loading: 'lazy',
      title: 'Открыть во весь экран',
      // Пока файл не собран, открывать нечего — src появится в finishAttach.
      onclick: () => img.src && showImage(img.src, meta.name),
    });
  }

  append(make('div', {}, stamp(at), whoLabel(peer, mine), card, img));

  if (img) {
    const own = swarm.get(meta.id)?.blobUrl;
    if (own) {
      img.src = own;
      action.remove();
    } else {
      action.click();       // качаем, не дожидаясь нажатия
    }
  }

  attachRows.set(meta.id, { action, sub, img });
}

// Ход загрузки вложения. Раньше на эти события никто не подписывался, и кнопка
// молчала до самого конца: на большом файле это выглядело как «ничего не
// происходит», хотя рой в этот момент качал вовсю.
swarm.on('progress', ({ id, have, total }) =>
  renderAttachProgress(id, Math.round((have / Math.max(1, total)) * 100))
);
// Рой собрал файл целиком — кнопка превращается в «Сохранить».
swarm.on('ready', ({ id, url, meta }) => finishAttach(id, url, meta));

function renderAttachProgress(id, pct) {
  const row = attachRows.get(id);
  if (row && row.action.isConnected) row.action.textContent = `${pct}%`;
}

/**
 * Файл собран: кнопка превращается в ссылку «Сохранить».
 *
 * На диск сам он не ложится. Раньше ложился — и это значило, что любой участник
 * комнаты мог положить вам в «Загрузки» что угодно, ни о чём не спрашивая.
 */
function finishAttach(id, url, meta) {
  const row = attachRows.get(id);
  if (!row) return;

  const link = make(
    'a',
    { class: 'tag', href: url, download: meta.name, html: icon('download') },
    ' Сохранить'
  );

  if (row.action.isConnected) row.action.replaceWith(link);
  row.sub.textContent = `${fmtSize(meta.size)} · получен, теперь вы тоже раздаёте`;

  if (row.img) row.img.src = url;
}

/**
 * Общее у всех строк чата: час слева и ник говорящего. Порядок и вид у них
 * один — и у сообщения, и у карточки файла, и у системной строки, — а
 * собирались они по отдельности в трёх местах.
 */
const stamp = (at) => make('span', { class: 'at', text: fmtClock(at) });

const whoLabel = (peer, mine) =>
  make('span', {
    class: 'who',
    text: mine ? 'Вы:' : `${peer?.name ?? 'Гость'}:`,
    style: peer?.color ? { color: peer.color } : null,
  });

/** Дописать строку в конец и остаться внизу: чат читают снизу вверх. */
function append(row) {
  const log = ui('#chat-log');
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

export function addChat(who, text, mine, at, color) {
  append(make('div', {}, stamp(at), whoLabel({ name: who, color }, mine), ...withLinks(text)));
}

/**
 * Ссылка в сообщении — только `https`.
 *
 * Приглашение в игру, адрес сервера, статья — их кидают в чат постоянно, а
 * нажать было нельзя: строка приходит от чужого клиента и кладётся сюда
 * текстом, как и всё остальное чужое. Текстом она и остаётся: разбираем
 * сообщение на куски и собираем из узлов, а не из разметки. Подставить сюда
 * свой тег по-прежнему нечем.
 *
 * Схема ровно одна. `javascript:` мимо этого правила не пройдёт, а вместе с ним
 * не пройдёт и `file:` — то есть чужая строка не сможет открыть ни своего кода,
 * ни чужого диска.
 */
const LINK = /https:\/\/[^\s<>"'`]+/g;

/**
 * Знаки, которыми кончается предложение, а не ссылка. Скобку отрезаем, только
 * если открывающей в ссылке не было: в адресах вроде `.../Foo_(bar)` она своя.
 */
function trim(url) {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if ('.,!?;:»"\''.includes(last) || (last === ')' && !url.slice(0, end).includes('('))) {
      end--;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

function withLinks(text) {
  const parts = [];
  let at = 0;
  for (const found of text.matchAll(LINK)) {
    const url = trim(found[0]);
    if (!url) continue;
    if (found.index > at) parts.push(text.slice(at, found.index));
    parts.push(linkNode(url));
    at = found.index + url.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * Открываем системой, а не переходом в окне: в приложении переход увёл бы
 * человека из комнаты, а вернуться оттуда нечем. `href` при этом настоящий —
 * ради «копировать ссылку» в контекстном меню и подсказки браузера внизу окна.
 */
function linkNode(url) {
  return make('a', {
    class: 'link',
    href: url,
    text: url,
    title: url,
    rel: 'noopener noreferrer',
    target: '_blank',
    onclick: (e) => {
      e.preventDefault();
      openExternal(url);
    },
  });
}

/**
 * Системная строка: кто вошёл, кто вышел, кто включил трансляцию.
 *
 * Со временем, как и всё остальное в чате. Без него в разговоре, к которому
 * вернулись через полчаса, не понять, «вышел» — это только что или ещё до
 * перерыва.
 *
 * Время можно передать: про выход мы сообщаем с задержкой — вдруг человек
 * просто моргнул связью и сейчас вернётся, — и показать надо тот час, когда он
 * ушёл, а не тот, когда мы решились об этом сказать.
 */
export function sysMsg(text, at) {
  append(make('div', { class: 'sys' }, stamp(at), text));
}
