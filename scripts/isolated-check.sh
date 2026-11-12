#!/usr/bin/env bash
# Run a contributor tree's install, build, typecheck, and unit tests where
# the command cannot see reviewer files. This is not the review.
#
#   scripts/isolated-check.sh <pr-number|https://github.com/owner/repo/pull/N> [--live]
#
# The pull request is fetched and copied with git archive of that commit id,
# not the moving FETCH_HEAD name. There is no linked worktree and no parent
# git directory. scripts/isolate-run.sh runs the
# commands. A URL whose owner or repository is not this checkout's origin is
# refused before fetch.
#
# --live is a separate trust decision. Passing checks does not pass
# CURSOR_API_KEY. Set CURSOR_REVIEW_TRUST=1 and CURSOR_REVIEW_TRUST_SHA to
# the reviewed commit. The fetched head must be that commit before the
# archive is extracted, and again immediately before the key is passed.
# The key is then given to this checkout's scripts/live-test.sh and the
# built plugin, still inside the boundary. The revision's shell is not run.
#
# Exit 0 when install, build, typecheck, unit tests, and any contract failure
# the pull request introduces all pass. A contract diagnostic that already
# fails on the merge base is pre-existing: it is logged and does not withhold
# the live credential. Exit 1 when a check the pull request introduces fails,
# 2 when the invocation or the isolation mechanism is unusable, and 128 plus
# the signal number when TERM, INT, HUP, or QUIT cancels a check or the live
# test. A cancelled run waits for the boundary to stop before it removes the
# archive. SIGKILL cannot be forwarded: killing this script that way can leave
# the boundary running, on the --live path with CURSOR_API_KEY.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/isolate-run.sh
source "$ROOT/scripts/isolate-run.sh"

worktree=""
base_tree=""
base_ready=0
base_attempted=0
compare_dir=""
check_fetched=""
check_new=0
check_preexisting=0
check_blocking=""
isolate_home=""
isolate_tmp=""
isolate_contracts=""
pr=""
pr_slug=""
origin_slug=""

check_cleanup() {
  cd "$ROOT" 2>/dev/null || true
  if [[ -n "$worktree" ]]; then
    rm -rf "$worktree"
    worktree=""
  fi
  if [[ -n "$base_tree" ]]; then
    rm -rf "$base_tree"
    base_tree=""
  fi
  if [[ -n "$compare_dir" ]]; then
    rm -rf "$compare_dir"
    compare_dir=""
  fi
  if [[ -n "$isolate_home" ]]; then
    rm -rf "$isolate_home"
    isolate_home=""
  fi
  if [[ -n "$isolate_tmp" ]]; then
    rm -rf "$isolate_tmp"
    isolate_tmp=""
  fi
  if [[ -n "$isolate_contracts" ]]; then
    rm -rf "$isolate_contracts"
    isolate_contracts=""
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

# Unit-test PATH plus a private directory of opencode and opencode1 symlinks.
# A binary that is not installed is left out; the live test then fails on it.
check_live_path() {
  [[ -n "$isolate_tmp" ]] || return 1
  local path name bin linked=""
  path="$(check_tool_path)"
  for name in opencode opencode1; do
    bin="$(command -v "$name" 2>/dev/null || true)"
    if [[ -n "$bin" ]]; then
      mkdir -p "$isolate_tmp/opencode-bin"
      ln -sfn "$bin" "$isolate_tmp/opencode-bin/$name"
      linked=1
    fi
  done
  if [[ -n "$linked" ]]; then
    path="${path}:${isolate_tmp}/opencode-bin"
  fi
  printf '%s' "$path"
}

# Prints skip, skip-failed, skip-untrusted, or run.
# Arguments: 0|1 --live, then the check exit code.
# CURSOR_REVIEW_TRUST=1 and CURSOR_REVIEW_TRUST_SHA are both required before
# run. Passing checks is not trust, and trust is one commit, not a boolean.
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
  if [[ ! "${CURSOR_REVIEW_TRUST_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'skip-untrusted'
    return 0
  fi
  printf 'run'
}

# Refuse to pass the key unless FETCH_HEAD is still the commit that was
# archived and the trusted commit. Prints the commit on success.
check_refuse_moved_commit() {
  local archived="$1" again
  again="$(git -C "$ROOT" rev-parse --verify FETCH_HEAD)"
  if [[ "$again" != "$archived" ]] || [[ "$again" != "${CURSOR_REVIEW_TRUST_SHA:-}" ]]; then
    echo "Refusing to forward the key. Fetched ${again}; trusted ${CURSOR_REVIEW_TRUST_SHA:-}; archived ${archived}." >&2
    return 2
  fi
  echo "Check commit: $again"
}

check_child=""
check_signal=""

# Record the first cancellation signal and ask isolate-run.sh to stop. A
# background job cannot trap INT or QUIT, so the request is always TERM.
check_note_signal() {
  [[ -n "$check_signal" ]] || check_signal="$1"
  [[ -z "$check_child" ]] || kill -s TERM "$check_child" 2>/dev/null || true
}

# Run isolate-run.sh with these arguments and wait for it.
#
#   check_supervise ISOLATE_RUN_ARGUMENT...
#
# isolate-run.sh runs in the background so that TERM, INT, HUP, or QUIT sent
# only to this shell is passed on, and this shell waits until the boundary
# has stopped. Only then does the cancelled run exit with 128 plus the signal
# number, and its EXIT trap remove the archive. isolate-run.sh, not this
# shell, kills a boundary that ignores the request. Every boundary this
# script starts goes through here, the live test's included.
check_supervise() {
  local status
  check_signal=""
  check_child=""
  trap 'check_note_signal TERM' TERM
  trap 'check_note_signal INT' INT
  trap 'check_note_signal HUP' HUP
  trap 'check_note_signal QUIT' QUIT
  "$ROOT/scripts/isolate-run.sh" "$@" <&0 &
  check_child=$!
  [[ -z "$check_signal" ]] || kill -s TERM "$check_child" 2>/dev/null || true
  while :; do
    wait "$check_child"
    status=$?
    kill -0 "$check_child" 2>/dev/null || break
  done
  check_child=""
  trap - TERM INT HUP QUIT
  if [[ -n "$check_signal" ]]; then
    echo "Check cancelled by SIG${check_signal}." >&2
    exit $((128 + $(kill -l "$check_signal")))
  fi
  return "$status"
}

# Run a command inside the filesystem and process boundary.
check_run_isolated() {
  if [[ -z "$isolate_contracts" ]]; then
    isolate_contracts="$(mktemp -d "${TMPDIR:-/tmp}/cursor-review-contracts.XXXXXX")"
    cp "$ROOT/scripts/review-model-contracts.mjs" "$isolate_contracts/review-model-contracts.mjs" || return 2
    cp "$ROOT/scripts/review-retention-contracts.mjs" "$isolate_contracts/review-retention-contracts.mjs" || return 2
    cp "$ROOT/scripts/review-model-cache-contract.mjs" "$isolate_contracts/review-model-cache-contract.mjs" || return 2
  fi
  check_supervise --src "${ISOLATE_SRC:-$PWD}" \
    --tool bun --tool node --tool git --tool python3 \
    --ro-bind "$isolate_contracts:/opt/harness/scripts" -- "$@"
}

# Load the archived tree with this checkout's harness. Tests replace this.
# This boundary holds CURSOR_API_KEY, so a cancelled live test is waited for
# like any check.
check_run_live() {
  local worktree="$1"
  check_supervise --src "$worktree" \
    --tool bun --tool node --tool git --tool python3 --tool opencode --tool opencode1 \
    --ro-bind "$ROOT/scripts:/opt/harness/scripts" \
    --env CURSOR_API_KEY \
    --set OPENCODE_CONFIG_ROOT=/src \
    --set OPENCODE_REVIEW_HOME=/tmp/review-opencode \
    --set "OPENCODE_LIVE_MODEL=${OPENCODE_LIVE_MODEL:-}" \
    -- bash /opt/harness/scripts/live-test.sh
}

check_note_blocking() {
  local label="$1"
  case ",${check_blocking}," in
    *",${label},"*) ;;
    *) check_blocking="${check_blocking:+$check_blocking,}${label}" ;;
  esac
}

# The merge-base object has to exist locally before GitHub is asked for the
# pull request's base. A stubbed git that cannot answer this probe makes the
# base unavailable without a network call.
check_pr_base_sha() {
  local slug sha
  if [[ -z "$origin_slug" ]]; then
    check_origin_slug || return 1
  fi
  slug="$origin_slug"
  sha="$(gh pr view "$pr" --repo "$slug" --json baseRefOid --jq .baseRefOid 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

# Archive the merge base and install plus build it in the same secret-free
# boundary as the head. A failure here cannot prove a head failure is old.
check_prepare_base() {
  local head="$1" base_sha merge code=0
  if [[ "$base_attempted" -eq 1 ]]; then
    [[ "$base_ready" -eq 1 ]]
    return
  fi
  base_attempted=1
  base_ready=0
  if [[ ! "$head" =~ ^[0-9a-f]{40}$ ]]; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if ! git -C "$ROOT" merge-base --is-ancestor "$head" "$head" >/dev/null 2>&1; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if ! base_sha="$(check_pr_base_sha)"; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if ! git -C "$ROOT" fetch --no-tags origin "$base_sha"; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  merge="$(git -C "$ROOT" merge-base "$head" FETCH_HEAD 2>/dev/null || true)"
  if [[ ! "$merge" =~ ^[0-9a-f]{40}$ ]]; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  echo "Base commit: $merge"
  base_tree="$(mktemp -d "${TMPDIR:-/tmp}/cursor-pr-base-${pr}.XXXXXX")"
  if ! git -C "$ROOT" archive "$merge" | tar -x -C "$base_tree"; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if [[ -e "$base_tree/.git" ]]; then
    echo "The merge base contains git metadata. It cannot classify contract failures." >&2
    echo "BASE_TREE=unavailable"
    return 1
  fi
  set +e
  CHECK_TREE=base ISOLATE_SRC="$base_tree" check_run_isolated bun install --frozen-lockfile --ignore-scripts
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    echo "BASE_BUILD=failed exit=${code}"
    echo "BASE_TREE=unavailable"
    return 1
  fi
  set +e
  CHECK_TREE=base ISOLATE_SRC="$base_tree" check_run_isolated bun run build
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    echo "BASE_BUILD=failed exit=${code}"
    echo "BASE_TREE=unavailable"
    return 1
  fi
  echo "BASE_TREE=prepared commit=${merge}"
  base_ready=1
  return 0
}

# Diagnostic identity, without counts or observed values. The same message on
# the head and the merge base is one inherited failure. Every catalog message
# is kept, not only lines that start with "OpenCode", and so is an error line
# the structured prefixes do not name. Detail under a retention failure belongs
# to that named failure.
check_write_signatures() {
  local source="$1" dest="$2"
  : >"$dest"
  [[ -f "$source" ]] || return 0
  awk '
    /^MODEL_CONTRACT=[^[:space:]]+:(failed|passed)/ {
      verbose = 0
      header = $1
      sub(/:.*/, "", header)
      next
    }
    /^MODEL_CACHE_CONTRACT=[^[:space:]]+:failed/ { verbose = 0; print $1; next }
    /^MODEL_CACHE_CONTRACT=[^[:space:]]+:passed/ { verbose = 0; next }
    /^RETENTION_CONTRACT=[^[:space:]]+:failed/ || /^RETENTION_TEMP=[^[:space:]]+:failed/ || /^RETENTION_ENV=[^[:space:]]+:failed/ {
      verbose = 1
      print $1
      next
    }
    /^RETENTION_CLEANUP=failed([[:space:]]|$)/ { verbose = 1; print "RETENTION_CLEANUP=failed"; next }
    /^RETENTION_/ { verbose = 0; next }
    /; count=/ {
      line = $0
      sub(/; count=.*/, "", line)
      if (header != "") print header "|" line
      else print line
      next
    }
    /^error:/ || /^Error:/ {
      if (!verbose) print $0
      next
    }
  ' "$source" | LC_ALL=C sort -u >"$dest"
}

check_print_signatures() {
  local prefix="$1" file="$2" line
  if [[ ! -s "$file" ]]; then
    echo "${prefix}=none"
    return 0
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    echo "${prefix}=${line}"
  done <"$file"
}

check_log_status() {
  local label="$1" code="$2"
  if [[ "$code" -eq 0 ]]; then
    echo "${label}=passed"
  elif [[ "$code" -eq 2 ]]; then
    echo "${label}=unavailable"
  else
    echo "${label}=failed exit=${code}"
  fi
}

# Run one harness contract on the archived head and, when the merge base
# prepared, on that base. Both runs are secret-free. Only a head failure that
# is not already on the base blocks the live credential.
check_contract_pair() {
  local label="$1"
  shift
  local head_log base_log head_code=0 base_code=0 head_sigs base_sigs new_sigs old_sigs
  check_prepare_base "$check_fetched" || true
  mkdir -p "$compare_dir"
  head_log="$compare_dir/${label}.head"
  base_log="$compare_dir/${label}.base"
  head_sigs="$compare_dir/${label}.head.sig"
  base_sigs="$compare_dir/${label}.base.sig"
  new_sigs="$compare_dir/${label}.new"
  old_sigs="$compare_dir/${label}.old"
  set +e
  CHECK_TREE=head ISOLATE_SRC="${worktree:-$PWD}" check_run_isolated "$@" >"$head_log" 2>&1
  head_code=$?
  set -e
  echo "${label}_HEAD_BEGIN"
  cat "$head_log"
  echo "${label}_HEAD_END"
  if [[ "$head_code" -eq 2 ]]; then
    echo "${label}=unavailable"
    check_note_blocking "$label"
    return 2
  fi
  base_code=2
  if [[ "$base_ready" -eq 1 ]]; then
    set +e
    CHECK_TREE=base ISOLATE_SRC="$base_tree" check_run_isolated "$@" >"$base_log" 2>&1
    base_code=$?
    set -e
    echo "${label}_BASE_BEGIN"
    cat "$base_log"
    echo "${label}_BASE_END"
  fi
  if [[ "$head_code" -eq 0 ]]; then
    echo "${label}=passed"
    if [[ "$base_ready" -eq 1 ]]; then
      check_log_status "${label}_BASE" "$base_code"
    else
      echo "${label}_BASE=unavailable"
    fi
    return 0
  fi
  check_write_signatures "$head_log" "$head_sigs"
  if [[ "$base_ready" -eq 1 && "$base_code" -ne 2 ]]; then
    check_write_signatures "$base_log" "$base_sigs"
    LC_ALL=C comm -13 "$base_sigs" "$head_sigs" >"$new_sigs"
    LC_ALL=C comm -12 "$base_sigs" "$head_sigs" >"$old_sigs"
  else
    : >"$base_sigs"
    cp "$head_sigs" "$new_sigs"
    : >"$old_sigs"
  fi
  echo "${label}_HEAD=failed exit=${head_code}"
  if [[ "$base_ready" -ne 1 || "$base_code" -eq 2 ]]; then
    echo "${label}_BASE=unavailable"
  else
    check_log_status "${label}_BASE" "$base_code"
  fi
  # A nonzero result with no diagnostic is not proof that the base failed the
  # same way. An empty new-signature file is pre-existing only when the head
  # actually named its failures and each of those names is on the base.
  if [[ -s "$head_sigs" && ! -s "$new_sigs" ]]; then
    echo "${label}=pre-existing exit=${head_code}"
    check_print_signatures "${label}_NEW" "$new_sigs"
    check_print_signatures "${label}_PREEXISTING" "$old_sigs"
    check_preexisting=$((check_preexisting + 1))
    return 0
  fi
  echo "${label}=failed exit=${head_code}"
  if [[ -s "$head_sigs" ]]; then
    check_print_signatures "${label}_NEW" "$new_sigs"
    check_print_signatures "${label}_PREEXISTING" "$old_sigs"
  else
    echo "${label}_NEW=unclassified"
    echo "${label}_PREEXISTING=none"
  fi
  check_new=$((check_new + 1))
  check_note_blocking "$label"
  return 1
}

check_step() {
  local label="$1" code=0
  shift
  case "$label" in
    MODEL_CONTRACTS|MODEL_CACHE_CONTRACTS|RETENTION_CONTRACTS)
      set +e
      check_contract_pair "$label" "$@"
      code=$?
      set -e
      return "$code"
      ;;
  esac
  set +e
  CHECK_TREE=head ISOLATE_SRC="${worktree:-$PWD}" check_run_isolated "$@"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    echo "${label}=passed"
    return 0
  fi
  if [[ "$code" -eq 2 ]]; then
    echo "${label}=unavailable"
    check_note_blocking "$label"
    return 2
  fi
  echo "${label}=failed exit=${code}"
  check_note_blocking "$label"
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
  local fetched
  fetched="$(git -C "$ROOT" rev-parse --verify FETCH_HEAD)"
  check_fetched="$fetched"
  echo "Check commit: $fetched"
  if [[ -n "${CURSOR_REVIEW_TRUST_SHA:-}" ]]; then
    if [[ ! "${CURSOR_REVIEW_TRUST_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
      echo "CURSOR_REVIEW_TRUST_SHA must be 40 lowercase hex characters." >&2
      exit 2
    fi
    if [[ "${CURSOR_REVIEW_TRUST_SHA}" != "$fetched" ]]; then
      echo "Fetched ${fetched}, not the trusted ${CURSOR_REVIEW_TRUST_SHA}. Refusing to archive or run it." >&2
      exit 2
    fi
  fi
  worktree="$(mktemp -d "${TMPDIR:-/tmp}/cursor-pr-check-${pr}.XXXXXX")"
  # Archive the recorded commit. FETCH_HEAD can move while git archive runs.
  git -C "$ROOT" archive "$fetched" | tar -x -C "$worktree"
  if [[ -e "$worktree/.git" ]]; then
    echo "The fetched tree contains git metadata. Refusing to run it." >&2
    exit 2
  fi
  cd "$worktree"

  echo "Check root: $worktree"
  echo "Pull request: $pr"
  compare_dir="$(mktemp -d "${TMPDIR:-/tmp}/cursor-pr-compare-${pr}.XXXXXX")"
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
      # These checks are independent once the subject builds. Preserve every
      # new failure while still collecting the other contracts and unit results.
      # An unavailable boundary still stops immediately. A contract failure
      # whose diagnostics already fail on the merge base does not close the
      # live credential gate. Install, build, typecheck, unit tests, and a
      # new contract failure do.
      local phase=0
      check_step MODEL_CONTRACTS bun /opt/harness/scripts/review-model-contracts.mjs /src || phase=$?
      checks="$phase"
      if [[ "$checks" -ne 2 ]]; then
        phase=0
        check_step MODEL_CACHE_CONTRACTS node /opt/harness/scripts/review-model-cache-contract.mjs /src || phase=$?
        if [[ "$phase" -gt "$checks" ]]; then checks="$phase"; fi
      fi
      if [[ "$checks" -ne 2 ]]; then
        phase=0
        check_step RETENTION_CONTRACTS bun /opt/harness/scripts/review-retention-contracts.mjs /src || phase=$?
        if [[ "$phase" -gt "$checks" ]]; then checks="$phase"; fi
      fi
      if [[ "$checks" -ne 2 ]]; then
        phase=0
        check_step UNIT_TESTS bun test || phase=$?
        if [[ "$phase" -gt "$checks" ]]; then checks="$phase"; fi
      fi
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
      echo "Passing checks is not a decision to trust this revision. Set CURSOR_REVIEW_TRUST=1 and CURSOR_REVIEW_TRUST_SHA to the reviewed commit. CURSOR_API_KEY was not passed."
      ;;
    run)
      echo "Loading /src/dist/plugin.js with opencode1 and /src/dist/plugin-opencode2.js with opencode."
      echo "CURSOR_REVIEW_TRUST=1 was set separately from the check result."
      # Classifying the merge base fetches that commit and moves FETCH_HEAD.
      # Fetch the reviewed head again so a concurrent push is still refused.
      git fetch --no-tags origin "pull/${pr}/head"
      check_refuse_moved_commit "$fetched"
      set +e
      check_run_live "$worktree"
      live_code=$?
      set -e
      ;;
    *)
      echo "LIVE_TEST=failed unknown action" >&2
      exit 2
      ;;
  esac

  echo "CHECK_SUMMARY pr=${pr} checks=${checks} new_contracts=${check_new} preexisting_contracts=${check_preexisting} blocking=${check_blocking:-none} live_exit=${live_code}"
  if [[ "$checks" -ne 0 || "$live_code" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  check_main "$@"
fi
