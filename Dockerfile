# Образ только упаковывает готовое: компиляция идёт снаружи, на раннере или на
# машине разработчика, — там она попадает под кэш cargo, который переживает
# сборки, чего кэш-маунты сборщика не умеют. Экспортёр сохраняет лишь диффы
# слоёв, а у слоя со сборкой дифф пустой: собранное лежит в кэш-маунте и в образ
# не попадает. Из-за этого прежний двухступенчатый Dockerfile начинал
# зависимости с нуля в каждом прогоне, сколько бы слоёв ни лежало в кэше.
#
#     cargo build --locked --release --target x86_64-unknown-linux-musl
#     mkdir -p dist && cp target/x86_64-unknown-linux-musl/release/yeruverse dist/
#     cp -r web dist/web
#     podman build --format docker --file Dockerfile -t yeruverse dist
#
# `--file` обязателен: контекст здесь — `dist`, а сам файл лежит рядом с ним, и
# без флага podman ищет его внутри контекста и не находит.
#
# Или просто `make image` — он делает ровно это.
#
# Собирает podman, а файл по-прежнему зовётся Dockerfile, хотя роднее ему было
# бы имя Containerfile: podman читает оба, а вот Dependabot ищет обновления базы
# по имени. Переименование стоило бы молчаливой потери обновлений `alpine`, и
# ради одного лишь названия платить за это незачем.
#
# `--format docker` — не про Docker, а про HEALTHCHECK ниже: у формата OCI такого
# поля нет, и podman по умолчанию собирает именно в него, выбрасывая проверку
# здоровья с одним предупреждением в выводе. Без неё `podman ps` никогда не
# скажет `(healthy)`, и «поднялся» перестанет отличаться от «поднялся и не
# отвечает» — а это ровно то, что смотрят первым делом, когда комната не
# открывается.
#
# Бинарник статический, поэтому в образе не нужно ни toolchain, ни libc, ни gcc.
# Корневые сертификаты тоже: reqwest собран с rustls, а корни у него свои,
# вкомпилированные. Видеотрафик через сервер не идёт, и образ намеренно
# крошечный.

FROM docker.io/library/alpine:3.24
# Системный пользователь без пароля и шелла; wget для HEALTHCHECK уже в busybox.
RUN adduser -S -H -u 10001 yeruverse
WORKDIR /app

COPY yeruverse /usr/local/bin/yeruverse
COPY web /app/web

ENV WEB_DIR=/app/web \
    PORT=8080 \
    RUST_LOG=yeruverse=info

USER yeruverse
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["yeruverse"]
