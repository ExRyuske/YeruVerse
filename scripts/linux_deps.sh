#!/usr/bin/env sh
# Системные библиотеки для сборки под Linux — на любом дистрибутиве.
#
# Tauri на Linux не везёт с собой ничего: вебвью, оболочку окна и значки он
# берёт у системы. Без заголовочных файлов сборка падает на «webkit2gtk-4.1
# not found» задолго до нашего кода, и понять по этой строке, чего не хватает,
# невозможно.
#
# Устроено это проверкой, а не списком пакетов, по одной причине: имён у одной
# и той же библиотеки столько же, сколько дистрибутивов, и угадать их все
# нельзя. Зато у неё есть одно имя, общее для всех, — модуль pkg-config. Оно и
# взято за истину: сначала спрашиваем, чего не хватает, потом (если умеем)
# ставим, потом спрашиваем ещё раз. Незнакомый менеджер пакетов или чужие имена
# в знакомом не оставят человека ни с чем: он всё равно получит точный список
# недостающего — по именам, которые его дистрибутив обязан понимать.
#
#   scripts/linux_deps.sh           поставить и проверить
#   scripts/linux_deps.sh --check   только проверить, ничего не ставя
#
# Список ниже — ровно то, чего требует наше дерево: webkit2gtk и gtk+ для окна,
# librsvg для значков, libpulse для звука компьютера (`sysaudio.rs`), wayland и
# xkbcommon для ввода (enigo). X11 здесь нет: приложение работает только под
# Wayland.
set -eu

# Модули pkg-config, без которых сборки не будет.
NEED='webkit2gtk-4.1 gtk+-3.0 librsvg-2.0 libpulse-simple wayland-client xkbcommon'
# Индикатор в системном лотке называется двумя способами: Ayatana (нынешний) и
# наследный appindicator. Годится любой, поэтому проверяются они вместе.
NEED_ANY='ayatana-appindicator3-0.1 appindicator3-0.1'
# Программы, без которых не соберётся.
NEED_BIN='cc pkg-config'
# Нужны только упаковщику AppImage. Их отсутствие не мешает `cargo build`,
# поэтому о них говорим отдельно и мягче.
WANT_BIN='patchelf file'

say() { printf '%s\n' "$*"; }

have_pkgconfig() { command -v pkg-config >/dev/null 2>&1; }

# Чего не хватает. Печатает недостающее по одному в строке; пусто — всё есть.
#
# Без pkg-config проверить библиотеки нечем, но молчать о них нельзя: человек
# узнавал бы о недостающем по одной строке за запуск. Поэтому там, где спросить
# не у кого, перечисляем всё, что понадобится, — пусть список окажется длиннее
# нужного, это дешевле пяти заходов по кругу.
missing() {
  for b in $NEED_BIN; do
    command -v "$b" >/dev/null 2>&1 || say "$b"
  done
  if ! have_pkgconfig; then
    for m in $NEED; do say "$m (не проверено: нет pkg-config)"; done
    say "$(echo "$NEED_ANY" | tr ' ' '|') (не проверено: нет pkg-config)"
    return
  fi
  for m in $NEED; do
    pkg-config --exists "$m" 2>/dev/null || say "$m"
  done
  found=''
  for m in $NEED_ANY; do
    pkg-config --exists "$m" 2>/dev/null && found=1
  done
  [ -n "$found" ] || say "$(echo "$NEED_ANY" | tr ' ' '|')"
}

missing_optional() {
  for b in $WANT_BIN; do
    command -v "$b" >/dev/null 2>&1 || say "$b"
  done
}

report() {
  gaps="$(missing)"
  if [ -n "$gaps" ]; then
    say 'Не хватает (имена модулей pkg-config и программ):'
    say "$gaps" | sed 's/^/  /'
    return 1
  fi
  say 'Всё на месте: собирать можно.'
  extra="$(missing_optional)"
  if [ -n "$extra" ]; then
    say 'Для AppImage дополнительно нужны:'
    say "$extra" | sed 's/^/  /'
  fi
  return 0
}

if [ "${1:-}" = '--check' ]; then
  report
  exit $?
fi

# Ставим от root напрямую, иначе через sudo: в контейнерах sudo обычно нет.
if [ "$(id -u)" = 0 ]; then
  SUDO=''
elif command -v sudo >/dev/null 2>&1; then
  SUDO='sudo'
else
  say 'Нужны права root: запустите под sudo или поставьте пакеты сами.'
  say ''
  report || true
  exit 1
fi

# Ставим списком, а не встало списком — по одному.
#
# Одно неверное имя не должно стоить всей установки, а неверные имена
# неизбежны: пакеты переименовывают между выпусками, и таблица ниже устаревает
# сама собой. Проверено на живых системах: на Alpine несуществующий
# `libappindicator-dev` утянул за собой девять исправных пакетов, на Arch то же
# самое сделала устаревшая база. Поштучная установка превращает промах в одну
# пропущенную строку, а окончательный ответ всё равно даёт проверка ниже.
PM=''
install_pkgs() {
  # Слова в $SUDO и $PM разделяются намеренно: это команда с флагами.
  # shellcheck disable=SC2086
  if $SUDO $PM "$@" >/dev/null; then
    return 0
  fi
  say 'Списком не встало — ставим по одному, чтобы одно чужое имя не унесло остальные.'
  for pkg in "$@"; do
    # shellcheck disable=SC2086
    $SUDO $PM "$pkg" >/dev/null 2>&1 || say "  пропущено (нет такого пакета?): $pkg"
  done
}

# Имена пакетов — подсказка, а не истина: они разнятся даже между выпусками
# одного дистрибутива. Промах здесь не страшен — итог проверяется по
# pkg-config; страшно было бы промахнуться молча.
install() {
  if command -v pacman >/dev/null 2>&1; then
    # Arch и всё, что из него растёт: CachyOS, EndeavourOS, Manjaro.
    #
    # `-Sy` обязателен: в свежепоставленной системе (и в любом образе) база
    # пакетов устаревает, и без обновления pacman отвечает «target not found»
    # на совершенно обычные имена. Полного обновления системы (`-Syu`) не
    # делаем: на роллинге это решение хозяина машины, а не сборочного скрипта.
    PM="pacman -S --needed --noconfirm"
    $SUDO pacman -Sy --noconfirm >/dev/null
    install_pkgs webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg libpulse \
      wayland libxkbcommon base-devel pkgconf patchelf file
  elif command -v apt-get >/dev/null 2>&1; then
    # Debian, Ubuntu и потомки.
    PM="apt-get install -y --no-install-recommends"
    $SUDO apt-get update >/dev/null
    install_pkgs libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libpulse-dev libwayland-dev libxkbcommon-dev \
      build-essential pkg-config patchelf file
  elif command -v dnf >/dev/null 2>&1; then
    # Fedora, RHEL и пересборки.
    PM="dnf install -y"
    install_pkgs webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel \
      librsvg2-devel pulseaudio-libs-devel wayland-devel libxkbcommon-devel \
      gcc gcc-c++ make pkgconf-pkg-config patchelf file
  elif command -v zypper >/dev/null 2>&1; then
    # openSUSE. Имена вебвью там менялись не раз, поэтому просим не по имени
    # пакета, а по тому, что пакет предоставляет: zypper умеет искать по
    # модулю pkg-config, и это надёжнее любого списка имён.
    PM="zypper --non-interactive install -y"
    install_pkgs 'pkgconfig(webkit2gtk-4.1)' 'pkgconfig(gtk+-3.0)' \
      'pkgconfig(ayatana-appindicator3-0.1)' 'pkgconfig(librsvg-2.0)' \
      'pkgconfig(libpulse-simple)' 'pkgconfig(wayland-client)' \
      'pkgconfig(xkbcommon)' gcc gcc-c++ make pkg-config patchelf file
  elif command -v apk >/dev/null 2>&1; then
    # Alpine и прочий musl.
    PM="apk add --no-cache"
    install_pkgs webkit2gtk-4.1-dev gtk+3.0-dev libayatana-appindicator-dev \
      librsvg-dev pulseaudio-dev wayland-dev libxkbcommon-dev \
      build-base pkgconf patchelf file
  elif command -v xbps-install >/dev/null 2>&1; then
    # Void.
    PM="xbps-install -Sy"
    install_pkgs libwebkit2gtk41-devel gtk+3-devel libayatana-appindicator-devel \
      librsvg-devel pulseaudio-devel wayland-devel libxkbcommon-devel \
      base-devel pkg-config patchelf file
  elif command -v eopkg >/dev/null 2>&1; then
    # Solus.
    PM="eopkg install -y"
    $SUDO eopkg install -y -c system.devel >/dev/null 2>&1 || true
    install_pkgs libwebkit-gtk-41-devel libgtk-3-devel libappindicator-devel \
      librsvg-devel pulseaudio-devel wayland-devel libxkbcommon-devel \
      patchelf file
  else
    say 'Менеджер пакетов не узнан — поставьте недостающее сами.'
    say 'Имена пакетов у каждого дистрибутива свои, а вот это одинаково везде:'
    say ''
    report || true
    say ''
    say 'Ищите пакеты, которые предоставляют эти модули pkg-config; обычно они'
    say 'называются <имя>-dev или <имя>-devel. На NixOS вместо этого добавьте'
    say 'их в devShell, а не ставьте в профиль.'
    exit 1
  fi
}

# Ставить нечего — и не ставим: лишний поход в сеть на каждый запуск ни к чему.
if [ -z "$(missing)" ] && [ -z "$(missing_optional)" ]; then
  report
  exit 0
fi

install

say ''
# Итог — по pkg-config, а не по коду выхода менеджера пакетов: он бывает
# доволен и тогда, когда поставил не то. Единственный честный ответ на вопрос
# «можно ли теперь собирать» даёт сама система сборки.
report
