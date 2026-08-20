// Список участников: кто в комнате, что у него включено и что ему разрешено.

import { control, native, settings, voice } from './core.js';
import { hidden, isSelf, state, viewKey } from './state.js';
import { painter, render } from './render.js';
import { make, markButton, ui, volumeSlider } from './ui.js';
import { setHidden } from './stage.js';
import { allowButton, canMoonlight, moonlightButton } from './sunshine.js';

painter('peers', renderPeers);

/**
 * Строки переживают перерисовку, а не создаются заново. Раньше список стирался
 * целиком на каждое изменение присутствия, и ползунок громкости исчезал прямо
 * из-под пальца — ради этого стоял флаг «сейчас тянут», который просто отменял
 * перерисовку. Список замирал: пока крутишь громкость, в нём не видно ни кто
 * вошёл, ни кто выключил микрофон.
 */
function renderPeers() {
  const list = ui('#peer-list');

  for (const [id, li] of state.peerEls) {
    if (state.peers.has(id)) continue;
    li.remove();
    state.peerEls.delete(id);
  }

  for (const p of state.peers.values()) {
    let li = state.peerEls.get(p.id);
    if (!li) {
      li = newPeerRow();
      state.peerEls.set(p.id, li);
      list.appendChild(li);
    }
    updatePeerRow(li, p);
  }

  ui('#peer-count').textContent = state.peers.size;
  render('cams');        // на плитках подписаны ники — они могли смениться
  applySpeaking();
}

/**
 * Каркас строки. Значки внутри меняются часто, а сама строка и ползунок
 * громкости живут, пока человек в комнате. Обёртки прозрачны для раскладки
 * (`display: contents`), поэтому ряд выглядит так же, как если бы значки лежали
 * в строке сами по себе.
 */
function newPeerRow() {
  return make(
    'li',
    {},
    ...['peer-name', 'peer-marks', 'peer-acts'].map((cls) => make('span', { class: cls }))
  );
}

function updatePeerRow(li, p) {
  const mine = isSelf(p.id);
  const name = li.querySelector('.peer-name');
  const marks = li.querySelector('.peer-marks');
  const acts = li.querySelector('.peer-acts');

  const label = p.name + (mine ? ' (вы)' : '');
  if (name.textContent !== label) name.textContent = label;
  name.style.color = p.color || 'inherit';

  marks.replaceChildren(...stateMarks(p), ...shareToggles(p, mine));

  // Ползунок появляется у тех, кого мы реально слышим, и живёт, пока слышим.
  const heard = !mine && voice.remotes.has(p.id);
  let vol = li.querySelector('.pv-mini');
  if (heard && !vol) li.insertBefore((vol = peerVolumeSlider(p.id)), acts);
  else if (!heard && vol) vol.remove();
  else vol?.sync();

  acts.replaceChildren(...peerActions(p, mine));
}

/**
 * Значок только у молчащих: включённый микрофон — это норма, и рисовать его
 * возле каждого ника значит показывать одно и то же по кругу. Своё состояние
 * показываем наравне с чужими: список должен читаться как список, а не как
 * «все, кроме меня», — и заодно видно, каким тебя видят остальные.
 */
function stateMarks(p) {
  return [
    [!p.voice || p.muted, 'mic-off', p.voice ? 'Микрофон заглушён' : 'Микрофон выключен'],
    [p.deaf, 'speaker-off', 'Звук выключен — участников не слышно'],
  ]
    .filter(([show]) => show)
    .map(([, glyph, title]) => markButton({ glyph, title, off: true }));
}

/**
 * Значок трансляции — заодно выключатель: чужую можно перестать получать
 * вовсе, чтобы не тратить ни канал, ни процессор.
 */
function shareToggles(p, mine) {
  return [
    [p.screen, 'screen', 'screen'],
    [p.camera, 'camera', 'cam'],
  ]
    .filter(([on]) => on)
    .map(([, glyph, kind]) => {
      const key = viewKey(p.id, kind);
      const off = hidden.has(key);
      return markButton({
        glyph,
        off,
        title: off
          ? 'Выключено у вас — вернуть'
          : mine
            ? 'Убрать у себя из виду (остальные продолжат видеть)'
            : 'Не получать эту трансляцию',
        onclick: () => setHidden(key, !off),
      });
    });
}

function peerActions(p, mine) {
  if (mine) return [];
  const actions = [];

  // Кому можно за мой компьютер — решаю я, поимённо. Замок нужен и без
  // Sunshine: он же открывает простое управление по WebRTC.
  if (native.caps.remoteControl) actions.push(allowButton(p.id));
  // А к кому можно мне — те, кто уже разрешил.
  if (canMoonlight(p.id)) actions.push(moonlightButton(p.id));

  if (state.paused && control.granted.has(p.id)) {
    actions.push(make('span', { class: 'tag warn', text: 'на паузе' }));
  }
  return actions;
}

/** Громкость голоса участника. Держится по нику, а не по идентификатору. */
function peerVolumeSlider(id) {
  return volumeSlider({
    max: 400,
    label: 'Громкость',
    get: () => settings.peerVolumeOf(id),
    set: (v) => settings.setPeerVolume(id, v),
  });
}

export function applySpeaking() {
  for (const [id, li] of state.peerEls) {
    li.classList.toggle('speaking', voice.speaking.has(isSelf(id) ? 'self' : id));
  }
}
