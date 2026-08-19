// Звуковой тракт приложения — один на всё.
//
// Здесь и только здесь заводится AudioContext, выбирается устройство вывода,
// меряются уровни и поднимается громкость выше ста процентов. На этом же
// контексте стоит шумодав микрофона: граф у приложения один.
//
// Контекстов было два — общий и отдельный у шумодава, на 48 кГц. Второй
// пересоздавался на каждую смену настройки микрофона, а движок отвечает на
// такое перенастройкой системного звука: щелчок, а то и провал в трансляции и
// в голосах собеседников, то есть ровно в том, к чему микрофон отношения не
// имеет. Поэтому контекст один и просят его сразу на 48 кГц: это частота, на
// которой работают модели шумодава, а всему остальному она безразлична.
//
// Играет звук при этом обычный <audio>/<video>, а WebAudio подключается только
// чтобы поднять громкость выше ста процентов — у элемента она упирается в
// единицу. Раньше всё шло через WebAudio, и на движке WebKit (Safari и окно
// приложения на macOS — это он) собеседников не было слышно вовсе: поток из
// WebRTC там доходит до графа обработки не всегда, а до элемента доходит всегда.

/** Частота, на которой работают модели шумодава. Другой они не умеют. */
export const MODEL_RATE = 48000;

/** Потолок усиления: дальше не громче, а грязнее. */
const MAX_GAIN = 5;

let shared = null;

/**
 * Единственный контекст приложения. Создаётся лениво — до жеста пользователя он
 * родился бы приостановленным, и уровни всегда были бы нулевыми.
 */
export function context() {
  if (!shared) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    try {
      shared = new Ctor({ sampleRate: MODEL_RATE });
    } catch {
      // Древний WebKit частоту выбирать не даёт. Всему, кроме шумодава, это
      // безразлично, а шумодав частоту проверит сам и уйдёт на подавление
      // средствами движка — о чём человеку и скажут.
      shared = new Ctor();
    }
  }
  wake();
  return shared;
}

/**
 * Разбудить тракт, если он уснул.
 *
 * Уснувший контекст не падает и не жалуется — он просто перестаёт отдавать
 * звук: дорожки живы, уровни нулевые, собеседники слышат тишину. Свернули
 * приложение на телефоне, система забрала звук под звонок — и сам он не
 * возвращается. Контекста может ещё и не быть: до первого звука поднимать его
 * незачем.
 */
function wake() {
  if (shared?.state === 'suspended') shared.resume().catch(() => {});
}

/** Работает ли тракт прямо сейчас. Обращение к нему заодно и будит. */
export function running() {
  return context().state === 'running';
}

/** То же, но с ожиданием: нужно тем, кто следом строит на нём граф. */
export async function resume() {
  const ctx = context();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  return ctx.state === 'running';
}

/** Устройство вывода умеют выбирать либо контекст, либо сами элементы. */
const ctxSink = () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const elSink = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export function canChooseOutput() {
  return ctxSink() || elSink();
}

const players = new Set();   // всё, что сейчас звучит, — им назначаем устройство
let sink = '';

/**
 * Звук, которому не дали начаться.
 *
 * Голос собеседника приходит сам, без всякого нажатия, а движки такое запускать
 * не дают: вебвью Android запрещает это прямой настройкой, Safari — политикой
 * автозапуска. Раньше всё шло через WebAudio, которому хватало одного касания за
 * всё время, а элемент требует разрешения на каждый запуск. Поэтому неудачу
 * запоминаем и повторяем при первом же касании страницы.
 */
const blocked = new Set();

/** Повторить то, что не запустилось. Функция сама решает, что ей нужно. */
export function retryOnGesture(fn) {
  blocked.add(fn);
}

/** Ждать больше нечего: элемент убрали, и запускать его при касании незачем. */
export function forgetGesture(fn) {
  blocked.delete(fn);
}

function unlock() {
  wake();
  for (const fn of [...blocked]) {
    Promise.resolve()
      .then(fn)
      .then(() => blocked.delete(fn))
      .catch(() => {});
  }
}
for (const event of ['pointerdown', 'keydown', 'touchend']) {
  document.addEventListener(event, unlock, { capture: true, passive: true });
}

// Вернулись из фона: касания может и не быть — окно просто снова на экране, а
// звук после сна телефона надо поднимать самим.
document.addEventListener('visibilitychange', () => document.hidden || wake());

/** Куда выводить звук — сразу всему приложению. */
export async function setOutput(deviceId) {
  sink = deviceId || '';
  // Ради системного устройства по умолчанию контекст не поднимаем: он родился
  // бы раньше первого звука и раньше первого касания, то есть уснувшим.
  if (ctxSink() && (sink || shared)) {
    try { await context().setSinkId(sink); } catch {}
  }
  for (const el of players) applySink(el);
}

function applySink(el) {
  if (elSink()) el.setSinkId(sink).catch(() => {});
}

/**
 * Замер уровня на узле графа.
 *
 * Одна реализация на всё: и индикатор «сейчас говорит», и присмотр за шумодавом
 * считают громкость одинаково — по среднеквадратичному значению последнего
 * кадра. Разными они были только по недосмотру.
 */
export function tap(node) {
  const analyser = context().createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.sqrt(sum / buf.length);
    },
    close() {
      // Отцепляем только свой замер: узел, к которому мы подключились, живёт
      // своей жизнью и может кормить ещё кого-то.
      try { node.disconnect(analyser); analyser.disconnect(); } catch {}
    },
  };
}

/** Замер громкости потока — тот же замер, только источник свой. */
export function meter(stream) {
  try {
    const src = context().createMediaStreamSource(stream);
    const probe = tap(src);
    return {
      level: () => probe.level(),
      close() {
        probe.close();
        try { src.disconnect(); } catch {}
      },
    };
  } catch {
    return null;   // в потоке нет звуковой дорожки — мерить нечего
  }
}

/**
 * Громкость media-элемента, играющего этот поток.
 *
 * До ста процентов играет сам элемент — это работает в любом движке. Выше
 * подключается усилитель WebAudio, и тогда элемент глушится, чтобы звук не шёл
 * двумя путями сразу.
 *
 * Глушится не раньше, чем усилитель докажет, что до него вообще доходит звук.
 * На движке WebKit (Safari и окно приложения на macOS) поток из WebRTC до графа
 * обработки доходит не всегда, и безусловное глушение означало ровно то, чего
 * человек не ждёт: поставил собеседнику погромче — и перестал его слышать.
 * Теперь в этом случае громкость просто упирается в сто процентов.
 */
export function volume(el, stream) {
  players.add(el);
  applySink(el);

  let boost = null;
  let level = 1;
  // Немой режим: движок не пустил звук без касания, и элемент играет молча.
  // Флаг нужен именно здесь. Пока его не было, глушение жило прямо в свойстве
  // элемента, а следующая же установка громкости — а она приходит на каждой
  // перерисовке сцены — снимала его без всякого касания. Движок на это отвечает
  // остановкой воспроизведения, и трансляция начинала дёргаться и молчать.
  let silenced = false;

  // Кто играет: усилитель (тогда элемент молчит) или сам элемент.
  const route = () => {
    const loud = level > 1 && !!boost?.alive();
    el.muted = silenced || loud;
    el.volume = loud ? 1 : Math.min(1, level);
    boost?.set(loud && !silenced ? level : 0);
  };

  return {
    set(v) {
      level = Math.min(MAX_GAIN, Math.max(0, v));
      if (level > 1 && !boost) boost = amplify(stream, route);
      route();
    },
    /** Играть молча (или перестать) — решение автозапуска, а не громкости. */
    mute(on) {
      silenced = !!on;
      route();
    },
    close() {
      players.delete(el);
      boost?.close();
      boost = null;
    },
  };
}

/** Чужой голос: свой невидимый элемент и та же громкость поверх него. */
export function playback(stream) {
  const el = new Audio();
  el.srcObject = stream;
  el.autoplay = true;
  el.style.display = 'none';   // Safari не играет элемент вне документа
  document.body.appendChild(el);
  const level = volume(el, stream);

  const play = () => el.play();
  return {
    play: () =>
      play().catch((e) => {
        retryOnGesture(play);
        throw e;                       // наверх уходит «звук заблокирован»
      }),
    set: (v) => level.set(v),
    close() {
      forgetGesture(play);
      level.close();
      el.srcObject = null;
      el.remove();
    },
  };
}

/**
 * Усилитель поверх потока: `gain` можно поднимать выше единицы.
 *
 * Media-элемент при этом всё равно нужен — без привязки потока к нему Chrome не
 * отдаёт звук в WebAudio вовсе, поэтому усилитель и живёт только рядом с
 * элементом.
 *
 * Рядом с усилением висит замер на самом источнике: по нему видно, дошёл ли
 * поток до графа. Пока в нём одни нули, усилитель молчит и звук идёт через
 * элемент; как только появится хоть что-то — зовём `onAlive`, и вызывающий
 * передаёт звук сюда. Замер стоит до регулятора: после него при нулевом
 * усилении было бы тихо всегда, и вопрос «дошёл ли поток» остался бы без
 * ответа навсегда.
 */
function amplify(stream, onAlive) {
  const ctx = context();
  let src;
  try {
    src = ctx.createMediaStreamSource(stream);
  } catch {
    // В потоке ещё нет звуковой дорожки — движки на это отвечают отказом.
    // Усиливать нечего, но дорожка может доехать позже: попробуем в другой раз.
    return null;
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(ctx.destination);

  const probe = tap(src);
  let alive = false;
  const timer = setInterval(() => {
    if (probe.level() === 0) return;   // цифровая тишина — ещё не ответ
    alive = true;
    clearInterval(timer);
    onAlive();
  }, 250);

  return {
    alive: () => alive,
    set(level) {
      gain.gain.value = Math.min(MAX_GAIN, Math.max(0, level));
    },
    close() {
      clearInterval(timer);
      probe.close();
      try { src.disconnect(); gain.disconnect(); } catch {}
    },
  };
}
