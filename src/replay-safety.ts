import type { CursorProviderError } from "./errors.js"
import { trace } from "./debug.js"
import { readAllFieldsStrict, type StrictRawField } from "./protocol/struct.js"

export type ReplayBarrierReason =
  | "visible-text"
  | "visible-reasoning"
  | "visible-tool-row"
  | "display-tool-lifecycle"
  | "non-control-exec"
  | "stateful-interaction"
  | "unknown-or-malformed-frame"

/** Host output without execution authority: sending the turn again repeats no side effect. */
const OUTPUT_ONLY_BARRIERS: ReadonlySet<ReplayBarrierReason> = new Set([
  "visible-text", "visible-reasoning", "visible-tool-row",
])

/** Plain Run-owned state retained across host tool-step pump calls. */
export type ReplaySafetyState = {
  statefulBarrier?: ReplayBarrierReason
  /**
   * Every exec needs its owner's host result; ids can restart on a resumed Run.
   * `callId` is the display call the exec claims.
   */
  execs?: Array<{ sessionId: string; id: number; callId?: string }>
  /** Display calls Cursor announced; history holds one only through the host exec that claims it. */
  announcedCalls?: string[]
  /** History cannot represent opaque interactions, unknown frames or unclaimed display work. */
  historyRebaseUnsafe?: boolean
}

/** Whether a host exec claimed every display call Cursor announced, so history holds each one. */
export function announcedCallsClaimed(state: ReplaySafetyState | undefined): boolean {
  const claimed = new Set(state?.execs?.flatMap((exec) => exec.callId ? [exec.callId] : []))
  return (state?.announcedCalls ?? []).every((callId) => claimed.has(callId))
}

export class AttemptReplaySafety {
  private barrierReason: ReplayBarrierReason | undefined
  private stateful = false

  constructor(
    private readonly sessionId: string,
    private readonly state: ReplaySafetyState = {},
  ) {
    this.stateful = state.statefulBarrier !== undefined
  }

  markBarrier(reason: ReplayBarrierReason): void {
    this.mark(reason, reason === "non-control-exec")
  }

  /**
   * A display lifecycle frame. A started call stays a stateful barrier but
   * blocks a history rebuild only until a host exec claims it; completion of a
   * claimed call adds nothing history lacks. Calls Cursor runs itself, and
   * frames without a call id, cannot be rebuilt.
   */
  recordToolLifecycle(lifecycle: ReplayToolLifecycle | undefined): void {
    const claimed = !!lifecycle && !!this.state.execs?.some((exec) => exec.callId === lifecycle.callId)
    if (lifecycle?.kind === "completed" && claimed) {
      trace(`replay: display completion of claimed callId=${lifecycle.callId} sessionId=${this.sessionId}`)
      return
    }
    if (lifecycle?.kind === "started" && !claimed) {
      const announced = this.state.announcedCalls ??= []
      if (!announced.includes(lifecycle.callId)) announced.push(lifecycle.callId)
      this.mark("display-tool-lifecycle", true)
      return
    }
    this.mark("display-tool-lifecycle", false)
  }

  recordExec(id: unknown, callId?: string): void {
    const execs = this.state.execs ??= []
    if (typeof id !== "number" || !Number.isSafeInteger(id)
      || execs.some(exec => exec.sessionId === this.sessionId && exec.id === id)) {
      this.state.historyRebaseUnsafe = true
      return
    }
    execs.push({ sessionId: this.sessionId, id, ...(callId ? { callId } : {}) })
  }

  private mark(reason: ReplayBarrierReason, historyRepresentable: boolean): void {
    if (!OUTPUT_ONLY_BARRIERS.has(reason)) {
      this.stateful = true
      this.state.statefulBarrier ??= reason
      if (!historyRepresentable) this.state.historyRebaseUnsafe = true
    }
    if (this.barrierReason) return
    this.barrierReason = reason
    trace(`replay barrier: reason=${reason} sessionId=${this.sessionId}`)
  }

  applyTo(failure: CursorProviderError): CursorProviderError {
    failure.replaySafe = this.barrierReason === undefined && !this.stateful && failure.replaySafe
    if (this.barrierReason) {
      failure.replayBarrier = this.stateful ? "stateful" : "output-only"
      trace(
        `replay suppressed: reason=${this.barrierReason} barrier=${failure.replayBarrier} ` +
          `sessionId=${this.sessionId}`,
      )
    }
    return failure
  }
}

export type DecodedReplayFrame = {
  interactionUpdate?: Record<string, unknown>
  exec?: Record<string, unknown>
  kv?: Record<string, unknown>
  execControl?: Record<string, unknown>
  interactionQuery?: Record<string, unknown>
}

export type ReplayToolLifecycle = { kind: "started" | "completed"; callId: string }

export type ReplayFrameAnalysis = {
  barrier?: ReplayBarrierReason
  /** Set for a well-formed lifecycle frame with a call id. */
  toolLifecycle?: ReplayToolLifecycle
}

// Field numbers follow Cursor CLI 2026.09.28 `agent.v1`; the extracted
// agent.proto lags the live server.
// `InteractionUpdate` oneof members this client recognizes. Besides the
// declared ones: `thinking_completed` #5 (duration), `token_delta` #8 (count),
// `tool_call_delta` #15 (argument stream, like `partial_tool_call` #7),
// `context_injection_state` #23 (status of a client injection, which Cursor
// CLI only shows for queued steers), `routed_model` #24 (display name) and
// `tool_requests_listed` #27 (count) carry no output and no state. Other
// members stay barriers. `user_message_appended` #6 is recognized but stateful:
// the shipped CLI commits its pending turn and starts one from the user message.
const INTERACTION_UPDATE_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17, 23, 24, 27])
/** `InteractionUpdate.message_started_at_ms` #25: a timestamp beside the oneof member. */
const INTERACTION_UPDATE_STARTED_AT = 25
const INTERACTION_QUERY_FIELDS = new Set([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14])
const TOP_LEVEL_FIELDS = new Set([1, 2, 3, 4, 5, 7])
/** `AgentServerMessage.ttft_breakdown` #8: timing metrics beside the oneof member. */
const SERVER_MESSAGE_TTFT = 8

/** At most one occurrence of an optional field, with the expected wire type. */
function optionalField(fields: readonly StrictRawField[], fn: number, wt: number): boolean {
  const matches = fields.filter((field) => field.fn === fn)
  return matches.length <= 1 && matches.every((field) => field.wt === wt)
}

function nestedFields(topLevel: StrictRawField | undefined, field: number): StrictRawField[] {
  if (topLevel?.fn !== field || topLevel.wt !== 2 || !topLevel.bytes) return []
  return readAllFieldsStrict(topLevel.bytes) ?? []
}

function analyzeExecWire(topLevel: StrictRawField | undefined) {
  const variants = nestedFields(topLevel, 2)
    .filter((field) => ![1, 15, 19].includes(field.fn))
  const exactVariant = (field: number): boolean =>
    variants.length === 1 && variants[0]!.fn === field && variants[0]!.wt === 2
  return {
    exactRequestContext: exactVariant(10),
    exactMcpState: exactVariant(36),
  }
}

// `KvServerMessage` = id #1, oneof get #2 / set #3, `span_context` #4 (tracing);
// Cursor sends the span on live KV requests.
function validKvWire(topLevel: StrictRawField | undefined): boolean {
  const fields = nestedFields(topLevel, 4)
  const spans = fields.filter((field) => field.fn === 4)
  if (spans.length > 1 || spans.some((field) => field.wt !== 2)) return false
  const variants = fields.filter((field) => field.fn !== 1 && field.fn !== 4)
  const variant = variants.length === 1 ? variants[0] : undefined
  const args = variant?.wt === 2 && variant.bytes
    ? (readAllFieldsStrict(variant.bytes) ?? [])
    : []
  const blobIds = args.filter(
    (field) => field.fn === 1 && field.wt === 2 && (field.bytes?.length ?? 0) > 0,
  )
  return !!variant
    && [2, 3].includes(variant.fn)
    && variant.wt === 2
    && blobIds.length === 1
    && args.every(
      (field) => field.wt === 2 && (field.fn === 1 || (variant.fn === 3 && field.fn === 2)),
    )
}

function validInteractionUpdateWire(
  topLevel: StrictRawField | undefined,
  decoded: Record<string, unknown> | undefined,
): boolean {
  if (!decoded) return true
  const all = nestedFields(topLevel, 1)
  if (!optionalField(all, INTERACTION_UPDATE_STARTED_AT, 0)) return false
  const fields = all.filter((field) => field.fn !== INTERACTION_UPDATE_STARTED_AT)
  const update = fields.length === 1 ? fields[0] : undefined
  if (!update || update.wt !== 2 || !INTERACTION_UPDATE_FIELDS.has(update.fn)) return false
  if (update.fn === 6) {
    const appended = update.bytes ? readAllFieldsStrict(update.bytes) : undefined
    return !!decoded.user_message_appended && appended?.length === 1
      && appended[0]!.fn === 1 && appended[0]!.wt === 2
  }
  if (update.fn === 2 || update.fn === 3) {
    // ToolCallStarted / ToolCallCompleted: call_id #1, tool_call #2,
    // model_call_id #3. A decoder can discard unknown or repeated fields;
    // those bytes must not authorize a history rebuild.
    const lifecycle = update.bytes ? readAllFieldsStrict(update.bytes) : undefined
    return !!lifecycle && lifecycle.every((field) => [1, 2, 3].includes(field.fn))
      && [1, 2, 3].every((field) => optionalField(lifecycle, field, 2))
  }
  if (![1, 4].includes(update.fn)) return true
  const delta = update.bytes ? (readAllFieldsStrict(update.bytes) ?? []) : []
  const text = delta.filter((field) => field.fn === 1)
  // #2 is `TextDeltaUpdate.is_server_notice` (bool) or
  // `ThinkingDeltaUpdate.thinking_style` (enum); both varints.
  const flag = delta.filter((field) => field.fn === 2)
  return text.length === 1 && text[0]!.wt === 2
    && optionalField(delta, 2, 0)
    && delta.length === text.length + flag.length
}

function validInteractionQueryWire(
  topLevel: StrictRawField | undefined,
  decoded: Record<string, unknown> | undefined,
): boolean {
  if (!decoded) return true
  const fields = nestedFields(topLevel, 7)
  const ids = fields.filter((field) => field.fn === 1)
  const variants = fields.filter((field) => field.fn !== 1)
  return ids.length <= 1
    && ids.every((field) => field.wt === 0)
    && variants.length === 1
    && variants[0]!.wt === 2
    && INTERACTION_QUERY_FIELDS.has(variants[0]!.fn)
}

function decodedMatchesWire(topLevel: StrictRawField | undefined, decoded: DecodedReplayFrame): boolean {
  return !(
    (topLevel?.fn === 1 && !decoded.interactionUpdate)
    || (topLevel?.fn === 2 && !decoded.exec)
    || (topLevel?.fn === 4 && !decoded.kv)
    || (topLevel?.fn === 5 && !decoded.execControl)
    || (topLevel?.fn === 7 && !decoded.interactionQuery)
  )
}

/**
 * Field numbers and wire types of a frame, nested three levels, without any
 * payload bytes: `1:2{16:2{1:0}}`. Compare it with `agent.proto` when a frame
 * is classified unknown.
 */
export function describeFrameLayout(payload: Uint8Array, depth = 3): string {
  const fields = readAllFieldsStrict(payload)
  if (!fields) return "?"
  return fields.map((field) => {
    const nested = depth > 1 && field.wt === 2 && field.bytes && field.bytes.length > 0
      ? readAllFieldsStrict(field.bytes)
      : undefined
    const inner = nested && nested.length > 0 ? `{${describeFrameLayout(field.bytes!, depth - 1)}}` : ""
    return `${field.fn}:${field.wt}${inner}`
  }).join(",")
}

/** Classify one decoded server frame without performing any protocol side effects. */
export function analyzeReplayFrame(
  payload: Uint8Array,
  decoded: DecodedReplayFrame,
): ReplayFrameAnalysis {
  const allTopLevel = readAllFieldsStrict(payload) ?? []
  const ttftValid = optionalField(allTopLevel, SERVER_MESSAGE_TTFT, 2)
  const topLevelFields = allTopLevel.filter((field) => field.fn !== SERVER_MESSAGE_TTFT)
  const topLevel = ttftValid && topLevelFields.length === 1 ? topLevelFields[0] : undefined
  const exec = analyzeExecWire(topLevel)
  const validKv = validKvWire(topLevel)
  const malformed = !topLevel
    || topLevel.wt !== 2
    || !TOP_LEVEL_FIELDS.has(topLevel.fn)
    || !validInteractionUpdateWire(topLevel, decoded.interactionUpdate)
    || !validInteractionQueryWire(topLevel, decoded.interactionQuery)
    || !decodedMatchesWire(topLevel, decoded)
    || !!decoded.execControl

  const started = decoded.interactionUpdate?.tool_call_started as Record<string, unknown> | undefined
  const completed = decoded.interactionUpdate?.tool_call_completed as Record<string, unknown> | undefined
  if (started || completed) {
    const callId = (started ?? completed)?.call_id
    return {
      barrier: "display-tool-lifecycle",
      ...(!malformed && typeof callId === "string" && callId.length > 0
        ? { toolLifecycle: { kind: started ? "started" : "completed", callId } }
        : {}),
    }
  }
  let barrier: ReplayBarrierReason | undefined
  if (malformed || (topLevel.fn === 4 && !validKv)) {
    barrier = "unknown-or-malformed-frame"
  } else if (topLevel.fn === 1 && decoded.interactionUpdate?.user_message_appended) {
    barrier = "stateful-interaction"
  } else if (topLevel.fn === 2 && !exec.exactRequestContext && !exec.exactMcpState) {
    barrier = "non-control-exec"
  }

  return { barrier }
}
