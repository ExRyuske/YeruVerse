// Чат: сообщения, системные строки и вложения. Через сервер идёт только текст
// и карточка файла — сами байты качаются роем напрямую между участниками.

import { icon } from './icons.js';
import { $, toast, fmtSize, fmtClock } from './ui.js';

/** Модуль не знает про глобальное состояние — всё нужное передаётся сюда. */
let ctx = null;

export function initChat(deps) {
  ctx = deps;
  ctx.ui('#btn-attach').onclick = () => ctx.ui('#in-attach').click();
  ctx.ui('#in-attach').onchange = (e) => {
    for (const file of e.target.files ?? []) sendFile(file);
    e.target.value = '';
  };
  ctx.net.addEventListener('file', ({ detail }) => {
    if (detail.from === ctx.self()?.id) return;   // свою карточку уже нарисовали
    addAttachment(ctx.peer(detail.from), detail.meta, false, detail.srv);
  });

  initDrop();

  // Скриншот из буфера уходит в чат по Ctrl+V, где бы ни стоял курсор: искать
  // ради этого скрепку и сохранённый на диск файл — лишние три действия.
  document.addEventListener('paste', (e) => {
    if (!ctx.self()) return;                      // ещё не в комнате
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
  const room = $('#screen-room');
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
  const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new File([file], `Снимок ${at.replace(':', '-')}.${ext}`, { type: file.type });
}

export function clearChat() {
  $('#chat-log').innerHTML = '';
  attachRows.clear();
}

const attachRows = new Map();   // id файла -> элементы строки в чате

/** Отправка файла: через сервер идёт только карточка, байты — роем. */
function sendFile(file) {
  if (file.size > 2 * 1024 ** 3) {
    return toast('Файл больше 2 ГБ — столько не удержит память браузера');
  }
  const meta = ctx.swarm.offer(file);
  ctx.net.send({ t: 'file', meta });
  addAttachment(ctx.self(), meta, true);
}


/** Картинки показываем прямо в чате, всё остальное — карточкой с кнопкой. */
const isImage = (meta) => (meta.mime ?? '').startsWith('image/');

function addAttachment(peer, meta, mine, at) {
  const log = $('#chat-log');
  const row = document.createElement('div');

  const time = document.createElement('span');
  time.className = 'at';
  time.textContent = fmtClock(at);

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = mine ? 'Вы:' : `${peer?.name ?? 'Гость'}:`;
  if (peer?.color) who.style.color = peer.color;

  const card = document.createElement('div');
  card.className = 'attach';
  if (!isImage(meta)) card.innerHTML = icon('file', { size: 18 });

  const info = document.createElement('div');
  info.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = meta.name;             // текстом: имя приходит от чужого клиента
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = fmtSize(meta.size);
  info.append(name, sub);

  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = mine ? 'Раздаётся' : 'Скачать';
  action.disabled = mine;
  action.onclick = () => {
    action.disabled = true;
    action.textContent = '0%';
    ctx.swarm.start(meta);
  };

  card.append(info, action);
  row.append(time, who, card);

  // Картинку показываем сразу: свою — из своей же копии, чужую качаем сами,
  // не дожидаясь нажатия. Ради снимка экрана жать «Скачать» никто не станет.
  let img = null;
  if (isImage(meta)) {
    img = document.createElement('img');
    img.className = 'shot';
    img.alt = meta.name;
    img.loading = 'lazy';
    row.appendChild(img);

    const own = ctx.swarm.get(meta.id)?.blobUrl;
    if (own) {
      img.src = own;
      action.remove();
    } else {
      action.click();
    }
  }

  log.appendChild(row);
  log.scrollTop = log.scrollHeight;

  attachRows.set(meta.id, { action, sub, img });
}

export function renderAttachProgress(id, pct) {
  const row = attachRows.get(id);
  if (row && row.action.isConnected) row.action.textContent = `${pct}%`;
}

/** Файл собран: подменяем кнопку ссылкой и сразу сохраняем его на диск. */
export function finishAttach(id, url, meta) {
  const row = attachRows.get(id);
  if (!row) return;

  const link = document.createElement('a');
  link.href = url;
  link.download = meta.name;
  link.innerHTML = icon('download', { size: 14 });
  link.append(' Сохранить');
  link.className = 'tag';

  if (row.action.isConnected) row.action.replaceWith(link);
  row.sub.textContent = `${fmtSize(meta.size)} · получен, теперь вы тоже раздаёте`;

  if (row.img) {
    row.img.src = url;
    return;   // картинка уже перед глазами, на диск её сохраняют по желанию
  }
  link.click();
}

export function addChat(who, text, mine, at, color) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = mine ? 'Вы:' : `${who}:`;
  if (color) w.style.color = color;

  const time = document.createElement('span');
  time.className = 'at';
  time.textContent = fmtClock(at);

  div.append(time, w, document.createTextNode(text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;

}

export function sysMsg(text) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}


