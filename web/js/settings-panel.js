// Общее окно настроек, всплывающие настройки у кнопок и диагностика: всё, что
// спрашивают про сам разговор, а не про то, что в нём происходит.

import { hotkeys, mesh, native, net, settings, voice } from './core.js';
import { state } from './state.js';
import { reason } from './errors.js';
import { icon } from './icons.js';
import { PRESETS, HEIGHTS } from './settings.js';
import { ACTIONS, label as hotkeyLabel } from './hotkeys.js';
import { modelTitle } from './denoise.js';
import { make, toast, ui } from './ui.js';
import { hiddenLabels } from './stage.js';
import { pollSunshine, sunshineHint } from './sunshine.js';
import { enableMic } from './devices.js';

/**
 * Есть ли кому ловить сочетания.
 *
 * Ловит их одна только оболочка приложения — на уровне системы, чтобы работало
 * и из полноэкранной игры. В браузере такого нет и быть не может, и раздел там
 * обещал бы настройку, которой неоткуда сработать; на телефоне их вдобавок
 * нечем и нажать.
 */
const hasHotkeys = () => native.caps.hotkeyMode !== 'none';

export function initSettingsPanel() {
  wireSettings();
  wireSunshine();
}

function wireSettings() {
  const modal = ui('#settings');
  const close = () => (modal.hidden = true);

  // Раздел прячем там, где ловить сочетания некому: настройка, которой неоткуда
  // сработать, — это просто мусор в окне.
  ui('#hotkeys-section').hidden = !hasHotkeys();

  ui('#btn-settings').onclick = () => {
    modal.hidden = false;
    refreshDevices();
    // Смотреть на «—» первую секунду незачем: диагностику рисуем сразу.
    painted = '';
    renderDiagnostics();
    if (hasHotkeys()) renderHotkeys();
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

  const denoise = ui('#set-denoise');
  denoise.value = settings.get('denoise');
  denoise.onchange = () => settings.set('denoise', denoise.value);

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

  preset.replaceChildren(...Object.entries(PRESETS).map(([id, p]) => new Option(p.title, id)));
  height.replaceChildren(...HEIGHTS.map((h) => new Option(`${h}p`, String(h))));

  const show = () => {
    preset.value = settings.get('quality');
    height.value = String(settings.get('streamHeight'));
    ui('#set-fps').value = settings.get('streamFps');
    ui('#set-bitrate').value = settings.get('streamBitrate');
    ui('#out-fps').textContent = `${settings.get('streamFps')} к/с`;
    ui('#out-bitrate').textContent = `${settings.get('streamBitrate')} Мбит/с`;
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
  ui('#set-fps').oninput = () => {
    settings.set('streamFps', Number(ui('#set-fps').value));
    custom();
    show();
  };
  ui('#set-bitrate').oninput = () => {
    settings.set('streamBitrate', Number(ui('#set-bitrate').value));
    custom();
    show();
  };

  show();
}

/** Ползунок «в процентах»: в настройках доля, на экране целые проценты. */
function bindRange(sel, outSel, key) {
  const el = ui(sel);
  const out = ui(outSel);
  const show = () => (out.textContent = `${Math.round(settings.get(key) * 100)}%`);
  el.value = Math.round(settings.get(key) * 100);
  show();
  el.oninput = () => {
    settings.set(key, Number(el.value) / 100);
    show();
  };
}

function bindCheck(sel, key) {
  const el = ui(sel);
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
  ui('#sunshine-section').hidden = false;
  ui('#sunshine-reach').textContent = sunshineHint();
  ui('#btn-sun-save').onclick = async () => {
    try {
      await native.sunshineCreds(ui('#set-sun-user').value.trim(), ui('#set-sun-pass').value);
      ui('#set-sun-pass').value = '';
      // Спрашиваем мост сразу: зрители должны узнать о новом порядке сопряжения
      // сейчас, а не через полминуты, когда подойдёт очередной опрос.
      await pollSunshine();
      toast('Сохранено: сопряжение с Moonlight теперь пройдёт без ручного PIN');
    } catch (e) {
      toast(`Не вышло: ${reason(e)}`);
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

  if (!hasHotkeys()) return;

  // Ловит сочетания оболочка, и она же решает, как: смотреть за клавиатурой или
  // забрать клавишу у системы. Наше дело — держать её список в согласии с
  // настройками и звать действие, когда она сообщит о срабатывании.
  const sync = () => native.setHotkeys(hotkeys.combos()).catch(() => {});
  hotkeys.onChange = sync;
  native.onHotkey(({ id, down }) => hotkeys.fire(id, down));
  sync();
}

/**
 * Одиночная клавиша там, где сочетания забираются у системы.
 *
 * Обычно приложение за клавиатурой просто смотрит, и назначенная клавиша
 * продолжает работать везде. Но где смотреть нечем — на Linux, и на macOS, пока
 * не выдан мониторинг ввода, — сочетание приходится регистрировать у системы, а
 * она отдаёт клавишу владельцу целиком: в игре и в любой другой программе та
 * перестаёт работать вовсе. С модификатором это незаметно (уходит сочетание, а
 * не клавиша), поэтому говорим только про одиночные — и говорим сразу, а не
 * оставляем человека выяснять это через неделю в игре.
 */
function warnAboutGrab(combo) {
  if (native.caps.hotkeyMode !== 'grab') return;
  const mac = native.caps.platform === 'macos';
  // Совет один и тот же на оба случая: там, где смотреть за вводом можно,
  // работает и мышь, и одиночная клавиша.
  const fix = mac
    ? 'Разрешите YeruVerse мониторинг ввода в настройках безопасности и ' +
      'перезапустите его.'
    : '';

  // Мышь достаётся только слежению: система отдаёт по имени одни клавиши, и
  // назначенная кнопка здесь не сработает вообще нигде — молчать об этом
  // нельзя, иначе она выглядит назначенной и рабочей.
  if (combo.includes('Mouse')) {
    return toast(
      `${hotkeyLabel(combo)} здесь не сработает: система отдаёт сочетания ` +
        `только с клавиатуры. ${fix || 'Назначьте клавишу.'}`,
      14000
    );
  }

  if (combo.includes('+')) return;
  toast(
    `${hotkeyLabel(combo)} назначена, но пока YeruVerse запущен, эта клавиша ` +
      'достанется только ему — в играх и других программах она работать не будет. ' +
      (fix || 'Добавьте к ней Ctrl или Alt, чтобы этого избежать.'),
    14000
  );
}

/** Список сочетаний в настройках: нажал «изменить» — нажал клавиши. */
function renderHotkeys() {
  ui('#hotkeys').replaceChildren(...ACTIONS.map(hotkeyRow));
}

function hotkeyRow(action) {
  const combo = make('button', {
    class: 'combo',
    text: hotkeyLabel(hotkeys.get(action.id)),
    onclick: async () => {
      combo.classList.add('recording');
      combo.textContent = 'нажмите клавиши…';
      const next = await hotkeys.record();
      combo.classList.remove('recording');
      if (next) {
        hotkeys.set(action.id, next);
        warnAboutGrab(next);
      }
      renderHotkeys();
    },
  });

  return make(
    'div',
    { class: 'row' },
    make('span', { text: action.title }),
    combo,
    make('button', {
      class: 'clear ghost',
      html: icon('close'),
      title: 'Вернуть сочетание по умолчанию',
      onclick: () => {
        hotkeys.reset(action.id);
        renderHotkeys();
      },
    })
  );
}

/**
 * Диагностика.
 *
 * Сюда приходят с одним вопросом: «почему меня не слышно» — и раньше в ответ
 * получали простыню из `connected/connected · канал open · путь srflx`. Это
 * состояние соединения на языке WebRTC, а не ответ; чтобы им воспользоваться,
 * надо было заранее знать, что `relay` — это TURN, а `srflx` — это хорошо.
 *
 * Теперь каждая строка отвечает словами и несёт цвет: зелёный — работает,
 * жёлтый — работает не так, красный — не работает. Наверху вывод целиком,
 * чтобы не читать все строки, когда всё в порядке.
 *
 * Заглавных букв здесь больше нет: пока диагностика была одноцветной простынёй,
 * кричать было единственным способом отметить беду. Теперь у строки есть цвет,
 * и крик только мешает читать.
 */
const OK = 'ok';
const WARN = 'warn';
const BAD = 'bad';

const row = (status, name, value) => ({ status, name, value });

/** Тип кандидата — словами. Человеку важно одно: напрямую или через сервер. */
const PATHS = {
  host: 'напрямую',
  srflx: 'напрямую',
  prflx: 'напрямую',
  relay: 'через TURN',
};

/** Состояние соединения — тоже словами, и сразу с оценкой. */
const LINKS = {
  new: [WARN, 'соединяемся'],
  connecting: [WARN, 'соединяемся'],
  connected: [OK, ''],
  disconnected: [WARN, 'связь пропала, восстанавливаем'],
  failed: [BAD, 'связи нет'],
  closed: [BAD, 'соединение закрыто'],
};

let painted = '';

async function renderDiagnostics() {
  const groups = [
    { title: 'Связь', rows: linkRows() },
    { title: 'Звук', rows: soundRows() },
    { title: 'Участники', rows: await peerRows() },
  ];

  // Панель перерисовывается раз в секунду, а меняется в ней редко: лишняя
  // перерисовка сбивает выделение текста, который как раз собирались скопировать.
  const shot = JSON.stringify(groups);
  if (shot === painted) return;
  painted = shot;
  paintDiagnostics(groups);
}

function linkRows() {
  const rows = [];

  rows.push(
    net.connected
      ? row(OK, 'Сервер', `на связи${Number.isFinite(net.rtt) ? ` · ${Math.round(net.rtt)} мс` : ''}`)
      : row(BAD, 'Сервер', 'связи нет — переподключаемся')
  );

  rows.push(
    state.config.turn
      ? row(OK, 'TURN', 'есть — соединятся все')
      : row(WARN, 'TURN', 'нет — за строгим NAT участник не соединится')
  );

  // «Защищённый контекст» — это термин браузера, и в строке диагностики он
  // спрашивает больше, чем отвечает. Пишем то, ради чего строка здесь стоит.
  rows.push(
    window.isSecureContext
      ? row(OK, 'Устройства', 'доступны — страница по https')
      : row(BAD, 'Устройства', 'без https браузер не даёт ни микрофон, ни камеру')
  );

  if (!native.available) rows.push(row(OK, 'Оболочка', 'обычный браузер'));
  else if (native.error) rows.push(row(BAD, 'Оболочка', `мост не отвечает: ${native.error}`));
  else rows.push(row(OK, 'Оболочка', `приложение — ${native.caps.platform}`));

  // Sunshine бывает только в настольной версии; в браузере эта строка была бы
  // про то, чего здесь нет и быть не может.
  if (native.caps.remoteControl) rows.push(sunshineRow());
  return rows;
}

/**
 * Состояние Sunshine. Важны два разных «не выйдет»: не запущен вовсе — и
 * запущен, но PIN придётся вводить руками. Из-за них подключение через
 * Moonlight и не получается.
 */
function sunshineRow() {
  if (!state.sunshine) return row(WARN, 'Sunshine', 'не запущен — управлять этим компьютером нельзя');
  const seen = state.sunshineOpen ? 'виден из интернета' : 'только в своей сети';
  const pin = state.sunshineCanPair ? 'PIN подтвердим сами' : 'PIN вводить вручную';
  return row(OK, 'Sunshine', `${state.sunshine} · ${seen} · ${pin}`);
}

function soundRows() {
  const rows = [];

  rows.push(
    !voice.enabled
      ? row(WARN, 'Микрофон', 'выключен — вас не слышно')
      : voice.muted
        ? row(WARN, 'Микрофон', 'включён, но заглушён — вас не слышно')
        : row(OK, 'Микрофон', 'в эфире')
  );

  // Что подавляет шум на самом деле: выбор в настройках и то, что получилось,
  // расходятся ровно там, где это важнее всего заметить. При выключенном
  // микрофоне строки нет вовсе — она отвечала бы про тракт, которого сейчас
  // не существует.
  //
  // «Выключен» и «не поднялся» — разные вещи: первое человек выбрал сам, и
  // жёлтому тут взяться неоткуда. Пока строка была одна на оба случая, она
  // предупреждала о том, о чём её же и просили.
  if (voice.enabled) {
    const chosen = settings.get('denoise');
    if (voice.denoising !== 'off') {
      rows.push(row(OK, 'Шумодав', `нейросетью — ${modelTitle(voice.denoising)}`));
    } else if (chosen === 'off') {
      rows.push(row(OK, 'Шумодав', 'выключен вами'));
    } else {
      rows.push(row(WARN, 'Шумодав', `${modelTitle(chosen)} не поднялся — шум идёт как есть`));
    }
  }

  const others = Math.max(0, state.peers.size - 1);
  if (!others) rows.push(row(OK, 'Слышим', 'в комнате пока вы один'));
  else {
    const heard = voice.remotes.size;
    rows.push(row(heard === others ? OK : WARN, 'Слышим', `${heard} из ${others}`));
  }

  if (voice.deafened) rows.push(row(WARN, 'Звук', 'выключен вами — участников не слышно'));

  const off = hiddenLabels();
  if (off.length) rows.push(row(WARN, 'Выключено', off.join(', ')));
  return rows;
}

async function peerRows() {
  const links = await mesh.diagnostics();
  if (!links.length) {
    return state.peers.size > 1
      ? [row(BAD, 'Соединений', 'нет ни одного, хотя участники в комнате есть')]
      : [row(OK, 'Никого', 'кроме вас в комнате пока никого')];
  }

  return links.map((link) => {
    const [status, note] = LINKS[link.state] ?? [WARN, link.state];
    const bits = [];
    if (note) bits.push(note);
    if (link.path) bits.push(PATHS[link.path] ?? link.path);
    if (Number.isFinite(link.rtt)) bits.push(`${Math.round(link.rtt)} мс`);
    const media = [link.audio && 'звук', link.video && 'видео'].filter(Boolean).join(' и ');
    bits.push(media || 'пока ничего не передаёт');
    if (link.ctl !== 'open') bits.push('канал чата закрыт');
    return row(status, state.peers.get(link.id)?.name ?? 'Участник', bits.join(' · '));
  });
}

/** Общий вывод: когда всё в порядке, читать остальное незачем. */
function verdict(groups) {
  const all = groups.flatMap((g) => g.rows);
  if (all.some((r) => r.status === BAD)) return row(BAD, '', 'Есть поломка');
  if (all.some((r) => r.status === WARN)) return row(WARN, '', 'Работает, но с оговорками');
  return row(OK, '', 'Всё в порядке');
}

function paintDiagnostics(groups) {
  ui('#diag').replaceChildren(
    paintRow(verdict(groups), 'diag-verdict'),
    ...groups
      .filter((g) => g.rows.length)
      .map(({ title, rows }) =>
        make(
          'div',
          { class: 'diag-group' },
          make('h4', { text: title }),
          ...rows.map((r) => paintRow(r))
        )
      )
  );
}

function paintRow({ status, name, value }, cls = '') {
  return make(
    'div',
    { class: `diag-row ${status}${cls ? ` ${cls}` : ''}` },
    // Точка тут та же, что у связи с сервером в шапке: зелёная — хорошо,
    // жёлтая — внимание, красная — не работает.
    make('span', { class: `dot${status === OK ? ' on' : status === BAD ? ' off' : ''}` }),
    make('span', { class: 'k', text: name }),
    make('span', { class: 'v', text: value })
  );
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
  select.replaceChildren(
    new Option(auto, ''),
    ...list.map((d) => new Option(d.label, d.deviceId))
  );
  select.disabled = false;

  select.value = settings.get(key);
  if (!select.value && list.length) settings.set(key, '');
}

/** Список устройств вывода. Переключение поддерживают не все движки. */
async function refreshOutputs() {
  const select = ui('#pick-output');
  const note = ui('#output-note');

  if (!voice.canChooseOutput) {
    select.disabled = true;
    select.replaceChildren(new Option('Как в системе'));
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
  fillDevices(ui('#pick-cam'), list, 'По умолчанию', 'camDevice');
}

export async function refreshDevices() {
  await refreshOutputs();
  await refreshCameras();
  const list = uniqueDevices(await voice.devices().catch(() => []));
  fillDevices(ui('#pick-mic'), list, 'По умолчанию', 'micDevice');
}
