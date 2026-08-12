// Панель настроек и диагностика. Модуль ничего не знает про состояние комнаты
// напрямую — всё, что ему нужно, приходит в initSettingsPanel.

import { icon } from './icons.js';
import { PRESETS, HEIGHTS } from './settings.js';
import { ACTIONS, label as hotkeyLabel } from './hotkeys.js';
import { $, ui } from './ui.js';

let ctx = null;

/**
 * Есть ли чем нажимать сочетания.
 *
 * На телефоне назначать их не на чем: экранная клавиатура вылезает только в
 * поле ввода и никаких Ctrl+Alt не отдаёт. Спрашиваем не «телефон ли это», а
 * есть ли точный указатель: планшет с клавиатурой и мышью сочетания получит,
 * а телефон с одним касанием — нет.
 */
const hasKeyboard = () => matchMedia('(any-pointer: fine)').matches;

const DENOISE = {
  rnnoise: 'нейросетью — RNNoise',
  browser: 'средствами движка',
  off: 'НЕТ — ни модель, ни движок не взялись',
};

/**
 * @param {object} deps  settings, voice, mesh, net, native, hotkeys, toast,
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

  // Раздел сочетаний на телефоне не показываем вовсе: настройка, которую там
  // нечем ни задать, ни применить, — это просто мусор в окне.
  ui('#hotkeys-section').hidden = !hasKeyboard();

  ui('#btn-settings').onclick = () => {
    modal.hidden = false;
    refreshDevices();
    if (hasKeyboard()) renderHotkeys();
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
  bindCheck('#set-mirror', 'mirrorCam');
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
    clear.innerHTML = icon('close');
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
    `сервер:     ${ctx.net.connected ? 'на связи' : 'нет связи'}  ${ctx.net.base}`,
    // «Защищённый контекст» — это термин браузера, и в строке диагностики он
    // спрашивает больше, чем отвечает. Пишем то, ради чего строка здесь стоит.
    `устройства: ${
      window.isSecureContext
        ? 'доступны — страница по https'
        : 'НЕДОСТУПНЫ — без https браузер не даёт ни микрофон, ни камеру'
    }`,
    `приложение: ${describeNative()}`,
    `задержка:   ${Number.isFinite(ctx.net.rtt) ? Math.round(ctx.net.rtt) + ' мс' : '—'}`,
    `TURN:       ${ctx.config().turn ? 'есть' : 'НЕТ — часть зрителей не соединится'}`,
    `Sunshine:   ${ctx.sunshine() || 'не запущен'}`,
    `выключено:  ${ctx.hidden().join(', ') || 'ничего'}`,
    `микрофон:   ${ctx.voice.enabled ? (ctx.voice.muted ? 'включён, заглушён' : 'в эфире') : 'выключен'}`,
    // Что подавляет шум на самом деле: выбор в настройках и то, что получилось,
    // расходятся ровно там, где это важнее всего заметить.
    `шумодав:    ${DENOISE[ctx.voice.denoising] ?? ctx.voice.denoising}`,
    `слышим:     ${ctx.voice.remotes.size} из ${Math.max(0, ctx.peers().size - 1)}`,
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

/**
 * Список устройств без повторов.
 *
 * Одно и то же устройство система показывает по нескольку раз: под собственным
 * идентификатором и под псевдонимами `default` и `communications`. Отсюда и
 * «Default — MacBook Air Speakers» рядом с «MacBook Air Speakers» — это одни и
 * те же колонки. Псевдоним у нас уже есть свой, «Системное по умолчанию»,
 * поэтому чужие только запутывают; остальные повторы отсеиваем по группе, в
 * которую система сама сводит один физический прибор.
 */
function uniqueDevices(list) {
  const seen = new Set();
  return list.filter((d) => {
    if (d.deviceId === 'default' || d.deviceId === 'communications') return false;
    // Имена придумывает система, а не мы. Безымянное устройство — это то, к
    // которому ещё не выдан доступ: подписать его «Микрофон 2» значит предложить
    // выбрать вслепую, а после первого включения система назовёт его сама.
    if (!d.label) return false;
    const key = d.groupId || d.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Заполняет список устройств.
 *
 * Первый пункт — не устройство, а его отсутствие: «как в системе». Всё
 * остальное подписано ровно так, как называет их сама система.
 *
 * Сохранённый выбор сбрасываем, только если список непустой и выбранного в нём
 * нет: пустой список означает не «устройство исчезло», а «доступ ещё не выдан»,
 * и стирать по нему чужую настройку нельзя.
 */
function fillDevices(select, list, auto, key) {
  select.innerHTML = '';
  select.append(new Option(auto, ''));
  for (const d of list) select.append(new Option(d.label, d.deviceId));
  select.disabled = false;

  select.value = ctx.settings.get(key);
  if (!select.value && list.length) ctx.settings.set(key, '');
}

/** Список устройств вывода. Переключение поддерживают не все движки. */
async function refreshOutputs() {
  const select = $('#pick-output');
  const note = $('#output-note');

  if (!ctx.voice.canChooseOutput) {
    select.disabled = true;
    select.innerHTML = '<option>Как в системе</option>';
    // На движке WebKit — это Safari и окно приложения на macOS — выбирать
    // устройство нечем: звук идёт туда же, куда системный. Меняется он в
    // «Звук» системных настроек, и это не поломка, а единственный путь.
    note.textContent =
      'Звук идёт туда же, куда системный. Устройство выбирается в настройках системы.';
    return;
  }
  note.textContent = '';

  const list = uniqueDevices(await ctx.voice.outputs().catch(() => []));
  fillDevices(select, list, 'Системное по умолчанию', 'outputDevice');
}

/**
 * Список камер. Имена система выдаёт только после первого доступа к камере, так
 * что до него в списке одна строка — «как в системе». После включения камеры
 * список наполняется сам: `refreshDevices` вызывается сразу после захвата.
 */
async function refreshCameras() {
  const list = uniqueDevices(
    (await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [])
      .filter((d) => d.kind === 'videoinput')
  );
  fillDevices($('#pick-cam'), list, 'По умолчанию', 'camDevice');
}

export async function refreshDevices() {
  await refreshOutputs();
  await refreshCameras();
  const list = uniqueDevices(await ctx.voice.devices().catch(() => []));
  fillDevices($('#pick-mic'), list, 'По умолчанию', 'micDevice');
}


