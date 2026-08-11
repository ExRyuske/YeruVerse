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
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
]

# Служба живёт ровно столько, сколько окно свёрнуто. `stopWithTask` убирает её
# вместе со смахнутым из недавних приложением: уведомление, пережившее закрытие,
# читается как «оно от меня не отвяжется».
SERVICE = """
        <service
            android:name=".RoomService"
            android:exported="false"
            android:stopWithTask="true"
            android:foregroundServiceType="microphone" />
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

    if 'RoomService' not in text:
        if '</application>' not in text:
            raise SystemExit('манифест: не нашли </application> — шаблон Tauri изменился')
        text = text.replace('</application>', SERVICE + '    </application>', 1)
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

    block = re.search(r'    kotlinOptions \{\n.*?\n    \}\n', text, re.S)
    if not block:
        raise SystemExit('gradle: не нашли блок kotlinOptions — шаблон Tauri изменился')

    text = text.replace(block.group(0), """    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        suppressWarnings = true
    }
""", 1)
    path.write_text(text)
    return 'gradle: Java 17, предупреждения Kotlin убраны'


ACTIVITY = '''{package}

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle

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
// мешает, но взамен требует постоянного уведомления. Поэтому поднимаем её
// только когда окно уходит с глаз, и убираем, как только оно вернулось.
class MainActivity : TauriActivity() {{
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

  override fun onPause() {{
    super.onPause()
    // Запускать отсюда, а не из фона: с Android 12 службу с микрофоном нельзя
    // поднять, когда приложение уже свёрнуто, а onPause — ещё передний план.
    if (inRoom()) {{
      val intent = Intent(this, RoomService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
      else startService(intent)
    }}
  }}

  override fun onResume() {{
    super.onResume()
    stopService(Intent(this, RoomService::class.java))
  }}

  override fun onDestroy() {{
    stopService(Intent(this, RoomService::class.java))
    super.onDestroy()
  }}

  /**
   * В комнате ли человек. Спрашивать об этом страницу нечем — моста из вебвью
   * в Kotlin у нас нет, — но идущая запись с микрофона отвечает на тот же
   * вопрос: с Android 10 система возвращает здесь только наши собственные
   * записи. Не смогли выяснить — считаем, что в комнате: лишнее уведомление
   * простительно, оборванный разговор нет.
   */
  private fun inRoom(): Boolean = try {{
    val audio = getSystemService(AUDIO_SERVICE) as AudioManager
    audio.activeRecordingConfigurations.isNotEmpty()
  }} catch (e: Throwable) {{
    true
  }}
}}
'''

SERVICE_KT = '''{package}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// Файл создаёт scripts/android_patch.py — правки руками переживут ровно до
// следующей генерации проекта.
//
// Служба ничего не делает: она и есть обещание системе, что приложение занято
// разговором. Пока она жива, микрофон не глушится, процесс не выгружается, а
// уведомление честно говорит человеку, что комната всё ещё открыта.
class RoomService : Service() {{
  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {{
    goForeground(note())

    // Одного лишь переднего плана мало: без этого замка процессор уходит спать
    // вместе с экраном, и звук начинает рваться.
    if (wake == null) {{
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yeruverse:room")
        .also {{ it.acquire() }}
    }}
    // Перезапускать себя после того, как систему попросили нас убить, незачем:
    // комнаты к тому моменту уже нет.
    return START_NOT_STICKY
  }}

  override fun onDestroy() {{
    wake?.let {{ if (it.isHeld) it.release() }}
    wake = null
    super.onDestroy()
  }}

  // Не `startForeground`: то же имя без `override` Kotlin считает случайным
  // перекрытием метода службы и отказывается собирать.
  private fun goForeground(note: Notification) {{
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {{
      startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }} else {{
      startForeground(NOTE_ID, note)
    }}
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
      .setContentText("Комната открыта, микрофон работает")
      .setSmallIcon(android.R.drawable.presence_audio_online)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
  }}

  companion object {{
    private const val CHANNEL = "room"
    private const val NOTE_ID = 1
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


def main() -> None:
    if not ANDROID.exists():
        raise SystemExit('нет gen/android — сначала `cargo tauri android init`')
    for report in (patch_manifest(), patch_gradle(), patch_activity()):
        print(report)


if __name__ == '__main__':
    sys.exit(main())
