#!/usr/bin/env python3
"""Иконки проекта — и приложения, и интерфейса.

    python3 scripts/icons.py app     # PNG и ICO всех размеров из одного рисунка
    python3 scripts/icons.py ui      # web/js/icons.js из Font Awesome Free

Две половины независимы, но дело одно, и держать под него два скрипта с
похожими именами значило каждый раз вспоминать, который из них какой.
"""

from __future__ import annotations

import argparse
import math
import pathlib
import re
import struct
import urllib.request
import zlib
from pathlib import Path

BG_TOP = (0x1B, 0x20, 0x30)
BG_BOTTOM = (0x0B, 0x0D, 0x12)
RING_A = (0x5B, 0x8C, 0xFF)
RING_B = (0xA7, 0x8B, 0xFA)
PLAY = (0xF2, 0xF5, 0xFF)
MOON = (0x3E, 0xCF, 0x8E)

ROOT = Path(__file__).resolve().parent.parent


def smoothstep(edge, d):
    """Покрытие пикселя по расстоянию до края фигуры: 1 внутри, 0 снаружи."""
    t = (edge - d) / max(edge * 2, 1e-6) + 0.5
    return min(1.0, max(0.0, t))


def sd_rounded_rect(px, py, half, r):
    qx = abs(px) - half + r
    qy = abs(py) - half + r
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sd_polygon(px, py, pts):
    """Точный SDF выпуклого многоугольника: максимум расстояний до его сторон."""
    best = -1e9
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        ex, ey = bx - ax, by - ay
        length = math.hypot(ex, ey)
        # Нормаль наружу для обхода по часовой стрелке.
        nx, ny = ey / length, -ex / length
        best = max(best, (px - ax) * nx + (py - ay) * ny)
    return best


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def over(dst, src, alpha):
    return tuple(dst[i] + (src[i] - dst[i]) * alpha for i in range(3))


def render(size):
    s = float(size)
    aa = s / 512.0            # ширина полосы сглаживания в пикселях
    cx = cy = s / 2.0

    ring_r = 0.315 * s        # радиус средней линии орбиты
    ring_w = 0.052 * s        # половина толщины
    play_r = 0.014 * s        # скругление углов треугольника

    # Треугольник по часовой стрелке, слегка ужат — скругление добавит объём.
    tri = [
        (cx - 0.075 * s, cy - 0.115 * s),
        (cx + 0.135 * s, cy),
        (cx - 0.075 * s, cy + 0.115 * s),
    ]

    moon_a = math.radians(-52)
    mx = cx + math.cos(moon_a) * ring_r
    my = cy + math.sin(moon_a) * ring_r
    moon_r = 0.062 * s

    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # фильтр строки PNG
        py = y + 0.5
        for x in range(size):
            px = x + 0.5

            # Фон: скруглённый квадрат с вертикальным градиентом.
            d_bg = sd_rounded_rect(px - cx, py - cy, s / 2.0, 0.225 * s)
            bg_alpha = smoothstep(aa, d_bg)
            color = lerp(BG_TOP, BG_BOTTOM, py / s)

            # Орбита.
            d_ring = abs(math.hypot(px - cx, py - cy) - ring_r) - ring_w
            a = smoothstep(aa, d_ring)
            if a > 0:
                color = over(color, lerp(RING_A, RING_B, (px + py) / (2 * s)), a)

            # Спутник: тёмный ободок отделяет его от орбиты.
            d_moon = math.hypot(px - mx, py - my) - moon_r
            a = smoothstep(aa, d_moon + 0.022 * s)
            if a > 0:
                color = over(color, BG_BOTTOM, a)
            a = smoothstep(aa, d_moon)
            if a > 0:
                color = over(color, MOON, a)

            # Треугольник воспроизведения.
            a = smoothstep(aa, sd_polygon(px, py, tri) - play_r)
            if a > 0:
                color = over(color, PLAY, a)

            row += bytes(int(round(min(255, max(0, c)))) for c in color)
            row.append(int(round(255 * bg_alpha)))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, raw):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data))
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    print(f"{path.relative_to(ROOT)} — {size}×{size}, {len(png) / 1024:.1f} КБ")


def app_icons(size: int | None = None, out: str | None = None) -> None:
    # Одиночная иконка нужного размера — если попросили именно её.
    if size and out:
        write_png(Path(out), size, render(size))
        return

    # Исходник для `cargo tauri icon` и растровые копии для сайта.
    targets = [
        (1024, ROOT / "desktop/src-tauri/icons/icon.png"),
        (512, ROOT / "web/icon-512.png"),
        (192, ROOT / "web/icon-192.png"),
        (180, ROOT / "web/apple-touch-icon.png"),
        (32, ROOT / "web/favicon.png"),
    ]
    for size, path in targets:
        write_png(path, size, render(size))


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
    'pen': 'pen-to-square',
    'save': 'bookmark',
    'lock': 'lock',
    'unlock': 'lock-open',
    'paperclip': 'paperclip',
    'send': 'paper-plane',
    'download': 'download',
    'close': 'xmark',
    'expand': 'expand',
    'collapse': 'compress',
}

HEADER = f'''// Иконки интерфейса. Файл собран скриптом scripts/icons.py ui — правки
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


def ui_icons() -> None:
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
        '`scripts/icons.py ui`, там же список используемых иконок.\n\n'
        '* Иконки — CC BY 4.0: https://creativecommons.org/licenses/by/4.0/\n'
        '* Проект и лицензия целиком: https://fontawesome.com/license/free\n'
        '* Copyright Fonticons, Inc.\n'
    )
    print(f'\n{OUT}: {len(ICONS)} иконок')

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='what', required=True)
    one = sub.add_parser('app', help='иконки приложения из исходного рисунка')
    one.add_argument('--size', type=int, help='нарисовать одну иконку этого размера')
    one.add_argument('--out', help='куда её положить')
    sub.add_parser('ui', help='иконки интерфейса из Font Awesome')

    args = parser.parse_args()
    if args.what == 'app':
        app_icons(args.size, args.out)
    else:
        ui_icons()


if __name__ == '__main__':
    main()
