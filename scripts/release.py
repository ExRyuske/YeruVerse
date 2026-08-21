#!/usr/bin/env python3
"""Выпуск версии: поднять номер и собрать манифест обновления.

    python3 scripts/release.py bump --part patch      # версия во всех пакетах
    python3 scripts/release.py manifest --tag v1.2.3 --dir dist

Это два шага одного дела, и держать под них два скрипта значило помнить два
имени вместо одного.

`bump` меняет только собственные пакеты в Cargo.toml и соответствующие записи
Cargo.lock — версии зависимостей не трогает, чтобы `cargo --locked` оставался
честной проверкой, а сервер, приложение и тег релиза не расходились.

`manifest` собирает `latest.json` — то, по чему приложение узнаёт о новой
версии. Он кладётся в тот же релиз, что и пакеты, а приложение забирает его по
постоянному адресу `releases/latest/download/latest.json`. Внутри — версия,
ссылки и подписи; без верной подписи установка не начнётся.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = 'ExRyuske/YeruVerse'
APP = ROOT / 'desktop/src-tauri'

PACKAGES = (
    (ROOT / 'Cargo.toml', ROOT / 'Cargo.lock', 'yeruverse'),
    (APP / 'Cargo.toml', APP / 'Cargo.lock', 'yeruverse-desktop'),
)
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')


# Кодировку и перевод строки задаём везде явно. Без этого Python берёт их из
# локали системы, и на раннере Windows (cp1252) первый же русский комментарий в
# Cargo.toml валит чтение, а запись переводит весь файл в CRLF. Пока скрипт жил
# только на ubuntu, этого не было видно.
def read(path: pathlib.Path) -> str:
    return path.read_text(encoding='utf-8')


def write(path: pathlib.Path, text: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def next_version(version: str, bump: str) -> str:
    match = VERSION.fullmatch(version)
    if not match:
        raise ValueError(f'нужна версия SemVer вида X.Y.Z, получено: {version}')
    major, minor, patch = map(int, match.groups())
    if bump == 'major':
        major, minor, patch = major + 1, 0, 0
    elif bump == 'minor':
        minor, patch = minor + 1, 0
    else:
        patch += 1
    return f'{major}.{minor}.{patch}'


def package_version(path: pathlib.Path, name: str) -> str:
    text = read(path)
    match = re.search(
        rf'(?ms)^\[package\]\nname = "{re.escape(name)}"\nversion = "([^"]+)"', text
    )
    if not match:
        raise ValueError(f'не нашли [package] {name} в {path.relative_to(ROOT)}')
    return match.group(1)


def replace_package_version(path: pathlib.Path, name: str, old: str, new: str) -> None:
    text = read(path)
    pattern = rf'(?ms)(^\[package\]\nname = "{re.escape(name)}"\nversion = "){re.escape(old)}(")'
    text, count = re.subn(pattern, rf'\g<1>{new}\g<2>', text)
    if count != 1:
        raise ValueError(f'не смогли однозначно обновить {path.relative_to(ROOT)}')
    write(path, text)


def replace_lock_version(path: pathlib.Path, name: str, old: str, new: str) -> None:
    text = read(path)
    pattern = rf'(?ms)(^name = "{re.escape(name)}"\nversion = "){re.escape(old)}(")'
    text, count = re.subn(pattern, rf'\g<1>{new}\g<2>', text)
    if count != 1:
        raise ValueError(f'не смогли однозначно обновить {path.relative_to(ROOT)}')
    write(path, text)


# Какой пакет для какой системы. macOS собирается только под Apple Silicon,
# поэтому Intel в манифест не попадает: обновлятель иначе скачал бы им
# приложение, которое не запустится.
#
# Имена не наши — их даёт `createUpdaterArtifacts`, и под Windows в Tauri 2 это
# сам установщик с подписью рядом (`-setup.exe.sig`, `.msi.sig`). Архивы
# `.nsis.zip`/`.msi.zip` остались в Tauri 1; пока мы искали их, в манифест не
# попадало ни одной записи для Windows — и обновление там молчало, хотя macOS
# обновлялся.
TARGETS = [
    ('.app.tar.gz', ['darwin-aarch64']),
    ('-setup.exe', ['windows-x86_64']),
    ('.msi', ['windows-x86_64']),
]


def cmd_bump(args: argparse.Namespace) -> None:
    versions = [package_version(manifest, name) for manifest, _, name in PACKAGES]
    if len(set(versions)) != 1:
        raise SystemExit(f'версии пакетов разошлись: {", ".join(versions)}')
    old = versions[0]
    new = next_version(old, args.part)

    if not args.dry_run:
        for manifest, lockfile, name in PACKAGES:
            replace_package_version(manifest, name, old, new)
            replace_lock_version(lockfile, name, old, new)
    print(f'v{old} -> v{new}')


def cmd_manifest(args: argparse.Namespace) -> None:
    version = args.tag.lstrip('v')

    # Версию манифеста берём из тега, а приложение о себе сообщает ту, что в
    # Cargo.toml. Разойдись они — обновлятель увидит новую версию, скачает
    # пакет, тот представится старой, и предложение появится снова. И так по
    # кругу, пока кто-нибудь не догадается сверить два числа.
    built = re.search(r'^version = "([^"]+)"', read(APP / 'Cargo.toml'), re.M)
    if not built:
        raise SystemExit('не нашли версию в Cargo.toml приложения')
    if built.group(1) != version:
        raise SystemExit(
            f'тег {args.tag} не совпадает с версией приложения {built.group(1)}.\n'
            'Поднимите version в desktop/src-tauri/Cargo.toml и повторите тег — '
            'иначе обновление будет предлагаться бесконечно.'
        )

    root = pathlib.Path(args.dir)
    platforms: dict[str, dict] = {}
    taken: set[pathlib.Path] = set()

    for suffix, keys in TARGETS:
        for sig in sorted(root.rglob(f'*{suffix}.sig')):
            taken.add(sig)
            archive = sig.with_suffix('')       # тот же файл без .sig
            if not archive.exists():
                print(f'нет пакета к подписи: {sig.name}', file=sys.stderr)
                continue
            entry = {
                'signature': read(sig).strip(),
                'url': f'https://github.com/{REPO}/releases/download/{args.tag}/{archive.name}',
            }
            # Первый найденный выигрывает: у NSIS и MSI одна и та же платформа,
            # а ставить лучше тем же способом, каким ставили изначально.
            for key in keys:
                platforms.setdefault(key, entry)

    # Подпись, которую мы не узнали, — это платформа, оставшаяся без обновления:
    # пакет собран и подписан, а в манифесте его нет, и там, где стоит эта
    # сборка, кнопки «Обновить» просто не появится. Молча так уже случилось
    # однажды, когда Tauri переименовал пакеты Windows, поэтому теперь кричим.
    if lost := sorted(set(root.rglob('*.sig')) - taken):
        raise SystemExit(
            'подписанные пакеты, которых нет в TARGETS: '
            + ', '.join(sig.name for sig in lost)
            + '\nОни собраны, но обновлятель их не увидит — поправьте TARGETS.'
        )

    if not platforms:
        raise SystemExit(
            'не нашли ни одного подписанного пакета обновления.\n'
            'Проверьте, что сборка шла с TAURI_SIGNING_PRIVATE_KEY и что в '
            'tauri.conf.json включён createUpdaterArtifacts.'
        )

    write(
        pathlib.Path(args.out),
        json.dumps(
            {
                'version': version,
                'notes': args.notes or f'Версия {version}',
                'pub_date': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                'platforms': platforms,
            },
            indent=2,
            ensure_ascii=False,
        )
        + '\n',
    )
    print(f'{args.out}: {args.tag}, платформы — {", ".join(sorted(platforms))}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)

    up = sub.add_parser('bump', help='повысить версию всех пакетов')
    up.add_argument('--part', required=True, choices=('patch', 'minor', 'major'))
    up.add_argument('--dry-run', action='store_true')
    up.set_defaults(run=cmd_bump)

    man = sub.add_parser('manifest', help='собрать latest.json из артефактов')
    man.add_argument('--tag', required=True, help='тег релиза, например v1.2.3')
    man.add_argument('--dir', default='dist', help='каталог с артефактами сборки')
    man.add_argument('--out', default='latest.json')
    man.add_argument('--notes', default='')
    man.set_defaults(run=cmd_manifest)

    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    main()
