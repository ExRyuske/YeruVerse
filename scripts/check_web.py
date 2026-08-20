#!/usr/bin/env python3
"""Проверка фронтенда без сборщика и без node.

Модули собирает сам браузер, поэтому опечатка в имени импорта или в
идентификаторе элемента ничем не ловится до открытия страницы — а открывается
она уже у человека. Здесь проверяется то, что можно проверить чтением:

* импортируется только то, что и правда экспортировано;
* каждый `$('#id')` и `ui('#id')` есть в разметке;
* модули не ходят по кругу — при циклическом импорте один из модулей начинает
  работу с недоинициализированным соседом, и падает это не всегда и не сразу;
* синтаксис (только macOS: разбор через JavaScriptCore, если он есть).

Запуск: `python3 scripts/check_web.py` из корня репозитория.
"""

import re
import subprocess
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
JS = WEB / "js"

IMPORT_RE = re.compile(
    r"^import\s+(?:(?P<names>\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?"
    r"['\"](?P<src>[^'\"]+)['\"]",
    re.MULTILINE | re.DOTALL,
)
EXPORT_DECL_RE = re.compile(
    r"^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(?P<name>[\w$]+)",
    re.MULTILINE,
)
EXPORT_LIST_RE = re.compile(r"^export\s*\{(?P<names>[^}]*)\}", re.MULTILINE)
SELECTOR_RE = re.compile(r"(?<![\w.])(?:\$|ui)\(\s*['\"]#([\w-]+)['\"]")
ID_RE = re.compile(r"\bid=[\"']([\w-]+)[\"']")
PAINTER_RE = re.compile(r"painter\(\s*['\"]([\w-]+)['\"]")
RENDER_RE = re.compile(r"(?<![\w.])render\((?P<args>[^)]*)\)")

# Объявления, после которых имя можно звать: функции, классы, переменные,
# методы класса и параметры-обработчики.
DECL_RE = re.compile(
    r"\b(?:function|class)\s+([\w$]+)"
    r"|\b(?:const|let|var)\s+([\w$]+)"
    r"|^\s+(?:async\s+|static\s+|get\s+|set\s+|\*)*([\w$]+)\s*\([^)]*\)\s*\{",
    re.MULTILINE,
)
# Точка перед именем — это обращение к свойству: `obj.foo()` зовёт не `foo`.
# Но три точки подряд — оператор расширения, и за ним стоит самое обычное имя:
# `...list.map()` и `...make(...)`. Пока это различие не делалось, всё после
# `...` было для проверки невидимо — вместе с ошибками в нём.
NOT_MEMBER = r"(?:(?<![\w$.'\"])|(?<=\.\.\.))"
CALL_RE = re.compile(NOT_MEMBER + r"([a-z_$][\w$]*)\s*\(")
# Разбор по месту: `const { a, b } = ...`, `const [{ c }] = ...`.
UNPACK_RE = re.compile(r"\b(?:const|let|var)\s*([\[{][^=;]*[\]}])\s*=")

# Всё, что даёт браузер. Своего здесь нет — только то, что есть на странице
# всегда, поэтому список короткий и почти не растёт.
BROWSER = set(
    """
    document window navigator location history console alert
    setTimeout setInterval clearTimeout clearInterval queueMicrotask
    fetch atob btoa isNaN parseInt parseFloat encodeURIComponent decodeURIComponent
    structuredClone requestAnimationFrame matchMedia getComputedStyle
    if for while switch catch return typeof new delete void await async of in do else try
    function class super this import
    """.split()
)


def strip_comments(src):
    """Строки и комментарии часто содержат то, что похоже на код."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return re.sub(r"(?<![:\w])//[^\n]*", "", src)


def strip_strings(src):
    """Убирает текст строк, но не то, что в них подставляют.

    Внутри `${...}` живёт обычный код — и вызовы оттуда ничем не отличаются от
    остальных. Пока шаблонные строки вырезались целиком, половина вызовов в
    проекте была для проверки невидима.
    """
    src = re.sub(r"'[^'\n]*'|\"[^\"\n]*\"", "''", src)
    keep = lambda m: " ".join(re.findall(r"\$\{([^{}]*)\}", m.group(0)))
    return re.sub(r"`[^`]*`", keep, src)


def parse_names(chunk):
    """Пары «что просят у соседа» и «как зовут здесь»: `label as hotkeyLabel`."""
    names = []
    for part in chunk.strip().strip("{}").split(","):
        part = part.strip()
        if not part:
            continue
        halves = [h.strip() for h in part.split(" as ")]
        names.append((halves[0], halves[-1]))
    return names


def module_facts(path):
    src = strip_comments(path.read_text())

    exports = set(EXPORT_DECL_RE.findall(src))
    for chunk in EXPORT_LIST_RE.findall(src):
        exports.update(name for name, _ in parse_names(chunk))

    imports = []
    for m in IMPORT_RE.finditer(src):
        if not m.group("src").startswith("."):
            continue
        wanted = [pair for pair in parse_names(m.group("names") or "") if pair[0] != "*"]
        imports.append((m.group("src"), wanted))

    # Тело без строк импорта: по нему видно, пользуются ли тем, что попросили.
    body = IMPORT_RE.sub("", src)
    selectors = set(SELECTOR_RE.findall(src))
    return exports, imports, selectors, body


def check():
    problems = []
    modules = sorted(JS.glob("*.js"))
    facts = {p.name: module_facts(p) for p in modules}

    known_ids = set()
    for page in WEB.glob("*.html"):
        known_ids.update(ID_RE.findall(page.read_text()))

    graph = {}
    for name, (_, imports, selectors, body) in facts.items():
        graph[name] = []
        for src_path, wanted in imports:
            target = Path(src_path).name
            if target not in facts:
                problems.append(f"{name}: импортирует несуществующий {src_path}")
                continue
            graph[name].append(target)
            for asked, local in wanted:
                if asked not in facts[target][0]:
                    problems.append(f"{name}: {target} не экспортирует {asked}")
                elif not re.search(NOT_MEMBER + rf"{re.escape(local)}(?![\w$])", body):
                    problems.append(f"{name}: импорт {local} не используется")

        for sel in sorted(selectors):
            if sel not in known_ids:
                problems.append(f"{name}: в разметке нет #{sel}")

    problems += cycles(graph)
    problems += painters(facts)
    problems += undeclared(facts)
    return problems


def undeclared(facts):
    """Зовут функцию, которую модуль не объявил и не импортировал.

    Ровно та ошибка, которую переезд кода между модулями и оставляет: вызов
    переехал, импорт — нет. Браузер сообщит о ней только на том месте, куда
    дошёл выполнением, то есть в чужих руках.
    """
    problems = []
    for name, (_, imports, _, body) in sorted(facts.items()):
        src = strip_strings(body)
        known = set(BROWSER)
        for match in DECL_RE.finditer(src):
            known.update(g for g in match.groups() if g)
        for pattern in UNPACK_RE.findall(src):
            known.update(re.findall(r"[\w$]+", pattern))
        for _, wanted in imports:
            known.update(local for _, local in wanted)
        # Параметры функций и стрелок: до скобки уже разобрались, здесь — то,
        # что внутри них.
        for args in re.findall(r"\(([^()]*)\)\s*(?:=>|\{)", src):
            known.update(re.findall(r"[\w$]+", args))

        for call in CALL_RE.finditer(src):
            if call.group(1) not in known:
                problems.append(f"{name}: зовут {call.group(1)}(), а его негде взять")
    return problems


def painters(facts):
    """Просят перерисовать по имени — значит, кто-то должен это имя занимать."""
    known = set()
    for _, _, _, body in facts.values():
        known.update(PAINTER_RE.findall(body))

    problems = []
    for name, (_, _, _, body) in sorted(facts.items()):
        for call in RENDER_RE.finditer(body):
            for arg in re.findall(r"['\"]([\w-]+)['\"]", call.group("args")):
                if arg not in known:
                    problems.append(f"{name}: рисовать «{arg}» некому")
    return problems


def cycles(graph):
    """Обход в глубину: путь до узла, который уже лежит на текущем пути."""
    found, seen, path = [], set(), []

    def walk(node):
        if node in path:
            found.append(" -> ".join(path[path.index(node):] + [node]))
            return
        if node in seen:
            return
        seen.add(node)
        path.append(node)
        for nxt in graph.get(node, []):
            walk(nxt)
        path.pop()

    for node in sorted(graph):
        walk(node)
    return [f"циклический импорт: {c}" for c in sorted(set(found))]


def syntax():
    """Разбор через JavaScriptCore. Есть только на macOS — иначе пропускаем."""
    jxa = (
        "function run(argv) { try { new Function(argv[0]); return 'OK' } "
        "catch (e) { return 'ERR ' + e.message } }"
    )
    problems = []
    for path in sorted(JS.glob("*.js")):
        script = to_script(path.read_text())
        try:
            out = subprocess.run(
                ["osascript", "-l", "JavaScript", "-e", jxa, script],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return []
        answer = (out.stdout or out.stderr).strip()
        if answer != "OK":
            problems.append(f"{path.name}: {answer}")
    return problems


def to_script(src):
    """Модульный синтаксис — в скриптовый: `new Function` разбирает только его."""
    out, skip = [], False
    for line in src.splitlines():
        if skip:
            out.append("")
            skip = ";" not in line and not re.search(r"from\s+['\"].*['\"]", line)
            continue
        if re.match(r"^\s*import\b", line) and not re.search(r"import\s*\(", line):
            out.append("")
            skip = ";" not in line and not re.search(r"from\s+['\"].*['\"]", line)
            continue
        line = re.sub(r"^(\s*)export\s+(?!default\b)", r"\1", line)
        line = re.sub(r"^\s*export\s*\{[^}]*\}\s*;?", "", line)
        out.append(line)
    text = "\n".join(out).replace("import.meta.url", "''")
    return re.sub(r"\bimport\s*\(", "Promise.resolve(", text)


def main():
    problems = check() + syntax()
    for p in problems:
        print(p)
    count = len(list(JS.glob("*.js")))
    print(f"\n{count} модулей проверено, замечаний: {len(problems)}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
