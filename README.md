# YeruVerse

[![Сборка](https://github.com/ExRyuske/YeruVerse/actions/workflows/ci.yml/badge.svg)](https://github.com/ExRyuske/YeruVerse/actions/workflows/ci.yml)
[![Релизы](https://img.shields.io/github/v/release/ExRyuske/YeruVerse?display_name=tag)](https://github.com/ExRyuske/YeruVerse/releases)

Комната, в которой показывают свой экран, разговаривают и при желании пускают
друг друга за компьютер. Работает в браузере; приложение для Windows, macOS,
Linux и Android добавляет системные сочетания, курсоры поверх окон, приём
чужого ввода и мост к Sunshine.

> Ранняя версия. Не открывайте комнату и доступ к компьютеру тем, кому не
> доверяете.

**Через сервер не идёт ничего тяжёлого**: он сводит участников по WebRTC и
передаёт чат. Видео, звук, файлы, курсоры и чужой ввод идут напрямую между
зрителями и защищены DTLS-SRTP. Комнаты живут в памяти — ни базы, ни истории,
ни учётных записей, ни cookie.

Секрет у комнаты один — её **код**, он же адрес: пока код неизвестен, комната
просто не находится. В ссылке он живёт во фрагменте (`#код`), в журнал сервера
попадает лишь необратимый отпечаток.

## Что в комнате

Экран и камера — независимо, в том числе несколько трансляций сразу, у каждой
своя громкость. Голос полной сеткой с подавлением шума RNNoise. Чат с
картинками из буфера и файлами, которые качаются роем участников. Курсоры всех
поверх видео. Управление чужим компьютером — по WebRTC прямо из браузера, а для
игр через **Sunshine** с **Moonlight**. Горячие клавиши, в приложении —
системные, работают даже из полноэкранной игры.

Пускать за свой компьютер решает хозяин, поимённо: в списке участников рядом с
каждым замок. Пока он закрыт, человек не знает даже адреса Sunshine.

## Запуск

```bash
cargo run                       # http://localhost:8080, или: make server
cargo install tauri-cli --version '^2' --locked
make app                        # .dmg / .msi / .AppImage под текущую систему
make android                    # APK под arm64, сразу подписанный
```

Двух вкладок на `http://localhost:8080/#test` хватает, чтобы увидеть комнату
изнутри. Между устройствами нужен **HTTPS**: микрофон и захват экрана браузеры
отдают только в защищённом контексте. Поэтому и окно приложения грузится прямо
с сервера — свой домен добавьте в
`desktop/src-tauri/capabilities/default.json`.

Ключ подписи APK создаётся при первом `make android` в `~/.yeruverse/android.jks`.
**Сохраните его**: обновление поверх установленного принимается только от того
же ключа.

| Переменная | Зачем |
|---|---|
| `PORT`, `WEB_DIR` | порт и каталог со статикой |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | TURN у Cloudflare (рекомендуется) |
| `TURN_URL`, `TURN_USER`, `TURN_PASS`, `TURN_TTL` | TURN у любого другого |

## Развёртывание

```bash
cp .env.example .env && $EDITOR .env    # домен и ключи TURN
docker compose up -d                    # сервер + Caddy с HTTPS
```

Домен из `.env` должен указывать A-записью на сервер. Образ лежит в
`ghcr.io/exryuske/yeruverse`; пакеты GitHub по умолчанию приватные, и до
открытия доступа `docker compose up` отвечает `unauthorized`.

**TURN** нужен там, где прямого соединения не выходит: мобильные операторы и
корпоративные сети раздают симметричный NAT. Свой coturn держать не надо —
сервер сам выпускает короткоживущие учётки Cloudflare. Проверка:
`curl -s https://ваш-домен/config.json` — должно быть `"turn": true`.

## Выпуск версии

**`git push` в `main` — и всё.** Сборка поднимает patch-версию, ставит тег,
собирает образ, установщики и APK и публикует релиз. Приложение раз в шесть
часов сверяется с `releases/latest/download/latest.json` и проверяет подпись
пакета встроенным ключом.

Руками — только `minor`/`major` (Actions → сборка → Run workflow) и отказ от
выпуска (`[skip release]` в сообщении коммита).

Нужны право `contents: write` (Settings → Actions → General) и четыре секрета
(Settings → Secrets and variables → Actions) — **до** первого push, иначе
установщики соберутся без подписи и обновляться будет нечем:

| Секрет | Где взять |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `make updater-key`, затем **всё содержимое** `~/.yeruverse/updater.key` — одна строка base64 от `dW50cnVzdGVkIGNvbW1lbnQ6` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | содержимое `~/.yeruverse/updater.key.password` |
| `ANDROID_KEYSTORE` | `base64 -i ~/.yeruverse/android.jks` |
| `ANDROID_KEYSTORE_PASS` | содержимое `~/.yeruverse/android.jks.password` |

## Структура

```
src/                 сервер: WebSocket, комнаты в памяти, выдача ICE
web/js/              фронтенд: сеть, WebRTC, голос, чат, курсоры, настройки
desktop/src-tauri/   оболочка Tauri: ввод, сочетания, оверлей, мост к Sunshine
scripts/             иконки, правки Android-проекта, сборка, подпись, выпуск
```

Почему что-то сделано именно так — в комментариях рядом с кодом.
Лицензии: **RNNoise** — BSD-3-Clause, **Font Awesome Free** — CC BY 4.0,
обе в `web/vendor/`.
