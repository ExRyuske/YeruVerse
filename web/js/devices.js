// Микрофон и камера: включение и разбор отказов. И то, и другое нужно и голосу,
// и трансляции, поэтому живёт отдельно от обоих.

import { voice } from './core.js';
import { toast } from './ui.js';

/**
 * Разбираем отказ в захвате: причина почти всегда в контексте, а не в коде.
 *
 * Про устройство говорим безлично — «устройство занято», а не «микрофон занят».
 * Один и тот же разбор нужен и микрофону, и камере, а называть камеру
 * микрофоном хуже, чем не называть никак: человек начинает искать поломку не
 * там, где она есть.
 */
export function deviceProblem(e) {
  if (!window.isSecureContext) {
    return `страница открыта по ${location.protocol.replace(':', '')} — нужен https`;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'браузер не даёт доступ к устройствам — откройте сайт в обычном браузере, а не во встроенном окне мессенджера';
  }
  switch (e?.name) {
    case 'NotAllowedError':
      return 'доступ запрещён — разрешите его для сайта в настройках браузера';
    case 'NotFoundError':
      return 'устройство не найдено';
    case 'NotReadableError':
      return 'устройство занято другим приложением';
    case 'OverconstrainedError':
      return 'устройство не умеет то, что мы просим';
    default:
      return e?.message ?? String(e);
  }
}

/**
 * Включение микрофона.
 *
 * Само приложение включает его при входе, после переподключения и при
 * возвращении из фона — но спрашивать разрешение можно только один раз.
 * Получив отказ, мы запоминаем это и больше не лезем: повторный запрос всё
 * равно вернёт отказ, зато человек получит ещё одно системное окно и ещё одно
 * сообщение об ошибке. Дальше — только по нажатию на кнопку микрофона.
 */
let micDenied = false;

export async function enableMic({ manual = false } = {}) {
  if (voice.enabled) return;
  if (micDenied && !manual) return;

  // Браузер знает состояние разрешения точнее нас: если доступ закрыт, вызов
  // захвата только выдаст ошибку, а окна с вопросом не будет.
  if (!manual) {
    const permission = await navigator.permissions
      ?.query({ name: 'microphone' })
      .then((p) => p.state)
      .catch(() => null);
    if (permission === 'denied') {
      micDenied = true;
      return;
    }
  }

  try {
    await voice.enable();
    micDenied = false;
  } catch (e) {
    if (e?.name === 'NotAllowedError') micDenied = true;
    toast(`Микрофон недоступен: ${deviceProblem(e)}`);
  }
}
