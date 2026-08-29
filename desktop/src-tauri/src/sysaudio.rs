//! Звук компьютера в трансляцию — на macOS.
//!
//! Чего здесь не хватало. Страница просит звук вместе с экраном
//! (`systemAudio: 'include'` в `getDisplayMedia`), и на Windows это работает, а
//! на macOS не работает нигде и ни в одном движке: ни WebKit, ни Chrome
//! системный звук в поток не отдают — не «не умеют пока», а не дают вовсе.
//! Просьба молча игнорируется, и трансляция уходит немой. Дырку эту может
//! закрыть только оболочка.
//!
//! Как закрываем. ScreenCaptureKit (macOS 13+, как раз наш минимум) умеет
//! отдавать звук всей системы отдельным потоком. Мы просим у него только звук —
//! картинку страница снимает сама, — режем отсчёты в 16 бит и отправляем на
//! страницу по каналу Tauri. Там из них собирается обычная дорожка
//! MediaStreamTrack, и дальше она ничем не отличается от любой другой:
//! `mesh` жмёт её тем же Opus с теми же настройками, что и звук игры на
//! Windows (см. `tuneAudio`).
//!
//! Почему шестнадцать бит, а не тридцать два. Вдвое меньше байтов через IPC при
//! разнице, которой не переживёт Opus на 128 кбит/с: у него самого точность
//! ниже. Сорок миллисекунд в посылке — компромисс между задержкой и накладными
//! расходами: мелкие посылки Tauri гонит через `eval`, что вчетверо дороже.
//!
//! `excludesCurrentProcessAudio` здесь не украшение: без него мы снимали бы и
//! голоса собеседников, которые звучат из наших же колонок, и возвращали бы их
//! обратно — эхо, от которого никакой шумодав не спасает.
//!
//! Поток живёт в своём потоке ОС: объекты ScreenCaptureKit не `Send`, а
//! состояние Tauri обязано им быть. Наружу торчит только отправитель «стоп».

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};

/// Ручка идущего захвата: чем его просят закончить и чем он подтверждает конец.
///
/// Подтверждение здесь не для порядка. Остановка ScreenCaptureKit не мгновенна,
/// а следующая демонстрация экрана начинается с вопроса к той же системе:
/// уйди мы, не дождавшись, и экран для неё всё ещё занят — вебвью получит
/// «The operation was aborted» и трансляция не начнётся вовсе.
struct Live {
    stop: std::sync::mpsc::Sender<()>,
    /// Поднимается в `true`, когда захват действительно закончился.
    ///
    /// Не канал, а условная переменная: просящих остановиться бывает двое —
    /// сначала выход из трансляции, следом её повторный запуск, — и оба должны
    /// дождаться одного и того же конца. Из канала же конец достаётся только
    /// первому, а второй уходит думать, что всё уже готово.
    finished: Arc<(Mutex<bool>, std::sync::Condvar)>,
}

/// Идущий захват. Пустое поле — не захватываем.
#[derive(Default)]
pub struct Sound {
    live: Mutex<Option<Live>>,
    /// Сколько байт мы отправили странице с начала захвата.
    ///
    /// Нужно ровно затем, чтобы разделить две беды, которые снаружи выглядят
    /// одинаково — тишиной. Ноль здесь значит, что звука не дала система; не
    /// ноль при пустой стороне страницы — что байты не доехали через IPC.
    /// Гадать об этом по одному лишь молчанию нельзя, а машины, где оно
    /// случается, у нас под рукой нет.
    sent: Arc<AtomicU64>,
}

impl Sound {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Сколько байт звука оболочка отправила странице с начала захвата.
#[tauri::command]
pub fn sound_stats(state: tauri::State<'_, Sound>) -> u64 {
    state.sent.load(Ordering::Relaxed)
}

/// Начать снимать звук системы.
///
/// `rate` — частота, на которой работает звуковой граф страницы. Спрашиваем её,
/// а не берём 48000: страница просит контекст на 48 кГц, но движок вправе
/// отказать и выдать свою, и тогда наши отсчёты играли бы не с той скоростью —
/// звук поехал бы по высоте, и понять почему было бы неоткуда.
#[tauri::command]
pub fn sound_start(
    state: tauri::State<'_, Sound>,
    channel: Channel<InvokeResponseBody>,
    rate: u32,
) -> Result<(), String> {
    if !(8_000..=192_000).contains(&rate) {
        return Err("странная частота дискретизации".into());
    }
    let mut slot = state.live.lock().unwrap();
    // Предыдущий захват гасим, а не отказываемся начинать новый.
    //
    // Отказ здесь был прямой дорогой к беде. Страница может уйти и вернуться —
    // перезагрузкой, сменой сервера, обычным F5, — и её состояние обнулится, а
    // наше нет: поток ScreenCaptureKit остался бы жить навсегда. Мало того что
    // звук после этого не завести, так ещё и экран у системы числится занятым,
    // и следующий `getDisplayMedia` в вебвью отвечает «The operation was
    // aborted» — то есть ломается уже и сама трансляция, к звуку отношения не
    // имеющая.
    if let Some(live) = slot.take() {
        let _ = live.stop.send(());
        await_finish(&live.finished);
    }
    state.sent.store(0, Ordering::Relaxed);
    *slot = Some(start(channel, rate, Arc::clone(&state.sent))?);
    Ok(())
}

/// Сколько ждём, пока захват действительно закончится.
const WAIT_STOP: std::time::Duration = std::time::Duration::from_secs(6);

/// Прекратить — и дождаться, пока система отпустит экран.
///
/// Возвращается только после подтверждения: страница зовёт это перед тем, как
/// снова просить демонстрацию, и уйти раньше времени значит сломать ей запуск.
/// Ожидание уходит в отдельный поток — держать на нём исполнителя асинхронных
/// команд нельзя.
///
/// Молчит, если и не начинали: выход из комнаты зовёт это на всякий случай, и
/// жаловаться там не на что.
#[tauri::command]
pub async fn sound_stop(state: tauri::State<'_, Sound>) -> Result<(), String> {
    // Ручку берём копией, а не забираем: пока идёт остановка, о ней должен
    // узнать и тот, кто спросит следом.
    let Some((stop, finished)) =
        state.live.lock().unwrap().as_ref().map(|l| (l.stop.clone(), Arc::clone(&l.finished)))
    else {
        return Ok(());
    };
    let _ = stop.send(());
    tauri::async_runtime::spawn_blocking(move || await_finish(&finished))
        .await
        .map_err(|e| e.to_string())?;
    state.live.lock().unwrap().take();
    Ok(())
}

/// Дождаться конца захвата. Не дождались — идём дальше: подвесить страницу
/// навсегда хуже, чем начать демонстрацию с риском отказа.
fn await_finish(finished: &(Mutex<bool>, std::sync::Condvar)) {
    let (lock, notify) = finished;
    let guard = lock.lock().unwrap();
    let _ = notify.wait_timeout_while(guard, WAIT_STOP, |done| !*done);
}

/// То же самое, но изнутри оболочки: страница ушла и попросить уже некому.
///
/// Зовётся на перезагрузку окна. Без этого захват переживал бы страницу: её
/// состояние обнуляется, наше нет, и поток ScreenCaptureKit оставался бы жить
/// до конца работы приложения — держа экран занятым и ломая уже саму
/// демонстрацию, а не только звук.
///
/// Здесь не ждём: это главный поток, и задерживать на нём загрузку страницы
/// ради подтверждения нельзя.
pub fn stop(state: &Sound) {
    if let Some(live) = state.live.lock().unwrap().take() {
        let _ = live.stop.send(());
    }
}

// ------------------------------------------------------------------ macOS

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_core_audio_types::AudioBufferList;
    use objc2_core_media::{CMBlockBuffer, CMSampleBuffer};
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
        SCStreamOutputType,
    };
    use tauri::ipc::{Channel, InvokeResponseBody};

    // Блочный буфер нам отдают уже удержанным, и вернуть его надо самим.
    // Забудешь — утечка по мегабайту в секунду.
    unsafe extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    /// Сколько ждать ответа системы. Первый запрос поднимает окно «разрешить
    /// запись экрана», и человек может думать над ним сколько угодно, но ждать
    /// его здесь нельзя: команда держит поток. Отказ по времени — это «не
    /// разрешили пока», и трансляция просто уйдёт без звука.
    const WAIT: Duration = Duration::from_secs(20);

    /// Сколько отсчётов копим перед отправкой — сорок миллисекунд.
    const CHUNK_MS: usize = 40;

    /// Ответ системы на «что можно снимать»: содержимое или объяснение отказа.
    type Shareable = Result<Retained<SCShareableContent>, String>;

    pub struct Ivars {
        channel: Channel<InvokeResponseBody>,
        /// Общий с состоянием счётчик отправленного — см. `Sound::sent`.
        sent: std::sync::Arc<std::sync::atomic::AtomicU64>,
        /// Накопитель: чередующиеся отсчёты каналов, по 16 бит.
        pending: std::sync::Mutex<Vec<i16>>,
        /// Сколько чисел должно набраться до отправки.
        chunk: usize,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[ivars = Ivars]
        struct Sink;

        unsafe impl NSObjectProtocol for Sink {}

        unsafe impl SCStreamOutput for Sink {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn did_output(
                &self,
                _stream: &SCStream,
                buffer: &CMSampleBuffer,
                kind: SCStreamOutputType,
            ) {
                if kind != SCStreamOutputType::Audio {
                    return;
                }
                self.take(buffer);
            }
        }
    );

    impl Sink {
        fn new(
            channel: Channel<InvokeResponseBody>,
            chunk: usize,
            sent: std::sync::Arc<std::sync::atomic::AtomicU64>,
        ) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                channel,
                sent,
                pending: std::sync::Mutex::new(Vec::with_capacity(chunk * 2)),
                chunk,
            });
            unsafe { msg_send![super(this), init] }
        }

        /// Разобрать посылку и, если набралось на кусок, отправить её странице.
        fn take(&self, buffer: &CMSampleBuffer) {
            // Сколько места нужно под список буферов, знает только сам буфер:
            // каналы приходят порознь, и сколько их — заранее не сказать.
            // Размер нужен ровно этот: с запасом API отвечает отказом
            // kCMSampleBufferError_ArrayTooSmall.
            let mut needed: usize = 0;
            let status = unsafe {
                buffer.audio_buffer_list_with_retained_block_buffer(
                    &mut needed,
                    std::ptr::null_mut(),
                    0,
                    None,
                    None,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if status != 0 || needed == 0 {
                return;
            }

            // Выравнивание не косметика: внутри списка лежит указатель.
            let mut storage = vec![0u64; needed.div_ceil(8)];
            let mut block: *mut CMBlockBuffer = std::ptr::null_mut();
            let status = unsafe {
                buffer.audio_buffer_list_with_retained_block_buffer(
                    std::ptr::null_mut(),
                    storage.as_mut_ptr().cast::<AudioBufferList>(),
                    needed,
                    None,
                    None,
                    0,
                    &mut block,
                )
            };
            if status != 0 {
                tracing::debug!("звук: список буферов не отдали, статус {status}");
                return;
            }

            let list = unsafe { &*storage.as_ptr().cast::<AudioBufferList>() };
            let buffers = unsafe {
                std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize)
            };

            // ScreenCaptureKit отдаёт каналы врозь, по буферу на каждый, а
            // странице нужно чередование — так его ждёт дорожка WebAudio.
            let plane = |i: usize| -> &[f32] {
                match buffers.get(i) {
                    Some(b) if !b.mData.is_null() => unsafe {
                        std::slice::from_raw_parts(
                            b.mData.cast::<f32>(),
                            b.mDataByteSize as usize / 4,
                        )
                    },
                    _ => &[],
                }
            };
            let left = plane(0);
            // Моно бывает: у виртуальных устройств и у части ноутбуков. Тогда
            // второй канал — это первый же, иначе справа была бы тишина.
            let right = if buffers.len() > 1 { plane(1) } else { left };
            let frames = left.len().min(right.len());

            if frames > 0 {
                let mut pending = self.ivars().pending.lock().unwrap();
                for i in 0..frames {
                    pending.push(to_i16(left[i]));
                    pending.push(to_i16(right[i]));
                }
                // Куски приходят мельче нашего, поэтому отдаём как накопится;
                // цикл — на случай посылки крупнее ожидаемой.
                let chunk = self.ivars().chunk;
                while pending.len() >= chunk {
                    let rest = pending.split_off(chunk);
                    let ready = std::mem::replace(&mut *pending, rest);
                    // Отправляем без блокировки: канал сам разберётся, а
                    // задерживать здесь нельзя — мы на очереди захвата.
                    let bytes: Vec<u8> = ready.iter().flat_map(|s| s.to_le_bytes()).collect();
                    let len = bytes.len() as u64;
                    if self.ivars().channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                        // Страница ушла — дальше слать некому, а копить тем
                        // более: захват остановят, но не в эту же миллисекунду.
                        pending.clear();
                        break;
                    }
                    self.ivars().sent.fetch_add(len, std::sync::atomic::Ordering::Relaxed);
                }
            }

            if !block.is_null() {
                unsafe { CFRelease(block.cast()) };
            }
        }
    }

    /// Отсчёт с плавающей точкой в целый. Обрезаем по краям: сумма нескольких
    /// источников вылезает за единицу, и без обрезки это давало бы не громкий
    /// звук, а треск от переполнения.
    fn to_i16(v: f32) -> i16 {
        (v.clamp(-1.0, 1.0) * 32767.0) as i16
    }

    /// Поднять захват. Возвращает отправитель, которым его останавливают.
    pub fn start(
        channel: Channel<InvokeResponseBody>,
        rate: u32,
        sent: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) -> Result<super::Live, String> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let finished =
            std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let raised = std::sync::Arc::clone(&finished);

        // Объекты ScreenCaptureKit не `Send`, поэтому живут целиком в этом
        // потоке: он их создаёт, он же и разбирает. Наружу уходит только
        // «стоп», а обратно — получилось или нет.
        std::thread::Builder::new()
            .name("sysaudio".into())
            .spawn(move || {
                // Область нужна затем, чтобы поток и приёмник успели умереть
                // до подтверждения: экран система отпускает вместе с ними, а
                // подтверждение обещает именно это.
                {
                    let (stream, _sink) = match setup(channel, rate, sent) {
                        Ok(pair) => {
                            let _ = ready_tx.send(Ok(()));
                            pair
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                    };
                    // Ждём «стоп». Оборванный канал — это ушедшее состояние
                    // приложения, то есть тот же «стоп».
                    let _ = stop_rx.recv();

                    let (done_tx, done_rx) = mpsc::channel::<()>();
                    let done = RcBlock::new(move |_err: *mut NSError| {
                        let _ = done_tx.send(());
                    });
                    unsafe { stream.stopCaptureWithCompletionHandler(Some(&done)) };
                    // Ответа ждём, но недолго: не дождались — всё равно
                    // отпускаем, поток захвата умрёт вместе с этим потоком.
                    let _ = done_rx.recv_timeout(Duration::from_secs(5));
                }
                let (lock, notify) = &*raised;
                *lock.lock().unwrap() = true;
                notify.notify_all();
            })
            .map_err(|e| format!("не подняли поток захвата: {e}"))?;

        ready_rx
            .recv_timeout(WAIT + Duration::from_secs(5))
            .map_err(|_| "ScreenCaptureKit не ответил".to_string())??;
        Ok(super::Live { stop: stop_tx, finished })
    }

    /// Поток и приёмник отдаются вместе: ScreenCaptureKit держит на приёмник
    /// только слабую ссылку, и уронив его здесь мы получили бы работающий
    /// захват, который никому ничего не отдаёт.
    fn setup(
        channel: Channel<InvokeResponseBody>,
        rate: u32,
        sent: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) -> Result<(Retained<SCStream>, Retained<Sink>), String> {
        // Что вообще можно снимать. Первый же вызов и поднимает запрос
        // «Запись экрана» — до него ScreenCaptureKit молчит.
        let (tx, rx) = mpsc::channel::<Shareable>();
        let handler = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
            let msg = if content.is_null() {
                Err(if err.is_null() {
                    "ScreenCaptureKit не объяснил отказ".to_string()
                } else {
                    unsafe { &*err }.localizedDescription().to_string()
                })
            } else {
                Ok(unsafe { Retained::retain(content) }.unwrap())
            };
            let _ = tx.send(msg);
        });
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };

        let content = rx
            .recv_timeout(WAIT)
            .map_err(|_| {
                "система не ответила — похоже, не выдана «Запись экрана» в настройках \
                 приватности"
                    .to_string()
            })?
            .map_err(|e| format!("{e} — проверьте «Запись экрана» в настройках приватности"))?;

        let displays = unsafe { content.displays() };
        let display = displays.iter().next().ok_or("не нашли ни одного экрана")?;

        // Снимаем «весь экран без исключений» — фильтр здесь только потому, что
        // без него поток не создать. Картинка нам не нужна вовсе.
        let empty = NSArray::new();
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &empty,
            )
        };

        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            // Потока без картинки не бывает, поэтому берём самую маленькую и
            // самую редкую: два пикселя раз в две секунды никого не греют.
            config.setWidth(2);
            config.setHeight(2);
            config.setMinimumFrameInterval(objc2_core_media::CMTime {
                value: 2,
                timescale: 1,
                flags: objc2_core_media::CMTimeFlags::Valid,
                epoch: 0,
            });
            config.setQueueDepth(3);
            config.setShowsCursor(false);

            config.setCapturesAudio(true);
            config.setSampleRate(rate as isize);
            config.setChannelCount(2);
            // Без этого мы вернули бы собеседникам их же голоса из наших колонок.
            config.setExcludesCurrentProcessAudio(true);
        }

        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                None,
            )
        };

        // Кусок в отсчётах: сорок миллисекунд на два канала.
        let chunk = (rate as usize * CHUNK_MS / 1000) * 2;
        let sink = Sink::new(channel, chunk, sent);
        // Своя очередь, а не главная: разбор посылок не должен ждать интерфейс.
        let queue = DispatchQueue::new("cc.yeru.yeruverse.sysaudio", None);
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*sink),
                SCStreamOutputType::Audio,
                Some(&queue),
            )
        }
        .map_err(|e| format!("не подписались на звук: {}", e.localizedDescription()))?;

        let (tx, rx) = mpsc::channel::<Option<String>>();
        let started = RcBlock::new(move |err: *mut NSError| {
            let _ = tx.send(if err.is_null() {
                None
            } else {
                Some(unsafe { &*err }.localizedDescription().to_string())
            });
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&started)) };

        match rx.recv_timeout(WAIT) {
            Ok(None) => Ok((stream, sink)),
            Ok(Some(e)) => Err(format!("захват не начался: {e}")),
            Err(_) => Err("захват не отозвался".into()),
        }
    }
}

#[cfg(target_os = "macos")]
use imp::start;

#[cfg(not(target_os = "macos"))]
fn start(
    _channel: Channel<InvokeResponseBody>,
    _rate: u32,
    _sent: Arc<AtomicU64>,
) -> Result<Live, String> {
    // На Windows и Linux этого моста не нужно: там движок отдаёт звук системы
    // сам, прямо в `getDisplayMedia`. Страница сюда и не постучится —
    // `capabilities` про эту сборку скажет «не умею».
    Err("захват звука системы есть только на macOS".into())
}
