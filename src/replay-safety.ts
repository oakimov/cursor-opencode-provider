import type { CursorProviderError } from "./errors.js"
import { trace } from "./debug.js"
import { readAllFieldsStrict, type StrictRawField } from "./protocol/struct.js"

export type ReplayBarrierReason =
  | "visible-text"
  | "visible-reasoning"
  | "display-tool-lifecycle"
  | "non-control-exec"
  | "stateful-interaction"
  | "unknown-or-malformed-frame"

export class AttemptReplaySafety {
  private barrierReason: ReplayBarrierReason | undefined

  constructor(private readonly sessionId: string) {}

  markBarrier(reason: ReplayBarrierReason): void {
    if (this.barrierReason) return
    this.barrierReason = reason
    trace(`replay barrier: reason=${reason} sessionId=${this.sessionId}`)
  }

  applyTo(failure: CursorProviderError): CursorProviderError {
    failure.replaySafe = this.barrierReason === undefined && failure.replaySafe
    if (this.barrierReason) {
      trace(`replay suppressed: reason=${this.barrierReason} sessionId=${this.sessionId}`)
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
  checkpointBytes?: Uint8Array
}

export type ReplayFrameAnalysis = {
  semanticProgress: boolean
  barrier?: ReplayBarrierReason
}

const INTERACTION_UPDATE_FIELDS = new Set([1, 2, 3, 4, 7, 13, 14, 16, 17])
const INTERACTION_QUERY_FIELDS = new Set([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14])
const TOP_LEVEL_FIELDS = new Set([1, 2, 3, 4, 5, 7])

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

function validKvWire(topLevel: StrictRawField | undefined): boolean {
  const variants = nestedFields(topLevel, 4).filter((field) => field.fn !== 1)
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
  const fields = nestedFields(topLevel, 1)
  const update = fields.length === 1 ? fields[0] : undefined
  if (!update || update.wt !== 2 || !INTERACTION_UPDATE_FIELDS.has(update.fn)) return false
  if (![1, 4].includes(update.fn)) return true
  const delta = update.bytes ? (readAllFieldsStrict(update.bytes) ?? []) : []
  return delta.length === 1 && delta[0]!.fn === 1 && delta[0]!.wt === 2
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

function hasSemanticProgress(decoded: DecodedReplayFrame): boolean {
  const update = decoded.interactionUpdate
  const text = (update?.text_delta as Record<string, unknown> | undefined)?.text
  const thinking = (update?.thinking_delta as Record<string, unknown> | undefined)?.text
  return (typeof text === "string" && text.length > 0)
    || (typeof thinking === "string" && thinking.length > 0)
    || !!update?.turn_ended
    || !!update?.tool_call_started
    || !!update?.tool_call_completed
    || !!decoded.exec
    || !!decoded.kv
    || !!decoded.execControl
    || !!decoded.interactionQuery
    || !!decoded.checkpointBytes?.length
}

/** Classify one decoded server frame without performing any protocol side effects. */
export function analyzeReplayFrame(
  payload: Uint8Array,
  decoded: DecodedReplayFrame,
): ReplayFrameAnalysis {
  const topLevelFields = readAllFieldsStrict(payload) ?? []
  const topLevel = topLevelFields.length === 1 ? topLevelFields[0] : undefined
  const exec = analyzeExecWire(topLevel)
  const validKv = validKvWire(topLevel)
  const malformed = !topLevel
    || topLevel.wt !== 2
    || !TOP_LEVEL_FIELDS.has(topLevel.fn)
    || !validInteractionUpdateWire(topLevel, decoded.interactionUpdate)
    || !validInteractionQueryWire(topLevel, decoded.interactionQuery)
    || !decodedMatchesWire(topLevel, decoded)
    || !!decoded.execControl

  let barrier: ReplayBarrierReason | undefined
  if (decoded.interactionUpdate?.tool_call_started || decoded.interactionUpdate?.tool_call_completed) {
    barrier = "display-tool-lifecycle"
  } else if (malformed || (topLevel.fn === 4 && !validKv)) {
    barrier = "unknown-or-malformed-frame"
  } else if (topLevel.fn === 2 && !exec.exactRequestContext && !exec.exactMcpState) {
    barrier = "non-control-exec"
  }

  return {
    semanticProgress: hasSemanticProgress(decoded),
    barrier,
  }
}
