#!/usr/bin/env bash
# Run a contributor tree's install, build, typecheck, and unit tests where
# the command cannot see reviewer files. This is not the review.
#
#   scripts/isolated-check.sh <pr-number|https://github.com/owner/repo/pull/N> [--live]
#
# The pull request is fetched and copied with git archive. There is no linked
# worktree and no parent git directory. scripts/isolate-run.sh runs the
# commands. A URL whose owner or repository is not this checkout's origin is
# refused before fetch.
#
# --live is a separate trust decision. Passing checks does not pass
# CURSOR_API_KEY. Set CURSOR_REVIEW_TRUST=1 only after you trust that
# revision. The key is then given to this checkout's scripts/live-test.sh
# and the built plugin, still inside the boundary. The revision's shell is
# not run.
#
# Exit 0 when the checks pass, 1 when a check fails, 2 when the invocation
# or the isolation mechanism is unusable.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/isolate-run.sh
source "$ROOT/scripts/isolate-run.sh"

worktree=""
isolate_home=""
isolate_tmp=""
pr=""
pr_slug=""
origin_slug=""

check_cleanup() {
  cd "$ROOT" 2>/dev/null || true
  if [[ -n "$worktree" ]]; then
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

check_origin_slug() {
  local url slug
  url="$(git -C "$ROOT" remote get-url origin)"
  slug="$(isolate_github_slug "$url")" || return 1
  origin_slug="$slug"
}

# Sets pr from a pull number or a canonical GitHub pull URL.
# A URL must name this checkout's origin. Returns 1 for anything else.
check_parse_target() {
  local input="$1" owner repo
  pr=""
  pr_slug=""
  if [[ "$input" =~ ^[0-9]+$ ]]; then
    pr="$input"
    return 0
  fi
  if [[ "$input" =~ ^https://github\.com/([^/]+)/([^/]+)/pull/([0-9]+)([/?#].*)?$ ]]; then
    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    pr="${BASH_REMATCH[3]}"
    pr_slug="${owner}/${repo}"
    check_origin_slug || return 1
    if [[ "$pr_slug" != "$origin_slug" ]]; then
      echo "Refusing ${pr_slug}; this checkout's origin is ${origin_slug}." >&2
      return 1
    fi
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

# Prints skip, skip-failed, skip-untrusted, or run.
# Arguments: 0|1 --live, then the check exit code.
# CURSOR_REVIEW_TRUST=1 is required before run. Passing checks is not trust.
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
  if [[ "${CURSOR_REVIEW_TRUST:-}" != "1" ]]; then
    printf 'skip-untrusted'
    return 0
  fi
  printf 'run'
}

# Run a command inside the filesystem and process boundary.
check_run_isolated() {
  "$ROOT/scripts/isolate-run.sh" --src "${ISOLATE_SRC:-$PWD}" \
    --tool bun --tool node --tool git --tool python3 -- "$@"
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
  if [[ "$code" -eq 2 ]]; then
    echo "${label}=unavailable"
    return 2
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
  git -C "$ROOT" archive FETCH_HEAD | tar -x -C "$worktree"
  if [[ -e "$worktree/.git" ]]; then
    echo "The fetched tree contains git metadata. Refusing to run it." >&2
    exit 2
  fi
  cd "$worktree"

  echo "Check root: $worktree"
  echo "Pull request: $pr"
  local checks=0
  check_step INSTALL bun install --frozen-lockfile --ignore-scripts || checks=$?
  if [[ "$checks" -eq 2 ]]; then
    echo "ISOLATION=unavailable"
    exit 2
  fi
  if [[ "$checks" -eq 0 ]]; then
    check_step BUILD bun run build || checks=$?
    if [[ "$checks" -eq 0 ]]; then
      check_step TYPECHECK bun run typecheck || checks=$?
    fi
    if [[ "$checks" -eq 0 ]]; then
      check_step UNIT_TESTS bun test || checks=$?
    fi
    if [[ "$checks" -eq 2 ]]; then
      echo "ISOLATION=unavailable"
      exit 2
    fi
  fi

  local live_code=0 action
  action="$(check_live_action "$live" "$checks")"
  case "$action" in
    skip)
      echo "LIVE_TEST=skipped"
      echo "Pass --live only when this change needs a live OpenCode run. Passing checks does not grant CURSOR_API_KEY."
      ;;
    skip-failed)
      echo "LIVE_TEST=skipped"
      echo "Checks failed, so the live test did not run and did not receive CURSOR_API_KEY."
      ;;
    skip-untrusted)
      echo "LIVE_TEST=skipped"
      echo "Passing checks is not a decision to trust this revision. Set CURSOR_REVIEW_TRUST=1 only after that decision. CURSOR_API_KEY was not passed."
      ;;
    run)
      echo "Loading /src/dist/plugin-opencode2.js through a private OpenCode config."
      echo "CURSOR_REVIEW_TRUST=1 was set separately from the check result."
      set +e
      "$ROOT/scripts/isolate-run.sh" --src "$worktree" \
        --tool bun --tool node --tool git --tool python3 --tool opencode \
        --ro-bind "$ROOT/scripts:/opt/harness/scripts" \
        --env CURSOR_API_KEY \
        --set OPENCODE_CONFIG_ROOT=/src \
        --set OPENCODE_REVIEW_HOME=/tmp/review-opencode \
        --set "OPENCODE_LIVE_MODEL=${OPENCODE_LIVE_MODEL:-}" \
        -- bash /opt/harness/scripts/live-test.sh
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
