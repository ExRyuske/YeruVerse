// Точка входа: собирает интерфейс из модулей и связывает их между собой.
//
// Здесь нет ни отрисовки, ни состояния — только развеска. Каждый модуль знает
// про свой кусок комнаты (сцена, участники, трансляции), а всё, что
// не принадлежит никому одному, — включение микрофона по возвращении из фона,
// звуковые кнопки, маршрут входящих потоков — живёт здесь.

import { askServer, mesh, native, net, settings, voice } from './core.js';
import { state } from './state.js';
import { render } from './render.js';
import { icon } from './icons.js';
import { clearStaleFlag, setIcon, toast, ui } from './ui.js';
import { initChat } from './chat.js';
import { initSettingsPanel, refreshDevices, wireHotkeys } from './settings-panel.js';
import { wireLayout } from './layout.js';
import { joinByCode, parseInvite, wireJoin } from './join.js';
import { wireRoom } from './room.js';
import { wireShares } from './shares.js';
import { wireControl } from './control-ui.js';
import { acceptScreen, wireStage } from './stage.js';
import { applySpeaking } from './peers.js';
import { enableMic } from './devices.js';
import { modelTitle, modelWeight } from './denoise.js';

init();

async function init() {
  ui('#btn-get-app').hidden = native.available;
  if (native.available) {
    await native.load();
    ui('#server-row').hidden = false;
    ui('#in-server').value = await native.currentServer().catch(() => location.origin);
  }

  await loadServerConfig();
  setInterval(loadServerConfig, 20 * 60 * 1000);

  const code = parseInvite();
  const nameField = ui('#in-name');
  nameField.value = settings.get('name');
  // Запоминаем сразу, а не только при входе: человек мог представиться и уйти
  // читать ссылку, а вернувшись — обнаружить пустое поле.
  nameField.oninput = () => settings.set('name', nameField.value.trim());

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

  wireLayout();
  wireJoin();
  wireRoom();
  wireShares();
  wireStage();
  wireControl();
  initSettingsPanel();
  wireHotkeys();
  initChat();

  refreshDevices();
  // Наушники воткнули или камеру отключили — список должен это заметить сам.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());

  // Интерфейс собрался целиком — прошлое аварийное обновление можно забыть.
  clearStaleFlag();

  // Ссылка-приглашение открывается сразу в комнате.
  if (code) joinByCode(code);
}

/**
 * Список ICE-серверов приходит с того же сервера. У Cloudflare учётки живут
 * ограниченное время, поэтому обновляем их периодически: они нужны в момент
 * установки соединения, а не постоянно.
 */
async function loadServerConfig() {
  state.config = await askServer('/config.json');
  mesh.iceServers = state.config.iceServers ?? [];
}

// ---------------------------------------------------------------- потоки

// Микрофон слушает голос, остальное показывает сцена. Вид потока приходит
// подписью от отправителя: по составу дорожек экран и камеру не различить.
mesh.on('stream', ({ id, stream, kind }) => {
  if (kind === 'mic') voice.attach(id, stream);
  else acceptScreen(id, stream, kind);
});

// ---------------------------------------------------------------- звук

voice.on('speaking', () => applySpeaking());

/** Обе кнопки звука выглядят и ведут себя одинаково: перечёркнута — выключено. */
function soundButton(sel, name, off, label) {
  const btn = ui(sel);
  btn.classList.toggle('off', off);
  setIcon(
    btn,
    off ? `${name}-off` : name,
    off ? `${label} выключен — включить` : `${label} включён — выключить`
  );
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
  render('peers');
});

voice.on('blocked', () => toast('Нажмите в любом месте страницы, чтобы включить звук'));

// Модель качается — это секунды, и всё это время микрофон молчит.
voice.on('denoise-loading', ({ kind }) =>
  toast(`Загружаем шумодав ${modelTitle(kind)} — ${modelWeight(kind)}`, 12000)
);

// Шумодав не взялся или отвалился на ходу. Сказать об этом важнее, чем кажется:
// молча подменённая обработка звучит иначе, и человек ищет причину в микрофоне.
voice.on('denoise-fallback', ({ from }) =>
  toast(`${modelTitle(from)} не заработал, и подавления шума больше нет`, 8000)
);

voice.on('devices', () => refreshDevices());
