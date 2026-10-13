// Тонкий транспорт до сервера: вход в комнату, чат, карточки файлов и транзит
// WebRTC-сигналинга. Всё остальное идёт мимо него, напрямую между участниками.

import { Emitter } from './events.js';

export class Net extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.base = location.origin;   // в десктопе указывает на выбранный сервер
    this.selfId = null;
    this.room = null;
    this.rtt = Infinity;
    this._samples = [];
    this._queue = [];
    this._closedByUs = false;
    this._retry = 0;
    // Прежний id и ключ к нему из `welcome`: с ними после обрыва сервер
    // возвращает нас тем же участником, и звонки с комнатой не рвутся.
    this._ticket = null;
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect({ base, room, name, color }) {
    if (base) this.base = base;
    this.room = room;
    this._creds = { room, name, color };
    this._open();
  }

  _open() {
    // Старый сокет мог остаться в CONNECTING и позже дёрнуть onclose — тогда
    // рядом жили бы два соединения, и комната видела бы вход-выход по кругу.
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;
    const alive = () => this.ws === ws;   // события мёртвых сокетов игнорируем

    ws.onopen = () => {
      if (!alive()) return ws.close();
      this._retry = 0;
      this.send({ t: 'join', ...this._creds, ...this._ticket });
      this._pingTimer = setInterval(() => this._ping(), 5000);
      this._ping();
      // В очереди лежит только то, что обрыв пережить обязано, — см. `HOLD`.
      for (const m of this._queue.splice(0)) this.send(m);
    };

    ws.onmessage = (e) => {
      if (!alive()) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'pong') return this._onPong(msg);
      if (msg.t === 'welcome') {
        this.selfId = msg.you.id;
        this._ticket = { id: msg.you.id, key: msg.key };
      }
      this.emit(msg.t, msg);
    };

    ws.onclose = () => {
      if (!alive()) return;
      this.ws = null;
      clearInterval(this._pingTimer);
      this.emit('status', { online: false });
      if (this._closedByUs) return;
      // Экспоненциальный бэкофф: мобильные сети любят рвать сокеты. Потолок
      // невысокий: место в комнате сервер держит за нами полминуты (`GRACE_MS`
      // в `hub.rs`), и попыток вернуться в этот срок должно быть несколько.
      const wait = Math.min(1000 * 2 ** this._retry++, 5000);
      this._retryTimer = setTimeout(() => this._open(), wait);
    };

    ws.onerror = () => alive() && ws.close();
  }

  /**
   * Разбудить соединение немедленно.
   *
   * Android усыпляет вебвью свёрнутого приложения: сокет умирает, а очередь
   * повторов к моменту возвращения успевает дорасти до пятнадцати секунд —
   * человек смотрит на «переподключение» вместо комнаты. Возвращаться нужно
   * сразу, поэтому счётчик попыток обнуляется и таймер не ждёт своей очереди.
   */
  wake() {
    if (this._closedByUs || this.connected) return;
    clearTimeout(this._retryTimer);
    this._retry = 0;
    this._open();
  }

  /** WebSocket-адрес того же сервера, что отдаёт /config.json. */
  wsUrl() {
    const u = new URL(this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  _ping() {
    this.send({ t: 'ping', at: Date.now() });
  }

  _onPong({ at }) {
    this._samples.push(Date.now() - at);
    if (this._samples.length > 12) this._samples.shift();
    // Показываем наименьший из последних замеров: он меньше всех искажён
    // джиттером, а скачущее вдвое число в подсказке ни о чём не говорит.
    this.rtt = Math.min(...this._samples);
    this.emit('status', { online: true, rtt: this.rtt });
  }

  /**
   * Что имеет смысл придержать до возвращения, а что нет.
   *
   * Строку чата, карточку файла, новое имя — придержать: человек сделал это,
   * ничего не зная про обрыв, и терять его работу не за что.
   *
   * Остальное привязано к сессии и копить его незачем. Замер задержки мерить
   * нечем; присутствие комната объявляет заново сама, обработчиком `welcome`.
   * Сигналинг WebRTC восстанавливается без очереди: предложение без ответа
   * повторяется, пока на него не ответят (`Conn._chase`), и несёт в себе уже
   * собранных кандидатов. А если вернуться тем же участником не вышло, он и
   * вовсе адресован соединениям, которые пересобираются с нуля (`Mesh.sync`).
   *
   * Копить их не просто незачем, а вредно. Очередь уходит одним всплеском сразу
   * за `join` — то есть до `welcome`, до `announceShares` и до всего, что мы про
   * себя рассказываем. Сервер отвечает на неё рассылкой присутствия, собранного
   * из карточки, где трансляция ещё не объявлена, — и комната узнаёт про нас
   * «трансляции нет» ровно в тот момент, когда она идёт. Заодно очередь за
   * долгий обрыв дорастает до сотен кандидатов и съедает счётчик сообщений на
   * сервере — тот самый, из-за которого потом теряется что-нибудь нужное.
   */
  static HOLD = new Set(['chat', 'file', 'profile']);

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
    else if (Net.HOLD.has(obj.t)) this._queue.push(obj);
  }

  signal(to, data) { this.send({ t: 'signal', to, data }); }
  chat(text) { this.send({ t: 'chat', text }); }
  profile(name, color) { this.send({ t: 'profile', name, color }); }

  close() {
    this._closedByUs = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._retryTimer);
    this._queue.length = 0;
    // Уходим сами — говорим об этом прямо. Молча закрытый сокет сервер
    // считает обрывом и держит место, ожидая возвращения.
    this.send({ t: 'leave' });
    const ws = this.ws;
    this.ws = null;          // с этого момента его события уже никого не волнуют
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }

  /** Полный сброс, чтобы после отказа можно было войти заново с другим ключом. */
  reset() {
    this.close();
    this._closedByUs = false;
    this._retry = 0;
    this.selfId = null;
    this._ticket = null;
  }
}
