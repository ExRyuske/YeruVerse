#!/usr/bin/env python3
"""Собирает `web/js/icons.js` из настоящих иконок Font Awesome Free.

Рисовать иконки руками — верный способ получить набор, в котором каждая живёт
своей жизнью. Здесь берутся оригинальные контуры Font Awesome, стиль **Solid**,
один на весь интерфейс: одна рисовальная сетка, один вес, один автор.

Скачивается ровно то, что используется, и складывается прямо в модуль — ни
шрифта, ни CSS, ни обращений к чужому серверу во время работы приложения.

    python3 scripts/fetch_icons.py     # или: make icons-ui

Иконки Font Awesome Free распространяются по CC BY 4.0; ссылка на лицензию
уезжает в заголовок сгенерированного файла и в web/vendor/fontawesome/NOTICE.md.
"""

import pathlib
import re
import sys
import urllib.request

VERSION = '6.7.2'
CDN = f'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@{VERSION}/svgs/solid'

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'web/js/icons.js'
NOTICE = ROOT / 'web/vendor/fontawesome/NOTICE.md'

# Наше имя -> имя иконки в Font Awesome. Состояние «выключено» — это отдельная
# иконка, а не линия поверх: у Font Awesome они нарисованы автором, и перечёркнуть
# чужой контур своей чертой значило бы сломать тот самый единый стиль.
ICONS = {
    'mic': 'microphone',
    'mic-off': 'microphone-slash',
    'speaker': 'volume-high',
    'speaker-off': 'volume-xmark',
    'gear': 'gear',
    'link': 'link',
    'exit': 'right-from-bracket',
    'screen': 'display',
    'camera': 'video',
    'file': 'file',
    'pointer': 'arrow-pointer',
    'gamepad': 'gamepad',
    'lock': 'lock',
    'unlock': 'lock-open',
    'paperclip': 'paperclip',
    'send': 'paper-plane',
    'download': 'download',
    'close': 'xmark',
    'expand': 'expand',
    'collapse': 'compress',
}

HEADER = f'''// Иконки интерфейса. Файл собран скриптом scripts/fetch_icons.py — правки
// руками переживут ровно до следующего запуска.
//
// Контуры взяты из Font Awesome Free {VERSION}, стиль Solid: одна рисовальная
// сетка, один вес, один автор — поэтому в ряду кнопок они выглядят как набор, а
// не как случайные картинки. Ни шрифта, ни CSS, ни обращений к чужому серверу:
// нужные контуры лежат прямо здесь.
//
// «Выключено» — это отдельная иконка (mic-off, speaker-off), а не линия поверх:
// перечёркивать чужой контур своей чертой значило бы ломать тот самый стиль.
//
// Иконки Font Awesome Free — CC BY 4.0, https://fontawesome.com/license/free
// Copyright Fonticons, Inc.

const PATHS = {{
'''

FOOTER = '''};

/**
 * Разметка иконки.
 *
 * Ширина у контуров Font Awesome разная, а высота всегда 512. Чтобы в ряду
 * кнопок они смотрелись одинаково, каждый вписывается в квадрат по своей
 * большей стороне — иначе узкие выглядели бы крупнее широких.
 */
export function icon(name, { size = 18 } = {}) {
  const found = PATHS[name];
  if (!found) return '';
  const [box, d] = found;
  return `<svg viewBox="${box}" class="ico" width="${size}" height="${size}" aria-hidden="true"><path d="${d}"/></svg>`;
}
'''


def fetch(fa_name: str) -> tuple[str, str]:
    url = f'{CDN}/{fa_name}.svg'
    with urllib.request.urlopen(url, timeout=30) as resp:
        svg = resp.read().decode()

    view = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
    path = re.search(r'<path d="([^"]+)"', svg)
    if not view or not path:
        raise SystemExit(f'{fa_name}: не разобрали SVG')

    width, height = int(view.group(1)), int(view.group(2))
    # Квадратная область по большей стороне, контур в её середине.
    box = max(width, height)
    return f'{(width - box) / 2:g} {(height - box) / 2:g} {box} {box}', path.group(1)


def main() -> None:
    lines = []
    for name, fa_name in ICONS.items():
        box, d = fetch(fa_name)
        lines.append(f"  '{name}': ['{box}', '{d}'],")
        print(f'  {name:<12} ← {fa_name}')

    OUT.write_text(HEADER + '\n'.join(lines) + '\n' + FOOTER)
    NOTICE.parent.mkdir(parents=True, exist_ok=True)
    NOTICE.write_text(
        f'# Font Awesome Free {VERSION}\n\n'
        'Контуры иконок из набора Font Awesome Free, стиль Solid. В репозитории\n'
        'они лежат не файлами, а внутри `web/js/icons.js` — его собирает\n'
        '`scripts/fetch_icons.py`, там же список используемых иконок.\n\n'
        '* Иконки — CC BY 4.0: https://creativecommons.org/licenses/by/4.0/\n'
        '* Проект и лицензия целиком: https://fontawesome.com/license/free\n'
        '* Copyright Fonticons, Inc.\n'
    )
    print(f'\n{OUT}: {len(ICONS)} иконок')


if __name__ == '__main__':
    sys.exit(main())
