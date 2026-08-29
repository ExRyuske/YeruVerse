// Прогон комнаты в настоящем браузере: два участника, WebRTC, чат, микрофон,
// шумодав и раскладка телефона в обеих ориентациях.
//
//     make server                 # в соседнем окне
//     npm i playwright && npx playwright install chromium
//     node scripts/room_check.mjs
//
// Сборщика в проекте нет, и это единственная проверка, которая видит страницу
// так же, как её видит человек: остальное — чтение кода. Chromium подставляет
// фальшивые микрофон и камеру, поэтому голос и картинка идут по-настоящему, но
// без единого устройства на машине.

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'нужен playwright — поставьте его рядом с проектом:\n' +
      '  npm i playwright && npx playwright install chromium'
  );
  process.exit(2);
}

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const SHOTS = process.env.SHOTS ?? '';
const ROOM = `check-${Math.random().toString(36).slice(2, 8)}`;

const ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

const problems = [];
const note = (ok, what, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' ПЛОХО'} ${what}${extra ? ' — ' + extra : ''}`);
  if (!ok) problems.push(what);
};

const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);

async function open(browser, viewport = { width: 1280, height: 800 }, extra = {}) {
  const ctx = await browser.newContext({
    permissions: ['microphone', 'camera'],
    viewport,
    ...extra,
  });
  // Считаем аудиоконтексты: их должно быть ровно столько, сколько задумано, —
  // один. Каждый лишний держит своё соединение с системным звуком, и его
  // рождение слышно во всём, что в этот момент играет.
  await ctx.addInitScript(() => {
    window.__contexts = 0;
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Real = window[name];
      if (!Real) continue;
      window[name] = class extends Real {
        constructor(...args) {
          super(...args);
          window.__contexts++;
        }
      };
    }
    // И каждый усилитель: громкость выше ста процентов живёт только в нём, а
    // снаружи её ничем не видно — ни в элементе, ни в настройках.
    window.__gains = [];
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function (...args) {
      const node = createGain.apply(this, args);
      window.__gains.push(node);
      return node;
    };
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  return page;
}

/** Панель диагностики — самый честный отчёт о том, что внутри комнаты. */
async function diag(page) {
  await page.click('#btn-settings');
  await page.waitForTimeout(1300);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#diag .diag-row')].map((el) => ({
      status: el.classList.contains('ok') ? 'ok' : el.classList.contains('bad') ? 'bad' : 'warn',
      name: el.querySelector('.k')?.textContent ?? '',
      value: el.querySelector('.v')?.textContent ?? '',
    }))
  );
  await page.click('#btn-settings-close');
  return rows;
}

/** Значение строки диагностики по её названию. */
const diagValue = (rows, name) => rows.find((r) => r.name === name)?.value ?? '';

/**
 * Долгоживущие объекты страницы — сокет, WebRTC-сеть, рой — первым аргументом,
 * своё значение вторым: `inside(page, ([{ net }, x]) => …, x)`.
 *
 * Наружу приложение их не выставляет, и правильно делает. Но модуль у браузера
 * один на адрес: `import()` того же файла, который страница уже загрузила,
 * отдаёт тот же самый экземпляр, а не новый. Так проверка добирается до
 * внутренностей, ничего не добавляя в само приложение — ни глобальной
 * переменной, ни ветки «если это тест».
 *
 * Модуль передаётся ссылкой на живой объект, а не строкой с кодом: политика
 * содержимого запрещает странице собирать функции из текста, и правильно
 * делает — в чат приходит чужой текст.
 */
async function inside(page, fn, arg) {
  const core = await page.evaluateHandle(() => import('/js/core.js'));
  try {
    return await page.evaluate(fn, [core, arg]);
  } finally {
    await core.dispose();
  }
}

const browser = await chromium.launch({ args: ARGS });

// ---------------------------------------------------------------- вход
const a = await open(browser);
await a.goto(BASE, { waitUntil: 'networkidle' });
note(a.errors.length === 0, 'страница грузится без ошибок', a.errors.join(' | '));

await a.fill('#in-name', 'Аня');
await a.fill('#in-link', ROOM);
await a.click('#btn-link');
await a.waitForTimeout(1500);
note(await a.isVisible('#screen-room'), 'вход в комнату');

const b = await open(browser);
await b.goto(`${BASE}/#${ROOM}`, { waitUntil: 'networkidle' });
await b.waitForTimeout(2500);
note(b.errors.length === 0, 'второй участник без ошибок', b.errors.join(' | '));
note((await a.textContent('#peer-count')) === '2', 'участники видят друг друга');

// ---------------------------------------------------------------- чат
await b.fill('#chat-input', 'слышно?');
await b.press('#chat-input', 'Enter');
await a.waitForTimeout(900);
note((await a.textContent('#chat-log')).includes('слышно?'), 'чат доходит');

// Ссылку в сообщении можно нажать, а вот подставить через неё разметку или
// чужую схему — нельзя: строка приходит от чужого клиента, и кладётся она
// текстом. Проверяем оба края разом, одним сообщением.
await b.fill('#chat-input', 'вот https://s.team/p/abc, а вот javascript:alert(1) <b>жирным</b>');
await b.press('#chat-input', 'Enter');
await a.waitForTimeout(900);
const links = await a.evaluate(() => ({
  hrefs: [...document.querySelectorAll('#chat-log a.link')].map((el) => el.href),
  tags: document.querySelectorAll('#chat-log b').length,
  text: document.querySelector('#chat-log')?.textContent ?? '',
}));
note(
  links.hrefs.some((h) => h === 'https://s.team/p/abc'),
  'ссылка в чате нажимается',
  links.hrefs.join(' ')
);
// Схему сверяем со списком разрешённого, а не запрещённого: `javascript:` —
// лишь один способ из нескольких, рядом с ним всегда стоят `data:` и
// `vbscript:`, и запрет по имени всегда отстаёт на одну схему. Разрешена ровно
// одна — та же, что и в `withLinks`.
note(
  links.hrefs.every((h) => new URL(h).protocol === 'https:') && links.tags === 0,
  'чужая схема и разметка остаются текстом',
  `тегов ${links.tags}`
);
note(links.text.includes('<b>жирным</b>'), 'разметка видна как написана');

// Системные строки — с часами, как и всё остальное в чате: «вышел» без времени
// в разговоре, к которому вернулись через полчаса, ни о чём не говорит.
const sysTimes = await a.evaluate(() =>
  [...document.querySelectorAll('#chat-log .sys')].map((el) => ({
    time: el.querySelector('.at')?.textContent ?? '',
    text: el.textContent,
  }))
);
note(sysTimes.length > 0, 'системные строки есть', sysTimes.map((r) => r.text).join(' | '));
note(sysTimes.every((r) => /\d/.test(r.time)), 'у системных строк есть время',
     sysTimes.map((r) => r.time).join(' '));

// ------------------------------------------------------------ вложения
// Карточка файла приходит от чужого клиента, и по ней получатель сразу
// разворачивает у себя массив кусков и битовое поле на каждый. Картинка при
// этом качается сама, не спрашивая, — то есть одного числа в карточке хватало,
// чтобы уложить вкладку каждому, кто просто сидит в комнате. Шлём такие
// карточки мимо интерфейса, прямо в сокет: именно так их и пришлют.
const BAD_CARDS = [
  { what: 'кусков на миллиард', chunks: 1e9 },
  { what: 'кусков отрицательно', chunks: -1 },
  { what: 'кусков не число', chunks: 'много' },
  { what: 'кусков нет вовсе', chunks: undefined },
  { what: 'куски мелкие, а их много', size: 2 * 1024 ** 3, chunkSize: 1, chunks: 2 * 1024 ** 3 },
];
for (const bad of BAD_CARDS) {
  await inside(b, ([{ net }, bad]) => {
    const meta = {
      id: `bad-${Math.random().toString(36).slice(2, 8)}`,
      name: 'кот.png',
      mime: 'image/png',       // картинка — значит начнёт качаться сама
      size: 1024,
      chunkSize: 64 * 1024,
      chunks: 1,
      ...bad,
    };
    delete meta.what;
    net.send({ t: 'file', meta });
  }, bad);
}
await a.waitForTimeout(1200);
const attach = await inside(a, ([{ swarm }]) => ({
  cards: document.querySelectorAll('#chat-log .attach').length,
  transfers: swarm.transfers.size,
  alive: !!document.querySelector('#chat-input'),
}));
note(attach.cards === 0, 'выдуманная карточка файла не рисуется', `карточек ${attach.cards}`);
note(attach.transfers === 0, 'и не разворачивает передачу', `передач ${attach.transfers}`);
note(attach.alive && a.errors.length === 0, 'комната цела после таких карточек',
     a.errors.join(' | '));

// А настоящая карточка — доходит и качается: проверка не должна была закрыть
// вложения заодно с выдуманными.
await inside(b, ([{ net, swarm }]) => {
  const file = new File([new Uint8Array(3000).fill(7)], 'горы.png', { type: 'image/png' });
  net.send({ t: 'file', meta: swarm.offer(file) });
});
await a.waitForTimeout(2500);
const real = await a.evaluate(() => ({
  cards: document.querySelectorAll('#chat-log .attach').length,
  shot: document.querySelector('#chat-log img.shot')?.src?.startsWith('blob:') ?? false,
}));
note(real.cards === 1, 'настоящее вложение приходит', `карточек ${real.cards}`);
note(real.shot, 'и картинка собирается роем целиком');

// ---------------------------------------------------------------- голос
const report = await diag(a);
console.log('\n--- диагностика ---');
for (const r of report) console.log(`  ${r.status.padEnd(4)} ${r.name.padEnd(12)} ${r.value}`);
console.log('');

note(diagValue(report, 'Микрофон') === 'в эфире', 'микрофон в эфире');
// Модель обязана подняться: без неё собеседников слышно, но шумодава нет, а
// молча подменённая обработка звучит иначе — это и надо ловить.
note(/нейросетью/.test(diagValue(report, 'Шумодав')), 'шумодав поднялся');
note(diagValue(report, 'Слышим') === '1 из 1', 'голос собеседника принят');
// Строка участника: состояние соединения человеческими словами, а не
// `connected/connected · путь srflx`.
const peerRow = report.find((r) => /напрямую|через TURN/.test(r.value));
note(!!peerRow, 'связь с участником описана словами', peerRow?.value);
note(/звук/.test(peerRow?.value ?? ''), 'видно, что от участника идёт звук');
note(report.every((r) => !/connected|srflx|relay|host/.test(r.value)),
     'в диагностике не осталось языка WebRTC');
note(report.some((r) => r.name === '' && r.value), 'наверху есть общий вывод');

// Каким уходит сам звук. Движок по умолчанию собирает его телефонным — моно и
// около тридцати килобит, — и разговор это ещё терпит, а звук игры уже нет.
// Поэтому обе стороны просят у Opus стерео и потолок повыше, а сколько взять на
// самом деле, отправитель решает для каждой дорожки отдельно.
const sound = await b.evaluate(async () => {
  const { mesh } = await import('/js/core.js');
  const c = [...mesh.conns.values()][0];
  const stats = await c.pc.getStats();
  const codecs = new Map();
  stats.forEach((s) => s.type === 'codec' && codecs.set(s.id, s));
  let fmtp = '';
  stats.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'audio') fmtp = codecs.get(s.codecId)?.sdpFmtpLine ?? '';
  });
  const mic = c.pc.getSenders().find((s) => s.track?.kind === 'audio');
  return {
    fmtp,
    hint: mic?.track?.contentHint ?? '',
    cap: mic?.getParameters().encodings?.[0]?.maxBitrate ?? 0,
  };
});
const ceiling = Number(/maxaveragebitrate=(\d+)/.exec(sound.fmtp)?.[1] ?? 0);
note(/stereo=1/.test(sound.fmtp), 'собеседник просит стерео', sound.fmtp);
note(ceiling > 32000, 'и потолок выше телефонного', `${ceiling} бит/с`);
note(sound.hint === 'speech' && sound.cap > 32000,
     'у микрофона своя подсказка и свой предел', `${sound.hint} · ${sound.cap} бит/с`);

// ------------------------------------------------------ настройки микрофона
//
// Микрофон — дело личное: его настройки не должны быть слышны ни в трансляции,
// ни у собеседников. Дороже всего тут перезахват устройства: на телефоне он
// переводит весь звук в разговорный режим, и вздрагивает всё, что играет.
// Поэтому модель шумодава живёт в нашем графе и устройство не трогает.
const micTrack = (page) =>
  page.evaluate(async () => {
    const { voice } = await import('/js/core.js');
    return voice.raw?.getAudioTracks()[0]?.id ?? '';
  });
const setDenoise = (page, kind) =>
  page.evaluate(async (k) => {
    const { settings } = await import('/js/core.js');
    settings.set('denoise', k);
    return settings.get('denoise');
  }, kind);

const micBefore = await micTrack(a);
note(!!micBefore, 'микрофон захвачен');

note((await setDenoise(a, 'off')) === 'off', 'настройка шумодава применяется');
await a.waitForTimeout(1200);
note((await micTrack(a)) === micBefore, 'смена модели шумодава не трогает устройство');

await setDenoise(a, 'rnnoise');
await a.waitForTimeout(1500);
note((await micTrack(a)) === micBefore, 'и обратно — тоже');
note(/RNNoise/.test(diagValue(await diag(a), 'Шумодав')), 'модель вернулась на место');

// Обработки движка на микрофоне нет вовсе — ни эхоподавления, ни автоусиления,
// ни его шумодава. Спрашиваем саму дорожку, а не настройки: настройка говорит,
// о чём просили, а дорожка — что из этого вышло. Всё это не только про свой
// голос: стоит попросить у движка хоть что-нибудь, как телефон переводит в
// разговорный режим весь звук разом, вместе с чужими голосами.
const processing = await a.evaluate(async () => {
  const { voice } = await import('/js/core.js');
  const s = voice.raw?.getAudioTracks()[0]?.getSettings() ?? {};
  return { эхо: s.echoCancellation, шумодав: s.noiseSuppression, усиление: s.autoGainControl };
});
note(
  Object.values(processing).every((v) => v === false || v === undefined),
  'движок микрофон не обрабатывает',
  JSON.stringify(processing)
);

note(
  (await a.evaluate(() => window.__contexts)) === 1,
  'аудиоконтекст в приложении один',
  `их ${await a.evaluate(() => window.__contexts)}`
);

// ------------------------------------------------------------ громкость
//
// Выше ста процентов элемент не умеет — там подключается усилитель, а сам
// элемент глушится, чтобы звук не шёл двумя путями сразу. Переключение между
// путями и есть самое хрупкое место: снаружи громче четырёхсот процентов и
// полная тишина выглядят одинаково.
const loudness = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('audio')].at(-1);
    return { gains: window.__gains.map((g) => g.gain.value), muted: el?.muted ?? null };
  });

const speaker = await b.evaluate(async () => {
  const { voice } = await import('/js/core.js');
  return [...voice.remotes.keys()][0] ?? '';
});
const setPeerVolume = (level) =>
  b.evaluate(async ([id, v]) => {
    const { settings } = await import('/js/core.js');
    settings.setPeerVolume(id, v);
  }, [speaker, level]);

note(!!speaker, 'есть кого слушать');
await setPeerVolume(4);

// Усилитель забирает звук себе не сразу: сперва он должен убедиться, что поток
// до графа вообще доходит, — на движке WebKit тот доходит не всегда. Ждём это,
// а не отмеряем секунду наугад: фальшивый микрофон Chromium пищит с паузами, и
// шумодав отправителя эти писки честно давит, так что первые замеры у
// получателя — цифровая тишина.
let loud = await loudness(b);
for (let i = 0; i < 24 && !(loud.gains.includes(4) && loud.muted); i++) {
  await b.waitForTimeout(250);
  loud = await loudness(b);
}
note(loud.gains.includes(4) && loud.muted === true, 'громкость 400% доходит до усилителя',
     JSON.stringify(loud));

await setPeerVolume(1);
await b.waitForTimeout(600);
loud = await loudness(b);
// Вернулись к ста процентам — играет снова сам элемент, усилитель молчит.
note(!loud.gains.some((g) => g > 0) && loud.muted === false, 'сто процентов играет элемент',
     JSON.stringify(loud));

// ---------------------------------------------------------------- камера
await a.click('#btn-camera');
await a.waitForTimeout(2500);
await b.waitForTimeout(2500);
note((await b.locator('.cam-tile').count()) >= 1, 'камера дошла до второго');

await b.click('.cam-tile video');
await b.waitForTimeout(600);
note(await b.isVisible('.lightbox.inside'), 'камера разворачивается');
// Увеличили одну — остальные всё равно должны быть видны и нажимаемы.
note(await b.isVisible('#cams'), 'полоса камер видна и при увеличении');
await shot(b, 'cam-enlarged');

// Камеру выключают, пока она увеличена. Окно про поток ничего не знает и само
// закрыться не может — закрыть его должна сцена, иначе поверх всего остаётся
// висеть последний кадр, и убрать его человеку нечем.
await a.click('#btn-camera');
await a.waitForTimeout(2200);
note((await b.locator('.lightbox.inside').count()) === 0, 'увеличение ушло вместе с камерой');
note((await b.locator('.cam-tile').count()) === 0, 'плитка камеры убрана');

// ------------------------------------------------------------ полный экран
//
// Полоса с кнопками тянется во всю ширину, а кнопок в ней от силы треть. Всё
// остальное её пространство обязано пропускать нажатия в кадр — иначе внизу
// чужого экрана получается полоса, куда курсор доходит, а щелчок нет.
await b.click('#btn-full');
await b.waitForTimeout(400);
const underBar = await b.evaluate(() => {
  const bar = document.querySelector('.sources').getBoundingClientRect();
  const el = document.elementFromPoint(
    Math.round(innerWidth * 0.35),
    Math.round(bar.top + bar.height / 2)
  );
  return el ? `${el.tagName.toLowerCase()}.${el.className || el.id}` : '—';
});
note(!/sources|src-row|views/.test(underBar), 'пустое место полосы пропускает нажатие к кадру',
     underBar);

/** Видно ли полосу: класс бездействия и её собственная прозрачность. */
const bar = () =>
  b.evaluate(() => ({
    idle: document.body.classList.contains('idle'),
    opacity: Number(getComputedStyle(document.querySelector('.sources')).opacity),
  }));

// Возим мышью по кадру — так ведёт себя игра и удалённое управление. Полоса
// обязана погаснуть: она мешает именно тогда, когда курсор в движении.
for (let i = 0; i < 12; i++) {
  await b.mouse.move(300 + i * 40, 300 + (i % 3) * 20);
  await b.waitForTimeout(300);
}
let bs = await bar();
note(bs.idle && bs.opacity === 0, 'полоса гаснет, даже когда мышь не стоит на месте',
     JSON.stringify(bs));

// Тянемся к кнопкам — выходит навстречу.
await b.mouse.move(640, 780);
await b.waitForTimeout(400);
bs = await bar();
note(!bs.idle && bs.opacity === 1, 'полоса выходит навстречу мыши у нижнего края',
     JSON.stringify(bs));

// Раскрытая настройка разворачивается вверх, далеко от края: гаснуть под
// курсором она не должна.
await b.click('[data-pop="pop-sound"]');
await b.mouse.move(640, 500);
await b.waitForTimeout(3200);
bs = await bar();
note(!bs.idle && bs.opacity === 1, 'раскрытая настройка не гаснет сама', JSON.stringify(bs));
await b.keyboard.press('Escape');

await b.mouse.move(640, 780);
await b.click('#btn-full');
await b.waitForTimeout(300);

// ---------------------------------------------------------------- телефон
const phone = await open(
  browser,
  { width: 844, height: 390 },     // горизонталь
  { isMobile: true, hasTouch: true }
);
await phone.goto(`${BASE}/#${ROOM}`, { waitUntil: 'networkidle' });
await phone.waitForTimeout(2000);
await shot(phone, 'phone-landscape');

const box = await phone.evaluate(() => {
  const at = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return { h: innerHeight, stage: at('.stage'), bar: at('#sidebar'), chat: at('.chat-form'),
           scroll: document.documentElement.scrollHeight };
});
note(box.bar && box.bar.h > box.h * 0.7, 'панель во всю высоту', `высота ${box.bar?.h}`);
note(box.stage && box.stage.h > 150, 'сцена не сплющена', `высота ${box.stage?.h}`);
note(box.scroll <= box.h + 2, 'нет прокрутки всей страницы', `${box.scroll} против ${box.h}`);
note(box.chat && box.chat.y + box.chat.h <= box.h + 2, 'чат не уехал за экран');

// Всплывающие настройки на телефоне: раскрываются они вверх, а места вверху
// нет — начало панели уезжало за верхний край вместе с выбором устройства.
for (const id of ['pop-mic', 'pop-sound', 'pop-cam']) {
  const fit = await phone.evaluate((pop) => {
    const caret = document.querySelector(`[data-pop="${pop}"]`);
    if (!caret || caret.offsetParent === null) return null;
    caret.click();
    const r = document.getElementById(pop).getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
  }, id);
  if (!fit) continue;
  note(fit.top >= 0 && fit.bottom <= fit.vh + 1, `${id} влезает в экран телефона`,
       `${fit.top}..${fit.bottom} из ${fit.vh}`);
}
await phone.keyboard.press('Escape');

await phone.setViewportSize({ width: 390, height: 844 });
await phone.waitForTimeout(800);
await shot(phone, 'phone-portrait');

// В вертикали ползунки громкости прячутся: в узкой строке участника им не
// место, а крутят их в настройках. Громкости трансляции в настройках нет —
// значит, она обязана остаться на виду, иначе звук чужого экрана на телефоне
// не убавить вовсе.
const volumes = await phone.evaluate(() => {
  const shown = (host) => {
    const probe = document.createElement('span');
    probe.className = 'pv-mini';
    host.appendChild(probe);
    const display = getComputedStyle(probe).display;
    probe.remove();
    return display;
  };
  return { views: shown(document.querySelector('#views')), peers: shown(document.querySelector('#peer-list')) };
});
note(volumes.views !== 'none', 'громкость трансляции видна в вертикали', volumes.views);
note(volumes.peers === 'none', 'громкость участника — в настройках', volumes.peers);
// Плитка камеры в полном экране стоит над полосой кнопок. Полоса бывает в одну
// строку и в две, и пока место под неё отмерялось числом, кнопки лежали поверх
// плитки — вместе с подписью, кому это лицо принадлежит.
await phone.click('#btn-camera');
await phone.waitForTimeout(2500);
await phone.click('#btn-full');
await phone.waitForTimeout(700);
const tile = await phone.evaluate(() => {
  const el = document.querySelector('.cam-tile');
  if (!el) return null;
  const cam = el.getBoundingClientRect();
  const bar = document.querySelector('.sources').getBoundingClientRect();
  return { camBottom: Math.round(cam.bottom), barTop: Math.round(bar.top) };
});
note(tile && tile.camBottom <= tile.barTop, 'плитка камеры не заезжает под кнопки',
     JSON.stringify(tile));

note(phone.errors.length === 0, 'телефон без ошибок', phone.errors.join(' | '));

// ------------------------------------------------------- переподключение
// Сокет рвётся сам по себе: телефон уснул, Wi-Fi переключился, оператор сменил
// адрес. Вернувшись, участник получает от сервера новый id — а от нового id
// зависит, кто в паре предлагает соединение, а кто отвечает. Пока старые
// соединения переживали возвращение, стороны считали роли от разных id и могли
// разойтись обе невежливыми, взаимно проигнорировав предложения друг друга:
// человек возвращался в комнату, но не возвращался к собеседникам.
const wasId = await inside(a, ([{ net }]) => net.selfId);
await inside(a, ([{ net }]) => net.ws.close());
await a.waitForTimeout(4000);

const after = await inside(a, async ([{ net, mesh }]) => {
  return {
    id: net.selfId,
    online: net.connected,
    conns: mesh.peers(),
    states: (await mesh.diagnostics()).map((r) => `${r.state}/${r.ctl}`),
  };
});
note(after.online, 'сокет вернулся');
note(after.id !== wasId, 'сервер выдал новый id', `${wasId} -> ${after.id}`);
note(after.conns.length === 2, 'соединения пересобраны под новый id',
     `их ${after.conns.length}: ${after.conns.join(', ')}`);
note(
  after.states.every((st) => st === 'connected/open'),
  'и снова живые, а не брошенные',
  after.states.join(' | ')
);

await b.fill('#chat-input', 'вернулся?');
await b.press('#chat-input', 'Enter');
await a.waitForTimeout(900);
note((await a.textContent('#chat-log')).includes('вернулся?'), 'чат идёт дальше');
note(a.errors.length === 0, 'возвращение без ошибок', a.errors.join(' | '));

// Возвращение чинит не только соединения, но и сцену.
//
// Пока нас не было, участник мог выйти и вернуться: id сервер выдаёт на
// соединение, а не на человека, и вернулся он уже под другим. `peer_leave` про
// прежний нам не пришёл — принимать его было некому, — и старый ключ остался бы
// на сцене навсегда. Стоит он дорого: сцена показывает мёртвый поток, а
// пришедший следом живой её уже не занимает, потому что она не пуста. Снаружи
// это и выглядит как «после переподключения трансляции пропали».
await b.click('#btn-camera');
await b.waitForTimeout(2500);
note((await a.locator('.cam-tile').count()) >= 1, 'камера соседа видна до обрыва');

// Подкладываем ровно то, что осталось бы от ушедшего в наше отсутствие: ключ с
// id, которого в комнате уже нет и о котором нам уже никто не скажет.
await a.evaluate(async () => {
  const { state } = await import('/js/state.js');
  state.screens.set('ушёл-пока-нас-не-было:screen', new MediaStream());
});

await inside(a, ([{ net }]) => net.ws.close());
await a.waitForTimeout(4000);

const scene = await a.evaluate(async () => {
  const { state } = await import('/js/state.js');
  return {
    orphans: [...state.screens.keys()].filter((k) => !state.peers.has(k.split(':')[0])),
    tiles: document.querySelectorAll('.cam-tile').length,
  };
});
note(scene.orphans.length === 0, 'мёртвые трансляции убраны при возвращении',
     scene.orphans.join(', '));
note(scene.tiles >= 1, 'а живая камера соседа осталась на месте');

await browser.close();
console.log(`\nитог: ${problems.length ? 'замечаний ' + problems.length : 'всё сошлось'}`);
for (const p of problems) console.log('  · ' + p);
process.exit(problems.length ? 1 : 0);
