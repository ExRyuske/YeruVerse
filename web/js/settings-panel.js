// Панель настроек и диагностика. Модуль ничего не знает про состояние комнаты
// напрямую — всё, что ему нужно, приходит в initSettingsPanel.

import { icon } from './icons.js';
import { PRESETS, HEIGHTS } from './settings.js';
import { ACTIONS, label as hotkeyLabel } from './hotkeys.js';
import { $, ui } from './ui.js';

let ctx = null;

/**
 * @param {object} deps  settings, voice, mesh, net, sync, native, hotkeys, toast,
 *                       peers() — карта участников, config() — ответ сервера,
 *                       sunshine(), sunshineHint(), enableMic()
 */
export function initSettingsPanel(deps) {
  ctx = deps;
  wireSettings();
  wireSunshine();
}

function wireSettings() {
  const modal = ui('#settings');
  const close = () => (modal.hidden = true);

  ui('#btn-settings').onclick = () => {
    modal.hidden = false;
    refreshDevices();
    renderHotkeys();
  };
  ui('#btn-settings-close').onclick = () => {
    ctx.hotkeys.cancelRecording();
    close();
  };
  modal.addEventListener('click', (e) => e.target === modal && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  const name = ui('#set-name');
  name.value = ctx.settings.get('name');
  // oninput, а не onchange: настройка должна сохраниться, даже если окно
  // закрыли, не убирая фокус с поля.
  name.oninput = () => {
    const n = name.value.trim();
    ctx.settings.set('name', n);
    if (n) ctx.net.profile(n, ctx.settings.get('color'));
  };

  bindRange('#set-voice-vol', '#out-voice-vol', 'voiceVolume');
  bindCheck('#set-ec', 'echoCancellation');

  const denoise = ui('#set-denoise');
  denoise.value = ctx.settings.get('denoise');
  denoise.onchange = () => ctx.settings.set('denoise', denoise.value);
  bindCheck('#set-agc', 'autoGainControl');

  ui('#pick-mic').onchange = () => ctx.settings.set('micDevice', ui('#pick-mic').value);
  ui('#pick-cam').onchange = () => ctx.settings.set('camDevice', ui('#pick-cam').value);
  wireStream();

  ui('#pick-output').onchange = () => {
    ctx.settings.set('outputDevice', ui('#pick-output').value);
  };

  // Полоска уровня помогает понять, ловит ли микрофон голос. Считаем её только
  // когда она на виду: раз в 150 мс, и всё это ради одной строки текста.
  const micPop = ui('#pop-mic');
  setInterval(() => {
    if (micPop.hidden) return;
    ui('#mic-level').textContent = ctx.voice.enabled
      ? levelBar(ctx.voice.level) + (ctx.voice.muted ? '  (заглушён)' : '')
      : 'микрофон выключен';
  }, 150);

  setInterval(() => !modal.hidden && renderDiagnostics(), 1000);
}

/**
 * Настройки трансляции. Заготовка — это просто быстрый способ проставить три
 * значения; стоит тронуть любое из них руками, и выбор честно переключается
 * на «Свои настройки», а не делает вид, что заготовка ещё действует.
 */
function wireStream() {
  const preset = ui('#set-quality');
  const height = ui('#set-height');

  preset.innerHTML = '';
  for (const [id, p] of Object.entries(PRESETS)) {
    preset.append(new Option(p.title, id));
  }
  height.innerHTML = '';
  for (const h of HEIGHTS) {
    height.append(new Option(`${h}p`, String(h)));
  }

  const show = () => {
    preset.value = ctx.settings.get('quality');
    height.value = String(ctx.settings.get('streamHeight'));
    $('#set-fps').value = ctx.settings.get('streamFps');
    $('#set-bitrate').value = ctx.settings.get('streamBitrate');
    $('#out-fps').textContent = `${ctx.settings.get('streamFps')} к/с`;
    $('#out-bitrate').textContent = `${ctx.settings.get('streamBitrate')} Мбит/с`;
  };

  preset.onchange = () => {
    const p = PRESETS[preset.value];
    ctx.settings.set('quality', preset.value);
    if (p?.fps) {
      ctx.settings.set('streamHeight', p.height);
      ctx.settings.set('streamFps', p.fps);
      ctx.settings.set('streamBitrate', p.bitrate);
    }
    show();
  };

  const custom = () => ctx.settings.set('quality', 'custom');
  height.onchange = () => {
    ctx.settings.set('streamHeight', Number(height.value));
    custom();
    show();
  };
  $('#set-fps').oninput = () => {
    ctx.settings.set('streamFps', Number($('#set-fps').value));
    custom();
    show();
  };
  $('#set-bitrate').oninput = () => {
    ctx.settings.set('streamBitrate', Number($('#set-bitrate').value));
    custom();
    show();
  };

  show();
}

function bindRange(sel, outSel, key, after) {
  const el = $(sel);
  const out = $(outSel);
  const show = () => (out.textContent = `${Math.round(ctx.settings.get(key) * 100)}%`);
  el.value = Math.round(ctx.settings.get(key) * 100);
  show();
  el.oninput = () => {
    ctx.settings.set(key, Number(el.value) / 100);
    show();
    after?.();
  };
}

function bindCheck(sel, key, after) {
  const el = $(sel);
  el.checked = ctx.settings.get(key);
  el.onchange = () => {
    ctx.settings.set(key, el.checked);
    after?.();
  };
}

/**
 * Доступ к веб-панели Sunshine. Нужен ровно для одного: подтвердить PIN за
 * человека, когда зритель сопрягается через Moonlight. Пароль уходит в
 * настройки приложения, а не в localStorage — тот привязан к origin страницы,
 * то есть к чужому серверу.
 */
function wireSunshine() {
  // Sunshine бывает только на настольной системе — на телефоне этот раздел
  // спрашивал бы пароль от того, чего там нет.
  if (!ctx.native.caps.remoteControl) return;
  $('#sunshine-section').hidden = false;
  $('#sunshine-reach').textContent = ctx.sunshineHint();
  $('#btn-sun-save').onclick = async () => {
    try {
      await ctx.native.sunshineCreds($('#set-sun-user').value.trim(), $('#set-sun-pass').value);
      $('#set-sun-pass').value = '';
      ctx.toast('Сохранено: сопряжение с Moonlight теперь пройдёт без ручного PIN');
    } catch (e) {
      ctx.toast(`Не вышло: ${e.message ?? e}`);
    }
  };
}

/** Действия горячих клавиш — те же, что у кнопок в шапке. */
export function wireHotkeys() {
  ctx.hotkeys.on('mic', () =>
    ctx.voice.enabled ? ctx.voice.setMuted(!ctx.voice.muted) : ctx.enableMic({ manual: true })
  );
  ctx.hotkeys.on('deafen', () => ctx.voice.setDeafened(!ctx.voice.deafened));
  // «Перехватить управление» вешает app.js: там живёт состояние комнаты.

  // Молчать, пока зажато. По отпускании возвращаем то состояние, что было:
  // если человек и так был заглушён, кнопка не должна его «разглушить».
  let before = null;
  ctx.hotkeys.on('push-mute', (down) => {
    if (down) {
      before = ctx.voice.muted;
      ctx.voice.setMuted(true);
    } else if (before !== null) {
      ctx.voice.setMuted(before);
      before = null;
    }
  });

  if (!ctx.native.caps.globalHotkeys) return;

  // В приложении те же сочетания регистрируются системно — иначе они работали
  // бы только когда окно в фокусе, а нужны они как раз из игры.
  const sync = () => ctx.native.setHotkeys(ctx.hotkeys.globalCombos()).catch(() => {});
  ctx.hotkeys.onChange = sync;
  ctx.native.onHotkey(({ id, down }) => ctx.hotkeys.fire(id, down));
  sync();
}

/** Список сочетаний в настройках: нажал «изменить» — нажал клавиши. */
function renderHotkeys() {
  const host = $('#hotkeys');
  host.innerHTML = '';

  for (const action of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'row';

    const title = document.createElement('span');
    title.textContent = action.title;

    const combo = document.createElement('button');
    combo.type = 'button';
    combo.className = 'combo';
    combo.textContent = hotkeyLabel(ctx.hotkeys.get(action.id));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear ghost';
    clear.innerHTML = icon('close', { size: 14 });
    clear.title = 'Вернуть сочетание по умолчанию';
    clear.onclick = () => {
      ctx.hotkeys.reset(action.id);
      renderHotkeys();
    };

    combo.onclick = async () => {
      combo.classList.add('recording');
      combo.textContent = 'нажмите клавиши…';
      const next = await ctx.hotkeys.record();
      combo.classList.remove('recording');
      if (next) ctx.hotkeys.set(action.id, next);
      renderHotkeys();
    };

    row.append(title, combo, clear);
    host.appendChild(row);
  }
}

/** Что видно про соединения — первое, куда смотреть, когда «не слышно». */
async function renderDiagnostics() {
  const lines = [
    `сервер:    ${ctx.net.connected ? 'на связи' : 'нет связи'}  ${ctx.net.base}`,
    `контекст:  ${window.isSecureContext ? 'защищённый' : 'НЕ защищённый — микрофона не будет'}`,
    `приложение: ${describeNative()}`,
    `задержка:  ${Number.isFinite(ctx.net.rtt) ? Math.round(ctx.net.rtt) + ' мс' : '—'}`,
    `TURN:      ${ctx.config().turn ? 'есть' : 'НЕТ — часть зрителей не соединится'}`,
    `Sunshine:  ${ctx.sunshine() || 'не запущен'}`,
    `выключено: ${ctx.hidden().join(', ') || 'ничего'}`,
    `микрофон:  ${ctx.voice.enabled ? (ctx.voice.muted ? 'включён, заглушён' : 'в эфире') : 'выключен'}`,
    `слышим:    ${ctx.voice.remotes.size} из ${Math.max(0, ctx.peers().size - 1)}`,
    '',
  ];

  const rows = await ctx.mesh.diagnostics();
  if (!rows.length) lines.push('соединений с участниками нет');
  for (const r of rows) {
    const name = ctx.peers().get(r.id)?.name ?? r.id.slice(0, 6);
    lines.push(`${name}: ${r.state}/${r.ice} · канал ${r.ctl} · путь ${r.path} · дорожек ${r.tracks}`);
  }
  $('#diag').textContent = lines.join('\n');
}

function describeNative() {
  if (!ctx.native.available) return 'нет, обычный браузер';
  if (ctx.native.error) return `мост не отвечает: ${ctx.native.error}`;
  return ctx.native.caps.platform;
}

function levelBar(level) {
  const n = Math.min(12, Math.round(level * 45));
  return '▮'.repeat(n) + '▯'.repeat(12 - n);
}

/** Список устройств вывода. Переключение поддерживают не все движки. */
async function refreshOutputs() {
  const select = $('#pick-output');
  const note = $('#output-note');

  if (!ctx.voice.canChooseOutput) {
    select.disabled = true;
    select.innerHTML = '<option>Системное по умолчанию</option>';
    note.textContent =
      'Этот браузер не умеет выбирать устройство вывода — поменяйте его в системе.';
    return;
  }
  note.textContent = '';

  const list = await ctx.voice.outputs().catch(() => []);
  select.disabled = false;
  select.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Системное по умолчанию';
  select.appendChild(auto);

  list.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    // Метки появляются только после того, как дали доступ к микрофону.
    o.textContent = d.label || `Устройство ${i + 1}`;
    select.appendChild(o);
  });
  select.value = ctx.settings.get('outputDevice');
}

/**
 * Список камер. Названия появляются только после первого доступа к камере —
 * до него система показывает голые идентификаторы, и «фронтальная» от «тыльной»
 * не отличить. Поэтому до первого включения подписываем их сами.
 */
async function refreshCameras() {
  const select = $('#pick-cam');
  const list = await navigator.mediaDevices
    ?.enumerateDevices()
    .then((all) => all.filter((d) => d.kind === 'videoinput'))
    .catch(() => []) ?? [];

  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = list.length ? 'По умолчанию' : 'Камер не найдено';
  select.appendChild(auto);
  select.disabled = !list.length;

  list.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Камера ${i + 1}`;
    select.appendChild(o);
  });
  select.value = ctx.settings.get('camDevice');
}

export async function refreshDevices() {
  await refreshOutputs();
  await refreshCameras();
  const select = $('#pick-mic');
  const list = await ctx.voice.devices().catch(() => []);
  select.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'По умолчанию';
  select.appendChild(auto);

  list.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    // Метки появляются только после того, как пользователь дал доступ.
    o.textContent = d.label || `Микрофон ${i + 1}`;
    select.appendChild(o);
  });
  select.value = ctx.settings.get('micDevice');
}


