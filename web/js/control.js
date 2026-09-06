// Управление чужим рабочим столом поверх демонстрации экрана.
//
// Ничего ставить не нужно: зритель сидит в браузере, смотрит трансляцию и
// тыкает в неё. Синтезировать ввод в чужой системе страница не имеет права,
// поэтому принимающая сторона — всегда десктопное приложение; отправлять может
// кто угодно, включая телефон.
//
// Это путь для простых дел: нажать кнопку в чужом окне, напечатать строку,
// прокрутить страницу. Для игр — захвата полноэкранного режима, мыши без
// ускорения, виртуального геймпада — этого мало, и притворяться тут нечем:
// такой режим ещё предстоит написать своими руками, внутри приложения.
//
// События идут по WebRTC напрямую хосту, сервер их не видит. Доступ выдаётся
// поимённо: замок возле ника открывает хозяин компьютера.
//
// Разрешение и удержание — разные вещи, и вторая живёт по времени. Открытый
// замок держится, пока его не закроют, а вот управление принимается ровно
// столько, сколько зритель подтверждает, что он у экрана: свёрнутое окно
// перестаёт это делать само собой (см. `takers`).

import { Emitter } from './events.js';
import { reason } from './errors.js';

const NS = 'rc';
const MOVE_MS = 30;      // 33 движения в секунду — глазу хватает

/**
 * Как часто зритель подтверждает хозяину, что управление всё ещё у него.
 *
 * Само по себе движение мыши таким подтверждением быть не может: человек
 * читает открывшееся окно и не шевелит ничем по полминуты — это не повод
 * отбирать у него управление. А вот страница, которую свернули, замолкает
 * целиком: браузер душит таймеры в скрытой вкладке, система усыпляет свёрнутое
 * окно, и биение прекращается само, без всякого нашего участия.
 */
const ALIVE_MS = 2000;

/** Сколько ждать подтверждения, прежде чем запереть управление. */
const HOLD_MS = 6000;

export class RemoteControl extends Emitter {
  constructor(mesh, native) {
    super();
    this.mesh = mesh;
    this.native = native;
    this.granted = new Set();     // кому я разрешил управлять собой
    this.myGrants = new Set();    // кто разрешил управлять собой мне
    // Открытый замок — это разрешение, а не приказ. Пока зритель не взял
    // управление сам, его мышь над трансляцией остаётся указкой: иначе первое
    // же движение начинало возить курсор по чужому столу.
    this.taking = false;
    this.screen = null;           // размер экрана хоста в пикселях
    this._lastMove = 0;
    // Кто держит управление мной прямо сейчас: id -> когда мы слышали его в
    // последний раз. Разрешение живёт в `granted` и переживает что угодно, а
    // это — про «человек у экрана сию секунду».
    this.takers = new Map();
    this._watchdog = null;        // сторож, запирающий управление за молчание
    this._heart = null;           // наше биение, пока управляем мы сами

    mesh.on('message', ({ id, msg }) => msg?.ns === NS && this._onMessage(id, msg));
    mesh.on('peer-close', ({ id }) => {
      // Ушедший мог держать клавишу или кнопку мыши — снимаем всё, иначе хост
      // останется с намертво нажатой клавишей.
      this._release(id, 'gone');
      if (this.granted.delete(id)) {
        this.native.releaseInput?.().catch(() => {});
        // И закрываем приём, когда ушёл последний, кому было разрешено, — ровно
        // как при снятии замка руками. Иначе система оставалась готовой принять
        // чужой ввод до конца разговора: отдавать его было уже некому, но дверь
        // так и стояла открытой, а закрыть её человек не мог — замок в списке
        // участников исчез вместе с ушедшим.
        if (!this.granted.size) this.native.setControl?.(false).catch(() => {});
      }
      this.myGrants.delete(id);
      this.emit('change', {});
    });
  }

  // ---------------------------------------------------------------- хост

  /** Разрешить или забрать управление. Вызывается вместе с выдачей замка. */
  async grant(id, on) {
    if (!on) {
      this.granted.delete(id);
      this._release(id, 'revoked');
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
      this._release(id, 'revoked');
      this.mesh.send(id, { ns: NS, type: 'grant', on: false });
    }
    if (this.native.available) await this.native.setControl(false).catch(() => {});
    this.emit('change', {});
  }

  /**
   * Держит ли этот человек управление прямо сейчас.
   *
   * Открытый замок — ещё не управление: зритель должен взять его сам и
   * подтверждать, что он у экрана. Перестал подтверждать — его ввод больше не
   * применяется, пока он не возьмёт управление заново.
   */
  holding(id) {
    const at = this.takers.get(id);
    return !!at && Date.now() - at <= HOLD_MS;
  }

  /** Зритель взял управление. Дальше он обязан подтверждать, что он у экрана. */
  _hold(id) {
    if (!this.granted.has(id) || this.takers.has(id)) return;
    this.takers.set(id, Date.now());
    this._guard();
    this.emit('taken', { id });
    this.emit('change', {});
  }

  /**
   * Биение от того, кто уже держит управление.
   *
   * Заново открыть замок оно не может, и это важнее, чем кажется: страница,
   * которую усыпили, продолжает бить — раз в минуту вместо двух раз в секунду.
   * Пускай бы такое биение возвращало управление, и оно бы мигало: минуту
   * заперто, шесть секунд открыто, и так до бесконечности.
   */
  _touch(id) {
    if (this.takers.has(id)) this.takers.set(id, Date.now());
  }

  /**
   * Запереть управление: зритель отдал его сам, ушёл или свернул окно.
   *
   * Отпускаем за него зажатое — он мог замереть с нажатой клавишей, и снять её
   * больше некому: своих сообщений от него уже не придёт.
   */
  _release(id, why = null) {
    if (!this.takers.delete(id)) return;
    this.native.releaseInput?.().catch(() => {});
    // Решили за зрителя — значит, ему об этом и сказать: у себя он до сих пор
    // считает, что управляет, и продолжает возить мышью по чужому экрану
    // впустую. Об остальных причинах он знает и без нас: их он и придумал.
    if (why === 'silent') this.mesh.send(id, { ns: NS, type: 'locked', why });
    this.emit('locked', { id, why });
    this.emit('change', {});
  }

  /**
   * Сторож молчания. Живёт, только пока есть кого сторожить: без управляющих
   * это был бы таймер, который просыпается до конца разговора просто так.
   */
  _guard() {
    if (this._watchdog) return;
    this._watchdog = setInterval(() => {
      for (const [id, at] of [...this.takers]) {
        if (Date.now() - at > HOLD_MS) this._release(id, 'silent');
      }
      if (this.takers.size) return;
      clearInterval(this._watchdog);
      this._watchdog = null;
    }, 1000);
  }

  // ---------------------------------------------------------------- зритель

  /** Есть ли что брать: хозяин открыл замок, и его экран сейчас на сцене. */
  get canTake() {
    return this.target ? this.myGrants.has(this.target) : false;
  }

  /** Управляю ли я прямо сейчас. */
  get controlling() {
    return this.taking && this.canTake;
  }

  /**
   * Взять управление или вернуть его хозяину. Решение зрителя.
   *
   * `why` уходит хозяину вместе с отказом: «отдал сам» и «свернул окно» — два
   * разных события, и на чужом компьютере они выглядели одинаково только
   * потому, что о втором до сих пор никто не рассказывал.
   */
  setTaking(on, why = null) {
    if (this.taking === on) return;
    // Отпускаем зажатое, пока ещё управляем: после снятия флага сообщение уже
    // не уйдёт, и на чужом компьютере осталась бы нажатая клавиша.
    if (!on) this.sendRelease();
    this.taking = on;
    if (this.target) this.mesh.send(this.target, { ns: NS, type: 'take', on, why });
    this._beat(on);
    this.emit('change', {});
  }

  /**
   * Биение, пока управляем: «я здесь, окно открыто».
   *
   * Хозяину этого не выяснить никак иначе. Свёрнутое окно продолжает держать
   * соединение и остаётся в комнате — молчит только страница, и без биения её
   * молчание неотличимо от «сижу и смотрю, не трогая мышь».
   */
  _beat(on) {
    clearInterval(this._heart);
    this._heart = null;
    if (!on) return;
    this._heart = setInterval(() => {
      if (this.controlling) this.mesh.send(this.target, { ns: NS, type: 'alive' });
    }, ALIVE_MS);
  }

  /**
   * Чей экран на сцене. Ввод уходит только его владельцу: координаты посчитаны
   * по его кадру и для чужого экрана бессмысленны.
   */
  set target(id) {
    const next = id ?? null;
    // Управление берут для конкретного компьютера. Перешли смотреть другую
    // трансляцию — и оно не должно перетечь туда само, даже если тот участник
    // тоже открыл замок. Отдаём его прежнему хозяину той же дорогой, что и по
    // нажатию кнопки: иначе он так и считал бы, что управление у зрителя.
    if (this._target && this._target !== next) this.setTaking(false, 'switched');
    this._target = next;
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
      else {
        this.myGrants.delete(from);
        // Замок закрыли — взятое управление кончилось вместе с ним, и хозяин
        // уже про него забыл. Держать флаг взятия дальше значило бы вернуть
        // управление само собой, стоит ему открыть замок снова.
        if (from === this.target) this.setTaking(false, 'revoked');
      }
      this.emit('granted-to-me', { from, on: msg.on });
      this.emit('change', {});
      return;
    }

    // Хозяин запер управление сам: наша страница молчала слишком долго. У себя
    // мы до сих пор считаем, что управляем, — снимаем флаг, иначе кнопка будет
    // врать, а мышь ходить вхолостую.
    if (msg.type === 'locked') {
      if (from === this.target && this.taking) this.setTaking(false, 'locked');
      this.emit('lost', { from, why: msg.why ?? null });
      return;
    }

    // Зритель взял управление или вернул его. Разрешение при этом не меняется:
    // замок остаётся открытым, и взять управление снова можно тем же нажатием.
    if (msg.type === 'take') {
      if (msg.on) this._hold(from);
      else this._release(from, msg.why ?? 'given');
      return;
    }
    // Биение: подтверждение, что зритель всё ещё у экрана.
    if (msg.type === 'alive') return void this._touch(from);

    // Дальше — чужой ввод. Принимаем только от того, кому сами разрешили и кто
    // прямо сейчас держит управление.
    //
    // Отпускание зажатого — исключение: это не ввод, а его откат, и приходит
    // оно как раз в тот миг, когда зритель уходит. Отбросив его вместе с
    // остальным, мы оставили бы на своём компьютере нажатую клавишу.
    if (!this.granted.has(from) || !this.native.caps.remoteControl) return;
    if (msg.type !== 'release' && !this.holding(from)) return;

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
      this.emit('error', { message: reason(e) });
    }
  }
}
