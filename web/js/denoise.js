// Подавление шума нейросетью: две модели и общий тракт вокруг них.
//
// Модели работают строго на 48 кГц — ради этого весь звуковой тракт приложения
// и просят на такой частоте. Своего контекста у шумодава больше нет: он
// пересоздавался на каждую смену настройки микрофона и уводил за собой
// системный звук, а с ним и трансляцию, и голоса. Здесь строится только граф —
// источник, модель, замеры — на общем контексте из `audio.js`.
//
// Обе модели живут в репозитории файлами и загружаются с нашего же сервера — ни
// одна строчка звука и ни один запрос наружу не уходят. Обновляются скриптом
// `scripts/denoiser.py`.

import { MODEL_RATE, context, meter, resume, running, tap } from './audio.js';

/** Ниже этого уровня выход тракта считается тишиной. */
export const SILENT_OUT = 0.0004;

export const MODELS = {
  /**
   * RNNoise — та же модель, что в Mumble и Jitsi. Крошечная (150 КБ) и
   * мгновенная: отличает голос от клавиатуры, вентилятора и шелеста бумаги.
   */
  rnnoise: {
    title: 'RNNoise',
    async node(ctx) {
      const base = new URL('../vendor/rnnoise/', import.meta.url);
      const [{ RnnoiseWorkletNode, loadRnnoise }] = await Promise.all([
        import(new URL('index.js', base).href),
        ctx.audioWorklet.addModule(new URL('workletProcessor.js', base).href),
      ]);
      const wasmBinary = await loadRnnoise({
        url: new URL('rnnoise.wasm', base).href,
        simdUrl: new URL('rnnoise_simd.wasm', base).href,
      });
      // Ворклет собирает модуль внутри себя, и там отказ уже никому не виден:
      // узел в графе есть, а звука из него нет. Поэтому пробуем собрать здесь.
      await WebAssembly.compile(wasmBinary);
      return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    },
    stop(node) {
      node.destroy?.();
    },
  },

  /**
   * DeepFilterNet 3 — заметно сильнее на настоящем шуме: улица, кафе, эхо
   * комнаты. Цена — 18 МБ модели, поэтому она качается только когда её выбрали,
   * и остаётся в кэше браузера до следующего обновления.
   */
  deepfilter: {
    title: 'DeepFilterNet 3',
    // Про такую загрузку нужно сказать: 18 МБ без единого слова выглядят как
    // зависший микрофон, а не как работа.
    heavy: '18 МБ, только в первый раз',
    async node(ctx) {
      const base = new URL('../vendor/deepfilternet/', import.meta.url);
      const [wasmModule] = await Promise.all([
        compile(new URL('deepfilter.wasm', base)),
        ctx.audioWorklet.addModule(new URL('worklet.js', base).href),
      ]);
      return new AudioWorkletNode(ctx, 'voice-clarity-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { wasmModule, enabled: true },
      });
    },
    stop(node) {
      node.port.postMessage({ type: 'destroy' });
    },
  },
};

export const isModel = (kind) => kind in MODELS;
export const modelTitle = (kind) => MODELS[kind]?.title ?? kind;
/** Насколько долго ждать первого запуска — или пусто, если ждать нечего. */
export const modelWeight = (kind) => MODELS[kind]?.heavy ?? '';

/**
 * Сборка модуля на главном потоке.
 *
 * `compileStreaming` разбирает поток по мере загрузки, но требует, чтобы сервер
 * назвал файл `application/wasm`. Если он назвал его иначе, дочитываем целиком
 * и собираем из буфера — восемнадцать мегабайт того стоят.
 */
async function compile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`модель не загрузилась: ${response.status}`);
  try {
    return await WebAssembly.compileStreaming(response.clone());
  } catch {
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

/**
 * Микрофон, пропущенный через выбранную модель.
 *
 * Уровень меряется дважды — до обработки и после. Пара нужна не для красоты:
 * это единственный способ заметить, что модель поднялась, ошибок не выдала, а
 * на выходе тишина. Такое случается, и молча.
 */
export class Denoiser {
  static async create(kind, raw) {
    const model = MODELS[kind];
    if (!model) throw new Error(`нет такой модели: ${kind}`);

    const ctx = context();
    // Другой частоты модель не знает: на 44.1 она отдаёт не голос, а кашу.
    // Тракт мы просили на 48 кГц, но старые движки частоту выбирать не дают —
    // и тогда честнее отказаться, чем портить звук. Отказ уводит на подавление
    // средствами движка, и человеку об этом скажут.
    if (ctx.sampleRate !== MODEL_RATE) {
      throw new Error(`тракт на ${ctx.sampleRate} Гц, а модели нужно ${MODEL_RATE}`);
    }

    // Тракт рождается приостановленным, если родился не в ответ на касание, — а
    // микрофон включается сам при входе, после переподключения и при
    // возвращении из фона. Приостановленный контекст не падает и не жалуется,
    // он молчит: дорожка живая, присутствие говорит «микрофон включён», а звука
    // в ней нет.
    if (!(await resume())) throw new Error('звуковой тракт не запустился');

    return new Denoiser(kind, ctx, raw, await model.node(ctx));
  }

  constructor(kind, ctx, raw, node) {
    this.kind = kind;
    this.node = node;
    this.source = ctx.createMediaStreamSource(raw);
    this.out = ctx.createMediaStreamDestination();
    this.source.connect(node);
    node.connect(this.out);

    // Уровень меряем до подавления: индикатор должен показывать, что микрофон
    // вообще что-то слышит, даже когда модель признала это шумом.
    this.meter = meter(raw);

    // И то же самое после — прямо с выхода узла, а не с готового потока: так
    // замер не зависит от того, дружит ли движок с MediaStream в графе
    // обработки.
    this.probe = tap(node);
  }

  get stream() {
    return this.out.stream;
  }

  /**
   * Работает ли тракт прямо сейчас.
   *
   * Уснувший контекст ведёт себя точно как сломавшаяся модель: на входе голос,
   * на выходе ноль. Разница в том, что лечится это пробуждением, а не заменой
   * шумодава, — поэтому спрашивать надо до того, как решать, что модель мертва.
   */
  awake() {
    return running();
  }

  /** Уровень на входе — то, что слышит микрофон. */
  level() {
    return this.meter?.level() ?? 0;
  }

  /** Уровень уже подавленного звука — то, что действительно уходит собеседникам. */
  outLevel() {
    return this.probe.level();
  }

  /**
   * Разобрать граф. Контекст при этом не трогаем — он общий, и закрыть его
   * значило бы оборвать и голоса, и звук трансляции заодно с микрофоном.
   */
  close() {
    // По шагам, и каждый сам за себя: общий try обрывался на первом же узле,
    // который движок успел отцепить сам, — а остальные так и оставались висеть
    // в общем графе.
    const step = (fn) => {
      try { fn(); } catch {}
    };
    step(() => this.meter?.close());
    step(() => this.probe.close());
    step(() => this.source.disconnect());
    step(() => this.node.disconnect());
    // Дорожка выхода живёт сама по себе: пока её не остановить, она остаётся
    // «живой» и после того, как собеседникам отдали уже другую.
    step(() => this.out.stream.getTracks().forEach((t) => t.stop()));
    step(() => this.out.disconnect());
    // Модель освобождает своё последней: после этого узел уже не узел.
    step(() => MODELS[this.kind]?.stop(this.node));
  }
}
