// Живой поток на сцене: демонстрация экрана или камера участника.
//
// Больше в комнате смотреть нечего — ни ссылок, ни файлов, ни синхронной
// перемотки. Поэтому здесь нет ни позиции, ни паузы, ни движка синхронизации:
// поток идёт как идёт, а всё управление свелось к громкости.

import { volume, retryOnGesture } from './audio.js';

export class StreamPlayer {
  constructor(container, stream) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    // Никаких встроенных кнопок: в живом потоке паузе взяться неоткуда, а
    // панель плеера перехватывала клики во время управления чужим компьютером.
    v.controls = false;
    v.srcObject = stream;
    container.appendChild(v);

    this.el = v;
    // Звук трансляции идёт через сам элемент, а усилитель подключается только
    // ради громкости выше ста процентов.
    this.sound = stream.getAudioTracks().length ? volume(v, stream) : null;
    this._play();
  }

  /**
   * Со звуком браузер может не разрешить запуск до первого касания страницы.
   * Тогда играем без звука: картинка нужнее, а звук вернётся при следующей
   * попытке — их делает `resume` раз в пару секунд.
   */
  _play() {
    this.el.play().catch(() => {
      // Со звуком не пустили — играем без него: картинка нужнее. И просим
      // вернуть звук при первом касании страницы, иначе трансляция так и
      // останется немой до конца разговора.
      this.el.muted = true;
      this.el.play().catch(() => {});
      retryOnGesture(() => {
        this.el.muted = false;
        return this.el.play();
      });
    });
  }

  /** Поток мог смениться — например, трансляцию перезапустили. */
  setStream(stream) {
    this.el.srcObject = stream;
    this._play();
  }

  /** Живой поток не должен оставаться на паузе, чем бы её ни вызвали. */
  resume() {
    if (this.el.paused) this._play();
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
