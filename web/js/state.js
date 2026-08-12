// Состояние комнаты — одно на страницу, потому что и комната одна.
//
// Здесь только данные и ни одной операции над ними: модули интерфейса читают
// отсюда то, что показывают, и меняют то, за что отвечают. Пока состояние жило
// внутри app.js, добраться до него можно было лишь через набор функций-гетраней,
// которые приходилось прокидывать в каждый модуль отдельным аргументом.

export const state = {
  self: null,
  peers: new Map(),
  peerEls: new Map(),
  player: null,
  shares: new Map(),   // 'screen' | 'cam' -> наш собственный поток
  screens: new Map(),  // 'peerId:screen' | 'peerId:cam' -> MediaStream
  view: null,          // что показано на сцене; null — ничего
  mounted: null,       // что сейчас в сцене, чтобы не пересоздавать зря
  everJoined: false,
  recentLeaves: new Map(),
  config: {},
  joined: false,
  code: '',             // единственный секрет комнаты; на сервер уходит производное
  sunshine: null,       // адрес нашего Sunshine, если он запущен
  sunshineOpen: false,  // виден ли он из интернета
  paused: false,        // мы перехватили управление у гостей
};

/**
 * Выключенные для себя трансляции: ключ вида `peer:kind`. Просьба уходит
 * владельцу, и он снимает дорожку именно с нашего соединения — экономится не
 * только процессор, но и канал.
 */
export const hidden = new Set();

/** Ключ трансляции одинаков у владельца и у зрителей — на нём сходятся курсоры. */
export const viewKey = (peer, kind) => `${peer}:${kind}`;
export const viewPeer = (key) => key?.split(':')[0] ?? null;
export const viewKind = (key) => key?.split(':')[1] ?? null;

/** Мы ли это. Проверка встречается всюду, а `state.self` может быть пустым. */
export const isSelf = (id) => !!state.self && id === state.self.id;
