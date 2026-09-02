// Список участников: кто в комнате, что у него включено и что ему разрешено.

import { control, native, settings, voice } from './core.js';
import { hidden, isSelf, state, viewKey } from './state.js';
import { painter, render } from './render.js';
import { icon } from './icons.js';
import { make, markButton, ui, volumeSlider } from './ui.js';
import { stacked } from './layout.js';
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
      li = newPeerRow(p.id);
      state.peerEls.set(p.id, li);
      list.appendChild(li);
    }
    updatePeerRow(li, p);
  }

  ui('#peer-count').textContent = state.peers.size;
  fillPeerCard();        // она показывает то же самое и отставать не должна
  render('cams');        // на плитках подписаны ники — они могли смениться
  applySpeaking();
}

/**
 * Каркас строки. Значки внутри меняются часто, а сама строка и ползунок
 * громкости живут, пока человек в комнате. Обёртки прозрачны для раскладки
 * (`display: contents`), поэтому ряд выглядит так же, как если бы значки лежали
 * в строке сами по себе.
 */
function newPeerRow(id) {
  return make(
    'li',
    {
      // Нажатие на строку поднимает карточку — но только там, где строка не
      // вмещает управления сама. На большом экране всё уже стоит в ней, и
      // всплывающий лист поверх был бы вторым способом сделать то же самое.
      // Нажатия на сами значки в строке карточку не открывают: у них своё дело.
      onclick: (e) => stacked() && !e.target.closest('button') && openPeerCard(id),
    },
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

// ---------------------------------------------------------------- карточка

/**
 * Карточка участника: всё, что о нём можно решить, в одном месте.
 *
 * На телефоне в вертикали список ложится строкой поперёк экрана — вертикаль там
 * дороже и отдана чату. В такую строку помещается только ник, и всё остальное
 * из неё уходит: громкость прячется совсем, выключатель чужой трансляции
 * остаётся значком в двадцать четыре точки без подписи, а замку, Moonlight и
 * «на паузе» места нет вовсе. Настроить собеседника с телефона было нечем —
 * старое примечание в стилях обещало громкость «в настройках», но её там нет и
 * не было.
 *
 * Поэтому по нажатию на ник поднимается лист снизу — с тем же ползунком и теми
 * же кнопками, что стоят в строке на большом экране. Собираются они теми же
 * сборщиками, что и строка: разойтись им не на чем, а подпись каждая берёт из
 * своей же подсказки — той, что на большом экране показывается по наведению.
 */
let card = null;

function openPeerCard(id) {
  closePeerCard();

  const name = make('b', { class: 'sheet-name' });
  const vol = make('div', { class: 'sheet-vol' });
  const rows = make('div', { class: 'sheet-rows' });
  const sheet = make(
    'div',
    { class: 'sheet' },
    make(
      'header',
      { class: 'sheet-head' },
      name,
      make('button', {
        class: 'ghost icon',
        title: 'Закрыть',
        html: icon('close'),
        onclick: closePeerCard,
      })
    ),
    vol,
    rows
  );
  // Нажатие мимо листа закрывает его — как и у всплывающих настроек рядом.
  const back = make('div', { class: 'sheet-back', onclick: (e) => e.target === back && closePeerCard() }, sheet);

  // Escape закрывает — как и всплывающие настройки рядом. Слушатель живёт
  // ровно столько, сколько открыта карточка: в остальное время он не при чём.
  const onKey = (e) => e.key === 'Escape' && closePeerCard();
  document.addEventListener('keydown', onKey);

  document.body.appendChild(back);
  card = { id, back, onKey, name, vol, rows };
  fillPeerCard();
}

function closePeerCard() {
  if (!card) return;
  document.removeEventListener('keydown', card.onKey);
  card.back.remove();
  card = null;
}

/**
 * Обновить открытую карточку. Зовётся с каждой перерисовкой списка: карточка
 * показывает то же самое, и отставать ей не от чего.
 *
 * Ползунок при этом переживает обновление, а не создаётся заново, — по той же
 * причине, что и в строке: пересозданный, он исчезает прямо из-под пальца.
 */
function fillPeerCard() {
  if (!card) return;
  const p = state.peers.get(card.id);
  // Вышел или вернулся под новым id, пока карточка открыта: настраивать больше
  // некого, а карточка без человека — это карточка ни о ком.
  if (!p) return closePeerCard();

  const mine = isSelf(p.id);
  card.name.textContent = p.name + (mine ? ' (вы)' : '');
  card.name.style.color = p.color || 'inherit';

  // Громкость идёт подписью вперёд: ползунок занимает всю оставшуюся ширину, и
  // подпись после него оказалась бы прижата к правому краю неизвестно к чему.
  const heard = !mine && voice.remotes.has(p.id);
  const slider = card.vol.querySelector('.pv-mini');
  if (heard && !slider) {
    card.vol.replaceChildren(
      make(
        'div',
        { class: 'sheet-row sheet-vol-row' },
        make('span', { text: 'Громкость' }),
        peerVolumeSlider(p.id)
      )
    );
  } else if (!heard && slider) {
    card.vol.replaceChildren();
  } else {
    slider?.sync();
  }

  const rows = [...stateMarks(p), ...shareToggles(p, mine), ...peerActions(p, mine)].map((el) =>
    labelled(el, el.title)
  );
  // Пустая карточка — тупик: человек нажал на ник и получил пустоту, из которой
  // непонятно, сломалось что-то или так и задумано. Это обычное дело для себя
  // самого: микрофон включён, трансляций нет — и решать про себя нечего.
  if (!rows.length && !card.vol.childElementCount) {
    rows.push(make('p', { class: 'muted sheet-empty', text: 'Тут пока нечего настроить' }));
  }
  card.rows.replaceChildren(...rows);
}

/**
 * Значок с подписью словами.
 *
 * В строке на большом экране подпись живёт подсказкой по наведению — на
 * телефоне наводить нечем, и без слов ряд одинаковых квадратиков не читается
 * никак. Берём ту же подсказку: второго её текста заводить не за что.
 */
function labelled(el, text) {
  return make('div', { class: 'sheet-row' }, el, make('span', { text: text ?? '' }));
}

export function applySpeaking() {
  for (const [id, li] of state.peerEls) {
    li.classList.toggle('speaking', voice.speaking.has(isSelf(id) ? 'self' : id));
  }
}
