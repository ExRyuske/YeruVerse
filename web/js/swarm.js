// Раздача файлов роем: каждый скачавший кусок сразу становится его источником
// для остальных. Сервер в передаче байтов не участвует.
//
// Передач может идти несколько одновременно — видео комнаты и вложения в чате
// живут в одном рое и различаются идентификатором файла.

import { Emitter } from './events.js';

const NS = 'swarm';
const CHUNK = 64 * 1024;      // помещается в дефолтный лимит DataChannel
const MIN_CHUNK = 4 * 1024;   // меньше — и число кусков перестаёт быть конечным
/**
 * Предел на файл. Держит его память браузера: рой собирает куски в куче, и
 * больше двух гигабайт вкладка просто не переживёт.
 *
 * Отсюда же его берёт `sendFile` в `chat.js` — раньше там стояло то же число
 * вторым литералом, и разъехаться им было нечем, кроме внимательности. Тот же
 * предел стоит и на сервере (`MAX_FILE` в `src/server.rs`): проверку делают оба
 * конца, потому что сервер бывает чужим ровно так же, как участник.
 */
export const MAX_SIZE = 2 * 1024 ** 3;
const MAX_INFLIGHT = 8;       // одновременных запросов к одному пиру
const REQ_TIMEOUT = 15000;

/**
 * Похожа ли карточка файла на карточку файла.
 *
 * Карточка приходит от чужого клиента через сервер, а получатель разворачивает
 * по ней массив кусков и битовое поле на каждый — то есть чужое число прямо
 * решает, сколько выделить памяти. Карточка с картинкой при этом качается сама,
 * не спрашивая (см. `addAttachment` в `chat.js`), так что одного числа
 * достаточно, чтобы уложить вкладку любому, кто просто сидит в комнате.
 *
 * Поэтому число кусков не ограничивается сверху отдельным пределом, а
 * сверяется с размером и длиной куска: они связаны, и любая пара, которая не
 * сходится, — заведомо не то, что мог прислать наш же `offer`. Нижний предел
 * длины куска здесь такой же важный, как верхний: без него два гигабайта
 * кусками по байту дают два миллиарда кусков, и все пределы обходятся честной
 * арифметикой.
 *
 * Ту же проверку делает сервер (`sane_file_meta` в `src/server.rs`). Дважды —
 * потому что сервер может оказаться чужим ровно так же, как участник.
 */
export function sane(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const str = (v, max) => typeof v === 'string' && !!v.length && v.length <= max;
  const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  return (
    str(meta.id, 64) &&
    str(meta.name, 260) &&
    str(meta.mime, 128) &&
    int(meta.size, 1, MAX_SIZE) &&
    int(meta.chunkSize, MIN_CHUNK, CHUNK) &&
    meta.chunks === Math.ceil(meta.size / meta.chunkSize)
  );
}

const byteLen = (n) => Math.ceil(n / 8);
const hasBit = (bits, i) => (bits[i >> 3] >> (i & 7)) & 1;
const setBit = (bits, i) => { bits[i >> 3] |= 1 << (i & 7); };
const clearBit = (bits, i) => { bits[i >> 3] &= ~(1 << (i & 7)); };

function toB64(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/** Одна передача: либо мы раздаём готовый файл, либо собираем его по кускам. */
class Transfer {
  constructor(meta, file) {
    this.meta = meta;
    this.file = file ?? null;                       // есть — значит раздаём
    this.chunks = file ? null : new Array(meta.chunks).fill(null);
    this.bits = new Uint8Array(byteLen(meta.chunks));
    this.have = 0;
    this.peerBits = new Map();                      // id пира -> его битовое поле
    this.inflight = new Map();                      // индекс -> { id, ts }
    this.serving = new Map();                       // id пира -> очередь индексов
    this.blobUrl = null;

    if (file) {
      this.bits.fill(0xff);
      this.have = meta.chunks;
      this.blobUrl = URL.createObjectURL(file);
    }
  }

  get done() { return this.have >= this.meta.chunks; }
  get progress() { return this.have / this.meta.chunks; }

  destroy() {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.chunks = null;
  }
}

export class Swarm extends Emitter {
  constructor(mesh) {
    super();
    this.mesh = mesh;
    this.transfers = new Map();   // id файла -> Transfer
    this._draining = new Set();

    mesh.on('message', ({ id, msg }) => msg?.ns === NS && this._onMsg(id, msg));
    mesh.on('binary', ({ id, buf }) => this._onChunk(id, buf));
    mesh.on('peer-open', ({ id }) => this._announceAll(id));
    mesh.on('peer-close', ({ id }) => {
      for (const t of this.transfers.values()) {
        t.peerBits.delete(id);
        t.serving.delete(id);
        for (const [i, f] of t.inflight) if (f.id === id) t.inflight.delete(i);
      }
      this._pumpAll();
    });

    // Подбираем куски, чьи запросы протухли или чьи владельцы только появились.
    // Когда передач нет — а это обычное состояние комнаты — таймер ничего не
    // делает и не будит вкладку.
    setInterval(() => this.transfers.size && this._pumpAll(), 3000);
  }

  get(id) { return this.transfers.get(id) ?? null; }

  /** Объявить свой файл. Возвращает описание для рассылки остальным. */
  offer(file) {
    const chunks = Math.max(1, Math.ceil(file.size / CHUNK));
    const meta = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      chunkSize: CHUNK,
      chunks,
    };
    this.transfers.set(meta.id, new Transfer(meta, file));
    this._announce(null, meta.id);
    return meta;
  }

  /**
   * Начать приём по описанию. Повторный вызов для того же файла безопасен.
   * Непроверенное описание не начинает ничего и возвращает `null`.
   */
  start(meta) {
    if (!sane(meta)) return null;
    let t = this.transfers.get(meta.id);
    if (!t) {
      t = new Transfer(meta, null);
      this.transfers.set(meta.id, t);
      this._announce(null, meta.id);
    }
    this._pump(t);
    return t;
  }

  drop(id) {
    this.transfers.get(id)?.destroy();
    this.transfers.delete(id);
  }

  clear() {
    for (const id of [...this.transfers.keys()]) this.drop(id);
  }

  // ---------------------------------------------------------------- обмен

  _announceAll(peer) {
    for (const id of this.transfers.keys()) this._announce(peer, id);
  }

  _announce(peer, id, wantBf = true) {
    const t = this.transfers.get(id);
    if (!t) return;
    const msg = { ns: NS, type: 'bf', fileId: id, bits: toB64(t.bits), wantBf };
    if (peer) this.mesh.send(peer, msg);
    else this.mesh.broadcast(msg);
  }

  _onMsg(peer, msg) {
    const t = this.transfers.get(msg.fileId);
    if (!t) return;   // про этот файл мы ещё не знаем — узнаем из комнаты

    switch (msg.type) {
      case 'bf':
        t.peerBits.set(peer, fromB64(msg.bits));
        // Отвечаем своим битовым полем ровно один раз — иначе обмен зациклится.
        if (msg.wantBf) this._announce(peer, msg.fileId, false);
        this._pump(t);
        break;

      case 'have': {
        const bits = t.peerBits.get(peer);
        if (bits) { setBit(bits, msg.i); this._pump(t); }
        break;
      }

      case 'req':
        this._enqueueServe(peer, t, msg.i);
        break;

      case 'nope': {
        t.inflight.delete(msg.i);
        const bits = t.peerBits.get(peer);
        if (bits) clearBit(bits, msg.i);
        this._pump(t);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- отдача

  _enqueueServe(peer, t, i) {
    if (!hasBit(t.bits, i)) {
      this.mesh.send(peer, { ns: NS, type: 'nope', fileId: t.meta.id, i });
      return;
    }
    const key = `${t.meta.id}|${peer}`;
    const q = t.serving.get(peer) ?? [];
    if (q.length > 64) return;      // защита от жадного пира
    q.push(i);
    t.serving.set(peer, q);
    this._drain(key, peer, t);
  }

  async _drain(key, peer, t) {
    if (this._draining.has(key)) return;
    this._draining.add(key);
    try {
      // Очередь спрашиваем у карты на каждом обороте, а не держим ссылку на
      // сам массив, и заодно сверяемся, что передача ещё жива.
      //
      // Ссылка была прямой дорогой к вечному циклу. Ушедшему участнику
      // `peer-close` очередь удаляет — но удаление касается записи в карте, а
      // не массива: тот оставался прежним и непустым. Отправка же на закрытом
      // соединении отвечает отказом всегда, и раздача уходила в холостой
      // круг по шестьдесят миллисекунд — навсегда, по одному кругу на каждую
      // пару «файл и отвалившийся участник», удерживая за собой всю передачу.
      let q;
      while ((q = t.serving.get(peer))?.length && this.transfers.get(t.meta.id) === t) {
        const i = q[0];
        const body = await this._read(t, i);
        if (!body) { q.shift(); continue; }

        const id = new TextEncoder().encode(t.meta.id);
        const out = new Uint8Array(5 + id.length + body.byteLength);
        const view = new DataView(out.buffer);
        view.setUint32(0, i, true);
        view.setUint8(4, id.length);
        out.set(id, 5);
        out.set(new Uint8Array(body), 5 + id.length);

        if (!this.mesh.sendBinary(peer, out.buffer)) {
          // Отказ бывает по двум причинам, и ждать стоит только одной из них:
          // забитый буфер рассосётся, а закрытый канал — нет.
          if (!this.mesh.isOpen(peer)) break;
          await new Promise((r) => setTimeout(r, 60));   // буфер забит — ждём
          continue;
        }
        q.shift();
      }
    } finally {
      this._draining.delete(key);
    }
  }

  async _read(t, i) {
    if (t.file) {
      const start = i * t.meta.chunkSize;
      return t.file.slice(start, Math.min(start + t.meta.chunkSize, t.meta.size)).arrayBuffer();
    }
    return t.chunks?.[i] ?? null;
  }

  // ---------------------------------------------------------------- закачка

  _pumpAll() {
    for (const t of this.transfers.values()) this._pump(t);
  }

  _pump(t) {
    if (t.file || !t.chunks) return;

    const now = Date.now();
    for (const [i, f] of t.inflight) {
      if (now - f.ts > REQ_TIMEOUT) t.inflight.delete(i);
    }

    const load = new Map();
    for (const f of t.inflight.values()) load.set(f.id, (load.get(f.id) ?? 0) + 1);

    for (let i = 0; i < t.meta.chunks; i++) {
      if (hasBit(t.bits, i) || t.inflight.has(i)) continue;

      // Из владельцев куска выбираем наименее загруженного — так рой сам
      // балансируется без координатора.
      let best = null;
      let bestLoad = MAX_INFLIGHT;
      for (const [id, bits] of t.peerBits) {
        if (!hasBit(bits, i) || !this.mesh.isOpen(id)) continue;
        const l = load.get(id) ?? 0;
        if (l < bestLoad) { best = id; bestLoad = l; }
      }
      if (!best) continue;

      t.inflight.set(i, { id: best, ts: now });
      load.set(best, bestLoad + 1);
      this.mesh.send(best, { ns: NS, type: 'req', fileId: t.meta.id, i });
    }
  }

  _onChunk(peer, buf) {
    if (buf.byteLength < 5) return;
    const view = new DataView(buf);
    const i = view.getUint32(0, true);
    const idLen = view.getUint8(4);
    // Длина имени приехала в том же кадре, что и сам кадр, и пока она с ним не
    // сверена — это просто чужое число: `Uint8Array` по нему не прочитает, а
    // бросит, и кусок потеряется молча, до следующего запроса по таймауту.
    if (5 + idLen > buf.byteLength) return;
    const id = new TextDecoder().decode(new Uint8Array(buf, 5, idLen));

    const t = this.transfers.get(id);
    if (!t || !t.chunks || i >= t.meta.chunks || hasBit(t.bits, i)) return;

    // Кусок должен быть ровно той длины, которую обещала карточка: последний
    // короче, остальные во всю. Иначе один пир, отдав вместо куска сколько ему
    // вздумается, набивает чужую память мимо всех пределов, а собранный файл
    // не имеет никакого отношения к размеру, который человек видел в чате.
    const want = Math.min(t.meta.chunkSize, t.meta.size - i * t.meta.chunkSize);
    if (buf.byteLength - 5 - idLen !== want) return;

    t.chunks[i] = buf.slice(5 + idLen);
    setBit(t.bits, i);
    t.have++;
    t.inflight.delete(i);

    this.mesh.broadcast({ ns: NS, type: 'have', fileId: id, i });
    this.emit('progress', { id, have: t.have, total: t.meta.chunks, sources: t.peerBits.size });

    if (t.done) this._finish(t);
    else this._pump(t);
  }

  _finish(t) {
    const blob = new Blob(t.chunks, { type: t.meta.mime });
    t.blobUrl = URL.createObjectURL(blob);
    // Куски больше не нужны в JS-куче: дальше отдаём срезами из Blob.
    t.file = new File([blob], t.meta.name, { type: t.meta.mime });
    t.chunks = null;
    this.emit('ready', { id: t.meta.id, url: t.blobUrl, meta: t.meta });
  }
}
