#!/usr/bin/env sh
# Выравнивание и подпись APK.
#
# Неподписанный пакет телефон не примет — скажет «пакет повреждён» или
# «недействителен». Тот же скрипт зовут и `make android`, и CI: раньше эта
# логика жила в двух местах и успела разойтись.
#
# Из окружения: ANDROID_HOME, KEYSTORE (файл ключа), KEYSTORE_PASS.
# Аргумент: куда положить подписанный APK (по умолчанию ./yeruverse.apk).
set -eu

out="${1:-yeruverse.apk}"
root="$(cd "$(dirname "$0")/.." && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"

tools="$(ls -d "$sdk"/build-tools/* 2>/dev/null | tail -1 || true)"
if [ -z "$tools" ]; then
  echo "не нашли build-tools в $sdk — задайте ANDROID_HOME" >&2
  exit 1
fi

raw="$(ls -t "$root"/desktop/src-tauri/gen/android/app/build/outputs/apk/*/release/*-unsigned.apk 2>/dev/null | head -1 || true)"
if [ -z "$raw" ]; then
  echo "не нашли собранный APK — сначала соберите его" >&2
  exit 1
fi

"$tools/zipalign" -f -p 4 "$raw" "$out"
"$tools/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:${KEYSTORE_PASS:-}" "$out"
echo "APK: $out"
