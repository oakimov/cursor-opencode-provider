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
python3 "$ROOT/scripts/live-reply.py" "$stdout_file" "$stderr_file" "$code" "$model"
status=$?
set -e
exit "$status"
