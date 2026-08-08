// Живой поток на сцене: демонстрация экрана или камера участника.
//
// Больше в комнате смотреть нечего — ни ссылок, ни файлов, ни синхронной
// перемотки. Поэтому здесь нет ни позиции, ни паузы, ни движка синхронизации:
// поток идёт как идёт, а всё управление свелось к громкости.

import { amplify } from './audio.js';

export class StreamPlayer {
  constructor(container, stream) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    // Никаких встроенных кнопок: в живом потоке паузе взяться неоткуда, а
    // панель плеера перехватывала клики во время управления чужим компьютером.
    v.controls = false;
    // Звук идёт через усилитель, поэтому сам элемент молчит. Элемент при этом
    // нужен: без него Chrome не отдаёт поток в WebAudio.
    v.muted = true;
    v.srcObject = stream;
    container.appendChild(v);

    this.el = v;
    this.sound = stream.getAudioTracks().length ? amplify(stream) : null;
    v.play().catch(() => {});
  }

  /** Поток мог смениться — например, трансляцию перезапустили. */
  setStream(stream) {
    this.el.srcObject = stream;
    this.el.play().catch(() => {});
  }

  /** Живой поток не должен оставаться на паузе, чем бы её ни вызвали. */
  resume() {
    if (this.el.paused) this.el.play().catch(() => {});
  }

  /** Громкость этой трансляции, 0..MAX_GAIN. */
  setVolume(level) {
    this.sound?.set(level);
  }

  destroy() {
    this.sound?.close();
    this.el.srcObject = null;
    this.el.remove();
  }
}
