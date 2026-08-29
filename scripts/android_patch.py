#!/usr/bin/env python3
"""Правки в сгенерированный Tauri проект Android.

`gen/android` создаётся `cargo tauri android init` и в репозиторий не входит:
после каждой пересборки проекта правки в нём исчезают. Поэтому они живут здесь
и накатываются перед каждой сборкой — идемпотентно, повторный запуск ничего не
портит.

Что правим и зачем:

* **Права в манифесте.** Без `RECORD_AUDIO` и `CAMERA` вебвью отказывает
  микрофону и камере ещё до вопроса пользователю, и в приложении видно только
  «доступ запрещён». Сам запрос wry показывает сам, но лишь для прав,
  объявленных в манифесте.
* **Уровень языка Java.** Шаблон Tauri ставит 8, JDK 21 на это ругается и
  однажды перестанет её принимать.
* **Предупреждения Kotlin.** Весь Kotlin здесь сгенерирован Tauri; чинить его
  устаревшие вызовы нам нечем, а лог сборки они забивают.
* **Edge-to-edge.** Шаблон растягивает окно под системную панель, и верхний ряд
  кнопок оказывается под часами и значком батареи. Отступ оттуда вебвью на
  Android не получает — `env(safe-area-inset-top)` там всегда ноль, — поэтому
  проще не залезать под панель вовсе.
* **Работа в фоне.** Свёрнутому приложению Android глушит микрофон и вправе
  выгрузить процесс: разговор обрывается ровно в тот момент, когда человек
  посмотрел, кто ему написал. Единственный законный способ этого избежать —
  служба переднего плана с постоянным уведомлением, и она добавляется здесь.
  Когда её поднимать, служба больше не гадает: об этом ей говорит страница
  через `src/room.rs`.
* **Полоса звука.** Стоит вебвью открыть микрофон, как система уводит весь звук
  разом в «разговорный» режим — полоса режется до телефонной, и собеседники
  начинают звучать как из трубки. Служба возвращает режим обратно.
* **Правило для R8.** В релизной сборке минификация включена, а метод моста
  зовётся только по имени из JNI — без правила он бы просто исчез, и мост
  отвалился бы молча и только в релизе.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ANDROID = ROOT / 'desktop/src-tauri/gen/android'

PERMISSIONS = [
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.CAMERA',
    # Служба переднего плана и её уведомление: без первого Android не даст
    # работать в фоне, без второго не покажет, что приложение ещё живо.
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    # Второй тип службы — для тех, кто в комнате только слушает. Без него
    # службу с типом «микрофон» система не даст поднять вовсе: этот тип
    # требует выданного доступа к микрофону, а у слушающего его нет.
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
]

# Служба живёт ровно столько, сколько человек в комнате. `stopWithTask` убирает
# её вместе со смахнутым из недавних приложением: уведомление, пережившее
# закрытие, читается как «оно от меня не отвяжется».
#
# Два типа сразу: какой из них взять на самом деле, служба решает при запуске
# по тому, дали ей микрофон или нет. Объявленное здесь — потолок, выйти за него
# во время работы нельзя.
SERVICE = """
        <service
            android:name=".RoomService"
            android:exported="false"
            android:stopWithTask="true"
            android:foregroundServiceType="microphone|mediaPlayback" />
"""

# R8 в релизе выбрасывает всё, чего не видит из Java. Мост из Rust приходит по
# имени метода через JNI — для минификатора это не вызов, а пустое место.
PROGUARD = """# Файл создаёт scripts/android_patch.py — правки руками переживут ровно до
# следующей генерации проекта. Подхватывается сам: релизная сборка Tauri
# складывает в proguardFiles все *.pro из каталога app.
#
# `setRoomActive` не зовут ниоткуда из Java — его зовёт оболочка из Rust через
# JNI, по имени (см. desktop/src-tauri/src/room.rs). Без этой строчки R8 метод
# переименует или выбросит, и комната перестанет переживать сворачивание —
# молча и только в релизной сборке.
-keepclassmembers class **.MainActivity {
    public void setRoomActive(boolean, boolean);
}
"""


def patch_manifest() -> str:
    path = ANDROID / 'app/src/main/AndroidManifest.xml'
    text = path.read_text()
    done = []

    missing = [p for p in PERMISSIONS if f'"{p}"' not in text]
    if missing:
        lines = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in missing)
        text = text.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n',
                            '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' + lines, 1)
        done.append('права ' + ', '.join(p.rsplit('.', 1)[-1] for p in missing))

    # Не «если ещё нет», а «приведи к нужному виду»: список типов службы у нас
    # менялся, и объявление, оставшееся от прошлой версии скрипта, обошлось бы
    # службой, которая не поднимается у слушающего.
    without = re.sub(r'\n *<service\b[^>]*?\.RoomService\b.*?/>\n', '\n', text, flags=re.S)
    if SERVICE not in text:
        if '</application>' not in without:
            raise SystemExit('манифест: не нашли </application> — шаблон Tauri изменился')
        text = without.replace('</application>', SERVICE + '    </application>', 1)
        done.append('служба комнаты')

    if not done:
        return 'манифест: всё на месте'
    # Вставка оставляет за собой строки из одних пробелов — убираем, чтобы
    # сгенерированный файл не выглядел так, будто его правили второпях.
    path.write_text(re.sub(r'[ \t]+\n', '\n', text))
    return 'манифест: добавлены ' + '; '.join(done)


def patch_gradle() -> str:
    path = ANDROID / 'app/build.gradle.kts'
    text = path.read_text()
    if 'VERSION_17' in text:
        return 'gradle: уровень языка уже поднят'

    # Шаблон Tauri успел сменить форму этого блока: было `kotlinOptions` внутри
    # `android`, стало `kotlin { compilerOptions }` снаружи. Понимаем обе —
    # сборка не должна падать из-за косметики в чужом шаблоне.
    block = re.search(r'    kotlinOptions \{\n.*?\n    \}\n', text, re.S)
    if block:
        replacement = """    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        suppressWarnings = true
    }
"""
        text = text.replace(block.group(0), replacement, 1)
        path.write_text(text)
        return 'gradle: Java 17, предупреждения Kotlin убраны'

    block = re.search(r'^kotlin \{\n.*?\n\}\n', text, re.S | re.M)
    if not block:
        raise SystemExit('gradle: не нашли настройки Kotlin — шаблон Tauri изменился')

    # В новой форме уровень языка Java живёт своим блоком внутри `android`,
    # поэтому его дописываем отдельно, рядом с `buildFeatures`.
    text = text.replace(block.group(0), """kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
        suppressWarnings = true
    }
}
""", 1)
    text = re.sub(r'^    compileOptions \{\n.*?\n    \}\n',
                  """    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
""", text, count=1, flags=re.S | re.M)
    path.write_text(text)
    return 'gradle: Java 17, предупреждения Kotlin убраны'


ACTIVITY = '''{package}

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.util.Log

// Правку накатывает scripts/android_patch.py — руками она переживёт ровно до
// следующей генерации проекта.
//
// Шаблон Tauri включает здесь edge-to-edge: окно занимает весь экран вместе с
// областью системной панели. Для страницы это значит, что верхний ряд кнопок
// оказывается под часами и значком батареи, а отступ взять неоткуда — вебвью на
// Android не сообщает safe-area-inset.
//
// Второе дело активности — служба переднего плана. Свёрнутому приложению
// Android глушит микрофон, а процесс вправе выгрузить совсем; служба этому
// мешает, но взамен требует постоянного уведомления. Раньше решение о ней
// принималось здесь и по догадке — идёт ли запись с микрофона. Догадка
// ошибалась в обе стороны, и хуже всего с теми, кто в комнате только слушает:
// микрофон они не занимают, и разговор у них обрывался при каждом сворачивании.
// Теперь об этом говорит сама страница — через `setRoomActive`.
class MainActivity : TauriActivity() {{
  /** Говорила ли с нами страница. Пока нет — работает старая догадка. */
  private var bridged = false

  override fun onCreate(savedInstanceState: Bundle?) {{
    super.onCreate(savedInstanceState)
    // Без этого разрешения служба всё равно работает, но молча: с Android 13
    // уведомление без спроса не показать, а невидимая служба выглядит как
    // приложение, которое непонятно чем занято.
    if (Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
          != PackageManager.PERMISSION_GRANTED) {{
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }}
  }}

  /**
   * «Мы в комнате» — приходит из оболочки (desktop/src-tauri/src/room.rs),
   * уже на потоке Android.
   *
   * Служба поднимается сразу, а не при сворачивании: с Android 12 службу с
   * микрофоном нельзя завести из фона, а вход в комнату — всегда передний
   * план. Лишние минуты с уведомлением дешевле разговора, который не пережил
   * сворачивания.
   *
   * `wideband` — просьба не отдавать звук системе в «разговорном» режиме;
   * что это значит, написано в RoomService.
   *
   * Метод зовут только из JNI, поэтому его имя защищено правилом в
   * app/proguard-yeruverse.pro — иначе R8 выбросил бы его из релизной сборки.
   */
  fun setRoomActive(active: Boolean, wideband: Boolean) {{
    bridged = true
    room(active, wideband)
  }}

  private fun room(active: Boolean, wideband: Boolean) {{
    // Под try: правил, по которым система отказывает службе, с каждой версией
    // больше, а отказ она оформляет исключением. Разговор, не переживший
    // сворачивания, — это неудобство; вылет приложения посреди разговора — нет.
    try {{
      val intent = Intent(this, RoomService::class.java)
      if (!active) {{
        stopService(intent)
        return
      }}
      intent.putExtra(RoomService.EXTRA_WIDEBAND, wideband)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
      else startService(intent)
    }} catch (e: Throwable) {{
      Log.w("YeruVerse", "служба комнаты не поднялась", e)
    }}
  }}

  override fun onPause() {{
    super.onPause()
    // Запасной путь для случая, когда страница о службе ничего не знает:
    // приложение обновляют вручную, а страницу отдаёт сервер, и версии могут
    // разойтись. Старая догадка — идёт ли запись с микрофона — здесь всё ещё
    // лучше, чем ничего.
    if (!bridged && recording()) room(true, false)
  }}

  override fun onDestroy() {{
    stopService(Intent(this, RoomService::class.java))
    super.onDestroy()
  }}

  /**
   * Занят ли микрофон нами. С Android 10 система возвращает здесь только наши
   * собственные записи. Не смогли выяснить — считаем, что заняты: лишнее
   * уведомление простительно, оборванный разговор нет.
   */
  private fun recording(): Boolean {{
    // Без выданного доступа к микрофону записи не может быть по определению.
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
          != PackageManager.PERMISSION_GRANTED) {{
      return false
    }}
    return try {{
      val audio = getSystemService(AUDIO_SERVICE) as AudioManager
      audio.activeRecordingConfigurations.isNotEmpty()
    }} catch (e: Throwable) {{
      true
    }}
  }}
}}
'''

SERVICE_KT = '''{package}

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

// Файл создаёт scripts/android_patch.py — правки руками переживут ровно до
// следующей генерации проекта.
//
// У службы два дела, и оба — обещания системе, а не работа.
//
// Первое: пока она жива, приложение считается занятым разговором. Микрофон не
// глушится, процесс не выгружается, а уведомление честно говорит человеку, что
// комната всё ещё открыта.
//
// Второе: держать звук в обычном режиме. Стоит вебвью открыть микрофон, как
// Chromium переводит систему в MODE_IN_COMMUNICATION — режим телефонного
// разговора. Вместе с микрофоном туда уезжает и воспроизведение: полоса
// режется до телефонной, включается аппаратная обработка, и собеседники
// начинают звучать как из трубки, хотя просили мы обработку только для записи.
// Из страницы этому противопоставить нечего — ограничения на getUserMedia
// движок соблюдает, а режим системы всё равно переключает. Отсюда и правка.
class RoomService : Service() {{
  private var wake: PowerManager.WakeLock? = null
  private var audio: AudioManager? = null
  private var modeListener: Any? = null
  private var poll: Handler? = null
  /**
   * Сколько раз мы уже возвращали режим. Ограничение против качелей: если
   * движок будет упрямо ставить своё в ответ на каждую нашу правку, звук от
   * этой борьбы станет только хуже, чем от проигрыша в ней.
   */
  private var fixes = 0

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {{
    // Отказ системы — не повод падать: молча уходим, комната просто не переживёт
    // сворачивания. Правила для служб переднего плана меняются от версии к
    // версии, и предугадать их все здесь нечем.
    try {{
      goForeground(note())
    }} catch (e: Throwable) {{
      Log.w("YeruVerse", "передний план не дали", e)
      stopSelf()
      return START_NOT_STICKY
    }}

    // Одного лишь переднего плана мало: без этого замка процессор уходит спать
    // вместе с экраном, и звук начинает рваться.
    if (wake == null) {{
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yeruverse:room")
        .also {{ it.acquire() }}
    }}

    // Настройку можно поменять, не выходя из комнаты, и команда придёт
    // повторно — поэтому здесь обе ветки, а не только включение.
    if (intent?.getBooleanExtra(EXTRA_WIDEBAND, false) == true) holdMusicMode() else releaseMode()

    // Перезапускать себя после того, как систему попросили нас убить, незачем:
    // комнаты к тому моменту уже нет.
    return START_NOT_STICKY
  }}

  override fun onDestroy() {{
    releaseMode()
    wake?.let {{ if (it.isHeld) it.release() }}
    wake = null
    super.onDestroy()
  }}

  // ------------------------------------------------------------ полоса звука

  /**
   * Возвращать звук в обычный режим всякий раз, когда его увели в разговорный.
   *
   * С Android 12 у системы есть уведомление о смене режима — тогда мы ничего не
   * опрашиваем и правим ровно по событию. Ниже приходится заглядывать самим;
   * раз в секунду для этого более чем достаточно, переключение происходит один
   * раз за разговор.
   */
  private fun holdMusicMode() {{
    if (audio != null) return   // уже держим: команду могли прислать повторно
    val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audio = am
    fixes = 0
    restore(am)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {{
      val listener = AudioManager.OnModeChangedListener {{ mode ->
        if (mode == AudioManager.MODE_IN_COMMUNICATION) restore(am)
      }}
      modeListener = listener
      try {{
        am.addOnModeChangedListener(mainExecutor, listener)
      }} catch (e: Throwable) {{
        Log.w("YeruVerse", "не подписались на смену режима звука", e)
        modeListener = null
      }}
    }} else {{
      val handler = Handler(Looper.getMainLooper())
      poll = handler
      val tick = object : Runnable {{
        override fun run() {{
          if (am.mode == AudioManager.MODE_IN_COMMUNICATION) restore(am)
          handler.postDelayed(this, 1000)
        }}
      }}
      handler.postDelayed(tick, 1000)
    }}
  }}

  private fun restore(am: AudioManager) {{
    if (fixes >= MAX_FIXES) return
    fixes++
    try {{
      am.mode = AudioManager.MODE_NORMAL
      // Вместе с режимом движок мог увести и сам маршрут — на разговорный
      // динамик у уха. В обычном режиме маршрут выбирает система, и выбирает
      // она правильно: наушники, если они есть, иначе громкий динамик.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
      if (fixes == MAX_FIXES) {{
        Log.w("YeruVerse", "движок упрямо возвращает разговорный режим — оставляем как есть")
      }}
    }} catch (e: Throwable) {{
      Log.w("YeruVerse", "не вернули обычный режим звука", e)
    }}
  }}

  private fun releaseMode() {{
    val am = audio ?: return
    poll?.removeCallbacksAndMessages(null)
    poll = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {{
      (modeListener as? AudioManager.OnModeChangedListener)?.let {{
        try {{
          am.removeOnModeChangedListener(it)
        }} catch (e: Throwable) {{
          Log.w("YeruVerse", "не отписались от смены режима звука", e)
        }}
      }}
    }}
    modeListener = null
    audio = null
  }}

  // ------------------------------------------------------------- уведомление

  // Не `startForeground`: то же имя без `override` Kotlin считает случайным
  // перекрытием метода службы и отказывается собирать.
  private fun goForeground(note: Notification) {{
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {{
      startForeground(NOTE_ID, note)
      return
    }}
    // Тип «микрофон» система даёт только тому, у кого микрофон уже разрешён, —
    // иначе не «не даст», а бросит исключение и уронит окно. Тем, кто в комнате
    // только слушает, остаётся «воспроизведение»: от выгрузки процесса оно
    // защищает так же.
    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
        checkSelfPermission(Manifest.permission.RECORD_AUDIO)
          == PackageManager.PERMISSION_GRANTED) {{
      type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }}
    startForeground(NOTE_ID, note, type)
  }}

  private fun note(): Notification {{
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {{
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL) == null) {{
        // Без звука и без всплывающей карточки: это не новость, а лампочка.
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL, "Комната", NotificationManager.IMPORTANCE_LOW)
        )
      }}
      Notification.Builder(this, CHANNEL)
    }} else {{
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }}

    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    return builder
      .setContentTitle("YeruVerse на связи")
      .setContentText("Комната открыта")
      .setSmallIcon(android.R.drawable.presence_audio_online)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
  }}

  companion object {{
    /** Просьба держать звук в обычном режиме. Приходит из настроек страницы. */
    const val EXTRA_WIDEBAND = "wideband"
    private const val CHANNEL = "room"
    private const val NOTE_ID = 1
    private const val MAX_FIXES = 12
  }}
}}
'''


def patch_activity() -> str:
    found = list((ANDROID / 'app/src/main/java').rglob('MainActivity.kt'))
    if not found:
        raise SystemExit('не нашли MainActivity.kt — шаблон Tauri изменился')
    path = found[0]

    # Активность переписывается целиком, поэтому убеждаемся, что переписываем
    # знакомое: либо шаблон Tauri (в нём есть enableEdgeToEdge), либо уже свою
    # версию. Что-то третье — значит, шаблон изменился, и молча выбрасывать его
    # содержимое нельзя.
    current = path.read_text()
    if 'enableEdgeToEdge' not in current and 'RoomService' not in current:
        raise SystemExit('MainActivity.kt: шаблон Tauri изменился — правку надо пересмотреть')

    # Первая строка — объявление пакета; всё остальное в файле наше.
    package = current.splitlines()[0]
    if not package.startswith('package '):
        raise SystemExit(f'{path.name}: первой строкой ждали package — шаблон Tauri изменился')

    reports = []
    for target, template in [
        (path, ACTIVITY),
        (path.with_name('RoomService.kt'), SERVICE_KT),
    ]:
        want = template.format(package=package)
        if target.exists() and target.read_text() == want:
            continue
        target.write_text(want)
        reports.append(target.name)

    return f'kotlin: переписаны {", ".join(reports)}' if reports else 'kotlin: всё на месте'


def patch_proguard() -> str:
    # Релизная сборка Tauri складывает в proguardFiles все *.pro из каталога
    # app, поэтому файл достаточно просто положить рядом — трогать gradle не
    # нужно.
    path = ANDROID / 'app/proguard-yeruverse.pro'
    if path.exists() and path.read_text() == PROGUARD:
        return 'proguard: всё на месте'
    path.write_text(PROGUARD)
    return 'proguard: правило для моста добавлено'


def main() -> None:
    if not ANDROID.exists():
        raise SystemExit('нет gen/android — сначала `cargo tauri android init`')
    for report in (patch_manifest(), patch_gradle(), patch_activity(), patch_proguard()):
        print(report)


if __name__ == '__main__':
    sys.exit(main())
