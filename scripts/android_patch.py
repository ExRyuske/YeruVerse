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
]


def patch_manifest() -> str:
    path = ANDROID / 'app/src/main/AndroidManifest.xml'
    text = path.read_text()
    missing = [p for p in PERMISSIONS if f'"{p}"' not in text]
    if not missing:
        return 'манифест: права на месте'

    lines = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in missing)
    text = text.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n',
                        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' + lines, 1)
    path.write_text(text)
    return 'манифест: добавлены ' + ', '.join(p.rsplit('.', 1)[-1] for p in missing)


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


def patch_activity() -> str:
    found = list((ANDROID / 'app/src/main/java').rglob('MainActivity.kt'))
    if not found:
        raise SystemExit('не нашли MainActivity.kt — шаблон Tauri изменился')
    path = found[0]

    text = path.read_text()
    if 'enableEdgeToEdge' not in text:
        return 'активность: окно уже не уезжает под системную панель'

    package = text.splitlines()[0]
    path.write_text(f"""{package}

import android.os.Bundle

// Правку накатывает scripts/android_patch.py — руками она переживёт ровно до
// следующей генерации проекта.
//
// Шаблон Tauri включает здесь edge-to-edge: окно занимает весь экран вместе с
// областью системной панели. Для страницы это значит, что верхний ряд кнопок
// оказывается под часами и значком батареи, а отступ взять неоткуда — вебвью на
// Android не сообщает safe-area-inset.
class MainActivity : TauriActivity() {{
  override fun onCreate(savedInstanceState: Bundle?) {{
    super.onCreate(savedInstanceState)
  }}
}}
""")
    return 'активность: выключен edge-to-edge'


def main() -> None:
    if not ANDROID.exists():
        raise SystemExit('нет gen/android — сначала `cargo tauri android init`')
    for report in (patch_manifest(), patch_gradle(), patch_activity()):
        print(report)


if __name__ == '__main__':
    sys.exit(main())
