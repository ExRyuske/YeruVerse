// Картинка в картинке: чужая трансляция в маленьком окне поверх всего.
//
// Ради этого окна всё и затевалось: своя игра занимает экран целиком, а
// YeruVerse при этом свёрнут — и посмотреть, что там у соседа, нечем. Окно PiP
// рисует не страница, а сама система: оно переживает и сворачивание, и чужой
// полный экран, чего никакая наша разметка не может в принципе.
//
// Способов два, и они не пересекаются. Chromium (Windows, Linux, WebView2)
// знает стандартный `requestPictureInPicture`, WebKit (macOS, iPhone) —
// только свой `webkitSetPresentationMode`, и стандартного у него нет до сих
// пор. Android-вебвью не умеет ни того, ни другого, и там кнопка честно
// говорит об этом вместо того, чтобы молча ничего не делать.

/** Кто уже под присмотром: второй раз слушателей вешать незачем. */
const watched = new WeakSet();
const listeners = new Set();

/** Какое видео сейчас в окошке. У WebKit спросить об этом больше некого. */
let current = null;

const webkit = (video) => typeof video?.webkitSetPresentationMode === 'function';

/** Умеет ли этот движок вынести именно это видео в отдельное окошко. */
export function pipSupported(video) {
  if (!video) return false;
  if (webkit(video)) return !!video.webkitSupportsPresentationMode?.('picture-in-picture');
  return !!(
    document.pictureInPictureEnabled &&
    !video.disablePictureInPicture &&
    typeof video.requestPictureInPicture === 'function'
  );
}

/** Это видео сейчас в окошке. */
export function pipActive(video) {
  if (!video) return false;
  return webkit(video)
    ? video.webkitPresentationMode === 'picture-in-picture'
    : document.pictureInPictureElement === video;
}

/**
 * Окошко закрывают не только кнопкой: его закрывает сама система, закрывает
 * человек за его собственный крестик, закрывает уход потока. Кнопка должна
 * показывать состояние, а не своё последнее нажатие, — поэтому о каждой смене
 * узнаёт интерфейс.
 */
export function onPipChange(fn) {
  listeners.add(fn);
}

function watch(video) {
  if (watched.has(video)) return;
  watched.add(video);

  const sync = () => {
    if (pipActive(video)) current = video;
    else if (current === video) current = null;
    for (const fn of listeners) fn();
  };
  // Первые два — стандартные, третий — весь WebKit целиком: он присылает одно
  // событие и на окошко, и на полный экран, поэтому режим перечитываем.
  for (const ev of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) {
    video.addEventListener(ev, sync);
  }
}

/**
 * Дождаться первого кадра.
 *
 * Chromium не открывает окошко, пока у элемента нет метаданных, и говорит об
 * этом по-английски и про `HTMLVideoElement`. А плитка камеры живёт ровно в
 * этом состоянии первые доли секунды после появления: поток уже назначен, кадр
 * ещё не пришёл — и нажатие в этот миг кончалось отказом на ровном месте.
 *
 * Ждать можно недолго: движок считает нажатие нажатием ещё несколько секунд
 * после самого нажатия, но не бесконечно, и просрочить это право хуже, чем
 * честно сказать «попробуйте ещё раз».
 */
function ready(video, ms = 2000) {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    video.addEventListener('loadedmetadata', finish);
  });
}

/**
 * Открыть окошко или закрыть его. Оба движка требуют нажатия человека, поэтому
 * зовётся это только из обработчика кнопки.
 */
export async function togglePip(video) {
  if (!video) throw new Error('нечего показывать');
  watch(video);

  const on = pipActive(video);
  if (webkit(video)) {
    video.webkitSetPresentationMode(on ? 'inline' : 'picture-in-picture');
    return;
  }
  if (on) return void (await document.exitPictureInPicture());

  await ready(video);
  if (video.readyState < 1) throw new Error('кадр ещё не пришёл, попробуйте ещё раз');
  await video.requestPictureInPicture();
}

/**
 * Закрыть окошко за тем, кто про него уже не узнает: поток кончился, плеер
 * снесли, плитка камеры ушла из полосы. Само окно про это ничего не знает и
 * висело бы последним кадром поверх всех программ.
 */
export function closePip(video) {
  if (!pipActive(video)) return;
  if (webkit(video)) video.webkitSetPresentationMode('inline');
  else document.exitPictureInPicture().catch(() => {});
}
