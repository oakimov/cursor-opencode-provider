#!/usr/bin/env python3
"""Judge an OpenCode --format json transcript.

The assistant reply is the concatenation of text parts. It passes only when
that reply is exactly "pong". Other JSON strings and surrounding log lines
do not count. CURSOR_API_KEY is read from the environment for redaction and
is never taken from argv.
"""
from __future__ import annotations

import json
import os
import sys


def assistant_reply(transcript: str) -> str:
    chunks: list[str] = []
    for line in transcript.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "text":
            continue
        part = event.get("part")
        if not isinstance(part, dict) or part.get("type") != "text":
            continue
        text = part.get("text")
        if isinstance(text, str):
            chunks.append(text)
    return "".join(chunks).strip()


def reply_is_pong(transcript: str) -> bool:
    return assistant_reply(transcript) == "pong"


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: live-reply.py stdout stderr exit_code model", file=sys.stderr)
        return 2
    out_path, err_path, code_s, model = sys.argv[1:]
    code = int(code_s)
    key = os.environ.get("CURSOR_API_KEY", "")

    def redact(text: str) -> str:
        return text.replace(key, "[REDACTED]") if key else text

    raw = open(out_path, encoding="utf-8", errors="replace").read()
    err = open(err_path, encoding="utf-8", errors="replace").read()
    passed = code == 0 and reply_is_pong(raw)
    print(f"LIVE_TEST={'passed' if passed else 'failed'}")
    print(f"model={model}")
    print(f"opencode_exit={code}")
    if not passed:
        print("--- opencode stdout ---")
        print(redact(raw)[-4000:])
        print("--- opencode stderr ---")
        print(redact(err)[-4000:])
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
