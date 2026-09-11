# Образ только упаковывает готовое: компиляция идёт снаружи, на раннере или на
# машине разработчика, — там она попадает под кэш cargo, который переживает
# сборки, чего кэш-маунты BuildKit не умеют. Экспортёр сохраняет лишь диффы
# слоёв, а у слоя со сборкой дифф пустой: собранное лежит в кэш-маунте и в образ
# не попадает. Из-за этого прежний двухступенчатый Dockerfile начинал
# зависимости с нуля в каждом прогоне, сколько бы слоёв ни лежало в кэше.
#
#     cargo build --locked --release --target x86_64-unknown-linux-musl
#     mkdir -p dist && cp target/x86_64-unknown-linux-musl/release/yeruverse dist/
#     cp -r web dist/web
#     docker build -f Dockerfile -t yeruverse dist
#
# Или просто `make docker` — он делает ровно это.
#
# Бинарник статический, поэтому в образе не нужно ни toolchain, ни libc, ни gcc.
# Корневые сертификаты тоже: reqwest собран с rustls, а корни у него свои,
# вкомпилированные. Видеотрафик через сервер не идёт, и образ намеренно
# крошечный.

FROM alpine:3.24
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
