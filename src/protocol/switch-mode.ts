/**
 * Cursor-native SwitchMode ⇄ OpenCode `plan_enter` / `plan_exit`.
 *
 * Cursor raises `switch_mode_request_query` (#4) with SwitchModeArgs and blocks
 * until the client replies approved{} or rejected{reason} (no async variant).
 * Cursor CLI prompts the user, then flips unifiedMode and injects a
 * `<system_reminder>` describing how to behave in that mode.
 * Display `switch_mode_tool_call` (#25) is a separate transcript record and is
 * not replayed as a host tool.
 *
 * Host mapping (advertisement-gated):
 * - plan, spec → plan_enter
 * - every other non-empty target → plan_exit (leave plan for OpenCode build),
 *   then inject the Cursor CLI-shaped mode reminder for that target
 *
 * CLI reject reason for user declines: "Mode switch rejected by user"
 * (chunk-7076/dist/ui.js onSwitchModeReject).
 */

import { decodeMessageSparse } from "./messages.js"

/**
 * `PendingExec.resultField` for a held-open SwitchMode InteractionQuery.
 * Continuation writes an InteractionResponse, not an ExecClientMessage.
 */
export const SWITCH_MODE_RESULT_FIELD = "switch_mode_request_response"

/** CLI verbatim when the user rejects the mode switch. */
export const USER_REJECTED_REASON = "Mode switch rejected by user"

export const MISSING_QUERY_REASON = "Missing switch-mode query"
export const MISSING_ARGS_REASON = "Missing switch-mode arguments"
export const MISSING_TARGET_REASON = "Missing targetModeId"

export const PLAN_ENTER_UNAVAILABLE_REASON =
  "The OpenCode `plan_enter` tool is not available to the current agent, so " +
  "entering plan mode cannot be offered this turn."

export const PLAN_EXIT_UNAVAILABLE_REASON =
  "The OpenCode `plan_exit` tool is not available to the current agent, so " +
  "leaving plan mode cannot be offered this turn."

export type SwitchModeHostTool = "plan_enter" | "plan_exit"

export type CursorSwitchModeArgs = {
  targetModeId: string
  explanation: string
  toolCallId: string
}

export type DecodedSwitchModeQuery = {
  args: CursorSwitchModeArgs
  toolCallId: string
}

export type SwitchModeMapping =
  | { ok: true; toolName: SwitchModeHostTool }
  | { ok: false; reason: string }

/** Active Cursor unified-mode id for an OpenCode session (after approved SwitchMode). */
type ActiveCursorModeState = {
  modeId: string
  /** True until the first post-switch Run consumes the enter reminder. */
  firstTurn: boolean
}

const activeCursorModeBySession = new Map<string, ActiveCursorModeState>()

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Normalize Cursor mode ids for comparison. */
export function normalizeSwitchModeId(targetModeId: string): string {
  return targetModeId.trim().toLowerCase()
}

/**
 * Map a Cursor unified-mode id onto an OpenCode plan enter/exit tool.
 * Does not check advertisement — callers gate on the host catalog.
 *
 * plan/spec enter plan; every other non-empty target leaves plan via plan_exit
 * (host-portable primary switch) and relies on {@link cursorModeSystemReminder}
 * for CLI-shaped behavioral guidance.
 */
export function mapSwitchModeTarget(targetModeId: string): SwitchModeMapping {
  const id = normalizeSwitchModeId(targetModeId)
  if (!id) return { ok: false, reason: MISSING_TARGET_REASON }

  if (id === "plan" || id === "spec") {
    return { ok: true, toolName: "plan_enter" }
  }
  return { ok: true, toolName: "plan_exit" }
}

/**
 * Resolve the host tool only when it is advertised this turn.
 */
export function resolveSwitchModeHostTool(
  targetModeId: string,
  options: {
    allowTools: boolean
    advertised: ReadonlySet<string> | Iterable<string>
  },
): SwitchModeMapping {
  const mapped = mapSwitchModeTarget(targetModeId)
  if (!mapped.ok) return mapped

  if (!options.allowTools) {
    return {
      ok: false,
      reason:
        mapped.toolName === "plan_enter"
          ? PLAN_ENTER_UNAVAILABLE_REASON
          : PLAN_EXIT_UNAVAILABLE_REASON,
    }
  }

  const names =
    options.advertised instanceof Set
      ? options.advertised
      : new Set(options.advertised)
  if (!names.has(mapped.toolName)) {
    return {
      ok: false,
      reason:
        mapped.toolName === "plan_enter"
          ? PLAN_ENTER_UNAVAILABLE_REASON
          : PLAN_EXIT_UNAVAILABLE_REASON,
    }
  }
  return mapped
}

/** Decode a `switch_mode_request_query` body, or undefined when unusable. */
export function decodeSwitchModeQuery(
  queryBytes: Uint8Array,
): DecodedSwitchModeQuery | undefined {
  let decoded: Record<string, unknown>
  try {
    decoded = decodeMessageSparse("SwitchModeRequestQuery", queryBytes)
  } catch {
    return undefined
  }
  const argsRecord = asRecord(decoded.args)
  if (!argsRecord) return undefined

  const targetModeId = str(argsRecord.target_mode_id)
  if (!targetModeId.trim()) return undefined

  const toolCallId =
    str(argsRecord.tool_call_id) || str(decoded.tool_call_id)

  return {
    args: {
      targetModeId,
      explanation: str(argsRecord.explanation),
      toolCallId,
    },
    toolCallId,
  }
}

/** OpenCode plan_enter / plan_exit advertise empty input. */
export function switchModeToolInput(): Record<string, never> {
  return {}
}

/** Shape `approved{}` / `rejected{reason}` for encodeMessage. */
export function switchModeApprovedResult(): Record<string, unknown> {
  return { approved: {} }
}

export function switchModeRejectedResult(reason: string): Record<string, unknown> {
  return { rejected: { reason } }
}

/**
 * Host tool outcome → Cursor SwitchModeRequestResponse.
 * Question/permission declines and empty failures use the CLI user-reject string.
 */
export function switchModeResultFromToolOutput(
  output: string,
  isError: boolean,
): Record<string, unknown> {
  if (!isError) return switchModeApprovedResult()
  const trimmed = output.trim()
  // OpenCode plan tools throw Question.RejectedError on "No" — treat as user reject.
  if (
    !trimmed
    || /reject/i.test(trimmed)
    || /denied/i.test(trimmed)
    || /permission/i.test(trimmed)
    || /cancelled|canceled|dismissed/i.test(trimmed)
  ) {
    return switchModeRejectedResult(USER_REJECTED_REASON)
  }
  return switchModeRejectedResult(trimmed)
}

/** Record the approved Cursor mode for later system-reminder injection. */
export function setActiveCursorMode(sessionKey: string | undefined, targetModeId: string): void {
  if (!sessionKey) return
  const modeId = normalizeSwitchModeId(targetModeId)
  if (!modeId) return
  activeCursorModeBySession.set(sessionKey, { modeId, firstTurn: true })
}

export function getActiveCursorMode(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  return activeCursorModeBySession.get(sessionKey)?.modeId
}

export function clearActiveCursorMode(sessionKey: string | undefined): void {
  if (!sessionKey) return
  activeCursorModeBySession.delete(sessionKey)
}

export function resetActiveCursorModesForTests(): void {
  activeCursorModeBySession.clear()
}

function wrapReminder(body: string): string {
  return `<system_reminder>\n${body.trim()}\n</system_reminder>`
}

/**
 * Cursor CLI-shaped mode reminder for the active unified mode.
 * Tool names are adapted to OpenCode (`task`, `question`) where the CLI names
 * Cursor-only tools; the behavioral contract matches the CLI reminders.
 */
export function cursorModeSystemReminder(
  targetModeId: string,
  options: { firstTurn?: boolean } = {},
): string | undefined {
  const id = normalizeSwitchModeId(targetModeId)
  if (!id) return undefined
  const first = options.firstTurn !== false

  if (id === "plan" || id === "spec") {
    return wrapReminder(
      first
        ? `Plan mode is active. The user does not want execution yet -- you MUST NOT make edits, run non-readonly tools (including changing configs or making commits), or otherwise modify system state. This supersedes any conflicting instruction.

1. Research enough to make an accurate plan.
2. Before finishing, resolve decisions that would materially change the implementation path, touched files, architecture, user-visible behavior, data model, or validation strategy. If investigation cannot resolve one, ask clarifying questions in small batches (use the OpenCode \`question\` tool when available).
3. Do not put choices in the plan for the user to resolve. The plan must present one recommended approach, not unresolved questions or "choose A or B" options.
4. When ready, write or update the plan as markdown and/or call OpenCode \`plan_exit\` so the user can approve leaving plan mode.
5. Do not execute the plan until the user confirms it.`
        : `Plan mode is still active. You MUST NOT make edits, run non-readonly tools (including changing configs or making commits), or otherwise modify system state. This supersedes any conflicting instruction.`,
    )
  }

  if (id === "chat") {
    return wrapReminder(
      first
        ? `Ask mode is active. The user wants you to answer questions about their codebase or coding in general. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits).

Your role in Ask mode:

1. Answer the user's questions comprehensively and accurately. Focus on providing clear, detailed explanations.
2. Use readonly tools to explore the codebase and gather information needed to answer the user's questions.
3. Provide code examples and references when helpful, citing specific file paths and line numbers.
4. If you need more information, ask the user for clarification (OpenCode \`question\` when available).
5. You may provide suggestions about how to implement something, but you MUST NOT actually implement it yourself.
6. If the user asks you to make changes or implement something, politely remind them that you're in Ask mode and can only provide information and guidance. Suggest they switch to Agent mode (OpenCode \`plan_exit\` / SwitchMode target agent) if they want you to make changes.`
        : `Ask mode is still active. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits).`,
    )
  }

  if (id === "debug") {
    return wrapReminder(
      first
        ? `You are now in **DEBUG MODE**. You must debug with **runtime evidence**.

**Why this approach:** Traditional AI agents jump to fixes claiming high confidence, but fail due to lacking runtime information. You cannot and must NOT fix bugs from code-only guesses — you need actual runtime data.

**Your systematic workflow:**
1. Generate 3-5 precise hypotheses about WHY the bug occurs.
2. Instrument code with logs to test hypotheses in parallel.
3. Ask the user to reproduce the bug. Conclude with a <reproduction_steps>...</reproduction_steps> block when the user must run something (mandatory unless the issue is fully confirmed fixed).
4. Analyze logs, accept/reject hypotheses, and only then implement a fix.
5. Verify the fix with runtime evidence before claiming success.

Prefer reproduction, runtime logs, and end-to-end verification over speculative refactors.`
        : `Debug mode is still active. You must debug with **runtime evidence**.

**During fixes:** Do NOT remove instrumentation until post-fix verification logs prove success or the user explicitly asks you to remove it.
**Testing:** Prefer reproduction, runtime logs, and end-to-end verification; run tests when they directly exercise a hypothesis or confirm the final fix.
**Reproduction steps (MANDATORY):** Unless the issue is fully confirmed fixed, conclude with a <reproduction_steps>...</reproduction_steps> block when the user must reproduce.
**If fix failed:** Generate NEW hypotheses from different subsystems and add more instrumentation.`,
    )
  }

  if (id === "multitask") {
    return wrapReminder(
      `Multitask Mode is active. You are a coordinator who pushes meaningful work to asynchronous workers through the OpenCode \`task\` tool (prefer background=true when the host supports it).

- For most non-trivial requests, launch or resume one coherent worker and let that worker handle the investigation/implementation.
- After delegating the only coherent worker task, do not redo the same work in the foreground. Only coordinate, answer a new independent question, or synthesize after multiple workers return.
- NEVER await or sleep while waiting for a running subagent — end your response; you will be notified when it completes.
- Do NOT aggressively decompose small or medium tasks into many sibling agents. Multitask Mode is about moving substantial work out of the foreground, not maximizing parallel agents.
- For trivial requests (zero or one tool call), fulfill them directly and disregard these Multitask instructions.`,
    )
  }

  if (id === "triage") {
    return wrapReminder(
      first
        ? `Triage mode is active. Your job is to coordinate long-horizon, multi-step work by delegating to subagents and integrating their progress.

1. Break the user's task into well-scoped subtasks and launch subagents with the OpenCode \`task\` tool. Provide clear objectives and context so each subagent can make measurable progress.
2. Routinely inspect subagent output and synthesize results.
3. Decide next steps and iterate: launch additional agents, request revisions, or merge work when ready.
4. Throughout triage mode, maintain a global plan, document your decisions, and ensure the combined work moves the user toward their goal.`
        : `Triage mode is still active. You must continue to coordinate long-horizon, multi-step work by delegating to subagents and integrating their progress.`,
    )
  }

  if (id === "project") {
    return wrapReminder(
      `You are Project Agent Mode: a long-running, high-level planner and orchestrator for complex software projects.

Your mandate is to convert user intent into a correct, high-quality implementation by delegating nearly all work to subagents and coordinating them safely over long horizons.

## Non-Negotiable Rules
1) Orchestrate, don't execute — you are NOT an implementer. Workspace modifications MUST be performed by OpenCode \`task\` subagents.
2) Task-first for everything — default to spawning subagents for research, exploration, implementation, validation, and review. Use your own read-only tools only for quick triage and synthesizing plans.
3) No work without clarity — if ambiguity remains, stop and ask clarifying questions (OpenCode \`question\` when available).
4) Phase-gated workflow — Clarify → Research → Plan → User Review → Implement → Review → Iterate → Finalize. Do not skip phases.
5) Externalize state — assume chat context may be condensed; keep durable progress notes so work can resume from written artifacts.`,
    )
  }

  if (id === "background") {
    return wrapReminder(
      `Cloud / background mode intent is active. Prefer long-running and environment/browser automation work via OpenCode \`task\` subagents (background=true when advertised) rather than blocking the foreground turn.

- Useful when the task needs browser automation, multi-service environments, or should keep running if the local session is interrupted.
- After launching background work, end your response promptly; do not busy-wait.
- For short local unit/lint/typecheck work, stay in ordinary agent execution instead.`,
    )
  }

  // agent / build / edit / unknown leave-plan targets: implementation mode.
  return wrapReminder(
    first
      ? `Agent mode is active (OpenCode build / agents). You have left plan mode and may implement: edit files, run tools, and execute the agreed approach.

- Prefer making progress with the advertised host tools.
- If the task is large or ambiguous again, switch back to plan mode (OpenCode \`plan_enter\` / SwitchMode target plan) before a large rewrite.`
      : `Agent mode is still active. Continue implementing with the advertised host tools. Switch back to plan mode only when a new large/ambiguous design decision appears.`,
  )
}

/**
 * Consume the active-mode reminder for this OpenCode session.
 * Marks the mode as no longer first-turn after the first successful read.
 */
export function takeActiveCursorModeReminder(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  const state = activeCursorModeBySession.get(sessionKey)
  if (!state) return undefined
  const reminder = cursorModeSystemReminder(state.modeId, { firstTurn: state.firstTurn })
  if (state.firstTurn) {
    activeCursorModeBySession.set(sessionKey, { modeId: state.modeId, firstTurn: false })
  }
  return reminder
}
