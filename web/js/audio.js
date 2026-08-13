// Один аудиоконтекст на всё приложение.
//
// Контекст — не бесплатная абстракция: каждый держит свой поток обработки и
// своё соединение с системным звуком. Их было два, и оба делали одно и то же,
// поэтому теперь голос собеседников и звук трансляций идут через общий.
// Отдельным остался только контекст RNNoise: модель работает строго на 48 кГц,
// а системный может оказаться 44.1.
//
// Играет звук при этом обычный <audio>, а WebAudio подключается только чтобы
// поднять громкость выше ста процентов — у элемента она упирается в единицу.
// Раньше всё шло через WebAudio, и на движке WebKit (Safari и окно приложения
// на macOS — это он) собеседников не было слышно вовсе: поток из WebRTC там
// доходит до графа обработки не всегда, а до <audio> доходит всегда.

/** Потолок усиления: дальше не громче, а грязнее. */
const MAX_GAIN = 5;

let shared = null;

/**
 * Общий контекст. Создаётся лениво — до жеста пользователя он родился бы в
 * состоянии suspended, и уровни всегда были бы нулевыми.
 */
function audioCtx() {
  if (!shared) shared = new (window.AudioContext || window.webkitAudioContext)();
  if (shared.state === 'suspended') shared.resume().catch(() => {});
  return shared;
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

function unlock() {
  if (shared?.state === 'suspended') shared.resume().catch(() => {});
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

/** Куда выводить звук — сразу всему приложению. */
export async function setOutput(deviceId) {
  sink = deviceId || '';
  if (ctxSink()) {
    try { await audioCtx().setSinkId(sink); } catch {}
  }
  for (const el of players) applySink(el);
}

function applySink(el) {
  if (elSink()) el.setSinkId(sink).catch(() => {});
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

  // Кто играет: усилитель (тогда элемент молчит) или сам элемент.
  const route = () => {
    const loud = level > 1 && !!boost?.alive();
    el.muted = loud;
    el.volume = loud ? 1 : Math.min(1, level);
    boost?.set(loud ? level : 0);
  };

  return {
    set(v) {
      level = Math.min(MAX_GAIN, Math.max(0, v));
      if (level > 1 && !boost) boost = amplify(stream, route);
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
      blocked.delete(play);
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
 * отдаёт звук в WebAudio вовсе, поэтому создаётся усилитель только из playback.
 *
 * Рядом с усилением висит замер на самом источнике: по нему видно, дошёл ли
 * поток до графа. Пока в нём одни нули, усилитель молчит и звук идёт через
 * элемент; как только появится хоть что-то — зовём `onAlive`, и вызывающий
 * передаёт звук сюда. Замер стоит до регулятора: после него при нулевом
 * усилении было бы тихо всегда, и вопрос «дошёл ли поток» остался бы без
 * ответа навсегда.
 */
function amplify(stream, onAlive) {
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(ctx.destination);

  const probe = ctx.createAnalyser();
  probe.fftSize = 512;
  src.connect(probe);
  const buf = new Float32Array(probe.fftSize);

  let alive = false;
  const timer = setInterval(() => {
    probe.getFloatTimeDomainData(buf);
    if (buf.every((v) => v === 0)) return;   // цифровая тишина — ещё не ответ
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
      try { src.disconnect(); gain.disconnect(); probe.disconnect(); } catch {}
    },
  };
}

/** Замер громкости потока — для индикатора «сейчас говорит». */
export function meter(stream) {
  try {
    const ctx = audioCtx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    return {
      level() {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        return Math.sqrt(sum / buf.length);
      },
      close() {
        try { src.disconnect(); analyser.disconnect(); } catch {}
      },
    };
  } catch {
    return null;
  }
}
