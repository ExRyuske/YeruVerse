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
      this.send({ t: 'join', ...this._creds });
      this._pingTimer = setInterval(() => this._ping(), 5000);
      this._ping();
      // join отправлен выше; из очереди он бы ушёл повторно.
      for (const m of this._queue.splice(0)) {
        if (m.t !== 'join') this.send(m);
      }
    };

    ws.onmessage = (e) => {
      if (!alive()) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'pong') return this._onPong(msg);
      if (msg.t === 'welcome') this.selfId = msg.you.id;
      this.emit(msg.t, msg);
    };

    ws.onclose = () => {
      if (!alive()) return;
      this.ws = null;
      clearInterval(this._pingTimer);
      this.emit('status', { online: false });
      if (this._closedByUs) return;
      // Экспоненциальный бэкофф: мобильные сети любят рвать сокеты.
      const wait = Math.min(1000 * 2 ** this._retry++, 15000);
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

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
    else if (obj.t !== 'ping') this._queue.push(obj);
  }

  signal(to, data) { this.send({ t: 'signal', to, data }); }
  chat(text) { this.send({ t: 'chat', text }); }
  profile(name, color) { this.send({ t: 'profile', name, color }); }

  close() {
    this._closedByUs = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._retryTimer);
    this._queue.length = 0;
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
  }
}
