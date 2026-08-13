# Короткие команды для типовых задач. Всё то же самое можно набрать руками —
# см. README, здесь просто собраны рабочие сочетания флагов.

.PHONY: help server app app-debug android android-all android-prepare sign-apk icons icons-ui denoiser updater-key updater-pubkey docker docker-run deploy check browser clean

APP_DIR := desktop/src-tauri
ANDROID_HOME ?= $(or $(ANDROID_SDK_ROOT),$(HOME)/Library/Android/sdk)
# Ключ подписи. Android не ставит неподписанный пакет — «пакет повреждён» это
# как раз про него. Ключ рождается сам и лежит вне репозитория; сохраните его:
# обновление поверх установленного приложения требует того же ключа.
KEYSTORE ?= $(HOME)/.yeruverse/android.jks
# Пароль keystore хранится только локально рядом с ним; в CI он приходит из
# GitHub Secret. Старое значение оставлено для первого создания ключа с нуля.
KEY_PASS ?= $(shell test -r "$(KEYSTORE).password" && tr -d '\n' < "$(KEYSTORE).password" || printf %s yeruverse)
APK := $(CURDIR)/yeruverse.apk

help:
	@echo "make server      — собрать и запустить сервер (веб-версия на :8080)"
	@echo "make app         — собрать установщик под текущую систему (.dmg/.msi/.AppImage)"
	@echo "make app-debug   — запустить приложение без упаковки"
	@echo "make android     — собрать и подписать APK под arm64 (нужны ANDROID_HOME и NDK_HOME)"
	@echo "make android-all — то же, но под все архитектуры (дольше в четыре раза)"
	@echo "make icons       — перерисовать иконки приложения"
	@echo "make icons-ui    — пересобрать иконки интерфейса из Font Awesome"
	@echo "make denoiser    — обновить модели шумодава в web/vendor"
	@echo "make updater-key — создать ключ подписи обновлений (один раз на проект)"
	@echo "make docker      — собрать образ сервера"
	@echo "make deploy      — поднять сервер + HTTPS + TURN через compose"
	@echo "make check       — форматирование, clippy, тесты и проверка фронтенда"
	@echo "make browser     — прогон комнаты в настоящем браузере (нужен playwright)"

server:
	cargo run --release


# Установщик под ту систему, на которой запущено: кросс-компиляции у Tauri нет.
app: tauri-cli $(UPDATER_KEY)
	TAURI_SIGNING_PRIVATE_KEY="$$(cat $(UPDATER_KEY))" \
	TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(UPDATER_KEY_PASS)" \
	  scripts/build_app.sh
	@echo "Готовые файлы: $(APP_DIR)/target/release/bundle/"

app-debug:
	cd $(APP_DIR) && cargo run

# Только arm64: все живые телефоны на нём, а Rust собирается под каждую
# архитектуру заново — на остальных трёх уходит вчетверо больше времени.
android: android-prepare
	cd $(APP_DIR) && cargo tauri android build --apk --target aarch64
	@$(MAKE) --no-print-directory sign-apk

android-all: android-prepare
	cd $(APP_DIR) && cargo tauri android build --apk
	@$(MAKE) --no-print-directory sign-apk

# Проект под Android генерируется заново и в репозиторий не входит, поэтому
# каждый раз доводим его до рабочего вида: права на микрофон, уровень языка,
# иконки. Вручную это забывается ровно один раз — и потом ищется полдня.
android-prepare: tauri-cli $(KEYSTORE)
	@test -d $(APP_DIR)/gen/android || (cd $(APP_DIR) && cargo tauri android init)
	cd $(APP_DIR) && cargo tauri icon icons/icon.png
	python3 scripts/android_patch.py

# Выравниваем и подписываем свежайший из собранных пакетов.
sign-apk:
	@ANDROID_HOME="$(ANDROID_HOME)" KEYSTORE="$(KEYSTORE)" KEYSTORE_PASS="$(KEY_PASS)" \
	  scripts/sign_apk.sh "$(APK)"

$(KEYSTORE):
	@mkdir -p "$(dir $@)"
	keytool -genkeypair -keystore "$@" -alias yeruverse -keyalg RSA -keysize 2048 \
	  -validity 10000 -storepass "$(KEY_PASS)" -keypass "$(KEY_PASS)" -dname "CN=YeruVerse"
	@echo "Ключ подписи создан: $@ — сохраните его, иначе обновление не встанет поверх"

# Ключ подписи обновлений: создаётся один раз, живёт вне репозитория.
# Его же содержимое кладут в секрет TAURI_SIGNING_PRIVATE_KEY на GitHub.
UPDATER_KEY ?= $(HOME)/.yeruverse/updater.key
# Ключ зашифрован всегда. Пароль лежит рядом с приватным ключом только локально
# (этот файл не попадает в репозиторий); в CI его передаёт GitHub Secret.
UPDATER_KEY_PASS ?= $(shell test -r "$(UPDATER_KEY).password" && tr -d '\n' < "$(UPDATER_KEY).password")

updater-key: $(UPDATER_KEY)

$(UPDATER_KEY):
	@mkdir -p "$(dir $@)"
	cd $(APP_DIR) && cargo tauri signer generate --ci -p "$(UPDATER_KEY_PASS)" -w "$@"
	@$(MAKE) --no-print-directory updater-pubkey

# Публичный ключ в конфиге обязан соответствовать приватному: разойдутся — и
# обновления перестанут ставиться молча, без единой ошибки в логе.
updater-pubkey:
	@python3 -c 'import json,pathlib,sys; 	  c=pathlib.Path("$(APP_DIR)/tauri.conf.json"); d=json.loads(c.read_text()); 	  d.setdefault("plugins",{}).setdefault("updater",{})["pubkey"]=pathlib.Path("$(UPDATER_KEY).pub").read_text().strip(); 	  c.write_text(json.dumps(d,indent=2,ensure_ascii=False)+"\n"); 	  print("публичный ключ вписан в tauri.conf.json")'

# Иконки приложения для всех платформ рождаются из одного PNG 1024×1024.
icons:
	python3 scripts/icons.py app
	cd $(APP_DIR) && cargo tauri icon icons/icon.png

# Иконки интерфейса: пересобрать web/js/icons.js из Font Awesome Free.
icons-ui:
	python3 scripts/icons.py ui

# Модели шумодава в web/vendor: RNNoise и DeepFilterNet. Версии закреплены в
# самом скрипте — обновление модели меняет звук у всех сразу.
denoiser:
	python3 scripts/denoiser.py

tauri-cli:
	@cargo tauri --version > /dev/null 2>&1 && exit 0; \
	 cargo binstall --version > /dev/null 2>&1 \
	   && cargo binstall -y tauri-cli@'^2' \
	   || cargo install tauri-cli --version '^2' --locked

docker:
	docker build -t yeruverse .

docker-run: docker
	docker run --rm -p 8080:8080 yeruverse

deploy:
	docker compose up -d

check:
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cargo test
	python3 scripts/check_web.py
	cd $(APP_DIR) && cargo clippy --all-targets -- -D warnings

# Прогон комнаты в настоящем Chromium: два участника, WebRTC, чат, голос и
# раскладка телефона. Нужен запущенный `make server` в соседнем окне и
# playwright (`npm i playwright && npx playwright install chromium`).
browser:
	node scripts/room_check.mjs

clean:
	cargo clean
	cd $(APP_DIR) && cargo clean
