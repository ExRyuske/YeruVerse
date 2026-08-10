#!/usr/bin/env sh
# Сборка установщиков приложения.
#
# Один и тот же путь у `make app` и у CI — иначе сборка «работает у меня» и
# падает на сервере по причине, которой в Makefile не видно.
#
# Ключ подписи обновлений берётся из TAURI_SIGNING_PRIVATE_KEY. Без него пакеты
# обновления не собираются вовсе: Tauri останавливает сборку, если публичный
# ключ в конфигурации есть, а приватного нет, — а так бывает в форках, где
# секреты недоступны. Лучше собрать установщики без автообновления, чем не
# собрать ничего.
#
# Всё, что передано аргументами, уходит в `cargo tauri build` как есть.
set -eu

cd "$(dirname "$0")/../desktop/src-tauri"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "::warning::нет TAURI_SIGNING_PRIVATE_KEY — собираем без пакетов обновления"
  exec cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
fi

# Ключ — одна строка base64. Перенос строки или пробел, попавшие при
# копировании через буфер, ломают разбор с невразумительным «Missing comment in
# secret key», поэтому чистим сами и проверяем заранее.
TAURI_SIGNING_PRIVATE_KEY="$(printf %s "$TAURI_SIGNING_PRIVATE_KEY" | tr -d '[:space:]')"
export TAURI_SIGNING_PRIVATE_KEY
# Пароль передаём всегда: без переменной Tauri ждёт ввода с клавиатуры, а в CI
# вводить некому.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

case "$TAURI_SIGNING_PRIVATE_KEY" in
  dW50cnVzdGVkIGNvbW1lbnQ6*) ;;
  *)
    echo "::error::TAURI_SIGNING_PRIVATE_KEY не похож на ключ. Нужно всё содержимое файла ~/.yeruverse/updater.key целиком — одна длинная строка base64, начинается с dW50cnVzdGVkIGNvbW1lbnQ6. Не путайте с updater.key.pub и не вставляйте расшифрованный текст ключа." >&2
    exit 1
    ;;
esac

exec cargo tauri build "$@"
