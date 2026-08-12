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
 * До ста процентов играет сам элемент — это работает в любом движке. Выше —
 * подключается усилитель WebAudio, а элемент глушится, чтобы звук не шёл двумя
 * путями сразу. Где WebAudio с потоком из WebRTC не дружит, громче ста
 * процентов просто не станет, но слышно будет.
 */
export function volume(el, stream) {
  players.add(el);
  applySink(el);

  let boost = null;

  return {
    set(v) {
      const level = Math.min(MAX_GAIN, Math.max(0, v));
      const loud = level > 1;
      if (loud && !boost) boost = amplify(stream);
      boost?.set(loud ? level : 0);
      el.muted = loud;
      el.volume = loud ? 1 : level;
    },
    close() {
      players.delete(el);
      boost?.close();
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

  return {
    play: () => el.play(),
    set: (v) => level.set(v),
    close() {
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
 */
function amplify(stream) {
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  src.connect(gain).connect(ctx.destination);
  return {
    set(level) {
      gain.gain.value = Math.min(MAX_GAIN, Math.max(0, level));
    },
    close() {
      try { src.disconnect(); gain.disconnect(); } catch {}
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
