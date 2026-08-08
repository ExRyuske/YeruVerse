#!/usr/bin/env python3
"""Собирает `latest.json` — то, по чему приложение узнаёт о новой версии.

Файл кладётся в тот же релиз GitHub, что и сами пакеты, а приложение забирает
его по постоянному адресу `releases/latest/download/latest.json`. Внутри —
версия, ссылки на пакеты и их подписи; без верной подписи установка не
начнётся, поэтому подделать обновление, подменив ответ, нельзя.

    python3 scripts/latest_json.py --tag v1.2.3 --dir dist --out latest.json

`--dir` — каталог со скачанными артефактами сборки (как их складывает
`actions/download-artifact`): архивы обновления и файлы `.sig` рядом.
"""

import argparse
import datetime as dt
import json
import pathlib
import sys

REPO = 'ExRyuske/YeruVerse'

# Какой архив для какой системы. macOS собирается универсальным, поэтому один и
# тот же пакет обслуживает и Apple Silicon, и Intel.
TARGETS = [
    ('.app.tar.gz', ['darwin-aarch64', 'darwin-x86_64']),
    ('-setup.nsis.zip', ['windows-x86_64']),
    ('.msi.zip', ['windows-x86_64']),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', required=True, help='тег релиза, например v1.2.3')
    ap.add_argument('--dir', default='dist', help='каталог с артефактами сборки')
    ap.add_argument('--out', default='latest.json')
    ap.add_argument('--notes', default='')
    args = ap.parse_args()

    root = pathlib.Path(args.dir)
    platforms: dict[str, dict] = {}

    for suffix, keys in TARGETS:
        for sig in sorted(root.rglob(f'*{suffix}.sig')):
            archive = sig.with_suffix('')       # тот же файл без .sig
            if not archive.exists():
                print(f'нет пакета к подписи: {sig.name}', file=sys.stderr)
                continue
            entry = {
                'signature': sig.read_text().strip(),
                'url': f'https://github.com/{REPO}/releases/download/{args.tag}/{archive.name}',
            }
            # Первый найденный выигрывает: у NSIS и MSI одна и та же платформа,
            # а ставить лучше тем же способом, каким ставили изначально.
            for key in keys:
                platforms.setdefault(key, entry)

    if not platforms:
        raise SystemExit(
            'не нашли ни одного подписанного пакета обновления.\n'
            'Проверьте, что сборка шла с TAURI_SIGNING_PRIVATE_KEY и что в '
            'tauri.conf.json включён createUpdaterArtifacts.'
        )

    pathlib.Path(args.out).write_text(
        json.dumps(
            {
                'version': args.tag.lstrip('v'),
                'notes': args.notes or f'Версия {args.tag.lstrip("v")}',
                'pub_date': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                'platforms': platforms,
            },
            indent=2,
            ensure_ascii=False,
        )
        + '\n'
    )
    print(f'{args.out}: {args.tag}, платформы — {", ".join(sorted(platforms))}')


if __name__ == '__main__':
    main()
