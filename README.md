# YeruVerse

[![CI](https://github.com/ExRyuske/YeruVerse/actions/workflows/ci.yml/badge.svg)](https://github.com/ExRyuske/YeruVerse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ExRyuske/YeruVerse?display_name=tag)](https://github.com/ExRyuske/YeruVerse/releases)

**Screens, voices and keyboards shared straight between people.** The server
only introduces them: video, audio, files, pointers and remote input travel
peer-to-peer and never pass through it.

Runs in any browser. The desktop app (Windows, macOS, Linux) adds what a web
page is not allowed to do: system-wide hotkeys, pointers drawn over every
window, injecting a guest's input, and a bridge to Sunshine. The Android build
keeps the room alive while you are off reading something else.

> Early days. Do not hand a room code — or your computer — to people you do not
> trust.

A room has exactly one secret: its **code**, which is also its address. Until
you know the code the room simply does not exist; there is no second password
to add. The code lives in the URL fragment (`#code`), so it never reaches the
server in a query string, and only an irreversible fingerprint of it is logged.
Rooms live in memory and vanish with the last participant — no database, no
chat history, no accounts, no cookies.

## In a room

Screen and camera share independently, several streams at once, each with its
own remembered volume. Voice goes over a full WebRTC mesh with RNNoise
suppression. Chat takes pasted images and dropped files, which download from a
swarm of peers rather than from the server. Everyone's pointer is visible over
the video.

Two ways to drive someone else's machine: **WebRTC input** straight from the
browser, and **Sunshine + Moonlight** when it has to be a game — full-screen
capture, virtual gamepad, millisecond latency.

The owner decides who gets in, **one person at a time**: every participant has
a padlock next to their name. While it is closed, they do not even learn the
Sunshine address.

## Running it

```bash
cargo run                       # http://localhost:8080, or: make server
cargo install tauri-cli --version '^2' --locked
make app                        # .dmg / .msi / .AppImage for the current OS
make android                    # signed arm64 APK
```

Two tabs on `http://localhost:8080/#test` are enough to see a room from the
inside. Across devices you need **HTTPS**: browsers hand out microphone and
screen capture only in a secure context. That is also why the app window loads
straight from the server instead of local files — add your own domain to
`desktop/src-tauri/capabilities/default.json`.

The APK signing key is created on the first `make android` at
`~/.yeruverse/android.jks`. **Keep it**: updates over an installed build are
only accepted from the same key.

| Variable | Purpose |
|---|---|
| `PORT`, `WEB_DIR` | HTTP port and static directory |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | TURN via Cloudflare (recommended) |
| `TURN_URL`, `TURN_USER`, `TURN_PASS`, `TURN_TTL` | any other TURN provider |

## Deploying

```bash
cp .env.example .env && $EDITOR .env    # domain and TURN keys
docker compose up -d                    # server + Caddy with HTTPS
```

The domain from `.env` must have an A record pointing at the host. The image
lives in `ghcr.io/exryuske/yeruverse`; GitHub packages are private by default,
so until you make it public `docker compose up` answers `unauthorized`.

**TURN** is what saves the connections that cannot be made directly — mobile
carriers and corporate networks hand out symmetric NAT. You do not need your own
coturn: the server mints short-lived Cloudflare credentials itself. Check with
`curl -s https://your-domain/config.json` — it should say `"turn": true`.

## Releasing

**`git push` to `main` is the whole procedure.** CI bumps the patch version,
tags it, builds the image, the installers and the APK, and publishes the
release. The app checks `releases/latest/download/latest.json` every six hours
and verifies the package signature against a built-in key.

By hand only for `minor`/`major` (Actions → CI → Run workflow) or to skip a
release (`[skip release]` in the commit message).

CI needs `contents: write` (Settings → Actions → General) and four secrets
(Settings → Secrets and variables → Actions), added **before** the first push —
otherwise the installers are built unsigned and nothing can ever update:

| Secret | Where it comes from |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `make updater-key`, then the **entire** contents of `~/.yeruverse/updater.key` — one base64 line starting with `dW50cnVzdGVkIGNvbW1lbnQ6` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contents of `~/.yeruverse/updater.key.password` |
| `ANDROID_KEYSTORE` | `base64 -i ~/.yeruverse/android.jks` |
| `ANDROID_KEYSTORE_PASS` | contents of `~/.yeruverse/android.jks.password` |

## Layout

```
src/                 server: WebSocket, in-memory rooms, ICE credentials
web/js/              front end: networking, WebRTC, voice, chat, pointers
desktop/src-tauri/   Tauri shell: input, hotkeys, overlay, Sunshine bridge
scripts/             icons, Android project patches, build, signing, release
```

Licences: **RNNoise** — BSD-3-Clause, **Font Awesome Free** — CC BY 4.0, both
under `web/vendor/`.
