// Простое управление чужим рабочим столом поверх демонстрации экрана.
//
// Ничего ставить не нужно: зритель сидит в браузере, смотрит трансляцию и
// тыкает в неё. Синтезировать ввод в чужой системе страница не имеет права,
// поэтому принимающая сторона — всегда десктопное приложение; отправлять может
// кто угодно, включая телефон.
//
// Это путь для простых дел: нажать кнопку в чужом окне, напечатать строку,
// прокрутить страницу. Для игр он не годится и не притворяется: там нужен
// захват полноэкранного режима, мышь без ускорения и виртуальный геймпад — всё
// это умеют Sunshine с Moonlight, и вот они рядом, в том же списке участников.
//
// События идут по WebRTC напрямую хосту, сервер их не видит. Доступ выдаётся
// поимённо тем же замком, что открывает адрес Sunshine.

const NS = 'rc';
const MOVE_MS = 30;      // 33 движения в секунду — глазу хватает

export class RemoteControl extends EventTarget {
  constructor(mesh, native) {
    super();
    this.mesh = mesh;
    this.native = native;
    this.granted = new Set();     // кому я разрешил управлять собой
    this.myGrants = new Set();    // кто разрешил управлять собой мне
    this.screen = null;           // размер экрана хоста в пикселях
    this._lastMove = 0;

    mesh.on('message', ({ id, msg }) => msg?.ns === NS && this._onMessage(id, msg));
    mesh.on('peer-close', ({ id }) => {
      // Ушедший мог держать клавишу или кнопку мыши — снимаем всё, иначе хост
      // останется с намертво нажатой клавишей.
      if (this.granted.delete(id)) this.native.releaseInput?.().catch(() => {});
      this.myGrants.delete(id);
      this.emit('change', {});
    });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }

  // ---------------------------------------------------------------- хост

  /** Разрешить или забрать управление. Вызывается вместе с выдачей замка. */
  async grant(id, on) {
    if (!on) {
      this.granted.delete(id);
      await this.native.releaseInput().catch(() => {});
      if (!this.granted.size) await this.native.setControl(false).catch(() => {});
    } else {
      if (!this.native.caps.remoteControl) throw new Error('нужна настольная версия');
      // Разрешение включается в Rust: одного согласия интерфейса мало. Оттуда
      // же приходит размер экрана — вторым вызовом его можно не добирать.
      this.screen = await this.native.setControl(true);
      if (!this.screen) throw new Error('система не отдала размер экрана');
      this.granted.add(id);
    }
    this.mesh.send(id, { ns: NS, type: 'grant', on });
    this.emit('change', {});
  }

  /** Снять все разрешения — при остановке демонстрации и при выходе. */
  async revokeAll() {
    for (const id of [...this.granted]) {
      this.granted.delete(id);
      this.mesh.send(id, { ns: NS, type: 'grant', on: false });
    }
    if (this.native.available) await this.native.setControl(false).catch(() => {});
    this.emit('change', {});
  }

  // ---------------------------------------------------------------- зритель

  /** Могу ли я сейчас управлять тем, что вижу. */
  get controlling() {
    return this.target ? this.myGrants.has(this.target) : false;
  }

  /**
   * Чей экран на сцене. Ввод уходит только его владельцу: координаты посчитаны
   * по его кадру и для чужого экрана бессмысленны.
   */
  set target(id) {
    if (this._target && this._target !== id) this.sendRelease();
    this._target = id ?? null;
  }
  get target() { return this._target ?? null; }

  sendMove(x, y) {
    const now = performance.now();
    if (now - this._lastMove < MOVE_MS) return;
    this._lastMove = now;
    this._send({ type: 'move', x, y });
  }

  /** Кнопка раздельно — иначе не выделить текст и не перетащить окно. */
  sendButton(button, down, at) {
    this._send({ type: 'btn', button, down, x: at?.x, y: at?.y });
  }

  sendScroll(dx, dy) { this._send({ type: 'scroll', dx, dy }); }

  /** `code` — физическое положение клавиши, `text` — символ на ней. */
  sendKey(code, text, down) { this._send({ type: 'key', code, text, down }); }

  /** Отпустить всё зажатое: ушли из окна, потеряли фокус, лишились доступа. */
  sendRelease() { this._send({ type: 'release' }); }

  _send(msg) {
    if (this.controlling) this.mesh.send(this.target, { ns: NS, ...msg });
  }

  // ---------------------------------------------------------------- приём

  async _onMessage(from, msg) {
    if (msg.type === 'grant') {
      if (msg.on) this.myGrants.add(from);
      else this.myGrants.delete(from);
      this.emit('granted-to-me', { from, on: msg.on });
      this.emit('change', {});
      return;
    }

    // Дальше — чужой ввод. Принимаем только от того, кому сами разрешили.
    if (!this.granted.has(from) || !this.native.caps.remoteControl) return;

    const px = (x, y) =>
      this.screen ? [Math.round(x * this.screen[0]), Math.round(y * this.screen[1])] : null;

    try {
      switch (msg.type) {
        case 'move': {
          const p = px(msg.x, msg.y);
          if (p) await this.native.moveMouse(p[0], p[1]);
          break;
        }
        case 'btn': {
          const p = msg.x == null ? null : px(msg.x, msg.y);
          if (p) await this.native.moveMouse(p[0], p[1]);
          await this.native.button(msg.button ?? 'left', !!msg.down);
          break;
        }
        case 'scroll':
          await this.native.scroll(msg.dx | 0, msg.dy | 0);
          break;
        case 'key':
          await this.native.key(msg.code, msg.text, !!msg.down);
          break;
        case 'release':
          await this.native.releaseInput();
          break;
      }
    } catch (e) {
      this.emit('error', { message: String(e?.message ?? e) });
    }
  }
}
