#!/usr/bin/env sh
# Сертификат подписи приложения под macOS. Создаётся один раз на проект.
#
# Зачем он вообще нужен. macOS помнит выданные права (микрофон, запись экрана,
# «Универсальный доступ», мониторинг ввода) не по имени приложения и не по пути,
# а по его «designated requirement» — строчке, которую система выводит из
# подписи. У неподписанного приложения выводить не из чего, и система
# отступает к хешу самого кода. Хеш меняется от сборки к сборке, поэтому после
# каждого обновления все разрешения приходилось выдавать заново.
#
# С этим сертификатом требование выглядит так:
#
#     identifier "cc.yeru.yeruverse" and certificate root = H"<отпечаток>"
#
# и остаётся тем же самым в каждой следующей сборке — права переживают
# обновление. Проверено: два бандла с разным хешем кода дают одно требование.
#
# Сертификат самоподписанный, аккаунт Apple для этого не нужен. Чего он НЕ
# даёт: Gatekeeper по-прежнему не знает, кто автор, и при первой установке
# скажет «не удалось проверить разработчика» — открывать придётся через
# «Правая кнопка → Открыть». Это ровно то же, что и сейчас; чтобы убрать и
# это, нужен платный Developer ID и нотаризация.
#
# ГЛАВНОЕ: сохраните файл. Потеряете — сменится отпечаток, и права слетят у
# всех ещё один раз (а Gatekeeper сочтёт обновление другим приложением).
set -eu

CERT="${MAC_CERT:-$HOME/.yeruverse/macos.p12}"
PASS_FILE="$CERT.password"
# Имя, которым потом подписываем: оно уходит в APPLE_SIGNING_IDENTITY. Менять
# его нельзя — по нему `codesign` находит ключ в связке.
NAME="${MAC_CERT_NAME:-YeruVerse Code Signing}"

if [ -f "$CERT" ]; then
  echo "сертификат уже есть: $CERT"
else
  mkdir -p "$(dirname "$CERT")"
  # Пароль рождается сам и ложится рядом — как у ключа обновлений и keystore.
  # Два UUID вместо чтения /dev/urandom через канал: конструкция
  # `tr ... < /dev/urandom | head -c N` намертво вешала сборку в CI, где
  # SIGPIPE игнорируется и `tr` не узнаёт, что его читателя уже нет
  # (подробности — в scripts/build_app.sh).
  if [ ! -f "$PASS_FILE" ]; then
    printf %s "$(uuidgen)$(uuidgen)" > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
  fi
  pass="$(tr -d '\n' < "$PASS_FILE")"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # basicConstraints=CA:false и extendedKeyUsage=codeSigning обязательны:
  # без них `codesign` ключ просто не увидит. Доверие к сертификату при этом
  # не нужно — подписывать он даёт и недоверенным, `find-identity` о таком
  # говорит «0 valid identities», и это нормально.
  cat > "$tmp/cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $NAME
O  = YeruVerse
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

  # Двадцать лет: сертификат просроченный не тем, что подпись перестанет
  # работать, а тем, что его придётся менять — а смена и есть та самая потеря
  # прав, от которой всё это затевалось.
  openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cnf" -extensions v3 >/dev/null 2>&1
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -name "$NAME" -out "$CERT" -passout "pass:$pass" >/dev/null 2>&1
  chmod 600 "$CERT"

  echo "сертификат создан: $CERT"
  echo "пароль: $PASS_FILE"
fi

# То же самое, но для GitHub: содержимое секретов MAC_CERTIFICATE и
# MAC_CERTIFICATE_PASSWORD. Печатаем всегда — скрипт зовут и затем, чтобы
# перевыложить секреты, не создавая ключ заново.
echo
echo "Секреты репозитория (Settings → Secrets and variables → Actions):"
echo
echo "MAC_CERTIFICATE (одной строкой):"
base64 < "$CERT" | tr -d '\n'
echo
echo
echo "MAC_CERTIFICATE_PASSWORD:"
tr -d '\n' < "$PASS_FILE"
echo
