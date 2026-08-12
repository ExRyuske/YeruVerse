// Жизнь комнаты: вход, выход и всё, что приходит с сервера, пока мы внутри.

import { control, mesh, net, serverBase, settings, swarm, voice } from './core.js';
import { isSelf, state, viewKey } from './state.js';
import { render } from './render.js';
import { $, copy, openExternal, showScreen, toast, ui } from './ui.js';
import { addChat, clearChat, sysMsg } from './chat.js';
import { removeScreen, resetStage } from './stage.js';
import { announceShares, stopShare } from './shares.js';
import { pollSunshine, resetSunshine } from './sunshine.js';
import { enableMic } from './devices.js';

/** Код комнаты — он же её адрес. Ничего из него не выводится. */
export function join(code) {
  if (state.joined) return;      // второй клик не должен плодить комнаты

  state.joined = true;
  state.code = code;
  const name = $('#in-name').value.trim();
  settings.set('name', name);

  net.connect({ base: serverBase(), room: code, name, color: settings.get('color') });
  // Просим микрофон прямо здесь: это ещё контекст пользовательского клика,
  // а значит запрос разрешения не будет отклонён браузером автоматически.
  enableMic();
  showScreen('room');
  $('#room-name').textContent = state.code;
  // В адресной строке держим код: перезагрузка вернёт в ту же комнату.
  history.replaceState(null, '', `${location.pathname}#${encodeURIComponent(state.code)}`);

  render('rooms');
  pollSunshine();
}

/** Полный выход: рвём сокет, гасим WebRTC, забываем комнату. */
export function leaveRoom() {
  for (const kind of [...state.shares.keys()]) stopShare(kind);
  control.revokeAll().catch(() => {});
  // Взятое управление не должно переживать выход: иначе в следующей комнате
  // первый же открытый замок сразу отдал бы чужой компьютер нашей мыши.
  control.setTaking(false);
  voice.disable();
  for (const id of [...voice.remotes.keys()]) voice.detach(id);
  swarm.clear();
  mesh.destroy();
  resetStage();
  net.reset();

  state.joined = false;
  state.everJoined = false;
  state.self = null;
  state.code = '';
  state.peers.clear();
  state.peerEls.clear();
  state.recentLeaves.clear();
  resetSunshine();

  $('#peer-list').innerHTML = '';
  $('#peer-count').textContent = '0';
  clearChat();
  $('#settings').hidden = true;
  $('#room-name').classList.remove('revealed');

  showScreen('join');
  history.replaceState(null, '', location.pathname);
  render('rooms');
}

export function wireRoom() {
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
    render('rooms');
  };

  ui('#btn-invite').onclick = () =>
    copy(inviteLink(), 'Ссылка скопирована', 'Ссылка для друзей:');
  ui('#btn-leave').onclick = leaveRoom;

  ui('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const input = ui('#chat-input');
    if (input.value.trim()) net.chat(input.value.trim());
    input.value = '';
  };
}

function inviteLink() {
  return `${new URL(net.base).origin}/#${encodeURIComponent(state.code)}`;
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
  render('peers');

  // Переподключение — это тоже welcome, но сообщать о входе повторно незачем.
  sysMsg(state.everJoined ? 'Соединение восстановлено' : 'Вы вошли в комнату');
  state.everJoined = true;

  announceShares();
  if (voice.enabled) net.send({ t: 'presence', voice: true, muted: voice.muted });
  if (voice.deafened) net.send({ t: 'presence', deaf: true });
  else enableMic();   // микрофон включён по умолчанию
});

net.addEventListener('peer_join', ({ detail }) => {
  const peer = detail.peer;
  state.peers.set(peer.id, peer);
  settings.trackPeer(peer.id, peer.name);
  mesh.add(peer.id);
  render('peers');

  // После обрыва человек возвращается с новым id: не объявляем его заново.
  const left = state.recentLeaves.get(peer.name);
  state.recentLeaves.delete(peer.name);
  if (!left || Date.now() - left > 15000) sysMsg(`${peer.name} присоединился`);
});

net.addEventListener('peer_leave', ({ detail }) => {
  const gone = state.peers.get(detail.id);
  state.peers.delete(detail.id);
  for (const kind of ['screen', 'cam']) removeScreen(viewKey(detail.id, kind));
  mesh.remove(detail.id);
  render('peers', 'views', 'cams', 'stage');
  if (!gone) return;

  state.recentLeaves.set(gone.name, Date.now());
  // Сообщаем о выходе с задержкой: если это был обрыв связи, человек вернётся
  // раньше, и в чате не появится лишней пары «вышел / присоединился».
  setTimeout(() => {
    if (!state.recentLeaves.get(gone.name)) return;
    state.recentLeaves.delete(gone.name);
    sysMsg(`${gone.name} вышел`);
  }, 15000);
});

net.addEventListener('presence', ({ detail }) => {
  const peer = detail.peer;
  const was = state.peers.get(peer.id);

  // Про трансляции сообщаем по присутствию, а не по приходу потока: поток
  // доедет не до всех сразу, а сообщение в чате должно быть у всех.
  if (!isSelf(peer.id)) {
    if (peer.screen && !was?.screen) sysMsg(`${peer.name} включил трансляцию`);
    if (!peer.screen && was?.screen) sysMsg(`${peer.name} выключил трансляцию`);
    if (peer.camera && !was?.camera) sysMsg(`${peer.name} включил камеру`);
  }

  state.peers.set(peer.id, peer);
  settings.trackPeer(peer.id, peer.name);
  // Выключенный микрофон убирает дорожку молча — снимаем приёмник по присутствию.
  if (!peer.voice) voice.detach(peer.id);
  if (!peer.screen) removeScreen(viewKey(peer.id, 'screen'));
  if (!peer.camera) removeScreen(viewKey(peer.id, 'cam'));
  render('peers', 'views', 'cams', 'stage');
});

net.addEventListener('chat', ({ detail }) => {
  const from = state.peers.get(detail.from);
  addChat(from?.name ?? 'Гость', detail.text, isSelf(detail.from), detail.srv, from?.color);
});

net.addEventListener('error', ({ detail }) => toast(detail.message));

net.addEventListener('status', ({ detail }) => {
  const dot = $('#conn-dot');
  dot.className = `dot ${detail.online ? 'on' : 'off'}`;
  dot.title = detail.online ? `RTT ${Math.round(detail.rtt ?? 0)} мс` : 'Переподключение…';
});
