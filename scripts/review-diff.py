#!/usr/bin/env python3
"""Automated checks for scripts/review-pr.sh.

Reads a unified diff on stdin. Prints FINDING lines. Exits 1 when a high
finding is present. Searches added lines only, and reads the whole diff
before deciding, so an early match cannot hide a later one.
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
EXPORT_V2 = re.compile(r"\bexport\b[^;]*\bCursorPluginV2\b", re.S)


def added_lines(diff: str) -> list[str]:
    lines: list[str] = []
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            lines.append(line)
    return lines


def strip_ts_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//.*?$", "", source, flags=re.M)


def deleted_tests(diff: str) -> list[str]:
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
    return found


def findings(diff: str, names: list[str], index_source: str | None) -> list[tuple[str, str, str]]:
    added = added_lines(diff)
    added_text = "\n".join(added)
    result: list[tuple[str, str, str]] = []
    if SECRET.search(added_text):
        result.append(("high", "no-secrets", "Diff adds secret-like material. Remove it before merge."))
    if any(SKIPPED_TEST.search(line) for line in added):
        result.append(("high", "no-weakened-tests", "Diff adds a skipped or todo test."))
    removed = deleted_tests(diff)
    if removed:
        result.append(("high", "no-weakened-tests", "Deleted test files: " + ", ".join(removed)))
    if "src/index.ts" in names and index_source is not None:
        if EXPORT_V2.search(strip_ts_comments(index_source)):
            result.append((
                "high",
                "entrypoints",
                "src/index.ts exports CursorPluginV2. The v2 plugin must stay off the package root.",
            ))
    if any(COMPAT_IMPORT.search(line) for line in added):
        result.append(("high", "provider-boundary", "Diff adds a compatibility-package import."))
    if any(name.startswith("src/") for name in names) and "CHANGELOG.md" not in names:
        result.append((
            "medium",
            "changelog",
            "src/ changed and CHANGELOG.md did not. Confirm whether the change is user-facing.",
        ))
    return result


def main() -> int:
    diff = sys.stdin.read()
    names = [line for line in os_lines(sys.argv[1]) if line] if len(sys.argv) > 1 else []
    index_source = None
    if len(sys.argv) > 2 and sys.argv[2]:
        index_source = Path(sys.argv[2]).read_text(encoding="utf-8")
    found = findings(diff, names, index_source)
    high = False
    for severity, rule_id, message in found:
        print(f"FINDING severity={severity} id={rule_id}: {message}")
        high = high or severity == "high"
    return 1 if high else 0


def os_lines(path: str) -> list[str]:
    return Path(path).read_text(encoding="utf-8").splitlines()


if __name__ == "__main__":
    raise SystemExit(main())
