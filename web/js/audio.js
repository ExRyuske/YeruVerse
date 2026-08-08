// Один аудиоконтекст на всё приложение.
//
// Контекст — не бесплатная абстракция: каждый держит свой поток обработки и
// своё соединение с системным звуком. Их было два, и оба делали одно и то же,
// поэтому теперь голос собеседников и звук трансляций идут через общий.
// Отдельным остался только контекст RNNoise: модель работает строго на 48 кГц,
// а системный может оказаться 44.1.
//
// Через WebAudio, а не через `volume` у media-элемента, всё это идёт по одной
// причине: у элемента громкость упирается в единицу, и «200%» звучали бы ровно
// как «100%».

/** Потолок усиления: дальше не громче, а грязнее. */
export const MAX_GAIN = 5;

let shared = null;

/**
 * Общий контекст. Создаётся лениво — до жеста пользователя он родился бы в
 * состоянии suspended, и уровни всегда были бы нулевыми.
 */
export function audioCtx() {
  if (!shared) shared = new (window.AudioContext || window.webkitAudioContext)();
  if (shared.state === 'suspended') shared.resume().catch(() => {});
  return shared;
}

/** Умеет ли контекст выбирать устройство вывода. */
export function canChooseOutput() {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

/** Куда выводить звук — сразу всё приложение, раз контекст общий. */
export async function setOutput(deviceId) {
  if (!canChooseOutput()) return;
  try {
    await audioCtx().setSinkId(deviceId || '');
  } catch {}
}

/**
 * Усилитель поверх потока: `gain` можно поднимать выше единицы.
 *
 * Media-элемент при этом всё равно нужен беззвучным — без привязки потока к
 * нему Chrome не отдаёт звук в WebAudio вовсе.
 */
export function amplify(stream) {
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
