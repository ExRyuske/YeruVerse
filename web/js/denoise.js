// Подавление шума нейросетью: две модели и общий тракт вокруг них.
//
// Модели работают строго на 48 кГц, поэтому для микрофона заводится свой
// аудиоконтекст с такой частотой: системный может оказаться 44.1 кГц.
//
// Обе живут в репозитории файлами и загружаются с нашего же сервера — ни одна
// строчка звука и ни один запрос наружу не уходят. Обновляются скриптом
// `scripts/denoiser.py`.

import { meter } from './audio.js';

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

    const ctx = new AudioContext({ sampleRate: 48000 });

    // Свой контекст рождается приостановленным, если родился не в ответ на
    // касание, — а микрофон включается сам при входе, после переподключения и
    // при возвращении из фона. Приостановленный контекст не падает и не жалуется,
    // он молчит: дорожка живая, присутствие говорит «микрофон включён», а звука
    // в ней нет. Общий контекст будят при каждом обращении, этот не будил никто.
    await ctx.resume().catch(() => {});
    if (ctx.state !== 'running') {
      ctx.close().catch(() => {});
      throw new Error('аудиоконтекст не запустился');
    }

    try {
      return new Denoiser(kind, ctx, raw, await model.node(ctx));
    } catch (e) {
      ctx.close().catch(() => {});
      throw e;
    }
  }

  constructor(kind, ctx, raw, node) {
    this.kind = kind;
    this.ctx = ctx;
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
    this.tap = ctx.createAnalyser();
    this.tap.fftSize = 512;
    node.connect(this.tap);
    this._buf = new Float32Array(this.tap.fftSize);
  }

  get stream() {
    return this.out.stream;
  }

  /** Уровень на входе — то, что слышит микрофон. */
  level() {
    return this.meter?.level() ?? 0;
  }

  /** Уровень уже подавленного звука — то, что действительно уходит собеседникам. */
  outLevel() {
    this.tap.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (const v of this._buf) sum += v * v;
    return Math.sqrt(sum / this._buf.length);
  }

  close() {
    try {
      MODELS[this.kind]?.stop(this.node);
      this.meter?.close();
      this.source.disconnect();
      this.node.disconnect();
      this.ctx.close();
    } catch {}
  }
}
