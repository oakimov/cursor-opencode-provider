#!/usr/bin/env bash
# Non-interactive OpenCode run against one checkout's built Cursor plugin.
# OPENCODE_CONFIG_ROOT selects the checkout (default: this repo).
# OPENCODE_REVIEW_HOME is the private OpenCode config/cache/data root.
# Required secret: CURSOR_API_KEY. No other secrets are read.
# Optional: OPENCODE_LIVE_MODEL (default cursor/composer-2.5).
# LIVE_TEST_TIMEOUT, when set, is the deadline command (SECONDS COMMAND...).
# Otherwise GNU timeout or gtimeout is required. The script exits 1 if neither
# exists. LIVE_TEST_PYTHON, when set, is the interpreter used to read logs.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
# Cleanup can run while a command's stderr is redirected at a temp log.
# Keep the operator's stderr on fd 3 so that failure is not deleted with the log.
exec 3>&2
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

owned_files=()
owned_pids=()
live_process_table=""

# ${#name[@]} is safe for an empty array under set -u on bash 3.2.
# shellcheck disable=SC2317
live_count() {
  eval "printf '%s' \${#$1[@]}"
}

# shellcheck disable=SC2317
live_at() {
  eval "printf '%s' \"\${$1[$2]}\""
}

# Invoked by the EXIT trap below.
# shellcheck disable=SC2317
live_signal_tree() {
  local signal="$1" pid="$2" child ppid
  [[ -n "$live_process_table" ]] || return 0
  while read -r child ppid; do
    [[ "$ppid" == "$pid" ]] || continue
    live_signal_tree "$signal" "$child"
  done <<<"$live_process_table"
  kill "-$signal" "$pid" 2>/dev/null || true
}

# Invoked from the EXIT trap through cleanup_owned.
# A failed process listing is a cleanup failure. The process group is still
# signalled, including descendants that ignore TERM.
# shellcheck disable=SC2317
kill_owned() {
  local pid i n failed=0
  n="$(live_count owned_pids)"
  [[ "$n" -gt 0 ]] || return 0
  if ! live_process_table="$(ps -ax -o pid=,ppid= 2>/dev/null)"; then
    echo "LIVE_TEST=failed" >&3
    echo "Process listing failed. Cleanup cannot see descendants." >&3
    failed=1
    live_process_table=""
  fi
  i=0
  while [[ "$i" -lt "$n" ]]; do
    pid="$(live_at owned_pids "$i")"
    i=$((i + 1))
    [[ -n "$pid" ]] || continue
    kill -TERM -- "-$pid" 2>/dev/null || true
    live_signal_tree TERM "$pid"
  done
  sleep 0.2
  if ! live_process_table="$(ps -ax -o pid=,ppid= 2>/dev/null)"; then
    echo "LIVE_TEST=failed" >&3
    echo "Process listing failed. Cleanup cannot see descendants." >&3
    failed=1
    live_process_table=""
  fi
  i=0
  while [[ "$i" -lt "$n" ]]; do
    pid="$(live_at owned_pids "$i")"
    i=$((i + 1))
    [[ -n "$pid" ]] || continue
    kill -KILL -- "-$pid" 2>/dev/null || true
    live_signal_tree KILL "$pid"
  done
  i=0
  while [[ "$i" -lt "$n" ]]; do
    pid="$(live_at owned_pids "$i")"
    i=$((i + 1))
    [[ -n "$pid" ]] || continue
    wait "$pid" 2>/dev/null || true
    if kill -0 "$pid" 2>/dev/null; then
      failed=1
    fi
  done
  owned_pids=()
  live_process_table=""
  return "$failed"
}

# Invoked by the EXIT trap below.
# shellcheck disable=SC2317
cleanup_owned() {
  local status=$?
  trap - EXIT INT TERM
  if ! kill_owned; then
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  fi
  if [[ "$(live_count owned_files)" -gt 0 ]]; then
    rm -f "${owned_files[@]}"
  fi
  exit "$status"
}

trap cleanup_owned EXIT
trap 'exit 143' INT TERM

live_python() {
  if [[ -n "${LIVE_TEST_PYTHON:-}" && -x "${LIVE_TEST_PYTHON}" ]]; then
    printf '%s' "$LIVE_TEST_PYTHON"
    return 0
  fi
  command -v python3
}

live_deadline_bin() {
  local bin=""
  if [[ -n "${LIVE_TEST_TIMEOUT:-}" ]]; then
    if [[ -x "${LIVE_TEST_TIMEOUT}" ]]; then
      printf '%s' "$LIVE_TEST_TIMEOUT"
      return 0
    fi
    echo "LIVE_TEST=failed" >&2
    echo "LIVE_TEST_TIMEOUT is set but not executable: ${LIVE_TEST_TIMEOUT}" >&2
    return 1
  fi
  bin="$(command -v timeout || true)"
  if [[ -z "$bin" ]]; then
    bin="$(command -v gtimeout || true)"
  fi
  if [[ -z "$bin" ]]; then
    echo "LIVE_TEST=failed" >&2
    echo "A deadline command is required. Install GNU timeout or gtimeout, or set LIVE_TEST_TIMEOUT to an executable that accepts SECONDS COMMAND..." >&2
    return 1
  fi
  printf '%s' "$bin"
}

run_deadline() {
  local seconds="$1" bin pid code=0
  shift
  bin="$DEADLINE_BIN"
  # Own the session so cancellation can signal the group on Linux and macOS.
  # Do not enable errexit here: a nonzero wait would skip the caller's diagnostics.
  "$(live_python)" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$bin" "$seconds" "$@" &
  pid=$!
  owned_pids+=("$pid")
  wait "$pid" || code=$?
  owned_pids=()
  return "$code"
}

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

if ! DEADLINE_BIN="$(live_deadline_bin)"; then
  exit 1
fi

marker="CURSOR_REVIEW_PLUGIN=${CURSOR_REVIEW_PLUGIN_PATH} version=${CURSOR_REVIEW_PLUGIN_VERSION}"
init_line="CURSOR_REVIEW_PLUGIN_INIT count=1 path=${CURSOR_REVIEW_PLUGIN_PATH}"
list_out="$(mktemp)"
list_err="$(mktemp)"
owned_files+=("$list_out" "$list_err")
marker_count=0
list_init=0
list_code=0
# Plugin discovery can exit before the import log is flushed. Retry only
# while that log is absent. More than one import or setup fails immediately.
for _attempt in 1 2 3 4 5; do
  set +e
  run_deadline 60 opencode plugin list --standalone --print-logs --log-level info >"$list_out" 2>"$list_err"
  list_code=$?
  set -e
  marker_count=$(grep -c -F "$marker" "$list_err" || true)
  list_init=$(grep -c -F "CURSOR_REVIEW_PLUGIN_INIT " "$list_err" || true)
  if [[ "$list_code" -ne 0 || "$marker_count" -gt 1 || "$list_init" -gt 1 || "$marker_count" -eq 1 ]]; then
    break
  fi
  sleep 0.2
done
if [[ "$list_code" -ne 0 || "$marker_count" -ne 1 || "$list_init" -gt 1 ]]; then
  echo "LIVE_TEST=failed"
  echo "OpenCode did not load the worktree plugin once."
  echo "expected=$marker"
  echo "marker_count=$marker_count list_init=$list_init"
  "$(live_python)" - "$list_err" "$list_code" <<'PY'
import os, sys
path, code = sys.argv[1], sys.argv[2]
key = os.environ.get("CURSOR_API_KEY", "")
text = open(path, encoding="utf-8", errors="replace").read()
if key:
    text = text.replace(key, "[REDACTED]")
print(f"plugin_list_exit={code}")
print(text[-2000:])
PY
  exit 1
fi
echo "PLUGIN_LOADED=$marker"
echo "OPENCODE_CONFIG_BEGIN"
cat "$OPENCODE_CONFIG_DIR/opencode.json"
echo "OPENCODE_CONFIG_END"

cd "$TREE"
model="${OPENCODE_LIVE_MODEL:-cursor/composer-2.5}"
prompt='Reply with exactly the word pong and nothing else.'
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
owned_files+=("$stdout_file" "$stderr_file")

set +e
# info plus --print-logs, so the wrapper's setup log reaches stderr. The reply stays on stdout.
run_deadline 180 opencode run --standalone --print-logs --auto --format json --log-level info \
  --model "$model" "$prompt" >"$stdout_file" 2>"$stderr_file"
code=$?
set -e

init_count=$(grep -c -F "$init_line" "$stdout_file" "$stderr_file" || true)
init_any=$(grep -c -F "CURSOR_REVIEW_PLUGIN_INIT " "$stdout_file" "$stderr_file" || true)
# grep -c with two files prints "file:count" lines. Sum them.
init_count=$(printf '%s\n' "$init_count" | awk -F: '{ s += $NF } END { print s + 0 }')
init_any=$(printf '%s\n' "$init_any" | awk -F: '{ s += $NF } END { print s + 0 }')
if [[ "$init_count" -ne 1 || "$init_any" -ne 1 ]]; then
  echo "LIVE_TEST=failed"
  echo "OpenCode initialized the provider ${init_any} times."
  echo "expected=$init_line"
  "$(live_python)" - "$stderr_file" "$code" <<'PY'
import os, sys
path, code = sys.argv[1], sys.argv[2]
key = os.environ.get("CURSOR_API_KEY", "")
text = open(path, encoding="utf-8", errors="replace").read()
if key:
    text = text.replace(key, "[REDACTED]")
print(f"opencode_exit={code}")
print(text[-2000:])
PY
  exit 1
fi
echo "PLUGIN_INIT_COUNT=1"

set +e
"$(live_python)" "$SCRIPT_ROOT/scripts/live-reply.py" "$stdout_file" "$stderr_file" "$code" "$model"
status=$?
set -e
exit "$status"
