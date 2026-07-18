/** Cursor agent.v1 TimeoutBehavior enum values. */
export const CURSOR_TIMEOUT_CANCEL = 1
export const CURSOR_TIMEOUT_BACKGROUND = 2

const MAX_TRACKED_SHELL_CALLS = 512
const OPENCODE_TIMEOUT_GRACE_MS = 15_000
const POLL_INTERVAL_MS = 100
const BACKGROUND_MARKER = "__CURSOR_SHELL_BACKGROUND__"
const EXIT_MARKER = "__CURSOR_SHELL_EXIT__"
const TIMEOUT_MARKER = "__CURSOR_SHELL_TIMEOUT__"

export type CursorShellPolicy = {
  command: string
  workingDirectory: string
  timeoutMs: number
  timeoutBehavior: number
  hardTimeoutMs?: number
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

const policies = new Map<string, CursorShellPolicy>()
const outcomes = new Map<string, CursorShellOutcome>()

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_SHELL_CALLS) {
    const oldest = map.keys().next().value as string | undefined
    if (!oldest) break
    map.delete(oldest)
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
  if (!metadata || metadata.shell_stream !== true) return undefined
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
    'wait "$cursor_shell_pid"',
    "cursor_shell_code=$?",
    'cat "$cursor_shell_log"',
    'if [ -n "$cursor_shell_status" ] && [ "$(cat "$cursor_shell_status" 2>/dev/null)" = timeout ]; then',
    `  printf '\n${TIMEOUT_MARKER}%s\n' ${policy.hardTimeoutMs ?? policy.timeoutMs}`,
    "else",
    '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${EXIT_MARKER}%s\n' "$cursor_shell_code"`,
    "fi",
    'rm -f -- "$cursor_shell_log"',
    'if [ -n "$cursor_shell_status" ]; then rm -f -- "$cursor_shell_status"; fi',
  )
  return lines.join("\n")
}

/** Mutate OpenCode Bash args before execution when Cursor requested soft backgrounding. */
export function prepareCursorShellArgs(toolCallId: string, args: Record<string, unknown>): void {
  const policy = policies.get(toolCallId)
  if (!policy || policy.timeoutBehavior !== CURSOR_TIMEOUT_BACKGROUND) return
  args.command = buildSoftBackgroundCommand(policy)
  // The wrapper returns just after Cursor's foreground window. OpenCode's own
  // timeout is only an outer safety net and must not win the race.
  args.timeout = Math.max(OPENCODE_TIMEOUT_GRACE_MS, policy.timeoutMs + OPENCODE_TIMEOUT_GRACE_MS)
}

/** Restore the model-facing command in OpenCode's completed tool title. */
export function cursorShellOriginalCommand(toolCallId: string): string | undefined {
  return policies.get(toolCallId)?.command || undefined
}

function withoutMarker(output: string, index: number): string {
  let clean = output.slice(0, index).replace(/[\t ]+$/gm, "").replace(/\n{2,}$/, "\n")
  if (clean.trim() === "" || clean.trim() === "(no output)") clean = ""
  return clean
}

function parseOpenCodeTimeout(output: string): { output: string; timeoutMs: number } | undefined {
  const re = /<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\.[\s\S]*?<\/shell_metadata>\s*$/
  const match = re.exec(output)
  if (!match || match.index === undefined) return undefined
  return { output: withoutMarker(output, match.index), timeoutMs: Number(match[1]) }
}

function parseWrapperOutcome(
  output: string,
  policy: CursorShellPolicy | undefined,
): { output: string; outcome: CursorShellOutcome } | undefined {
  const background = new RegExp(`${BACKGROUND_MARKER}(\\d+):([^\\r\\n]+)\\s*$`).exec(output)
  if (background?.index !== undefined) {
    const pid = Number(background[1])
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
  const timeout = new RegExp(`${TIMEOUT_MARKER}(\\d+)\\s*$`).exec(output)
  if (timeout?.index !== undefined) {
    return {
      output: withoutMarker(output, timeout.index),
      outcome: { kind: "timeout", timeoutMs: Number(timeout[1]) },
    }
  }
  const exit = new RegExp(`${EXIT_MARKER}(-?\\d+)\\s*$`).exec(output)
  if (exit?.index !== undefined) {
    return {
      output: withoutMarker(output, exit.index),
      outcome: { kind: "exit", code: Number(exit[1]) },
    }
  }
  return undefined
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
  if (!toolCallId.startsWith("cursor_")) return output
  const policy = policies.get(toolCallId)
  // Private wrapper sentinels are meaningful only for calls we transformed.
  // A normal foreground command is allowed to print the same text verbatim.
  const wrapper = policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND
    ? parseWrapperOutcome(output, policy)
    : undefined
  if (wrapper) {
    remember(outcomes, toolCallId, wrapper.outcome)
    return wrapper.output
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    remember(outcomes, toolCallId, { kind: "timeout", timeoutMs: timeout.timeoutMs })
    return timeout.output
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
  let clean = output
  if (!outcomes.has(toolCallId)) clean = captureCursorShellResult(toolCallId, output)
  const outcome = outcomes.get(toolCallId)
  outcomes.delete(toolCallId)
  policies.delete(toolCallId)
  return { output: clean, outcome }
}

/** Test/process cleanup. */
export function resetCursorShellCalls(): void {
  policies.clear()
  outcomes.clear()
}
