//! Звук компьютера в трансляцию — на macOS, и звук выбранного устройства — на
//! Windows.
//!
//! На Windows движок отдаёт звук системы сам, но только с устройства по
//! умолчанию. Если программа, которую хочется транслировать, играет в другое
//! (браузер — в наушники, всё остальное — в колонки), её не слышно. Для этого
//! случая внизу файла есть второй захват — WASAPI loopback с названного
//! устройства; путь до страницы у него тот же, что описан ниже для macOS.
//!
//! Чего здесь не хватало. Страница просит звук вместе с экраном
//! (`systemAudio: 'include'` в `getDisplayMedia`), и на Windows это работает, а
//! на macOS не работает нигде и ни в одном движке: ни WebKit, ни Chrome
//! системный звук в поток не отдают — не «не умеют пока», а не дают вовсе.
//! Просьба молча игнорируется, и трансляция уходит немой. Дырку эту может
//! закрыть только оболочка.
//!
//! Как закрываем. ScreenCaptureKit (macOS 13+, как раз наш минимум)
//! умеет отдавать звук всей системы отдельным потоком. Мы просим у него только звук —
//! картинку страница снимает сама, — режем отсчёты в 16 бит и отправляем на
//! страницу по каналу Tauri. Там из них собирается обычная дорожка
//! MediaStreamTrack, и дальше она ничем не отличается от любой другой:
//! `mesh` жмёт её тем же Opus с теми же настройками, что и звук игры на
//! Windows (см. `tuneAudio`).
//!
//! Почему шестнадцать бит, а не тридцать два. Вдвое меньше байтов через IPC при
//! разнице, которой не переживёт Opus на 128 кбит/с: у него самого точность
//! ниже.
//!
//! Почему посылка ограничена байтами, а не временем. У `Channel` в Tauri два
//! пути доставки: до 1024 байт — синхронный `eval`, выполняющийся ровно в том
//! порядке, в каком его позвали; крупнее — отдельный `fetch`, а его обещания
//! у разных посылок могут разрешиться не в том порядке, в каком ушли. Дорожка
//! на странице ждёт посылки строго по счёту и копит всё, что пришло не по
//! очереди (см. её `Channel`), — а если хоть одна крупная посылка потеряется
//! по дороге, счётчик замирает навсегда, и всё, что после неё, оседает в
//! памяти, не доходя до `onmessage`. Раньше здесь стоял кусок на сорок
//! миллисекунд — крупнее 1024 байт почти при любой частоте и потому всегда
//! шёл уязвимым путём; отсюда и «звук снимается, но не доходит до страницы».
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
///
/// Слот хранит захват вместе с его порядковым номером: `sound_stop` дожидается
/// остановки асинхронно, и пока оно ждёт, `sound_start` может успеть поставить
/// на слот уже следующий захват. Без номера финальный `take()` в `sound_stop`
/// снёс бы этот новый захват вместо того, что оно на самом деле остановило, —
/// и тот остался бы висеть в памяти без способа его когда-либо остановить.
#[derive(Default)]
pub struct Sound {
    live: Mutex<Option<(u64, Live)>>,
    next_id: AtomicU64,
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

/// Устройства вывода, с которых можно снять звук: `{ id, name }`.
///
/// Только Windows. На macOS список пуст: ScreenCaptureKit снимает звук системы
/// целиком и про устройства не спрашивает.
#[tauri::command]
pub async fn sound_devices() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "windows")]
    {
        // Отдельный поток, а не рабочий поток исполнителя: COM заводится на
        // поток, и оставлять его заведённым на чужом незачем.
        let list: Vec<(String, String)> =
            tauri::async_runtime::spawn_blocking(|| std::thread::spawn(win::devices).join())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|_| "перечисление устройств упало".to_string())??;
        Ok(list
            .into_iter()
            .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
            .collect())
    }
    #[cfg(not(target_os = "windows"))]
    Ok(Vec::new())
}

/// Начать снимать звук системы.
///
/// `rate` — частота, на которой работает звуковой граф страницы. Спрашиваем её,
/// а не берём 48000: страница просит контекст на 48 кГц, но движок вправе
/// отказать и выдать свою, и тогда наши отсчёты играли бы не с той скоростью —
/// звук поехал бы по высоте, и понять почему было бы неоткуда.
///
/// `device` — с какого устройства вывода снимать; это только Windows (см.
/// `sound_devices`). Пусто — с того, что в системе по умолчанию.
#[tauri::command]
pub async fn sound_start(
    state: tauri::State<'_, Sound>,
    channel: Channel<InvokeResponseBody>,
    rate: u32,
    device: Option<String>,
) -> Result<(), String> {
    if !(8_000..=192_000).contains(&rate) {
        return Err("странная частота дискретизации".into());
    }

    // Ручку прошлого захвата берём копией и сразу отпускаем состояние — как и
    // в `sound_stop`, а не держим на ней замок целиком. Ждать остановки
    // прошлого захвата (и подъёма нового — тоже не мгновенного) можно и
    // секунды: команда идёт на асинхронном исполнителе, и без этого
    // блокирующее ожидание держало бы там же рабочий поток — тот самый, на
    // котором крутятся и другие команды, включая `fetch` для этого же канала.
    let previous = state.live.lock().unwrap().take().map(|(_, live)| (live.stop, live.finished));
    let sent = Arc::clone(&state.sent);

    let live = tauri::async_runtime::spawn_blocking(move || {
        // Предыдущий захват гасим, а не отказываемся начинать новый.
        //
        // Отказ здесь был прямой дорогой к беде. Страница может уйти и
        // вернуться — перезагрузкой, сменой сервера, обычным F5, — и её
        // состояние обнулится, а наше нет: поток ScreenCaptureKit остался бы
        // жить навсегда. Мало того что звук после этого не завести, так ещё и
        // экран у системы числится занятым, и следующий `getDisplayMedia` в
        // вебвью отвечает «The operation was aborted» — то есть ломается уже
        // и сама трансляция, к звуку отношения не имеющая.
        if let Some((stop, finished)) = previous {
            let _ = stop.send(());
            await_finish(&finished);
        }
        sent.store(0, Ordering::Relaxed);
        start(channel, rate, device.filter(|d| !d.is_empty()), sent)
    })
    .await
    .map_err(|e| e.to_string())??;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    *state.live.lock().unwrap() = Some((id, live));
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
    let Some((id, stop, finished)) = state
        .live
        .lock()
        .unwrap()
        .as_ref()
        .map(|(id, l)| (*id, l.stop.clone(), Arc::clone(&l.finished)))
    else {
        return Ok(());
    };
    let _ = stop.send(());
    tauri::async_runtime::spawn_blocking(move || await_finish(&finished))
        .await
        .map_err(|e| e.to_string())?;

    // Снимаем со слота только то, что сами остановили: за время ожидания
    // `sound_start` мог успеть поставить туда уже следующий захват.
    let mut guard = state.live.lock().unwrap();
    if matches!(&*guard, Some((cur, _)) if *cur == id) {
        guard.take();
    }
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
    if let Some((_, live)) = state.live.lock().unwrap().take() {
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

    /// Верхняя граница одной посылки в байтах — см. объяснение в шапке файла
    /// про два пути доставки `Channel`. Чуть меньше самого порога (1024) на
    /// всякий случай, без плотной подгонки под чужую константу.
    const MAX_CHUNK_BYTES: usize = 1000;

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
        _device: Option<String>,
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

        // Кусок в отсчётах, чередующихся по каналам: сколько укладывается в
        // `MAX_CHUNK_BYTES` — независимо от частоты, чтобы граница не
        // поплыла вместе с ней.
        const BYTES_PER_FRAME: usize = 4; // два канала по 16 бит
        let chunk = (MAX_CHUNK_BYTES / BYTES_PER_FRAME) * 2;
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

// ---------------------------------------------------------------- Windows

/// Звук одного устройства вывода — WASAPI loopback.
///
/// Обычный путь на Windows сюда не заходит: звук системы движок отдаёт сам,
/// вместе с картинкой. Но отдаёт он только устройство по умолчанию, и выбрать
/// другое у него нечем. Здесь снимается ровно то устройство, которое назвал
/// человек, — всё, что в него играет.
///
/// Формат просим сразу тот, что ждёт страница: два канала по 16 бит на частоте
/// её звукового графа. Пересчёт из формата устройства делает сама система
/// (`AUTOCONVERTPCM`) — свой передискретизатор ради этого держать незачем.
///
/// Чего здесь нет, в отличие от macOS, — исключения собственного звука.
/// Loopback отдаёт всё, что звучит в устройстве, и если приложение выводит
/// голоса собеседников в него же, они вернутся к ним эхом. Страница об этом
/// предупреждает рядом с выбором.
///
/// И ещё одно отличие: в тишине loopback не присылает ничего вовсе, а не нули.
/// Странице это безразлично — пустая очередь у неё и есть тишина, — но проверка
/// «ноль байт значит сломано» (см. `watchSound`) здесь неприменима.
#[cfg(target_os = "windows")]
mod win {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    use tauri::ipc::{Channel, InvokeResponseBody};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, DEVICE_STATE_ACTIVE,
        WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED, STGM_READ,
    };

    /// См. шапку файла про два пути доставки `Channel`: посылка обязана быть
    /// меньше 1024 байт, иначе порядок не гарантирован.
    const MAX_CHUNK_BYTES: usize = 1000;
    /// Два канала по 16 бит.
    const BYTES_PER_FRAME: usize = 4;
    /// `WAVE_FORMAT_PCM`: целые отсчёты без сжатия.
    const FORMAT_PCM: u16 = 1;
    /// `AUDCLNT_BUFFERFLAGS_SILENT`: в буфере тишина, и читать его нельзя —
    /// там может лежать мусор.
    const FLAG_SILENT: u32 = 2;
    /// Как часто заглядываем за новыми отсчётами.
    const POLL: Duration = Duration::from_millis(10);
    /// Буфер захвата в сотнях наносекунд — 200 мс: запас на случай, если поток
    /// ненадолго не дадут.
    const BUFFER_HNS: i64 = 2_000_000;

    /// COM на время жизни значения. Заводится на поток и на нём же гасится.
    struct Com;

    impl Com {
        fn new() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(|e| format!("COM не поднялся: {e}"))?;
            Ok(Self)
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| format!("нет доступа к звуковым устройствам: {e}"))
    }

    /// Идентификатор устройства — строка, по которой его потом находят.
    fn id_of(device: &IMMDevice) -> Option<String> {
        let raw = unsafe { device.GetId() }.ok()?;
        let id = unsafe { raw.to_string() }.ok();
        // Строку выделила система, и вернуть её надо самим.
        unsafe { CoTaskMemFree(Some(raw.0.cast())) };
        id
    }

    /// Имя устройства — то же, что показывает система в «Звуке».
    fn name_of(device: &IMMDevice) -> Option<String> {
        let store = unsafe { device.OpenPropertyStore(STGM_READ) }.ok()?;
        let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }.ok()?;
        let name = value.to_string();
        (!name.is_empty()).then_some(name)
    }

    /// Подключённые устройства вывода: идентификатор и имя.
    pub fn devices() -> Result<Vec<(String, String)>, String> {
        let _com = Com::new()?;
        let list = unsafe { enumerator()?.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
            .map_err(|e| format!("не перечислили устройства: {e}"))?;
        let count = unsafe { list.GetCount() }.map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for i in 0..count {
            let Ok(device) = (unsafe { list.Item(i) }) else { continue };
            let Some(id) = id_of(&device) else { continue };
            let name = name_of(&device).unwrap_or_else(|| "Без названия".into());
            out.push((id, name));
        }
        Ok(out)
    }

    /// Поднять захват. Возвращает отправитель, которым его останавливают.
    pub fn start(
        channel: Channel<InvokeResponseBody>,
        rate: u32,
        device: Option<String>,
        sent: Arc<AtomicU64>,
    ) -> Result<super::Live, String> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let finished = Arc::new((Mutex::new(false), Condvar::new()));
        let raised = Arc::clone(&finished);

        // Объекты COM живут в своём потоке целиком — как и ScreenCaptureKit на
        // macOS: он их создаёт, он же и разбирает.
        std::thread::Builder::new()
            .name("sysaudio".into())
            .spawn(move || {
                match setup(rate, device.as_deref()) {
                    Ok((_com, client, capture)) => {
                        let _ = ready_tx.send(Ok(()));
                        pump(&capture, &channel, &sent, &stop_rx);
                        let _ = unsafe { client.Stop() };
                        // Порядок важен: клиенты умирают здесь, до `_com`.
                        drop(capture);
                        drop(client);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
                let (lock, notify) = &*raised;
                *lock.lock().unwrap() = true;
                notify.notify_all();
            })
            .map_err(|e| format!("не подняли поток захвата: {e}"))?;

        ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "звуковая система не ответила".to_string())??;
        Ok(super::Live { stop: stop_tx, finished })
    }

    /// Открыть устройство и запустить на нём захват.
    ///
    /// `Com` отдаётся вместе с клиентами и объявлен первым: умирать он должен
    /// последним, а порядок разбора кортежа у вызывающего — его забота.
    fn setup(
        rate: u32,
        device: Option<&str>,
    ) -> Result<(Com, IAudioClient, IAudioCaptureClient), String> {
        let com = Com::new()?;
        let all = enumerator()?;
        let device = match device {
            Some(id) => unsafe { all.GetDevice(PCWSTR(HSTRING::from(id).as_ptr())) }.map_err(|_| {
                "выбранное устройство звука не найдено — выберите другое в настройках трансляции"
                    .to_string()
            })?,
            None => unsafe { all.GetDefaultAudioEndpoint(eRender, eConsole) }
                .map_err(|e| format!("в системе нет устройства вывода: {e}"))?,
        };

        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| format!("устройство не открылось: {e}"))?;

        let format = WAVEFORMATEX {
            wFormatTag: FORMAT_PCM,
            nChannels: 2,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * BYTES_PER_FRAME as u32,
            nBlockAlign: BYTES_PER_FRAME as u16,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                BUFFER_HNS,
                0,
                &format,
                None,
            )
        }
        .map_err(|e| format!("устройство не отдаёт звук: {e}"))?;

        let capture: IAudioCaptureClient =
            unsafe { client.GetService() }.map_err(|e| format!("захват не открылся: {e}"))?;
        unsafe { client.Start() }.map_err(|e| format!("захват не начался: {e}"))?;
        Ok((com, client, capture))
    }

    /// Перекладывать отсчёты странице, пока не попросят остановиться.
    fn pump(
        capture: &IAudioCaptureClient,
        channel: &Channel<InvokeResponseBody>,
        sent: &AtomicU64,
        stop: &mpsc::Receiver<()>,
    ) {
        let mut pending: Vec<u8> = Vec::with_capacity(MAX_CHUNK_BYTES * 4);
        loop {
            // Ожидание «стопа» служит и паузой между заходами. Оборванный
            // канал — это ушедшее состояние приложения, то есть тот же «стоп».
            match stop.recv_timeout(POLL) {
                Err(RecvTimeoutError::Timeout) => {}
                _ => return,
            }

            loop {
                // Ошибка здесь — это выдернутое или отключённое устройство.
                // Дальше с него ничего не придёт, и ждать нечего.
                let frames = match unsafe { capture.GetNextPacketSize() } {
                    Ok(0) => break,
                    Ok(_) => {
                        let mut data = std::ptr::null_mut::<u8>();
                        let mut frames = 0u32;
                        let mut flags = 0u32;
                        if let Err(e) = unsafe {
                            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                        } {
                            tracing::debug!("звук: буфер не отдали: {e}");
                            return;
                        }
                        let bytes = frames as usize * BYTES_PER_FRAME;
                        if flags & FLAG_SILENT != 0 || data.is_null() {
                            pending.resize(pending.len() + bytes, 0);
                        } else {
                            pending.extend_from_slice(unsafe {
                                std::slice::from_raw_parts(data, bytes)
                            });
                        }
                        let _ = unsafe { capture.ReleaseBuffer(frames) };
                        frames
                    }
                    Err(e) => {
                        tracing::debug!("звук: устройство пропало: {e}");
                        return;
                    }
                };
                if frames == 0 {
                    break;
                }

                while pending.len() >= MAX_CHUNK_BYTES {
                    let rest = pending.split_off(MAX_CHUNK_BYTES);
                    let ready = std::mem::replace(&mut pending, rest);
                    if channel.send(InvokeResponseBody::Raw(ready)).is_err() {
                        // Страница ушла — слать некому. Остановят нас следом.
                        return;
                    }
                    sent.fetch_add(MAX_CHUNK_BYTES as u64, Ordering::Relaxed);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
use win::start;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start(
    _channel: Channel<InvokeResponseBody>,
    _rate: u32,
    _device: Option<String>,
    _sent: Arc<AtomicU64>,
) -> Result<Live, String> {
    Err("захват звука системы есть только на macOS и Windows".into())
}
