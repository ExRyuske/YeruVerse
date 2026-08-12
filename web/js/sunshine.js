// Мост к Sunshine и Moonlight.
//
// Полноэкранную игру браузер не захватывает, а инжектировать ввод в чужую
// систему не имеет права — и то, и другое умеет Sunshine (либо его форк
// Apollo) в паре с Moonlight. Наше дело маленькое: заметить, что он запущен, и
// разнести адрес по комнате, чтобы подключение было в одно нажатие.
//
// Адрес идёт по WebRTC напрямую зрителям — сервер его не видит.

import { control, mesh, native, serverBase, settings } from './core.js';
import { state } from './state.js';
import { render } from './render.js';
import { icon } from './icons.js';
import { copy, toast } from './ui.js';

const SUN = 'sun';
const sunshineHosts = new Map();   // id участника -> адрес его Sunshine
const allowed = new Set();         // кому я разрешил подключаться к моему ПК

/** Есть ли к кому подключаться Moonlight'ом у этого участника. */
export const canMoonlight = (id) => sunshineHosts.has(id);

/** Комната кончилась: чужие адреса и выданные разрешения вместе с ней. */
export function resetSunshine() {
  sunshineHosts.clear();
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
    try {
      await native.sunshinePin(String(msg.pin));
      mesh.send(id, { ns: SUN, type: 'paired', ok: true });
      toast(`${state.peers.get(id)?.name ?? 'Участник'} сопряжён с вашим Sunshine`);
    } catch (e) {
      mesh.send(id, { ns: SUN, type: 'paired', ok: false, why: String(e?.message ?? e) });
    }
    return;
  }
  if (msg.type === 'paired') {
    toast(
      msg.ok
        ? 'Сопряжение прошло — Moonlight подключается'
        : `Хост не подтвердил PIN: ${msg.why ?? 'нет доступа к его Sunshine'}. Введите PIN у него в панели вручную`,
      12000
    );
    return;
  }

  if (msg.host) sunshineHosts.set(id, msg.host);
  else sunshineHosts.delete(id);
  render('peers');
});

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
  mesh.send(id, { ns: SUN, host: allowed.has(id) ? state.sunshine : null });
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
    toast(`Управление не включилось: ${e.message ?? e}`);
  }
  render('peers');

  const who = state.peers.get(id)?.name ?? 'Участник';
  toast(on ? `${who} пущен за ваш компьютер` : `${who} больше не может подключаться`);
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
  const { running, address } = await native.sunshine().catch(() => ({}));
  if (!running || !address) {
    if (state.sunshine) {
      state.sunshine = null;
      for (const id of allowed) tellSunshine(id);
      render('peers');
    }
    return;
  }

  // Виден ли Sunshine снаружи, решают проброс портов на роутере и адрес
  // провайдера — они меняются раз в недели, а не раз в полминуты. Спрашиваем
  // сервер не чаще раза в пять минут, иначе это просто фоновый запрос по кругу.
  if (Date.now() - reachedAt > 5 * 60 * 1000) {
    reached = await fetch(new URL('/reach', serverBase()), { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({}));
    reachedAt = Date.now();
  }
  const reach = reached;
  // Наружу отдаём публичный адрес, только если он и правда отвечает; иначе
  // локальный — в своей сети он рабочий, а из интернета не сработает ничего.
  const host = reach.open && reach.ip ? reach.ip : address;

  if (host === state.sunshine) return;
  state.sunshine = host;
  state.sunshineOpen = !!reach.open;
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
 */
async function openMoonlight(id, host) {
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
      .catch((e) => toast(`${e.message ?? e}`, 9000));
  }

  // Первое подключение. PIN придумываем сами и отдаём обеим сторонам: Moonlight
  // получает его аргументом, хозяин — сообщением, которое его приложение само
  // отнесёт в Sunshine.
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  try {
    await native.moonlight(host, 'pair', pin);
  } catch (e) {
    return toast(`${e.message ?? e}`, 9000);
  }
  settings.set('pairedHosts', [...paired, host]);
  mesh.send(id, { ns: SUN, type: 'pin', pin });
  toast('Сопрягаемся: PIN ушёл хозяину компьютера, подтверждать вручную не нужно', 10000);
}

/** Кнопка «подключиться к этому компьютеру Moonlight'ом». */
export function moonlightButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mark';
  btn.innerHTML = icon('gamepad');
  btn.title = 'Экран и управление через Moonlight';
  btn.onclick = () => openMoonlight(id, sunshineHosts.get(id));
  return btn;
}

/** Переключатель «этому человеку можно подключаться к моему компьютеру». */
export function allowButton(id) {
  const on = allowed.has(id);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mark' + (on ? ' on' : '');
  btn.innerHTML = icon(on ? 'unlock' : 'lock');
  btn.title = on
    ? 'Забрать доступ к моему компьютеру'
    : 'Разрешить подключаться к моему компьютеру';
  btn.onclick = () => setAllowed(id, !on);
  return btn;
}
