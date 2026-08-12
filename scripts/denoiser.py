#!/usr/bin/env python3
"""Обновить вендоренные шумодавы в web/vendor.

    python3 scripts/denoiser.py

Оба шумодава лежат в репозитории файлами, а не тянутся из чужой сети: политика
содержимого разрешает странице только свой сервер, да и обещание «ничего не
уходит наружу» стоит дороже пары мегабайт в репозитории.

* RNNoise — маленькая (150 КБ) и мгновенная модель, берётся из
  `@sapphi-red/web-noise-suppressor`;
* DeepFilterNet 3 — заметно лучше на настоящем шуме, но весит 18 МБ, поэтому
  включается по выбору и качается один раз. Берётся из `denoise-voice-clarity`:
  MIT, без зависимостей, и главное — ворклет там самодостаточный, то есть
  подключается как обычный файл, без сборщика.
"""

import io
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

VENDOR = Path(__file__).resolve().parent.parent / 'web/vendor'

# Версии закреплены: обновление модели меняет звук у всех сразу, и делать это
# случайной пересборкой не стоит.
PACKAGES = {
    'deepfilternet': {
        'npm': 'denoise-voice-clarity',
        'version': '0.2.2',
        'files': {
            'dist/voiceClarity.worklet.js': 'worklet.js',
            'dist/wasm/denoise_voice_core_bg.wasm': 'deepfilter.wasm',
            'LICENSE': 'LICENSE',
        },
        'notice': (
            '# denoise-voice-clarity {version}\n\n'
            'DeepFilterNet 3 в WebAssembly: ворклет `worklet.js` и модель\n'
            '`deepfilter.wasm` (18 МБ). Собран из пакета npm\n'
            '`denoise-voice-clarity` — https://github.com/rajan471/denoise-voice-clarity\n\n'
            'Пересобрать: `python3 scripts/denoiser.py`.\n\n'
            '* Лицензия MIT, полный текст — в файле LICENSE рядом.\n'
            '* Сама модель DeepFilterNet — https://github.com/Rikorose/DeepFilterNet\n'
        ),
    },
}


def fetch(name: str, version: str) -> tarfile.TarFile:
    url = f'https://registry.npmjs.org/{name}/-/{name.split("/")[-1]}-{version}.tgz'
    print(f'  качаем {url}')
    with urllib.request.urlopen(url, timeout=120) as resp:
        return tarfile.open(fileobj=io.BytesIO(resp.read()), mode='r:gz')


def install(target: str, spec: dict) -> None:
    out = VENDOR / target
    out.mkdir(parents=True, exist_ok=True)
    print(f'{target} ← {spec["npm"]}@{spec["version"]}')

    with fetch(spec['npm'], spec['version']) as tar:
        for src, dst in spec['files'].items():
            member = tar.extractfile(f'package/{src}')
            if member is None:
                raise SystemExit(f'в пакете нет {src}')
            data = member.read()
            (out / dst).write_bytes(data)
            print(f'  {dst:<20} {len(data) / 1024:.0f} КБ')

    (out / 'NOTICE.md').write_text(spec['notice'].format(version=spec['version']))


def main() -> None:
    if not VENDOR.exists():
        raise SystemExit(f'нет каталога {VENDOR}')
    for target, spec in PACKAGES.items():
        install(target, spec)
    print('\nготово. Проверьте размер: du -sh web/vendor/*')


if __name__ == '__main__':
    main()
