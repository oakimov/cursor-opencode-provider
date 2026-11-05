#!/usr/bin/env python3
"""Mechanical checks for one review diff.

The diff is stdin. Names are a NUL-separated file. Rules are read from
<review-root>/.cursor/rules. Prints the rules that apply to the diff and any
mechanical findings. Exit 0 when no high finding is present, 1 when one is,
and 2 when the inputs cannot be read. This is not the review.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SECRET = re.compile(r"crsr_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}")
SKIPPED_TEST = re.compile(r"^\+.*\b(it|test|describe)\.(skip|todo)\b")
COMPAT_IMPORT = re.compile(
    r"""^\+.*(?:from|import|require\()\s*['"](?:@opencode-compat/|[^'"]*opencode-plugin-compat)"""
)
DELETED_TEST = re.compile(r"^diff --git a/(test/.+\.test\.ts) b/\1$")
TEST_FILE = re.compile(r"^test/.+\.test\.ts$")
EXPORT_V2 = re.compile(r"\bexport\b[^;]*\bCursorPluginV2\b", re.S)


def glob_to_re(pattern: str) -> re.Pattern[str]:
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def read_names(path: Path) -> list[str]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise SystemExit(f"cannot read names: {exc.strerror}") from exc
    return [part.decode("utf-8", "surrogateescape") for part in data.split(b"\0") if part]


def parse_rule(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"{path.name}: {exc.strerror}") from exc
    if not text.startswith("---"):
        raise ValueError(f"{path.name}: missing opening frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"{path.name}: missing closing frontmatter")
    _, meta, body = parts
    info = {"file": path.name, "always": "false", "globs": "", "id": path.stem, "severity": ""}
    for line in meta.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip().strip("'\"")
        if key == "alwaysApply":
            info["always"] = value
        elif key == "globs":
            info["globs"] = value
    match = re.search(r"^Greptile id: (\S+)", body, re.M)
    if match:
        info["id"] = match.group(1)
    match = re.search(r"^Severity: (\S+)", body, re.M)
    if match:
        info["severity"] = match.group(1)
    return info


def load_rules(rules_dir: Path) -> list[dict[str, str]]:
    if not rules_dir.is_dir():
        raise ValueError(f"{rules_dir}: not a directory")
    return [parse_rule(path) for path in sorted(rules_dir.glob("*.mdc"))]


def rule_matches(info: dict[str, str], names: list[str]) -> bool:
    if info["always"] == "true":
        return True
    patterns = [glob_to_re(part.strip()) for part in info["globs"].split(",") if part.strip()]
    return any(pattern.match(name) for name in names for pattern in patterns)


def added_lines(diff: str) -> list[str]:
    return [line for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++")]


def strip_ts_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//.*?$", "", source, flags=re.M)


def deleted_tests(diff: str, extra: list[str]) -> list[str]:
    found: list[str] = []
    pending: str | None = None
    for line in diff.splitlines():
        match = DELETED_TEST.match(line)
        if match:
            pending = match.group(1)
            continue
        if pending and line.startswith("deleted file mode"):
            found.append(pending)
            pending = None
            continue
        if pending and line.startswith("diff --git"):
            pending = None
    for name in extra:
        if TEST_FILE.match(name) and name not in found:
            found.append(name)
    return found


def findings(
    diff: str,
    names: list[str],
    index_source: str | None,
    deleted_names: list[str],
) -> list[tuple[str, str, str]]:
    added = added_lines(diff)
    result: list[tuple[str, str, str]] = []
    if SECRET.search("\n".join(added)):
        result.append(("high", "no-secrets", "Diff adds secret-like material. Remove it before merge."))
    if any(SKIPPED_TEST.search(line) for line in added):
        result.append(("high", "no-weakened-tests", "Diff adds a skipped or todo test."))
    removed = deleted_tests(diff, deleted_names)
    if removed:
        result.append(("high", "no-weakened-tests", "Deleted test files: " + ", ".join(removed)))
    if index_source is not None and EXPORT_V2.search(strip_ts_comments(index_source)):
        result.append((
            "high",
            "entrypoints",
            "src/index.ts exports CursorPluginV2. The v2 plugin stays off the package root.",
        ))
    if any(COMPAT_IMPORT.search(line) for line in added):
        result.append(("high", "provider-boundary", "Diff adds a compatibility-package import."))
    if any(name.startswith("src/") for name in names) and "CHANGELOG.md" not in names:
        result.append((
            "medium",
            "changelog",
            "src/ changed and CHANGELOG.md did not. Add an Unreleased line if the change is user-facing.",
        ))
    return result


def index_source(root: Path, names: list[str]) -> str | None:
    if "src/index.ts" not in names:
        return None
    index = (root / "src" / "index.ts").resolve()
    if not index.is_relative_to(root.resolve()):
        raise ValueError("refusing to read src/index.ts outside the review root")
    if not index.is_file():
        return None
    return index.read_text(encoding="utf-8")


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("usage: review-diff.py <review-root> <names-file> [deleted-names]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    try:
        names = read_names(Path(sys.argv[2]))
        deleted_names = read_names(Path(sys.argv[3])) if len(sys.argv) == 4 else []
        rules = load_rules(root / ".cursor" / "rules")
        source = index_source(root, names)
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"RULE_PARSE {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"RULE_PARSE {exc.strerror}", file=sys.stderr)
        return 2

    print("Rules in scope (.cursor/rules):")
    for info in rules:
        if rule_matches(info, names):
            print(f"- [{info['severity'] or 'context'}] {info['id']} ({info['file']})")
    found = findings(sys.stdin.read(), names, source, deleted_names)
    high = 0
    medium = 0
    for severity, rule_id, message in found:
        print(f"FINDING severity={severity} id={rule_id}: {message}")
        if severity == "high":
            high += 1
        elif severity == "medium":
            medium += 1
    print(f"DIFF_RESULT high={high} medium={medium}")
    return 1 if high else 0


if __name__ == "__main__":
    raise SystemExit(main())
