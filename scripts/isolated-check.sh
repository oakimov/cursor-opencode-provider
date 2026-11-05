#!/usr/bin/env bash
# Run a contributor tree's install, build, typecheck, and unit tests without
# reviewer secrets. This is not the review.
#
#   scripts/isolated-check.sh <pr-number|https://github.com/owner/repo/pull/N> [--live]
#
# --live is a trust decision. After the checks pass, this checkout's
# scripts/live-test.sh loads the worktree's built plugin through a private
# OpenCode config. The revision's shell is not run. A failed check does not
# receive the key.
#
# Exit 0 when the checks pass, 1 when a check fails, 2 when the invocation is invalid.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

worktree=""
isolate_home=""
isolate_tmp=""

check_cleanup() {
  cd "$ROOT" 2>/dev/null || true
  if [[ -n "$worktree" ]]; then
    git worktree remove --force "$worktree" >/dev/null 2>&1 || true
    rm -rf "$worktree"
    worktree=""
  fi
  if [[ -n "$isolate_home" ]]; then
    rm -rf "$isolate_home"
    isolate_home=""
  fi
  if [[ -n "$isolate_tmp" ]]; then
    rm -rf "$isolate_tmp"
    isolate_tmp=""
  fi
}

usage() {
  echo "Usage: scripts/isolated-check.sh <pr-number|pr-url> [--live]" >&2
  exit 2
}

# Sets pr to the digits of a pull number or a canonical GitHub pull URL.
# Returns 1 for anything else.
check_parse_target() {
  local input="$1"
  pr=""
  if [[ "$input" =~ ^[0-9]+$ ]]; then
    pr="$input"
    return 0
  fi
  if [[ "$input" =~ ^https://github\.com/[^/]+/[^/]+/pull/([0-9]+)([/?#].*)?$ ]]; then
    pr="${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

check_begin_sandbox() {
  if [[ -z "$isolate_home" ]]; then
    isolate_home="$(mktemp -d "${TMPDIR:-/tmp}/cursor-pr-home.XXXXXX")"
  fi
  if [[ -z "$isolate_tmp" ]]; then
    isolate_tmp="$(mktemp -d "${TMPDIR:-/tmp}/cursor-pr-tmp.XXXXXX")"
  fi
}

check_tool_path() {
  local tool dir path="/usr/bin:/bin"
  for tool in bun git python3 node; do
    if command -v "$tool" >/dev/null 2>&1; then
      dir="$(dirname "$(command -v "$tool")")"
      case ":${path}:" in
        *":${dir}:"*) ;;
        *) path="${path}:${dir}" ;;
      esac
    fi
  done
  printf '%s' "$path"
}

# Unit-test PATH plus a private directory that contains only an opencode symlink.
check_live_path() {
  [[ -n "$isolate_tmp" ]] || return 1
  local path bin
  path="$(check_tool_path)"
  bin="$(command -v opencode 2>/dev/null || true)"
  if [[ -n "$bin" ]]; then
    mkdir -p "$isolate_tmp/opencode-bin"
    ln -sfn "$bin" "$isolate_tmp/opencode-bin/opencode"
    path="${path}:${isolate_tmp}/opencode-bin"
  fi
  printf '%s' "$path"
}

# Prints skip, skip-failed, or run. Arguments: 0|1 --live, then the check exit code.
check_live_action() {
  local live="$1" checks="$2"
  if [[ "$checks" -ne 0 ]]; then
    printf 'skip-failed'
    return 0
  fi
  if [[ "$live" -ne 1 ]]; then
    printf 'skip'
    return 0
  fi
  printf 'run'
}

# Run a command with no reviewer secrets. Caller must check_begin_sandbox first.
check_run_isolated() {
  [[ -n "$isolate_home" && -n "$isolate_tmp" ]] || return 1
  env -i \
    PATH="$(check_tool_path)" \
    HOME="$isolate_home" \
    TMPDIR="$isolate_tmp" \
    USER="${USER:-reviewer}" \
    LOGNAME="${LOGNAME:-${USER:-reviewer}}" \
    LANG="${LANG:-C.UTF-8}" \
    SHELL="${SHELL:-/bin/bash}" \
    CI=1 \
    "$@"
}

check_step() {
  local label="$1"
  shift
  local code=0
  set +e
  check_run_isolated "$@"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    echo "${label}=passed"
    return 0
  fi
  echo "${label}=failed exit=${code}"
  return 1
}

check_main() {
  cd "$ROOT"
  local live=0 target="" arg
  for arg in "$@"; do
    case "$arg" in
      --live) live=1 ;;
      --help|-h) usage ;;
      -*) usage ;;
      *)
        [[ -z "$target" ]] || usage
        target="$arg"
        ;;
    esac
  done
  [[ -n "$target" ]] || usage
  check_parse_target "$target" || usage

  trap check_cleanup EXIT
  git fetch --no-tags origin "pull/${pr}/head"
  worktree="$(mktemp -d "${TMPDIR:-/tmp}/cursor-pr-check-${pr}.XXXXXX")"
  git worktree add --detach "$worktree" FETCH_HEAD
  cd "$worktree"

  echo "Check root: $worktree"
  echo "Pull request: $pr"
  check_begin_sandbox
  local checks=0
  check_step INSTALL bun install --frozen-lockfile --ignore-scripts || checks=1
  if [[ "$checks" -eq 0 ]]; then
    check_step BUILD bun run build || checks=1
    check_step TYPECHECK bun run typecheck || checks=1
    check_step UNIT_TESTS bun test || checks=1
  fi

  local live_code=0 action
  action="$(check_live_action "$live" "$checks")"
  case "$action" in
    skip)
      echo "LIVE_TEST=skipped"
      echo "Pass --live only when this change needs a live OpenCode run and you trust this checkout's harness with CURSOR_API_KEY."
      ;;
    skip-failed)
      echo "LIVE_TEST=skipped"
      echo "Checks failed, so the live test did not run and did not receive CURSOR_API_KEY."
      ;;
    run)
      echo "Worktree: $worktree"
      echo "Loading $worktree/dist/plugin-opencode2.js through a private OpenCode config."
      set +e
      env -i \
        PATH="$(check_live_path)" \
        HOME="$isolate_home" \
        TMPDIR="$isolate_tmp" \
        USER="${USER:-reviewer}" \
        LOGNAME="${LOGNAME:-${USER:-reviewer}}" \
        LANG="${LANG:-C.UTF-8}" \
        SHELL="${SHELL:-/bin/bash}" \
        CI=1 \
        CURSOR_API_KEY="${CURSOR_API_KEY:-}" \
        OPENCODE_LIVE_MODEL="${OPENCODE_LIVE_MODEL:-}" \
        OPENCODE_CONFIG_ROOT="$worktree" \
        OPENCODE_REVIEW_HOME="$isolate_tmp/review-opencode" \
        bash "$ROOT/scripts/live-test.sh"
      live_code=$?
      set -e
      ;;
    *)
      echo "LIVE_TEST=failed unknown action" >&2
      exit 2
      ;;
  esac

  echo "CHECK_SUMMARY pr=${pr} checks=${checks} live_exit=${live_code}"
  if [[ "$checks" -ne 0 || "$live_code" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  check_main "$@"
fi
