// Общее окно настроек, всплывающие настройки у кнопок и диагностика: всё, что
// спрашивают про сам разговор, а не про то, что в нём происходит.

import { hotkeys, mesh, native, net, settings, voice } from './core.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { PRESETS, HEIGHTS } from './settings.js';
import { ACTIONS, label as hotkeyLabel } from './hotkeys.js';
import { modelTitle } from './denoise.js';
import { $, toast, ui } from './ui.js';
import { hiddenLabels } from './stage.js';
import { pollSunshine, sunshineHint } from './sunshine.js';
import { enableMic } from './devices.js';

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
  browser: 'средствами движка',
  off: 'НЕТ — ни модель, ни движок не взялись',
};

/** Что подавляет шум прямо сейчас: модель — по имени, остальное — словами. */
const denoiseTitle = (kind) => DENOISE[kind] ?? `нейросетью — ${modelTitle(kind)}`;

export function initSettingsPanel() {
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
    hotkeys.cancelRecording();
    close();
  };
  modal.addEventListener('click', (e) => e.target === modal && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  const name = ui('#set-name');
  name.value = settings.get('name');
  // oninput, а не onchange: настройка должна сохраниться, даже если окно
  // закрыли, не убирая фокус с поля.
  name.oninput = () => {
    const n = name.value.trim();
    settings.set('name', n);
    if (n) net.profile(n, settings.get('color'));
  };

  bindRange('#set-voice-vol', '#out-voice-vol', 'voiceVolume');
  bindCheck('#set-ec', 'echoCancellation');

  const denoise = ui('#set-denoise');
  denoise.value = settings.get('denoise');
  denoise.onchange = () => settings.set('denoise', denoise.value);
  bindCheck('#set-agc', 'autoGainControl');

  ui('#pick-mic').onchange = () => settings.set('micDevice', ui('#pick-mic').value);
  ui('#pick-cam').onchange = () => settings.set('camDevice', ui('#pick-cam').value);
  bindCheck('#set-mirror', 'mirrorCam');
  bindCheck('#set-monitor', 'monitor');
  wireStream();

  ui('#pick-output').onchange = () => {
    settings.set('outputDevice', ui('#pick-output').value);
  };

  // Полоска уровня помогает понять, ловит ли микрофон голос. Считаем её только
  // когда она на виду: раз в 150 мс, и всё это ради одной строки текста.
  const micPop = ui('#pop-mic');
  setInterval(() => {
    if (micPop.hidden) return;
    ui('#mic-level').textContent = voice.enabled
      ? levelBar(voice.level) + (voice.muted ? '  (заглушён)' : '')
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

  // Что беречь при нехватке канала — не часть заготовки качества: это про то,
  // как проседать, а не про то, с чего начинать.
  const priority = ui('#set-priority');
  priority.value = settings.get('streamPriority');
  priority.onchange = () => settings.set('streamPriority', priority.value);

  preset.innerHTML = '';
  for (const [id, p] of Object.entries(PRESETS)) {
    preset.append(new Option(p.title, id));
  }
  height.innerHTML = '';
  for (const h of HEIGHTS) {
    height.append(new Option(`${h}p`, String(h)));
  }

  const show = () => {
    preset.value = settings.get('quality');
    height.value = String(settings.get('streamHeight'));
    $('#set-fps').value = settings.get('streamFps');
    $('#set-bitrate').value = settings.get('streamBitrate');
    $('#out-fps').textContent = `${settings.get('streamFps')} к/с`;
    $('#out-bitrate').textContent = `${settings.get('streamBitrate')} Мбит/с`;
  };

  preset.onchange = () => {
    const p = PRESETS[preset.value];
    settings.set('quality', preset.value);
    if (p?.fps) {
      settings.set('streamHeight', p.height);
      settings.set('streamFps', p.fps);
      settings.set('streamBitrate', p.bitrate);
    }
    show();
  };

  const custom = () => settings.set('quality', 'custom');
  height.onchange = () => {
    settings.set('streamHeight', Number(height.value));
    custom();
    show();
  };
  $('#set-fps').oninput = () => {
    settings.set('streamFps', Number($('#set-fps').value));
    custom();
    show();
  };
  $('#set-bitrate').oninput = () => {
    settings.set('streamBitrate', Number($('#set-bitrate').value));
    custom();
    show();
  };

  show();
}

/** Ползунок «в процентах»: в настройках доля, на экране целые проценты. */
function bindRange(sel, outSel, key) {
  const el = $(sel);
  const out = $(outSel);
  const show = () => (out.textContent = `${Math.round(settings.get(key) * 100)}%`);
  el.value = Math.round(settings.get(key) * 100);
  show();
  el.oninput = () => {
    settings.set(key, Number(el.value) / 100);
    show();
  };
}

function bindCheck(sel, key) {
  const el = $(sel);
  el.checked = settings.get(key);
  el.onchange = () => settings.set(key, el.checked);
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
  if (!native.caps.remoteControl) return;
  $('#sunshine-section').hidden = false;
  $('#sunshine-reach').textContent = sunshineHint();
  $('#btn-sun-save').onclick = async () => {
    try {
      await native.sunshineCreds($('#set-sun-user').value.trim(), $('#set-sun-pass').value);
      $('#set-sun-pass').value = '';
      // Спрашиваем мост сразу: зрители должны узнать о новом порядке сопряжения
      // сейчас, а не через полминуты, когда подойдёт очередной опрос.
      await pollSunshine();
      toast('Сохранено: сопряжение с Moonlight теперь пройдёт без ручного PIN');
    } catch (e) {
      toast(`Не вышло: ${e.message ?? e}`);
    }
  };
}

/** Действия горячих клавиш — те же, что у кнопок в шапке. */
export function wireHotkeys() {
  hotkeys.on('mic', () =>
    voice.enabled ? voice.setMuted(!voice.muted) : enableMic({ manual: true })
  );
  hotkeys.on('deafen', () => voice.setDeafened(!voice.deafened));
  // «Перехватить управление» вешает control-ui.js: это его дело целиком.

  // Молчать, пока зажато. По отпускании возвращаем то состояние, что было:
  // если человек и так был заглушён, кнопка не должна его «разглушить».
  let before = null;
  hotkeys.on('push-mute', (down) => {
    if (down) {
      before = voice.muted;
      voice.setMuted(true);
    } else if (before !== null) {
      voice.setMuted(before);
      before = null;
    }
  });

  if (!native.caps.globalHotkeys) return;

  // В приложении те же сочетания регистрируются системно — иначе они работали
  // бы только когда окно в фокусе, а нужны они как раз из игры.
  const sync = () => native.setHotkeys(hotkeys.globalCombos()).catch(() => {});
  hotkeys.onChange = sync;
  native.onHotkey(({ id, down }) => hotkeys.fire(id, down));
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
    combo.textContent = hotkeyLabel(hotkeys.get(action.id));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear ghost';
    clear.innerHTML = icon('close');
    clear.title = 'Вернуть сочетание по умолчанию';
    clear.onclick = () => {
      hotkeys.reset(action.id);
      renderHotkeys();
    };

    combo.onclick = async () => {
      combo.classList.add('recording');
      combo.textContent = 'нажмите клавиши…';
      const next = await hotkeys.record();
      combo.classList.remove('recording');
      if (next) hotkeys.set(action.id, next);
      renderHotkeys();
    };

    row.append(title, combo, clear);
    host.appendChild(row);
  }
}

/** Что видно про соединения — первое, куда смотреть, когда «не слышно». */
async function renderDiagnostics() {
  const lines = [
    `сервер:     ${net.connected ? 'на связи' : 'нет связи'}  ${net.base}`,
    // «Защищённый контекст» — это термин браузера, и в строке диагностики он
    // спрашивает больше, чем отвечает. Пишем то, ради чего строка здесь стоит.
    `устройства: ${
      window.isSecureContext
        ? 'доступны — страница по https'
        : 'НЕДОСТУПНЫ — без https браузер не даёт ни микрофон, ни камеру'
    }`,
    `приложение: ${describeNative()}`,
    `задержка:   ${Number.isFinite(net.rtt) ? Math.round(net.rtt) + ' мс' : '—'}`,
    `TURN:       ${state.config.turn ? 'есть' : 'НЕТ — часть зрителей не соединится'}`,
    `Sunshine:   ${sunshineLine()}`,
    `выключено:  ${hiddenLabels().join(', ') || 'ничего'}`,
    `микрофон:   ${voice.enabled ? (voice.muted ? 'включён, заглушён' : 'в эфире') : 'выключен'}`,
    // Что подавляет шум на самом деле: выбор в настройках и то, что получилось,
    // расходятся ровно там, где это важнее всего заметить.
    `шумодав:    ${denoiseTitle(voice.denoising)}`,
    `слышим:     ${voice.remotes.size} из ${Math.max(0, state.peers.size - 1)}`,
    '',
  ];

  const rows = await mesh.diagnostics();
  if (!rows.length) lines.push('соединений с участниками нет');
  for (const r of rows) {
    const name = state.peers.get(r.id)?.name ?? r.id.slice(0, 6);
    lines.push(`${name}: ${r.state}/${r.ice} · канал ${r.ctl} · путь ${r.path} · дорожек ${r.tracks}`);
  }
  $('#diag').textContent = lines.join('\n');
}

/**
 * Состояние Sunshine одной строкой. Раньше здесь был только адрес, и по нему не
 * отличить «не запущен» от «запущен, но PIN придётся вводить руками» — а это
 * ровно те два случая, из-за которых подключение через Moonlight и не выходит.
 */
function sunshineLine() {
  if (!native.caps.remoteControl) return 'только в настольной версии';
  if (!state.sunshine) return 'не запущен';
  const seen = state.sunshineOpen ? 'виден из интернета' : 'только в своей сети';
  const pin = state.sunshineCanPair ? 'PIN подтверждаем сами' : 'PIN вводить вручную';
  return `${state.sunshine} · ${seen} · ${pin}`;
}

function describeNative() {
  if (!native.available) return 'нет, обычный браузер';
  if (native.error) return `мост не отвечает: ${native.error}`;
  return native.caps.platform;
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

  select.value = settings.get(key);
  if (!select.value && list.length) settings.set(key, '');
}

/** Список устройств вывода. Переключение поддерживают не все движки. */
async function refreshOutputs() {
  const select = $('#pick-output');
  const note = $('#output-note');

  if (!voice.canChooseOutput) {
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

  const list = uniqueDevices(await voice.outputs().catch(() => []));
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
  const list = uniqueDevices(await voice.devices().catch(() => []));
  fillDevices($('#pick-mic'), list, 'По умолчанию', 'micDevice');
}


