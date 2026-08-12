// Общие указатели поверх видео: каждый видит курсоры остальных с ником и его
// цветом, а клик оставляет пульсирующую метку. Для демонстрации экрана это
// способ «потыкать» хосту: инжектировать ввод в чужую ОС браузер не умеет,
// но показать, куда нажать, — вполне.
//
// Координаты нормализованы к прямоугольнику самого кадра, а не элемента:
// у всех разные окна, и без этого метка уезжала бы в чёрные поля.

const SEND_MS = 40;        // 25 обновлений в секунду
const STALE_MS = 4000;     // курсор без движения гаснет
const NS = 'ptr';

export class Pointers {
  constructor(mesh, stage) {
    this.mesh = mesh;
    this.stage = stage;
    // Чужие курсоры видны всегда: смысл указки в том, чтобы её не искать, и
    // выключателя у неё нет — транслирующий иначе не увидел бы никого, пока
    // каждый зритель не догадается включить показ у себя.
    this.sharePointer = false;
    this.peerOf = () => null;
    this.onRemote = null;   // чужой курсор: нужен оверлею поверх всех окон
    // Хуки простого управления чужим столом; в браузере без разрешения молчат.
    this.onMove = null;
    this.onButton = null;
    this.onScroll = null;
    this.grabInput = false;   // гасить контекстное меню, пока управляем
    this._down = new Set();
    // Что сейчас на сцене. Курсоры показываем только тем, кто смотрит то же
    // самое: иначе при двух трансляциях метки перемешаются.
    this.context = null;
    this.cursors = new Map();   // peerId -> узел курсора в окне приложения
    // Когда от участника последний раз что-то приходило. Отдельно от `cursors`:
    // курсор может жить на слое поверх других окон, не имея узла в приложении,
    // и без этой отметки он либо висел бы вечно, либо пропадал, стоит человеку
    // перестать шевелить мышью.
    this.seen = new Map();
    this._last = 0;

    const layer = document.createElement('div');
    layer.className = 'ptr-layer';
    stage.appendChild(layer);
    this.layer = layer;

    // Слушаем на сцене: слой прозрачен для мыши, чтобы не мешать плееру.
    stage.addEventListener('pointermove', (e) => this._local(e, 'm'));
    stage.addEventListener('pointerdown', (e) => {
      this._local(e, 'click');
      this._button(e, true);
    });
    // Отпускание ловим на окне: кнопку можно отпустить, уже уведя мышь со сцены,
    // и тогда на хосте она осталась бы зажатой.
    window.addEventListener('pointerup', (e) => this._button(e, false));
    stage.addEventListener('pointerleave', () => this._send({ type: 'out' }));
    // Знак как в DOM: вниз и вправо — положительные, инжектор понимает так же.
    stage.addEventListener('wheel', (e) => {
      if (!this.onScroll) return;
      if (this.grabInput) e.preventDefault();
      this.onScroll(Math.sign(e.deltaX), Math.sign(e.deltaY));
    }, { passive: false });
    stage.addEventListener('contextmenu', (e) => this.grabInput && e.preventDefault());

    mesh.on('message', ({ id, msg }) => msg?.ns === NS && this._remote(id, msg));
    mesh.on('peer-close', ({ id }) => this.drop(id));

    // Курсоры гаснут сами; когда их нет, и проверять нечего.
    setInterval(() => this.seen.size && this._expire(), 1000);
  }

  /** Сменилось то, что показано на сцене — чужие курсоры больше не про это. */
  setContext(context) {
    if (this.context === context) return;
    this.context = context;
    for (const id of [...this.cursors.keys()]) this._hide(id);
  }

  /** Смотрим чужую трансляцию — значит, есть куда показывать курсором. */
  setSharing(on) {
    if (this.sharePointer === on) return;
    this.sharePointer = on;
    if (!on) this._send({ type: 'out' });
  }

  /**
   * Курсор пропал совсем: участник ушёл, увёл мышь со сцены или замолчал.
   * Об этом узнают оба места показа — и окно приложения, и прозрачный слой
   * поверх других окон.
   */
  drop(id) {
    this._hide(id);
    this.seen.delete(id);
    this.onRemote?.(id, { gone: true });
  }

  /**
   * Убрать курсор только из окна приложения.
   *
   * «Показывают не на то, что у меня открыто» — это не «курсора больше нет».
   * Слой поверх других окон живёт своей жизнью: он показывает тех, кто тычет в
   * мой экран, и моя собственная сцена к этому отношения не имеет. Пока это
   * было одним действием, каждое входящее сообщение рисовало курсор на слое и
   * тут же его стирало — двадцать пять раз в секунду. Курсор мигал, а щелчки
   * оставляли за собой вереницу кругов.
   */
  _hide(id) {
    this.cursors.get(id)?.remove();
    this.cursors.delete(id);
  }

  /**
   * Прямоугольник реального кадра внутри сцены (video рисуется с
   * object-fit: contain).
   *
   * Именно прямой потомок сцены: `video` в ней теперь не один. В углу лежит
   * полоса камер, и каждая плитка — тоже `video`, причём в разметке они идут
   * раньше плеера. Простой поиск находил первую попавшуюся камеру и мерил кадр
   * по ней: координаты считались по её пропорциям, курсоры уезжали, а часть
   * сцены вовсе переставала их принимать — со стороны это выглядит как
   * подтормаживание. Развёрнутая камера лежит внутри своей обёртки и сюда тоже
   * не попадает.
   */
  _frame() {
    // Замер кэшируем на десятую долю секунды. Каждый чужой курсор двигает свой
    // узел, а следующий тут же спрашивает размеры сцены — браузер вынужден
    // пересчитывать раскладку между записью и чтением, и на нескольких курсорах
    // это заметно дёргает картинку. Раскладка меняется от разворота окна и
    // поворота телефона, а не тридцать раз в секунду, поэтому свежесть в 100 мс
    // здесь избыточна с запасом.
    const now = performance.now();
    if (this._frameAt && now - this._frameAt < 100) return this._frameCache;
    this._frameAt = now;

    const stage = this.stage.getBoundingClientRect();
    const v = this.stage.querySelector(':scope > video');
    if (v?.videoWidth && v?.videoHeight) {
      const scale = Math.min(stage.width / v.videoWidth, stage.height / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      return (this._frameCache = {
        left: stage.left + (stage.width - w) / 2,
        top: stage.top + (stage.height - h) / 2,
        width: w,
        height: h,
        stage,
      });
    }
    return (this._frameCache = {
      left: stage.left,
      top: stage.top,
      width: stage.width,
      height: stage.height,
      stage,
    });
  }

  /** Доля кадра под курсором или null, если курсор вне кадра. */
  _at(e) {
    const f = this._frame();
    if (!f.width || !f.height) return null;
    const x = (e.clientX - f.left) / f.width;
    const y = (e.clientY - f.top) / f.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;   // курсор в чёрном поле
    return { x, y };
  }

  _local(e, type) {
    if (!this.mesh.peers().length) return;
    const now = performance.now();
    if (type === 'm' && now - this._last < SEND_MS) return;
    this._last = now;

    const p = this._at(e);
    if (!p) return;

    // Свой курсор отправляем, пока смотрим чужую трансляцию; локальный показ
    // чужих меток и метка собственного клика зависят от кнопки.
    if (this.sharePointer) {
      this._send({ type, x: +p.x.toFixed(4), y: +p.y.toFixed(4), v: this.context });
      if (type === 'click') this._ping(p.x, p.y, this.peerOf('self'));
    }
    if (type === 'm') this.onMove?.(p.x, p.y);
  }

  /** Нажатие и отпускание кнопки мыши уходят отдельными событиями. */
  _button(e, down) {
    if (!this.onButton) return;
    const name = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    // Отпускание считается только для кнопки, зажатой здесь же: клик по чату не
    // должен превращаться в отпускание кнопки на чужом компьютере.
    if (down) this._down.add(name);
    else if (!this._down.delete(name)) return;
    this.onButton(name, down, this._at(e));
  }

  _send(msg) {
    this.mesh.broadcast({ ns: NS, ...msg });
  }

  _remote(id, msg) {
    if (msg.type === 'out') return this.drop(id);

    const peer = this.peerOf(id);

    // Оверлей поверх других окон получает курсоры всегда: транслирующий смотрит
    // в игру, а не в приложение, и его собственная сцена может быть занята чем
    // угодно — но зрители-то показывают именно на его экран.
    this.onRemote?.(id, msg, peer);
    this.seen.set(id, Date.now());

    // Внутри приложения рисуем только то, что показывают на текущей сцене.
    if ((msg.v ?? null) !== this.context) return this._hide(id);

    const f = this._frame();
    const left = f.left - f.stage.left + msg.x * f.width;
    const top = f.top - f.stage.top + msg.y * f.height;

    if (msg.type === 'click') this._ping(msg.x, msg.y, peer);

    let el = this.cursors.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ptr';
      el.innerHTML =
        '<svg viewBox="0 0 12 18" width="14" height="20"><path d="M1 1l10 8-4.5.6L9 15l-2 .9-2.4-5.3L1 13z"/></svg><span></span>';
      this.layer.appendChild(el);
      this.cursors.set(id, el);
    }
    el.style.setProperty('--ptr', peer?.color ?? '#5b8cff');
    el.querySelector('span').textContent = peer?.name ?? '';
    el.style.transform = `translate(${left}px, ${top}px)`;
  }

  /** Короткая пульсирующая метка в точке клика. */
  _ping(x, y, peer) {
    const f = this._frame();
    const ping = document.createElement('div');
    ping.className = 'ptr-ping';
    ping.style.setProperty('--ptr', peer?.color ?? '#5b8cff');
    ping.style.transform =
      `translate(${f.left - f.stage.left + x * f.width}px, ${f.top - f.stage.top + y * f.height}px)`;
    this.layer.appendChild(ping);
    setTimeout(() => ping.remove(), 900);
  }

  _expire() {
    const now = Date.now();
    for (const [id, at] of this.seen) {
      if (now - at > STALE_MS) this.drop(id);
    }
  }
}
