#!/usr/bin/env bash
# Non-interactive OpenCode run against one checkout's built Cursor plugin.
# OPENCODE_CONFIG_ROOT selects the checkout (default: this repo).
# OPENCODE_REVIEW_HOME is the private OpenCode config/cache/data root.
# Required secret: CURSOR_API_KEY. No other secrets are read.
# Optional: OPENCODE_LIVE_MODEL (default cursor/composer-2.5).
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${OPENCODE_CONFIG_ROOT:-$SCRIPT_ROOT}"

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

OPENCODE_CONFIG_ROOT="$TREE" bash "$SCRIPT_ROOT/scripts/configure-opencode.sh"
if [[ -n "${OPENCODE_REVIEW_HOME:-}" ]]; then
  # shellcheck disable=SC1091
  source "$OPENCODE_REVIEW_HOME/env"
else
  # shellcheck disable=SC1091
  source "$TREE/.opencode-local/env"
fi
export OPENCODE_CONFIG_DIR CURSOR_OPENCODE2_DEV_ENTRY
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME TMPDIR
export CURSOR_REVIEW_PLUGIN_PATH CURSOR_REVIEW_PLUGIN_VERSION

echo "WORKTREE=$TREE"
echo "PLUGIN_PATH=$CURSOR_REVIEW_PLUGIN_PATH"
echo "PLUGIN_VERSION=$CURSOR_REVIEW_PLUGIN_VERSION"
echo "OPENCODE_CONFIG_DIR=$OPENCODE_CONFIG_DIR"

if ! command -v opencode >/dev/null 2>&1; then
  echo "LIVE_TEST=failed" >&2
  echo "opencode is not on PATH. Run scripts/cloud-agent-install.sh." >&2
  exit 1
fi

marker="CURSOR_REVIEW_PLUGIN=${CURSOR_REVIEW_PLUGIN_PATH} version=${CURSOR_REVIEW_PLUGIN_VERSION}"
list_out="$(mktemp)"
list_err="$(mktemp)"
cleanup_list() { rm -f "$list_out" "$list_err"; }
set +e
timeout 60 opencode plugin list --standalone --print-logs --log-level info >"$list_out" 2>"$list_err"
list_code=$?
set -e
if [[ "$list_code" -ne 0 ]] || ! grep -F "$marker" "$list_err" >/dev/null; then
  echo "LIVE_TEST=failed"
  echo "OpenCode did not load the worktree plugin."
  echo "expected=$marker"
  python3 - "$list_err" "$list_code" <<'PY'
import os, sys
path, code = sys.argv[1], sys.argv[2]
key = os.environ.get("CURSOR_API_KEY", "")
text = open(path, encoding="utf-8", errors="replace").read()
if key:
    text = text.replace(key, "[REDACTED]")
print(f"plugin_list_exit={code}")
print(text[-2000:])
PY
  cleanup_list
  exit 1
fi
cleanup_list
echo "PLUGIN_LOADED=$marker"

cd "$TREE"
model="${OPENCODE_LIVE_MODEL:-cursor/composer-2.5}"
prompt='Reply with exactly the word pong and nothing else.'
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
# Invoked by the EXIT trap below.
# shellcheck disable=SC2317
cleanup() { rm -f "$stdout_file" "$stderr_file"; }
trap cleanup EXIT

set +e
timeout 180 opencode run --standalone --auto --format json --log-level error \
  --model "$model" "$prompt" >"$stdout_file" 2>"$stderr_file"
code=$?
set -e

set +e
python3 "$SCRIPT_ROOT/scripts/live-reply.py" "$stdout_file" "$stderr_file" "$code" "$model"
status=$?
set -e
exit "$status"
