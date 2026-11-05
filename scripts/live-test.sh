#!/usr/bin/env bash
# Non-interactive OpenCode run against this checkout's Cursor provider.
# Required secret: CURSOR_API_KEY (a Cursor user API key). No other secrets are read.
# Optional: OPENCODE_LIVE_MODEL (default cursor/composer-2.5).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  cat <<'EOF'
LIVE_TEST=skipped
Live OpenCode test skipped.
Required secret: CURSOR_API_KEY
Set CURSOR_API_KEY to a Cursor user API key from https://cursor.com/settings.
The live test reads no other secrets and does not call Cursor when this variable is unset.
EOF
  exit 0
fi

bash "$ROOT/scripts/configure-opencode.sh" >/dev/null
# shellcheck disable=SC1091
source "$ROOT/.opencode-local/env"
export OPENCODE_CONFIG_DIR CURSOR_OPENCODE2_DEV_ENTRY

if ! command -v opencode >/dev/null 2>&1; then
  echo "LIVE_TEST=failed" >&2
  echo "opencode is not on PATH. Run scripts/cloud-agent-install.sh." >&2
  exit 1
fi

model="${OPENCODE_LIVE_MODEL:-cursor/composer-2.5}"
prompt='Reply with exactly the word pong and nothing else.'
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
cleanup() { rm -f "$stdout_file" "$stderr_file"; }
trap cleanup EXIT

set +e
timeout 180 opencode run --standalone --auto --format json --log-level error \
  --model "$model" "$prompt" >"$stdout_file" 2>"$stderr_file"
code=$?
set -e

set +e
python3 - "$CURSOR_API_KEY" "$stdout_file" "$stderr_file" "$code" "$model" <<'PY'
import json, pathlib, sys

key, out_path, err_path, code_s, model = sys.argv[1:]
code = int(code_s)

def redact(text: str) -> str:
    return text.replace(key, "[REDACTED]") if key else text

raw = pathlib.Path(out_path).read_text(encoding="utf-8", errors="replace")
err = pathlib.Path(err_path).read_text(encoding="utf-8", errors="replace")

def standalone_pong(text: str) -> bool:
    if any(line.strip() == "pong" for line in text.splitlines()):
        return True
    blobs = []
    try:
        blobs.append(json.loads(text))
    except json.JSONDecodeError:
        for line in text.splitlines():
            try:
                blobs.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    def walk(node):
        if isinstance(node, str):
            yield node
        elif isinstance(node, dict):
            for value in node.values():
                yield from walk(value)
        elif isinstance(node, list):
            for value in node:
                yield from walk(value)

    return any(value.strip() == "pong" for blob in blobs for value in walk(blob))

passed = code == 0 and standalone_pong(raw)
print(f"LIVE_TEST={'passed' if passed else 'failed'}")
print(f"model={model}")
print(f"opencode_exit={code}")
if not passed:
    print("--- opencode stdout ---")
    print(redact(raw)[-4000:])
    print("--- opencode stderr ---")
    print(redact(err)[-4000:])
sys.exit(0 if passed else 1)
PY
status=$?
set -e
exit "$status"
