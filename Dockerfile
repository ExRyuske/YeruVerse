# Сервер комнат: сборка и рантайм разведены, в образ едет только бинарник и
# статика. Видеотрафик через сервер не идёт, поэтому образ намеренно крошечный.

FROM rust:1-alpine AS build
# musl-dev нужен линковщику; больше ничего ставить не приходится — всё дерево
# зависимостей чисто на Rust, без OpenSSL и прочей нативщины.
RUN apk add --no-cache musl-dev
WORKDIR /src

# Слой зависимостей отдельно: правки в src/ не пересобирают полкрейта.
COPY Cargo.toml Cargo.lock ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && echo '' > src/lib.rs \
 && cargo build --release --bin yeruverse \
 && rm -rf src

COPY src ./src
# Трогаем исходники, иначе cargo примет заглушки из слоя выше за свежие.
# Кэш реестра и target переживает пересборки образа: правка одной строки в
# src/ больше не тянет за собой скачивание и компиляцию всех зависимостей.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    touch src/main.rs src/lib.rs \
 && cargo build --release --bin yeruverse \
 && cp target/release/yeruverse /usr/local/bin/yeruverse

FROM alpine:3.24
# Системный пользователь без пароля и шелла; wget для HEALTHCHECK уже в busybox.
RUN adduser -S -H -u 10001 yeruverse
WORKDIR /app

COPY --from=build /usr/local/bin/yeruverse /usr/local/bin/yeruverse
COPY web /app/web

ENV WEB_DIR=/app/web \
    PORT=8080 \
    RUST_LOG=yeruverse=info

USER yeruverse
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["yeruverse"]
