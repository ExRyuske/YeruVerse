// Свои трансляции: экран и камера. Захват, качество и присмотр за тем, что
// зрители видят не чёрный прямоугольник.

import { control, mesh, native, net, settings } from './core.js';
import { state, viewKey } from './state.js';
import { render } from './render.js';
import { $, toast, ui } from './ui.js';
import { addScreen, removeScreen } from './stage.js';
import { deviceProblem } from './devices.js';
import { refreshDevices } from './settings-panel.js';

/**
 * Экран и камера отличаются только способом захвата и подписью — всё остальное
 * у них общее, поэтому и код общий.
 */
const SHARES = {
  screen: {
    button: '#btn-screen',
    presence: 'screen',
    capture: () => {
      const q = streamSettings();
      return navigator.mediaDevices.getDisplayMedia({
        // ideal, а не exact: если экран меньше или система не тянет, браузер
        // подберёт ближайшее вместо отказа в захвате.
        video: {
          frameRate: { ideal: q.fps, max: q.fps },
          height: { ideal: q.height },
          displaySurface: 'monitor',   // для игры нужен экран целиком
        },
        // Звук игры берём как есть: обработка, рассчитанная на речь, съедает
        // басы и приглушает тихие места.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',   // не предлагать транслировать сам YeruVerse
        surfaceSwitching: 'include',     // окно можно сменить, не пересоздавая поток
      });
    },
    missing: 'Захват экрана недоступен: нужен HTTPS и браузер с его поддержкой',
  },
  cam: {
    button: '#btn-camera',
    presence: 'camera',
    capture: async () => {
      const id = settings.get('camDevice');
      // Размер и частота — пожеланием: телефонная камера часто не умеет ровно
      // столько, и жёсткое требование обернулось бы отказом вместо картинки.
      const base = { width: { ideal: 1280 }, frameRate: { ideal: 30 } };
      // Не выбрана — берём фронтальную: на телефоне до первого доступа система
      // не называет камеры, и выбирать там пока не из чего.
      const video = id ? { ...base, deviceId: { exact: id } } : { ...base, facingMode: 'user' };

      // звук идёт голосовым каналом, дублировать незачем
      try {
        return await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        if (e?.name !== 'OverconstrainedError') throw e;
        // Запомненной камеры больше нет — берём любую. Оставить человека без
        // картинки из-за строчки в настройках хуже, чем взять не ту камеру.
        settings.set('camDevice', '');
        return navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      }
    },
    missing: 'Камера недоступна: нужен https',
  },
};

export function wireShares() {
  ui('#btn-screen').onclick = () => toggleShare('screen');
  ui('#btn-camera').onclick = () => toggleShare('cam');

  // Захвата экрана на телефоне нет ни у одного движка: ни Chrome для Android,
  // ни системный вебвью не отдают getDisplayMedia, а системный MediaProjection
  // в MediaStream страницы никак не превращается. Кнопку в таком окружении
  // убираем совсем — вместе с настройками качества, которые ей и служат:
  // погашенная кнопка обещает, что когда-нибудь заработает, а она не заработает.
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('#btn-screen').closest('.with-pick').hidden = true;
  }
}

/** Свою трансляцию после обрыва надо объявить заново. */
export function announceShares() {
  for (const kind of state.shares.keys()) {
    net.send({ t: 'presence', [SHARES[kind].presence]: true });
  }
}

export async function toggleShare(kind) {
  if (state.shares.has(kind)) return stopShare(kind);

  const share = SHARES[kind];
  const capture = kind === 'screen' ? 'getDisplayMedia' : 'getUserMedia';
  if (!navigator.mediaDevices?.[capture]) return toast(share.missing);

  try {
    const stream = await share.capture();
    state.shares.set(kind, stream);
    mesh.setStream(kind, stream);
    net.send({ t: 'presence', [share.presence]: true });

    // Своя трансляция — такой же поток в общем списке, только без звука себе.
    //
    // Сцену она себе не забирает, если там уже что-то есть. Свой экран видно и
    // так, а вот занять им сцену значило бы потерять чужую трансляцию вместе с
    // курсорами на ней: указки рисуются только на том кадре, к которому
    // относятся, и при двух трансляциях каждый смотрел бы в свою — курсоров не
    // видел бы никто. Если смотреть было нечего, addScreen покажет её сам.
    addScreen(viewKey(state.self.id, kind), stream);
    render('views', 'stage', 'peers');
    $(share.button).classList.add('active');

    // Названия камер и микрофонов система показывает только после того, как
    // доступ уже выдан. До первого включения в списке голые «Камера 1».
    if (kind === 'cam') refreshDevices();

    // Оверлей поднимаем вместе с трансляцией — и только если указка включена.
    if (native.caps.overlay) native.setOverlay(true).catch(() => {});
    if (kind === 'screen') watchFrames(stream);
    stream.getVideoTracks()[0].addEventListener('ended', () => stopShare(kind));
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast(`${share.missing}: ${deviceProblem(e)}`);
  }
}

export function stopShare(kind) {
  const stream = state.shares.get(kind);
  if (!stream) return;

  if (kind === 'screen') control.revokeAll().catch(() => {});
  stream.getTracks().forEach((t) => t.stop());
  state.shares.delete(kind);
  mesh.setStream(kind, null);
  net.send({ t: 'presence', [SHARES[kind].presence]: false });
  removeScreen(viewKey(state.self?.id, kind));
  if (!state.shares.size && native.caps.overlay) native.setOverlay(false).catch(() => {});
  render('peers');
  $(SHARES[kind].button).classList.remove('active');
}

/**
 * Присматриваем за собственной трансляцией экрана.
 *
 * Игра в настоящем полноэкранном режиме (и почти всё, что закрыто защитой от
 * записи) отдаёт захвату чёрный кадр: зрители видят пустоту, а транслирующий
 * об этом не догадывается — у него-то на экране игра. Раз в пару секунд
 * смотрим на собственный кадр и, если он мёртвый, говорим, что именно делать.
 */
function watchFrames(stream) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // Полностью скрытое видео браузер вправе не декодировать, поэтому оставляем
  // его в разметке невидимым пикселем.
  video.style.cssText =
    'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let dead = 0;
  let warned = false;
  const stop = () => {
    clearInterval(timer);
    video.srcObject = null;
    video.remove();
  };

  let silent = 0;
  const timer = setInterval(() => {
    if (state.shares.get('screen') !== stream) return stop();
    if (!video.videoWidth) {
      // Кадров нет вообще: захват согласился, но источник ничего не отдаёт.
      if (++silent === 5) {
        toast('Захват не отдаёт кадров — перезапустите трансляцию', 8000);
      }
      return;
    }
    silent = 0;

    let dark;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        max = Math.max(max, data[i], data[i + 1], data[i + 2]);
      }
      dark = max < 12;
    } catch {
      return stop();   // кадр прочитать нельзя — молча уходим, а не спамим
    }

    dead = dark ? dead + 1 : 0;
    if (!dark) warned = false;
    if (dead >= 3 && !warned) {
      warned = true;
      toast(
        'Зрители видят чёрный экран. Игры захватываются только в режиме ' +
          '«окно без рамок» — переключите его в настройках графики. ' +
          'Если включён HDR, выключите и его.',
        12000
      );
    }
  }, 2000);
}

// ---------------------------------------------------------------- качество

/** Текущие настройки трансляции — из своих значений, а не из заготовки. */
function streamSettings() {
  return {
    height: settings.get('streamHeight'),
    fps: settings.get('streamFps'),
    bitrate: Math.round(settings.get('streamBitrate') * 1_000_000),
  };
}

// Кодировщик настраивается отсюда — mesh про настройки ничего не знает.
function applyQuality() {
  const q = streamSettings();
  mesh.videoBitrate = q.bitrate;
  mesh.videoFramerate = q.fps;
  mesh.retune();
}

/**
 * Новые настройки — на живую трансляцию, без перезапуска.
 *
 * Битрейт и частоту кадров задаёт кодировщик, и там они меняются на лету. А вот
 * разрешение — свойство самого захвата: пока дорожка отдаёт 1080 строк, никакие
 * настройки кодировщика не сделают из них 720. Поэтому разрешение просим у
 * дорожки отдельно.
 *
 * Если дорожка меняться отказалась — а это умеют не все движки, — захват
 * перезапускается целиком. Тогда система снова спросит, что показывать: обидно,
 * но лучше, чем настройка, которая молча ничего не делает.
 */
let retuneTimer;
function retuneCapture() {
  // Ползунок шлёт событие на каждый пиксель, а applyConstraints — операция не
  // из дешёвых: ждём, пока человек отпустит.
  clearTimeout(retuneTimer);
  retuneTimer = setTimeout(async () => {
    const track = state.shares.get('screen')?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    const q = streamSettings();
    try {
      await track.applyConstraints({
        height: { ideal: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      });
    } catch {
      restartScreen();
    }
  }, 400);
}

/**
 * Перезапуск демонстрации с новыми настройками — запасной путь для движков, где
 * живой захват настройки менять не даёт. Система снова спросит, что показывать:
 * без этого вопроса захват экрана не начинается нигде и никогда.
 */
async function restartScreen() {
  if (!state.shares.has('screen')) return;
  stopShare('screen');
  // Про отказ toggleShare рассказывает сам, поэтому смотрим на итог, а не ловим
  // исключение: захват мог не начаться и молча — например, если окно выбора
  // закрыли.
  await toggleShare('screen');
  toast(
    state.shares.has('screen')
      ? 'Трансляция перезапущена с новыми настройками'
      : 'Настройки применятся, когда включите трансляцию заново',
    6000
  );
}

settings.on(({ key }) => {
  if (!key.startsWith('stream')) return;
  applyQuality();
  // Битрейт живёт только в кодировщике, дорожку он не касается.
  if (key !== 'streamBitrate') retuneCapture();
});

// Камеру меняют, когда она уже включена: перезапускаем захват и подменяем
// дорожку — собеседники не видят ни разрыва, ни пересогласования.
//
// Старый захват отпускаем до нового, а не после. Система не отдаёт одно и то же
// устройство дважды, и запрос поверх работающего падал с «занято другим
// приложением» — на телефоне, где камера всего одна, это значило, что сменить
// её нельзя вовсе.
settings.on(async ({ key }) => {
  if (key !== 'camDevice' || !state.shares.has('cam')) return;
  state.shares.get('cam').getTracks().forEach((t) => t.stop());
  try {
    const stream = await SHARES.cam.capture();
    state.shares.set('cam', stream);
    await mesh.replaceStream('cam', stream);
    addScreen(viewKey(state.self.id, 'cam'), stream);
  } catch (e) {
    // Прежний поток уже мёртв, поэтому камеру честно выключаем: оставить
    // остановленную дорожку значит показывать всем застывший кадр.
    stopShare('cam');
    toast(`Камера не включилась: ${deviceProblem(e)}`);
  }
});

// Зеркало — дело показа, а не захвата: перерисовать плитки достаточно.
settings.on(({ key }) => key === 'mirrorCam' && render('cams'));

applyQuality();
