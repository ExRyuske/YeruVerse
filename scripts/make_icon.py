#!/usr/bin/env python3
"""Генератор иконки YeruVerse.

Рисует ту же фигуру, что и web/icon.svg: тёмный скруглённый квадрат, орбита
градиентом, треугольник воспроизведения и спутник на орбите. Сглаживание —
через знаковые расстояния (SDF), поэтому картинка чистая на любом размере и
никаких сторонних библиотек не нужно.

    python3 scripts/make_icon.py            # все размеры по умолчанию
    python3 scripts/make_icon.py 1024 out.png
"""

import math
import struct
import sys
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


def main():
    if len(sys.argv) == 3:
        size, out = int(sys.argv[1]), Path(sys.argv[2])
        write_png(out, size, render(size))
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


if __name__ == "__main__":
    main()
