#!/usr/bin/env python3
"""Синхронно повышает SemVer-версию всех пакетов YeruVerse.

Скрипт намеренно не трогает версии зависимостей. Он меняет только собственные
пакеты в Cargo.toml и соответствующие записи Cargo.lock, чтобы `cargo --locked`
оставался честной проверкой и сервер, десктоп и тег релиза не расходились.
"""

from __future__ import annotations

import argparse
import pathlib
import re


ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGES = (
    (ROOT / 'Cargo.toml', ROOT / 'Cargo.lock', 'yeruverse'),
    (ROOT / 'desktop/src-tauri/Cargo.toml', ROOT / 'desktop/src-tauri/Cargo.lock', 'yeruverse-desktop'),
)
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')


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
    text = path.read_text()
    match = re.search(
        rf'(?ms)^\[package\]\nname = "{re.escape(name)}"\nversion = "([^"]+)"', text
    )
    if not match:
        raise ValueError(f'не нашли [package] {name} в {path.relative_to(ROOT)}')
    return match.group(1)


def replace_package_version(path: pathlib.Path, name: str, old: str, new: str) -> None:
    text = path.read_text()
    pattern = rf'(?ms)(^\[package\]\nname = "{re.escape(name)}"\nversion = "){re.escape(old)}(")'
    text, count = re.subn(pattern, rf'\g<1>{new}\g<2>', text)
    if count != 1:
        raise ValueError(f'не смогли однозначно обновить {path.relative_to(ROOT)}')
    path.write_text(text)


def replace_lock_version(path: pathlib.Path, name: str, old: str, new: str) -> None:
    text = path.read_text()
    pattern = rf'(?ms)(^name = "{re.escape(name)}"\nversion = "){re.escape(old)}(")'
    text, count = re.subn(pattern, rf'\g<1>{new}\g<2>', text)
    if count != 1:
        raise ValueError(f'не смогли однозначно обновить {path.relative_to(ROOT)}')
    path.write_text(text)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--bump', required=True, choices=('patch', 'minor', 'major'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    versions = [package_version(manifest, name) for manifest, _, name in PACKAGES]
    if len(set(versions)) != 1:
        raise SystemExit(f'версии пакетов разошлись: {", ".join(versions)}')
    old = versions[0]
    new = next_version(old, args.bump)

    if not args.dry_run:
        for manifest, lockfile, name in PACKAGES:
            replace_package_version(manifest, name, old, new)
            replace_lock_version(lockfile, name, old, new)
    print(f'v{old} -> v{new}')


if __name__ == '__main__':
    main()
