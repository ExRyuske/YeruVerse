// Отсчёты, снятые оболочкой, превращаются здесь в обычную дорожку звука.
//
// Модуль живёт в отдельном мире: это не обычный модуль страницы, а процессор
// WebAudio. Ни импортов отсюда, ни доступа к DOM — только сообщения через порт
// и вызов `process` от звукового движка, раз в 128 кадров и всегда вовремя.
// Поэтому здесь нет ни единого вызова, который мог бы задуматься: всё, что
// пришло, уже разобрано и лежит в очереди.
//
// Приходят чередующиеся отсчёты двух каналов по 16 бит (см. `sysaudio.rs`).

/**
 * Сколько звука разрешаем накопить, в кадрах — четверть секунды при 48 кГц.
 *
 * Часы у оболочки и у звукового движка идут от одного и того же устройства, но
 * не абсолютно вровень, и за долгий разговор очередь медленно растёт или
 * тощает. Растущую подрезаем: лишняя задержка в трансляции хуже, чем щелчок
 * раз в час. Пустая очередь и так отдаёт тишину.
 */
const MAX_FRAMES = 19200;
const REBUFFER_EMPTY = 1200;

class SystemSound extends AudioWorkletProcessor {
  constructor(options) {
    super();
    /**
     * Сколько кадров копим, прежде чем заиграть после пустой очереди.
     */
    this.prebuffer = options?.processorOptions?.prebuffer ?? 0;
    /** Копим запас и пока молчим. */
    this.filling = this.prebuffer > 0;
    /** Очередь пришедших кусков; каждый — Int16Array с чередованием каналов. */
    this.queue = [];
    /** Докуда прочитан первый кусок, в отсчётах (не в кадрах). */
    this.head = 0;
    /** Сколько кадров лежит в очереди — чтобы не пересчитывать её каждый раз. */
    this.frames = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.emptyFrames = 0;
    this.stopped = false;

    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.stopped = true;
        return;
      }
      const chunk = new Int16Array(data);
      this.queue.push(chunk);
      this.frames += chunk.length >> 1;

      // Подрезаем с головы, а не с хвоста: свежий звук нужнее старого.
      // Сбрасываем с запасом до рабочего уровня, чтобы не резать каждый кусок подряд.
      if (this.frames > MAX_FRAMES) {
        const target = Math.max(this.prebuffer * 2, 4800);
        while (this.frames > target && this.queue.length > 1) {
          const dropped = this.queue.shift();
          this.frames -= (dropped.length - this.head) >> 1;
          this.head = 0;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    // Моно на выходе бывает, если движок решил иначе: тогда правый канал
    // просто некуда писать, и мы отдаём один.
    const right = out[1] ?? null;
    const need = left.length;

    if (this.filling) {
      // Буферы выхода приходят уже обнулёнными — пока копим, это и есть тишина.
      if (this.frames < this.prebuffer) return !this.stopped;
      this.filling = false;
      this.emptyFrames = 0;
    }

    for (let i = 0; i < need; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        // Кратковременную нехватку гасим плавным затуханием, чтобы не щёлкать
        // и не уходить сразу в повторное накопление; перенабор включаем
        // только если источник замолчал дольше ~25 мс.
        this.lastL *= 0.95;
        this.lastR *= 0.95;
        left[i] = this.lastL;
        if (right) right[i] = this.lastR;
        this.emptyFrames++;
        if (this.prebuffer > 0 && this.emptyFrames >= REBUFFER_EMPTY) {
          this.filling = true;
        }
        continue;
      }
      const l = chunk[this.head] / 32768;
      const r = chunk[this.head + 1] / 32768;
      this.lastL = l;
      this.lastR = r;
      this.emptyFrames = 0;
      left[i] = l;
      if (right) right[i] = r;
      this.head += 2;
      this.frames--;
      if (this.head >= chunk.length) {
        this.queue.shift();
        this.head = 0;
      }
    }

    // `false` разбирает процессор насовсем — отсюда возврата нет.
    return !this.stopped;
  }
}

registerProcessor('system-sound', SystemSound);
