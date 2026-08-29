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
# На macOS сюда же приезжает сертификат подписи приложения — из MAC_CERTIFICATE
# в CI или из ~/.yeruverse/macos.p12 на своей машине (см. scripts/mac_cert.sh).
# Без него приложение выходит подписанным «ad-hoc», а это значит, что после
# каждого обновления система заново спрашивает доступ к микрофону, к записи
# экрана и к управлению компьютером.
#
# Вместе с подписью Tauri включает hardened runtime, а в нём доступ к железу
# закрыт, пока он не открыт в entitlements.plist — отсюда там микрофон и
# камера. Комментариев в том файле нет намеренно: `plutil` их принимает, а
# разборщик самой системы (AMFI) спотыкается и подпись срывается с
# «syntax error near line N».
#
# Всё, что передано аргументами, уходит в `cargo tauri build` как есть.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/desktop/src-tauri"

# ------------------------------------------------------------ подпись macOS

# Связку ключей и список поиска надо вернуть как было, чем бы сборка ни
# кончилась: временная связка, оставшаяся в списке, ломает следующую сборку
# сообщением про неоднозначный сертификат.
keychain=''
keychains_saved=''
cleanup() {
  [ -n "$keychains_saved" ] && security list-keychains -d user -s $keychains_saved
  [ -n "$keychain" ] && security delete-keychain "$keychain" 2>/dev/null
  return 0
}

if [ "$(uname -s)" = "Darwin" ]; then
  cert=''
  cert_pass=''
  if [ -n "${MAC_CERTIFICATE:-}" ]; then
    cert="$(mktemp -t yeruverse-cert).p12"
    printf %s "$MAC_CERTIFICATE" | tr -d '[:space:]' | base64 --decode > "$cert"
    cert_pass="${MAC_CERTIFICATE_PASSWORD:-}"
  elif [ -f "${MAC_CERT:-$HOME/.yeruverse/macos.p12}" ]; then
    cert="${MAC_CERT:-$HOME/.yeruverse/macos.p12}"
    cert_pass="$(tr -d '\n' < "$cert.password" 2>/dev/null || true)"
  fi

  if [ -z "$cert" ]; then
    echo "::warning::нет сертификата macOS — приложение выйдет неподписанным, и права доступа слетят при следующем обновлении. Сделайте его: make mac-cert"
  else
    trap cleanup EXIT INT TERM
    keychain="$HOME/Library/Keychains/yeruverse-build.keychain-db"
    kpass="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"

    security delete-keychain "$keychain" 2>/dev/null || true
    security create-keychain -p "$kpass" "$keychain"
    security unlock-keychain -p "$kpass" "$keychain"
    # Без снятия таймаута связка запирается посреди долгой сборки, и подпись
    # падает в самом конце — после того, как всё уже скомпилировано.
    security set-keychain-settings -t 3600 -u "$keychain"
    security import "$cert" -P "$cert_pass" -T /usr/bin/codesign -k "$keychain"
    # Иначе `codesign` при обращении к ключу поднимает окно «разрешить доступ»,
    # которого в CI некому нажать, и сборка висит до таймаута.
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kpass" "$keychain" >/dev/null 2>&1

    # Tauri зовёт `codesign` без `--keychain`, поэтому связка должна стоять в
    # списке поиска — иначе ключа он не найдёт.
    keychains_saved="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
    security list-keychains -d user -s $keychains_saved "$keychain"

    # Имя сертификата и есть identity: по нему `codesign` выбирает ключ.
    # Проверять его через `find-identity` бессмысленно — самоподписанному он
    # говорит «0 valid identities», потому что смотрит на доверие, а подписывать
    # такой сертификат всё равно даёт.
    APPLE_SIGNING_IDENTITY="${MAC_CERT_NAME:-YeruVerse Code Signing}"
    export APPLE_SIGNING_IDENTITY
    echo "подпись macOS: $APPLE_SIGNING_IDENTITY"

    [ -n "${MAC_CERTIFICATE:-}" ] && rm -f "$cert"
  fi
fi

# ------------------------------------------------------- подпись обновлений

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "::warning::нет TAURI_SIGNING_PRIVATE_KEY — собираем без пакетов обновления"
  cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
  exit $?
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

# Не `exec`: он заменяет процесс, а вместе с ним пропадает и уборка временной
# связки ключей.
cargo tauri build "$@"
