import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Cursor agent.v1 TimeoutBehavior enum values. */
export const CURSOR_TIMEOUT_CANCEL = 1
export const CURSOR_TIMEOUT_BACKGROUND = 2

const MAX_TRACKED_SHELL_CALLS = 512
const OPENCODE_TIMEOUT_GRACE_MS = 15_000
const POLL_INTERVAL_MS = 100
const BACKGROUND_MARKER = "__CURSOR_SHELL_BACKGROUND__"
const EXIT_MARKER = "__CURSOR_SHELL_EXIT__"
const TIMEOUT_MARKER = "__CURSOR_SHELL_TIMEOUT__"
/** Private marker for Cursor `background_shell_spawn_args` detach wrappers. */
export const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__"

export type CursorShellPolicy = {
  command: string
  workingDirectory: string
  timeoutMs: number
  timeoutBehavior: number
  hardTimeoutMs?: number
  /** Immediate nohup detach for Cursor `background_shell_spawn_args`. */
  backgroundSpawn?: boolean
}

export type CursorShellOutcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout"; timeoutMs: number }
  | {
      kind: "backgrounded"
      shellId: number
      pid: number
      command: string
      workingDirectory: string
      msToWait: number
      reason: 1
    }

type CursorShellEnvWrap = {
  env: Record<string, string>
  cleanup: () => void
}

const policies = new Map<string, CursorShellPolicy>()
const outcomes = new Map<string, CursorShellOutcome>()
/** callIDs that need shell.env injectors (so args.command can stay display-original). */
const pendingEnvWraps = new Set<string>()
const activeEnvWraps = new Map<string, CursorShellEnvWrap>()

function remember<T>(map: Map<string, T>, key: string, value: T, onEvict?: (value: T) => void): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_SHELL_CALLS) {
    const oldest = map.keys().next().value as string | undefined
    if (!oldest) break
    const evicted = map.get(oldest)
    map.delete(oldest)
    if (evicted !== undefined && onEvict) onEvict(evicted)
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

export function shellPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): CursorShellPolicy | undefined {
  if (!metadata) return undefined
  if (metadata.background_shell_spawn === true) {
    return {
      command: typeof metadata.command === "string" ? metadata.command : "",
      workingDirectory:
        typeof metadata.working_directory === "string" ? metadata.working_directory : "",
      timeoutMs: 0,
      timeoutBehavior: 0,
      backgroundSpawn: true,
    }
  }
  if (metadata.shell_stream !== true) return undefined
  const timeoutMs = finiteNonNegative(metadata.timeout_ms) ?? 30_000
  const timeoutBehavior = finiteNonNegative(metadata.timeout_behavior) ?? 0
  const hardTimeoutMs = finiteNonNegative(metadata.hard_timeout_ms)
  return {
    command: typeof metadata.command === "string" ? metadata.command : "",
    workingDirectory:
      typeof metadata.working_directory === "string" ? metadata.working_directory : "",
    timeoutMs,
    timeoutBehavior,
    ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
  }
}

/** Register a Cursor shell request before OpenCode executes its emitted tool call. */
export function registerCursorShellCall(
  toolCallId: string,
  metadata: Record<string, unknown> | undefined,
): void {
  const policy = shellPolicyFromMetadata(metadata)
  if (!policy || !toolCallId.startsWith("cursor_")) return
  remember(policies, toolCallId, policy)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * F11 / soft-background helper.
 *
 * Run a Cursor soft-background command for its foreground window, then leave
 * it detached (`nohup`) if still alive. The sentinel is removed by the after
 * hook before OpenCode stores/renders the result.
 *
 * This approximates Cursor's TIMEOUT_BACKGROUND semantics through OpenCode's
 * foreground-only bash tool. Residual: after OpenCode returns, the child (and
 * optional hard-timeout watchdog) may still be running; this provider does not
 * reap leftover processes — cleanup is left to the user / OS.
 */
export function buildSoftBackgroundCommand(policy: CursorShellPolicy): string {
  const polls = Math.ceil(policy.timeoutMs / POLL_INTERVAL_MS)
  const hardPolls = policy.hardTimeoutMs !== undefined
    ? Math.max(1, Math.ceil(policy.hardTimeoutMs / POLL_INTERVAL_MS))
    : undefined
  const lines = [
    'cursor_shell_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(policy.command)} >"$cursor_shell_log" 2>&1 </dev/null &`,
    "cursor_shell_pid=$!",
  ]
  if (hardPolls !== undefined) {
    lines.push(
      'cursor_shell_status="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell-status.XXXXXX")" || exit 1',
      `nohup sh -c 'cursor_hard_poll=0; while [ "$cursor_hard_poll" -lt "$1" ] && kill -0 "$2" 2>/dev/null; do sleep ${POLL_INTERVAL_MS / 1000}; cursor_hard_poll=$((cursor_hard_poll + 1)); done; if kill -0 "$2" 2>/dev/null; then printf timeout >"$3"; kill -TERM "$2" 2>/dev/null; sleep 3; kill -KILL "$2" 2>/dev/null; fi' cursor-shell-watchdog ${hardPolls} "$cursor_shell_pid" "$cursor_shell_status" >/dev/null 2>&1 </dev/null &`,
      "cursor_shell_watchdog_pid=$!",
    )
  } else {
    lines.push('cursor_shell_status=""', 'cursor_shell_watchdog_pid=""')
  }
  lines.push(
    // Avoid interactive job-control noise ("Terminated: 15 …") when we later
    // reap the watchdog; that text can otherwise land after our private marker
    // and leak into OpenCode's bash UI.
    "set +m 2>/dev/null || true",
    'if [ -n "$cursor_shell_watchdog_pid" ]; then disown "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    'disown "$cursor_shell_pid" 2>/dev/null || true',
    "cursor_shell_poll=0",
    `while [ "$cursor_shell_poll" -lt ${polls} ] && kill -0 "$cursor_shell_pid" 2>/dev/null; do`,
    `  sleep ${POLL_INTERVAL_MS / 1000}`,
    "  cursor_shell_poll=$((cursor_shell_poll + 1))",
    "done",
    'if kill -0 "$cursor_shell_pid" 2>/dev/null; then',
    '  cat "$cursor_shell_log"',
    `  printf '\n${BACKGROUND_MARKER}%s:%s\n' "$cursor_shell_pid" "$cursor_shell_log"`,
    "  exit 0",
    "fi",
    'wait "$cursor_shell_pid" 2>/dev/null',
    "cursor_shell_code=$?",
    'cat "$cursor_shell_log"',
    'if [ -n "$cursor_shell_status" ] && [ "$(cat "$cursor_shell_status" 2>/dev/null)" = timeout ]; then',
    // Reap the watchdog before printing the private marker so any residual
    // shell diagnostics cannot trail the sentinel.
    '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${TIMEOUT_MARKER}%s\n' ${policy.hardTimeoutMs ?? policy.timeoutMs}`,
    "else",
    '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${EXIT_MARKER}%s\n' "$cursor_shell_code"`,
    "fi",
    'rm -f -- "$cursor_shell_log"',
    'if [ -n "$cursor_shell_status" ]; then rm -f -- "$cursor_shell_status"; fi',
  )
  return lines.join("\n")
}

/**
 * F11 / background_shell_spawn_args helper.
 *
 * OpenCode's bash tool is foreground-only. Detach the requested command inside
 * that one foreground call (`nohup … &`) and print a private marker containing
 * the spawned PID and log path. With stdin and all output redirected, the host
 * shell can return immediately instead of retaining OpenCode's tool pipe.
 *
 * Residual: the detached child is not reaped by this provider after OpenCode
 * completes the tool call; cleanup is left to the user / OS.
 */
export function buildBackgroundShellCommand(command: string): string {
  return [
    'bg_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-bg.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
    "bg_pid=$!",
    `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
  ].join("\n")
}

/**
 * Prepare OpenCode Bash args before execution when Cursor requested wrapping.
 *
 * Important: do **not** replace `args.command` with the wrapper script.
 * OpenCode's bash UI renders `state.input.command`, and `ctx.metadata()`
 * persists the execute-time `args` object into that field. Mutating
 * `args.command` therefore leaks the private wrapper into the TUI/GUI.
 *
 * Wrapping is applied later via {@link cursorShellEnvForCall} (`shell.env`),
 * which uses BASH_ENV / ZDOTDIR injectors so bash/zsh `-c <original>` is
 * replaced with the wrapper while the stored/displayed command stays original.
 * Permissions also keep analyzing the real user command.
 */
export function prepareCursorShellArgs(toolCallId: string, args: Record<string, unknown>): void {
  const policy = policies.get(toolCallId)
  if (!policy) return
  if (policy.backgroundSpawn) {
    pendingEnvWraps.add(toolCallId)
    return
  }
  if (policy.timeoutBehavior !== CURSOR_TIMEOUT_BACKGROUND) return
  pendingEnvWraps.add(toolCallId)
  // The wrapper returns just after Cursor's foreground window. OpenCode's own
  // timeout is only an outer safety net and must not win the race.
  args.timeout = Math.max(OPENCODE_TIMEOUT_GRACE_MS, policy.timeoutMs + OPENCODE_TIMEOUT_GRACE_MS)
}

/** Restore the model-facing command in OpenCode's completed tool title. */
export function cursorShellOriginalCommand(toolCallId: string): string | undefined {
  return policies.get(toolCallId)?.command || undefined
}

function writeShellEnvInjector(wrapperBody: string): CursorShellEnvWrap {
  const dir = mkdtempSync(join(tmpdir(), "cursor-opencode-wrap-"))
  const wrapperPath = join(dir, "wrapper.sh")
  const bashEnvPath = join(dir, "bashenv.sh")
  const zshenvPath = join(dir, ".zshenv")
  writeFileSync(wrapperPath, `${wrapperBody}\n`, { mode: 0o700 })
  // Sourced by non-interactive bash (BASH_ENV) or zsh (.zshenv via ZDOTDIR).
  // `exec` replaces the host shell so OpenCode's `-c <original>` body never runs.
  //
  // Do not gate on a sticky env flag: soft-background children inherit the
  // wrapper environment, and a leftover CURSOR_OPENCODE_WRAP_ACTIVE=1 would
  // make later injectors no-op (original `-c` runs unwrapped). Unsetting the
  // injector vars before `exec` is enough to prevent re-entry.
  const injector = [
    "unset BASH_ENV ZDOTDIR ENV CURSOR_OPENCODE_WRAP_ACTIVE",
    `exec /bin/sh ${shellQuote(wrapperPath)}`,
    "",
  ].join("\n")
  writeFileSync(bashEnvPath, injector, { mode: 0o600 })
  writeFileSync(zshenvPath, injector, { mode: 0o600 })
  return {
    env: {
      BASH_ENV: bashEnvPath,
      ZDOTDIR: dir,
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    },
  }
}

/** Drop injector temp files for a finished/abandoned Cursor shell call. */
export function releaseCursorShellEnv(toolCallId: string): void {
  pendingEnvWraps.delete(toolCallId)
  const active = activeEnvWraps.get(toolCallId)
  if (!active) return
  activeEnvWraps.delete(toolCallId)
  active.cleanup()
}

/**
 * Env vars for OpenCode's `shell.env` hook so bash/zsh execute the Cursor
 * wrapper while `args.command` (and therefore the bash UI) stay original.
 */
export function cursorShellEnvForCall(toolCallId: string | undefined): Record<string, string> | undefined {
  if (typeof toolCallId !== "string" || !toolCallId || !pendingEnvWraps.has(toolCallId)) return undefined
  const policy = policies.get(toolCallId)
  if (!policy) return undefined
  const existing = activeEnvWraps.get(toolCallId)
  if (existing) return existing.env
  const wrapperBody = policy.backgroundSpawn
    ? buildBackgroundShellCommand(policy.command)
    : policy.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND
      ? buildSoftBackgroundCommand(policy)
      : undefined
  if (!wrapperBody) return undefined
  const wrap = writeShellEnvInjector(wrapperBody)
  remember(activeEnvWraps, toolCallId, wrap, (evicted) => evicted.cleanup())
  pendingEnvWraps.delete(toolCallId)
  return wrap.env
}

function withoutMarker(output: string, index: number): string {
  let clean = output.slice(0, index).replace(/[\t ]+$/gm, "").replace(/\n{2,}$/, "\n")
  if (clean.trim() === "" || clean.trim() === "(no output)") clean = ""
  return clean
}

/**
 * OpenCode only stores/renders text (`output` / `metadata.output`). Private
 * markers become typed Cursor outcomes, but stripping them alone can leave a
 * blank or partial bash bubble that looks like success. Append a short
 * user-facing status so the UI explains background handoff / timeout.
 */
function formatShellOutcomeDisplay(clean: string, outcome: CursorShellOutcome): string {
  let notice: string | undefined
  if (outcome.kind === "backgrounded") {
    notice = outcome.msToWait > 0
      ? `Still running in the background (pid ${outcome.pid}) after ${outcome.msToWait}ms.`
      : `Started in the background (pid ${outcome.pid}).`
  } else if (outcome.kind === "timeout") {
    notice = `Timed out after ${outcome.timeoutMs}ms.`
  }
  if (!notice) return clean
  if (!clean) return `${notice}\n`
  return clean.endsWith("\n") ? `${clean}${notice}\n` : `${clean}\n${notice}\n`
}

/**
 * Find the last private wrapper sentinel.
 *
 * Soft-background wrappers print the marker as the final intentional line, but
 * the host shell can still append job-control diagnostics afterwards (e.g.
 * "Terminated: 15 … nohup sh -c '…cursor-shell-watchdog…'"). Match the sentinel
 * on its own line and discard everything from that point to EOF.
 */
function lastPrivateMarker(
  output: string,
  marker: string,
  valuePattern: string,
): { index: number; values: string[] } | undefined {
  const re = new RegExp(`(?:^|\\r?\\n)(${marker}${valuePattern})`, "g")
  let match: RegExpExecArray | null
  let last: { index: number; values: string[] } | undefined
  while ((match = re.exec(output)) !== null) {
    if (match.index === undefined || match[1] === undefined) continue
    const index = match[0].startsWith("\r\n")
      ? match.index + 2
      : match[0].startsWith("\n")
        ? match.index + 1
        : match.index
    last = { index, values: match.slice(2) }
  }
  return last
}

function parseOpenCodeTimeout(output: string): { output: string; timeoutMs: number } | undefined {
  const re = /<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\.[\s\S]*?<\/shell_metadata>\s*$/
  const match = re.exec(output)
  if (!match || match.index === undefined) return undefined
  return { output: withoutMarker(output, match.index), timeoutMs: Number(match[1]) }
}

function parseSoftBackgroundOutcome(
  output: string,
  policy: CursorShellPolicy | undefined,
): { output: string; outcome: CursorShellOutcome } | undefined {
  const background = lastPrivateMarker(output, BACKGROUND_MARKER, "(\\d+):([^\\r\\n]+)")
  if (background) {
    const pid = Number(background.values[0])
    if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff) {
      return {
        output: withoutMarker(output, background.index),
        outcome: {
          kind: "backgrounded",
          shellId: pid,
          pid,
          command: policy?.command ?? "",
          workingDirectory: policy?.workingDirectory ?? "",
          msToWait: policy?.timeoutMs ?? 0,
          reason: 1,
        },
      }
    }
  }
  const timeout = lastPrivateMarker(output, TIMEOUT_MARKER, "(\\d+)")
  if (timeout) {
    return {
      output: withoutMarker(output, timeout.index),
      outcome: { kind: "timeout", timeoutMs: Number(timeout.values[0]) },
    }
  }
  const exit = lastPrivateMarker(output, EXIT_MARKER, "(-?\\d+)")
  if (exit) {
    return {
      output: withoutMarker(output, exit.index),
      outcome: { kind: "exit", code: Number(exit.values[0]) },
    }
  }
  return undefined
}

function parseBackgroundSpawnOutcome(
  output: string,
  policy: CursorShellPolicy | undefined,
): { output: string; outcome: CursorShellOutcome } | undefined {
  const match = lastPrivateMarker(output, BACKGROUND_SHELL_MARKER, "(\\d+):([^\\r\\n]+)")
  if (!match) return undefined
  const pid = Number(match.values[0])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return undefined
  return {
    output: withoutMarker(output, match.index),
    outcome: {
      kind: "backgrounded",
      shellId: pid,
      pid,
      command: policy?.command ?? "",
      workingDirectory: policy?.workingDirectory ?? "",
      msToWait: 0,
      reason: 1,
    },
  }
}

/**
 * Strip private wrapper sentinels / OpenCode timeout envelopes for display.
 * Does not record outcomes — use {@link captureCursorShellResult} for that.
 */
export function sanitizeCursorShellDisplayOutput(
  output: string,
  policy?: CursorShellPolicy,
): string {
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) return formatShellOutcomeDisplay(spawn.output, spawn.outcome)
  }
  if (policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND) {
    const wrapper = parseSoftBackgroundOutcome(output, policy)
    if (wrapper) return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome)
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    return formatShellOutcomeDisplay(timeout.output, {
      kind: "timeout",
      timeoutMs: timeout.timeoutMs,
    })
  }
  return output
}

/** Sanitize a secondary display string (e.g. Bash `metadata.output`) for a registered call. */
export function sanitizeRegisteredCursorShellOutput(toolCallId: string, output: string): string {
  if (typeof toolCallId !== "string" || !toolCallId) return output
  return sanitizeCursorShellDisplayOutput(output, policies.get(toolCallId))
}

/**
 * Capture Bash completion in the classic plugin's after hook. Returns the
 * sanitized output that OpenCode should store and render.
 */
export function captureCursorShellResult(
  toolCallId: string,
  output: string,
  metadata?: Record<string, unknown>,
): string {
  if (typeof toolCallId !== "string" || !toolCallId.startsWith("cursor_")) return output
  const policy = policies.get(toolCallId)
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) {
      remember(outcomes, toolCallId, spawn.outcome)
      return formatShellOutcomeDisplay(spawn.output, spawn.outcome)
    }
  }
  // Private wrapper sentinels are meaningful only for calls we transformed.
  // A normal foreground command is allowed to print the same text verbatim.
  const wrapper = policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND
    ? parseSoftBackgroundOutcome(output, policy)
    : undefined
  if (wrapper) {
    remember(outcomes, toolCallId, wrapper.outcome)
    return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome)
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    const outcome = { kind: "timeout" as const, timeoutMs: timeout.timeoutMs }
    remember(outcomes, toolCallId, outcome)
    return formatShellOutcomeDisplay(timeout.output, outcome)
  }
  const exitCode = finiteNonNegative(metadata?.exit)
  if (exitCode !== undefined) remember(outcomes, toolCallId, { kind: "exit", code: exitCode })
  return output
}

/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export function consumeCursorShellResult(
  toolCallId: string,
  output: string,
): { output: string; outcome?: CursorShellOutcome } {
  if (typeof toolCallId !== "string" || !toolCallId) {
    return { output }
  }
  let clean = output
  if (!outcomes.has(toolCallId)) clean = captureCursorShellResult(toolCallId, output)
  const outcome = outcomes.get(toolCallId)
  outcomes.delete(toolCallId)
  policies.delete(toolCallId)
  releaseCursorShellEnv(toolCallId)
  return { output: clean, outcome }
}

/** Test/process cleanup. */
export function resetCursorShellCalls(): void {
  for (const wrap of activeEnvWraps.values()) wrap.cleanup()
  activeEnvWraps.clear()
  pendingEnvWraps.clear()
  policies.clear()
  outcomes.clear()
}