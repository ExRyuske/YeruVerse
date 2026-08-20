// Мост к Sunshine и Moonlight.
//
// Полноэкранную игру браузер не захватывает, а инжектировать ввод в чужую
// систему не имеет права — и то, и другое умеет Sunshine (либо его форк
// Apollo) в паре с Moonlight. Наше дело маленькое: заметить, что он запущен, и
// разнести адрес по комнате, чтобы подключение было в одно нажатие.
//
// Адрес идёт по WebRTC напрямую зрителям — сервер его не видит.

import { askServer, control, mesh, native, settings } from './core.js';
import { state } from './state.js';
import { reason } from './errors.js';
import { render } from './render.js';
import { copy, markButton, toast } from './ui.js';

const SUN = 'sun';
/** id участника -> `{ host, canPair }`: адрес его Sunshine и умеет ли он сам
 *  подтвердить PIN. От второго зависит весь порядок сопряжения. */
const sunshineHosts = new Map();
const allowed = new Set();         // кому я разрешил подключаться к моему ПК

/** Адрес панели Sunshine на своей же машине — там подтверждают PIN руками. */
const PANEL = 'https://localhost:47990';

/** Есть ли к кому подключаться Moonlight'ом у этого участника. */
export const canMoonlight = (id) => sunshineHosts.has(id);

/** Комната кончилась: чужие адреса и выданные разрешения вместе с ней. */
export function resetSunshine() {
  sunshineHosts.clear();
  pending.clear();
  // Кому я разрешил зайти на свой компьютер — вместе с комнатой и заканчивается.
  // Список переживал выход, хотя те люди остались в покинутой комнате.
  allowed.clear();
}

mesh.on('message', async ({ id, msg }) => {
  if (msg?.ns !== SUN) return;

  // Сопряжение: зритель прислал PIN, который показал его Moonlight. Отдаём
  // своему Sunshine — иначе этот PIN пришлось бы переписывать руками в
  // веб-панель, и это единственный шаг, на котором всё бросают.
  if (msg.type === 'pin') {
    if (!allowed.has(id)) return;
    const who = state.peers.get(id)?.name ?? 'Участник';
    try {
      await native.sunshinePin(String(msg.pin));
      mesh.send(id, { ns: SUN, type: 'paired', ok: true });
      toast(`${who} сопряжён с вашим Sunshine`);
    } catch (e) {
      mesh.send(id, { ns: SUN, type: 'paired', ok: false, why: reason(e) });
      // Автоматически не вышло — значит, PIN придётся ввести руками. Показываем
      // его хозяину компьютера: до сих пор об этой неудаче узнавал только
      // зритель, а человек у клавиатуры не видел ни PIN, ни самой просьбы.
      toast(
        `${who} сопрягается: введите PIN ${msg.pin} в панели Sunshine — ${PANEL}`,
        30000
      );
    }
    return;
  }
  if (msg.type === 'paired') {
    toast(
      msg.ok
        ? 'Сопряжение прошло — Moonlight подключается'
        : `Хозяин компьютера не подтвердил PIN сам (${msg.why ?? 'нет доступа к его Sunshine'}). ` +
            `Продиктуйте ему код ${pending.get(id) ?? ''} — он введёт его в своей панели Sunshine`,
      20000
    );
    return;
  }

  if (msg.host) sunshineHosts.set(id, { host: msg.host, canPair: !!msg.canPair });
  else sunshineHosts.delete(id);
  render('peers');
});

/** Какой PIN мы отправили какому хосту — чтобы было что продиктовать. */
const pending = new Map();

mesh.on('peer-open', ({ id }) => tellSunshine(id));
mesh.on('peer-close', ({ id }) => {
  allowed.delete(id);
  if (sunshineHosts.delete(id)) render('peers');
});

/**
 * Свой адрес получает только тот, кому его дали. Пускать за свой компьютер всю
 * комнату разом — не то согласие, которое можно выдать один раз и забыть.
 */
function tellSunshine(id) {
  const mine = allowed.has(id);
  mesh.send(id, {
    ns: SUN,
    host: mine ? state.sunshine : null,
    // Умеем ли мы подтвердить PIN за человека. Зритель по этому решает, как
    // запускать сопряжение: со своим кодом или с тем, что покажет Moonlight.
    canPair: mine && state.sunshineCanPair,
  });
}

/**
 * Разрешить или забрать доступ к своему компьютеру.
 *
 * Замок один на оба пути: и на простое управление по WebRTC, и на адрес
 * Sunshine для Moonlight. Разделять их значило бы спрашивать согласие дважды за
 * одно и то же — «пусти меня за свой компьютер».
 */
async function setAllowed(id, on) {
  if (on) allowed.add(id);
  else allowed.delete(id);
  tellSunshine(id);

  try {
    if (native.caps.remoteControl) await control.grant(id, on);
  } catch (e) {
    toast(`Управление не включилось: ${reason(e)}`);
  }
  render('peers');

  const who = state.peers.get(id)?.name ?? 'Участник';
  toast(on ? `${who} пущен за ваш компьютер` : `${who} больше не может подключаться`);
  if (on) warnAboutSunshine();
}

/**
 * Замок открыт — но через Moonlight к нам зайдут не всегда, и молчать об этом
 * нельзя: снаружи это выглядит как «просто не работает». Мышь и клавиатура по
 * WebRTC при этом работают в любом случае, они Sunshine не требуют.
 */
function warnAboutSunshine() {
  if (!native.caps.remoteControl) return;
  if (!state.sunshine) {
    toast(
      'Sunshine не запущен — играть через Moonlight не выйдет. ' +
        'Мышь и клавиатура по-прежнему работают: они идут напрямую.',
      10000
    );
    return;
  }
  if (!state.sunshineCanPair) {
    toast(
      'Логин и пароль панели Sunshine не сохранены: PIN при первом подключении ' +
        'придётся ввести руками. Настройки → Sunshine избавят от этого шага.',
      10000
    );
  }
}

/**
 * Ищем Sunshine и заодно выясняем, как до него добраться снаружи.
 *
 * Локальный адрес работает только в своей сети. Из интернета нужен публичный, и
 * он же должен быть открыт: Moonlight ходит по своим портам напрямую, никакой
 * ретрансляции у него нет. Проверить это изнутри своей сети нельзя — у себя всё
 * открыто всегда, — поэтому спрашиваем сервер комнат: он смотрит на нас ровно
 * так, как посмотрит зритель из интернета.
 */
let reachedAt = 0;
let reached = {};

export async function pollSunshine() {
  // Адрес Sunshine нужен только в комнате: вне её раздавать его некому, а мост
  // приложения незачем дёргать каждые полминуты просто так.
  if (!native.available || !state.joined) return;
  const { running, address, canPair } = await native.sunshine().catch(() => ({}));

  // Способ сопряжения меняется не сам по себе, а когда человек сохранил доступ
  // к панели прямо сейчас. Зрителям об этом надо сказать так же, как об адресе:
  // от этого зависит, спросит ли их Moonlight код.
  const pairing = !!canPair;
  const pairingChanged = pairing !== state.sunshineCanPair;
  state.sunshineCanPair = pairing;

  if (!running || !address) {
    if (state.sunshine || pairingChanged) {
      state.sunshine = null;
      announce();
    }
    return;
  }

  // Виден ли Sunshine снаружи, решают проброс портов на роутере и адрес
  // провайдера — они меняются раз в недели, а не раз в полминуты. Спрашиваем
  // сервер не чаще раза в пять минут, иначе это просто фоновый запрос по кругу.
  if (Date.now() - reachedAt > 5 * 60 * 1000) {
    reached = await askServer('/reach');
    reachedAt = Date.now();
  }
  const reach = reached;
  // Наружу отдаём публичный адрес, только если он и правда отвечает; иначе
  // локальный — в своей сети он рабочий, а из интернета не сработает ничего.
  const host = reach.open && reach.ip ? reach.ip : address;

  state.sunshineOpen = !!reach.open;
  if (host === state.sunshine && !pairingChanged) return;
  state.sunshine = host;
  announce();
}

/** Разослать свой адрес тем, кому он разрешён. */
function announce() {
  for (const id of allowed) tellSunshine(id);
  render('peers');
}

/** Что сказать про доступность Sunshine снаружи — по-русски и по делу. */
export function sunshineHint() {
  if (!state.sunshine) return '';
  return state.sunshineOpen
    ? `Sunshine виден из интернета: ${state.sunshine}`
    : 'Sunshine виден только в вашей сети. Чтобы пускать друзей из интернета, ' +
        'пробросьте на роутере порты 47984–47990 TCP и 47998–48010 UDP на этот ' +
        'компьютер — либо соедините машины через Tailscale или ZeroTier, тогда ' +
        'пробрасывать ничего не нужно.';
}

/**
 * Запуск Moonlight.
 *
 * Ссылок вида `moonlight://` не существует — такую схему в системе никто не
 * регистрирует, поэтому запускать нужно сам исполняемый файл, и делает это
 * оболочка. У Moonlight две команды: `pair` знакомит с компьютером и показывает
 * PIN, `stream` сразу открывает рабочий стол. Первая нужна ровно один раз на
 * адрес, поэтому сопряжённые адреса мы помним.
 *
 * Сопряжений тоже два, и выбор между ними — не мелочь.
 *
 * Если хозяин сохранил доступ к своей панели Sunshine, PIN придумываем мы:
 * Moonlight получает его аргументом и ни о чём не спрашивает, а приложение
 * хозяина само отнесёт код в панель. Один щелчок, и всё.
 *
 * Если не сохранил — подставлять код нельзя. Раньше он подставлялся всегда, и
 * получалось худшее из возможного: Moonlight PIN не показывал (он его уже
 * знал), подтвердить его хозяину было нечем, и сопряжение просто не
 * происходило — молча, без единого запроса на экране. Поэтому здесь Moonlight
 * запускается без кода: он покажет свой, и его останется продиктовать.
 */
async function openMoonlight(id, entry) {
  const host = entry?.host;
  if (!host) return;

  // Без нашего приложения запустить процесс нельзя — пробуем схему (вдруг
  // клиент её всё-таки зарегистрировал) и показываем адрес, чтобы его можно
  // было просто вставить в уже установленный Moonlight.
  if (!native.available) {
    location.href = `moonlight://${host}`;
    return copy(host, 'Адрес скопирован — вставьте в Moonlight', 'Адрес для Moonlight:');
  }

  const paired = settings.get('pairedHosts') ?? [];
  if (paired.includes(host)) {
    return native
      .moonlight(host, 'stream')
      .then(() => toast(`Moonlight подключается к ${host}`))
      .catch((e) => toast(reason(e), 9000));
  }

  // Первое подключение к этому компьютеру.
  const pin = entry.canPair ? String(Math.floor(1000 + Math.random() * 9000)) : null;
  try {
    await native.moonlight(host, 'pair', pin);
  } catch (e) {
    return toast(reason(e), 9000);
  }
  settings.set('pairedHosts', [...paired, host]);

  if (!pin) {
    return toast(
      'Moonlight сейчас покажет PIN — продиктуйте его хозяину компьютера, ' +
        'он введёт код в своей панели Sunshine.',
      20000
    );
  }
  pending.set(id, pin);
  mesh.send(id, { ns: SUN, type: 'pin', pin });
  toast('Сопрягаемся: PIN ушёл хозяину компьютера, подтверждать вручную не нужно', 10000);
}

/** Кнопка «подключиться к этому компьютеру Moonlight'ом». */
export function moonlightButton(id) {
  return markButton({
    glyph: 'gamepad',
    title: 'Экран и управление через Moonlight',
    // Адрес и способ сопряжения приезжают вместе — оба от хозяина компьютера.
    onclick: () => openMoonlight(id, sunshineHosts.get(id)),
  });
}

/** Переключатель «этому человеку можно подключаться к моему компьютеру». */
export function allowButton(id) {
  const on = allowed.has(id);
  return markButton({
    glyph: on ? 'unlock' : 'lock',
    on,
    title: on
      ? 'Забрать доступ к моему компьютеру'
      : 'Разрешить подключаться к моему компьютеру',
    onclick: () => setAllowed(id, !on),
  });
}
