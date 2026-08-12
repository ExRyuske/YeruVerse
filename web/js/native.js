// Мост к десктопной оболочке. В браузере всё вырождается в «недоступно», и
// приложение работает ровно как раньше — ни одна ветка кода не ломается.

const bridge = window.__TAURI__?.core ?? null;

export const native = {
  available: !!bridge,
  /** Что умеет текущая сборка. До load() — консервативные значения. */
  caps: {
    platform: 'web',
    overlay: false,
    globalHotkeys: false,
    remoteControl: false,
    updates: false,
  },
  /** Почему мост не ответил. Показывается в диагностике, а не глотается. */
  error: null,

  /**
   * Спрашиваем оболочку о её возможностях. На удалённой странице мост
   * поднимается не мгновенно, поэтому пробуем несколько раз, а причину отказа
   * запоминаем: «управление недоступно» без объяснения отлаживать невозможно.
   */
  async load(attempts = 3) {
    if (!bridge) return this.caps;
    for (let i = 0; i < attempts; i++) {
      try {
        this.caps = await this.invoke('capabilities');
        this.error = null;
        return this.caps;
      } catch (e) {
        this.error = String(e?.message ?? e);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    console.warn('YeruVerse: нативный мост не отвечает —', this.error);
    return this.caps;
  },

  async invoke(cmd, args = {}) {
    if (!bridge) throw new Error('нативный слой недоступен');
    return bridge.invoke(cmd, args);
  },

  /** Адрес сервера, на который смотрит окно приложения. */
  currentServer() { return this.invoke('current_server'); },
  /** Сменить сервер: окно уйдёт на новый адрес и перезагрузится. */
  setServer(url) { return this.invoke('set_server', { url }); },

  /** Системные сочетания: работают, даже когда окно свёрнуто. */
  setHotkeys(hotkeys) { return this.invoke('set_hotkeys', { hotkeys }); },
  /** Подписка на системное сочетание: `{ id, down }` — нажали или отпустили. */
  onHotkey(fn) {
    return window.__TAURI__?.event?.listen('hotkey', (e) => fn(e.payload)) ?? Promise.resolve();
  },

  /** Прозрачное окно с курсорами поверх всех приложений. */
  setOverlay(enabled) { return this.invoke('overlay', { enabled }); },

  /** Полный экран окном приложения: в Android-вебвью только так и работает. */
  setFullscreen(on) { return this.invoke('set_fullscreen', { on }); },
  /** Событие в окно оверлея: позиция курсора или щелчок. */
  cursor(payload) {
    return window.__TAURI__?.event?.emit('cursor', payload) ?? Promise.resolve();
  },

  /** Sunshine: `{ running, address, canPair }`. */
  sunshine() { return this.invoke('sunshine'); },
  /** Доступ к веб-панели Sunshine — нужен, чтобы подтверждать PIN за человека. */
  sunshineCreds(user, password) {
    return this.invoke('sunshine_creds', { user, password });
  },
  /** Отдать PIN своему Sunshine: сопряжение проходит без ручного ввода. */
  sunshinePin(pin) { return this.invoke('sunshine_pin', { pin }); },

  /** Приём чужого ввода. Возвращает размер экрана в пикселях. */
  setControl(enabled) { return this.invoke('set_control', { enabled }); },
  /** Перехватить управление у гостя: его ввод перестаёт применяться. */
  inputPause(paused) { return this.invoke('input_pause', { paused }); },
  moveMouse(x, y) { return this.invoke('input_move', { x, y }); },
  button(button, down) { return this.invoke('input_button', { button, down }); },
  scroll(dx, dy) { return this.invoke('input_scroll', { dx, dy }); },
  key(code, text, down) {
    return this.invoke('input_key', { code: code ?? null, text: text ?? null, down });
  },
  releaseInput() { return this.invoke('input_release'); },

  /**
   * Открыть ссылку системой. Для `moonlight://` иначе никак: окно чужую схему
   * игнорирует, и снаружи это выглядит как «Moonlight не открывается».
   */
  openUrl(url) { return this.invoke('open_url', { url }); },

  /**
   * Запустить Moonlight: `pair` — знакомство с компьютером и PIN, `stream` —
   * сразу рабочий стол. Схемы `moonlight://` в системе не существует, поэтому
   * зовётся сам исполняемый файл.
   */
  moonlight(host, action, pin) {
    return this.invoke('moonlight', { host, action, pin: pin ?? null });
  },

  /** Номер новой версии или null. */
  updateCheck() { return this.invoke('update_check'); },
  /** Скачать, поставить и перезапуститься. Обратно эта команда не возвращается. */
  updateInstall() { return this.invoke('update_install'); },
};
