// Звук компьютера в свою трансляцию — на macOS.
//
// Везде, кроме macOS, это делает сам движок: `getDisplayMedia` отдаёт звук
// вместе с картинкой, и здесь ничего не нужно. На macOS системный звук не
// отдаёт ни один движок — ни WebKit, ни Chrome, — и трансляция уходит немой.
// Закрыть эту дыру может только оболочка, и она это делает (`sysaudio.rs`):
// снимает звук через ScreenCaptureKit и присылает сюда отсчёты.
//
// Отсюда они попадают в обычную дорожку MediaStreamTrack, и дальше всё как
// всегда — `mesh` жмёт её тем же Opus, что и звук игры на Windows.

import { context, resume } from './audio.js';
import { native } from './native.js';
import { reason } from './errors.js';

/** Идущий захват. Он один: снимать звук системы дважды незачем и нечем. */
let live = null;

/** Умеет ли эта сборка отдавать звук системы. */
export function canCaptureSound() {
  return !!native.caps.systemAudio;
}

/**
 * Начать снимать звук системы и вернуть дорожку с ним.
 *
 * Ошибку не глотаем: самая частая — не выдана «Запись экрана», и человеку об
 * этом надо сказать, иначе он будет искать причину в настройках трансляции.
 */
export async function captureSound() {
  if (live) return live.track;
  if (!canCaptureSound()) throw new Error('захват звука системы недоступен');

  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel) throw new Error('нативный слой недоступен');

  // Контекст может быть приостановлен — тогда дорожка молчала бы, а причина
  // была бы не видна ни в одном месте. Ответ проверяем: спящий тракт означает
  // тишину в трансляции, и молчать об этом нельзя.
  if (!(await resume())) throw new Error('звуковой тракт не проснулся');
  const ctx = context();
  await ctx.audioWorklet.addModule(new URL('./sound-worklet.js', import.meta.url).href);

  const node = new AudioWorkletNode(ctx, 'system-sound', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);

  const channel = new Channel();
  channel.onmessage = (data) => {
    // Оболочка шлёт сырые байты, и приходят они как ArrayBuffer. Отдаём его
    // процессору с передачей владения: копировать по двести килобайт в
    // секунду незачем.
    const buf = data instanceof ArrayBuffer ? data : data?.buffer;
    if (buf) node.port.postMessage(buf, [buf]);
  };

  try {
    // Частоту берём у графа, а не считаем: движок вправе не дать 48 кГц, и
    // тогда наши отсчёты играли бы не с той скоростью — звук поехал бы по
    // высоте, а понять почему было бы неоткуда.
    await native.invoke('sound_start', { channel, rate: Math.round(ctx.sampleRate) });
  } catch (e) {
    node.port.postMessage('stop');
    node.disconnect();
    throw new Error(reason(e));
  }

  const track = dest.stream.getAudioTracks()[0];
  live = { node, dest, track };
  return track;
}

/** Прекратить. Звать можно всегда — если не начинали, ничего не случится. */
export function stopSound() {
  if (!live) return;
  const { node, track } = live;
  live = null;
  native.invoke('sound_stop').catch(() => {});
  node.port.postMessage('stop');
  node.disconnect();
  track.stop();
}
