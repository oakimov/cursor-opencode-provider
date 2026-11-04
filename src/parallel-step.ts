/**
 * Parallel tool-call step boundary for OpenCode's AI SDK step model.
 *
 * Cursor fires execs as they are generated; CLI demuxes them concurrently and
 * has no step boundary. OpenCode needs one `finish: tool-calls` after every
 * call of the generation. Cursor's `tool_requests_listed` (InteractionUpdate
 * field 27) carries that count. Calls held behind a file change
 * (`src/step-order.ts`) count as disposed here and run in a later host step.
 */

/** Idle without a progress frame while holding → close the step (ms). */
export const PARALLEL_STEP_IDLE_MS = 1_500

export type ParallelStepState = {
  /** From field 27; undefined until Cursor lists the count for this step. */
  listedCount?: number
  /** Model tool_call_ids seen this step. */
  callIds: Set<string>
  /** Ids with a final client disposition this step. */
  resolved: Set<string>
  /** Host tool-call parts emitted this step. */
  emitted: number
  /** Wall time of the last progress frame (for the liveness guard). */
  lastProgressAt: number
  /**
   * Runs only calls released from a hold. Its Cursor step was booked with the
   * host step that held them, so its finish books nothing.
   */
  unbilled?: boolean
}

/** Process-level: Cursor has sent field 27 on any Run in this process. */
let toolRequestsListedSeen = false

export function noteToolRequestsListedSeen(): void {
  toolRequestsListedSeen = true
}

export function hasSeenToolRequestsListed(): boolean {
  return toolRequestsListedSeen
}

/** Test-only: reset the process capability gate. */
export function resetToolRequestsListedSeenForTests(): void {
  toolRequestsListedSeen = false
}

export function createParallelStep(now = Date.now()): ParallelStepState {
  return {
    callIds: new Set(),
    resolved: new Set(),
    emitted: 0,
    lastProgressAt: now,
  }
}

export function noteParallelStepProgress(step: ParallelStepState, now = Date.now()): void {
  step.lastProgressAt = now
}

export function noteListedCallCount(
  step: ParallelStepState,
  callCount: number,
  now = Date.now(),
): void {
  noteToolRequestsListedSeen()
  if (Number.isFinite(callCount) && callCount >= 0) {
    step.listedCount = callCount
  }
  noteParallelStepProgress(step, now)
}

/**
 * Record a final disposition for `callId`. Returns true when newly resolved.
 * Empty ids are ignored. Prior-step ids in `prior` are ignored.
 */
export function resolveParallelStepCall(
  step: ParallelStepState,
  callId: string | undefined,
  prior?: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  if (!callId) return false
  if (prior?.has(callId)) return false
  step.callIds.add(callId)
  if (step.resolved.has(callId)) return false
  step.resolved.add(callId)
  noteParallelStepProgress(step, now)
  return true
}

export function recordParallelStepEmission(step: ParallelStepState, now = Date.now()): void {
  step.emitted++
  noteParallelStepProgress(step, now)
}

/** True when the listed count is known and every listed call is resolved. */
export function parallelStepCountMet(step: ParallelStepState): boolean {
  return step.listedCount !== undefined && step.resolved.size >= step.listedCount
}

/**
 * Whether to keep pumping for more calls of this step instead of finishing.
 *
 * - Gate off and no count yet → do not hold (today's one-call finish).
 * - Human-gated interaction with unknown count → do not hold (prompt must show).
 * - Otherwise hold until the count is met (or the liveness guard fires).
 */
export function shouldHoldParallelStep(
  step: ParallelStepState,
  options: {
    fieldSeen?: boolean
    humanGatedWithoutCount?: boolean
  } = {},
): boolean {
  if (options.humanGatedWithoutCount && step.listedCount === undefined) return false
  const fieldSeen = options.fieldSeen ?? hasSeenToolRequestsListed()
  if (!fieldSeen && step.listedCount === undefined) return false
  if (parallelStepCountMet(step)) return false
  return true
}

/** True when the hold has made no progress for `idleMs`. */
export function shouldGuardCloseParallelStep(
  step: ParallelStepState,
  now = Date.now(),
  idleMs = PARALLEL_STEP_IDLE_MS,
): boolean {
  if (parallelStepCountMet(step)) return false
  return now - step.lastProgressAt >= idleMs
}

/**
 * Frames that reset the liveness guard while holding. Heartbeat, KV, and
 * checkpoint are not progress — they say nothing about further tool calls.
 */
export function isParallelStepProgressFrame(kinds: {
  toolRequestsListed?: boolean
  partialToolCall?: boolean
  toolCallDelta?: boolean
  toolCallStarted?: boolean
  toolCallCompleted?: boolean
  exec?: boolean
  interactionQuery?: boolean
  textDelta?: boolean
  thinkingDelta?: boolean
}): boolean {
  return !!(
    kinds.toolRequestsListed
    || kinds.partialToolCall
    || kinds.toolCallDelta
    || kinds.toolCallStarted
    || kinds.toolCallCompleted
    || kinds.exec
    || kinds.interactionQuery
    || kinds.textDelta
    || kinds.thinkingDelta
  )
}
