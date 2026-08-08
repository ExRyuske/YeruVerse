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
  card.innerHTML = icon('file', { size: 18 });

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
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;

  attachRows.set(meta.id, { action, sub });
}

export function renderAttachProgress(id, pct) {
  const row = attachRows.get(id);
  if (row && row.action.isConnected) row.action.textContent = `${pct}%`;
}

/** Файл собран: подменяем кнопку ссылкой и сразу сохраняем его на диск. */
export function finishAttach(id, url, meta) {
  const row = attachRows.get(id);
  if (!row || !row.action.isConnected) return;

  const link = document.createElement('a');
  link.href = url;
  link.download = meta.name;
  link.innerHTML = icon('download', { size: 14 });
  link.append(' Сохранить');
  link.className = 'tag';
  row.action.replaceWith(link);
  row.sub.textContent = `${fmtSize(meta.size)} · получен, теперь вы тоже раздаёте`;
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


