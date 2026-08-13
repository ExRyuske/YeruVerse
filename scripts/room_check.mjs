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
  const text = await page.textContent('#diag');
  await page.click('#btn-settings-close');
  return text;
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

// ---------------------------------------------------------------- голос
const report = await diag(a);
console.log('\n--- диагностика ---\n' + report + '\n');
const line = (name) => report.match(new RegExp(`${name}:.*`))?.[0] ?? '';
note(/микрофон:\s+(в эфире|включён)/.test(report), 'микрофон в эфире', line('микрофон'));
// Модель обязана подняться: без неё собеседников слышно, но шумодава нет, а
// молча подменённая обработка звучит иначе — это и надо ловить.
note(/шумодав:\s+нейросетью/.test(report), 'шумодав поднялся', line('шумодав'));
note(/слышим:\s+1 из 1/.test(report), 'голос собеседника принят', line('слышим'));
note(/connected/.test(report), 'WebRTC соединение установлено');

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
await b.keyboard.press('Escape');

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

await phone.setViewportSize({ width: 390, height: 844 });
await phone.waitForTimeout(800);
await shot(phone, 'phone-portrait');
note(phone.errors.length === 0, 'телефон без ошибок', phone.errors.join(' | '));

await browser.close();
console.log(`\nитог: ${problems.length ? 'замечаний ' + problems.length : 'всё сошлось'}`);
for (const p of problems) console.log('  · ' + p);
process.exit(problems.length ? 1 : 0);
