import protobuf from "protobufjs"

export type CursorPromptTokenCategory = {
  id: string
  label: string
  estimatedTokens: number
  characterCount?: number
}

export type CursorPromptTokenBreakdown = {
  totalUsedTokens: number
  maxTokens: number
  categories: CursorPromptTokenCategory[]
}

export type CursorConversationTokenDetails = {
  usedTokens: number
  maxTokens: number
  breakdown?: CursorPromptTokenBreakdown
}

export type CursorContextUsageSource =
  | "checkpoint-current-run"
  | "checkpoint-previous-turn"

const MAX_BREAKDOWN_CATEGORIES = 128

function requireWireType(actual: number, expected: number, field: string): void {
  if (actual !== expected) throw new Error(`invalid ${field} wire type`)
}

function decodeCategory(data: Uint8Array): CursorPromptTokenCategory {
  const reader = protobuf.Reader.create(data)
  let id = ""
  let label = ""
  let estimatedTokens = 0
  let characterCount: number | undefined
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const wireType = tag & 7
    switch (tag >>> 3) {
      case 1:
        requireWireType(wireType, 2, "category id")
        id = reader.string()
        break
      case 2:
        requireWireType(wireType, 2, "category label")
        label = reader.string()
        break
      case 3:
        requireWireType(wireType, 0, "category token count")
        estimatedTokens = reader.uint32()
        break
      case 4:
        requireWireType(wireType, 0, "category character count")
        characterCount = reader.uint32()
        break
      default:
        reader.skipType(wireType)
    }
  }
  return {
    id,
    label,
    estimatedTokens,
    ...(characterCount === undefined ? {} : { characterCount }),
  }
}

function decodeBreakdown(data: Uint8Array): CursorPromptTokenBreakdown {
  const reader = protobuf.Reader.create(data)
  let totalUsedTokens = 0
  let maxTokens = 0
  const categories: CursorPromptTokenCategory[] = []
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const wireType = tag & 7
    switch (tag >>> 3) {
      case 1:
        requireWireType(wireType, 0, "breakdown used tokens")
        totalUsedTokens = reader.uint32()
        break
      case 2:
        requireWireType(wireType, 0, "breakdown max tokens")
        maxTokens = reader.uint32()
        break
      case 3:
        requireWireType(wireType, 2, "breakdown category")
        if (categories.length < MAX_BREAKDOWN_CATEGORIES) {
          categories.push(decodeCategory(reader.bytes()))
        } else {
          reader.bytes()
        }
        break
      default:
        reader.skipType(wireType)
    }
  }
  return { totalUsedTokens, maxTokens, categories }
}

function decodeTokenDetails(data: Uint8Array): CursorConversationTokenDetails | undefined {
  const reader = protobuf.Reader.create(data)
  let usedTokens = 0
  let maxTokens = 0
  let sawUsedTokens = false
  let sawMaxTokens = false
  let breakdown: CursorPromptTokenBreakdown | undefined
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const wireType = tag & 7
    switch (tag >>> 3) {
      case 1:
        requireWireType(wireType, 0, "used tokens")
        usedTokens = reader.uint32()
        sawUsedTokens = true
        break
      case 2:
        requireWireType(wireType, 0, "max tokens")
        maxTokens = reader.uint32()
        sawMaxTokens = true
        break
      case 3:
        requireWireType(wireType, 2, "token breakdown")
        breakdown = decodeBreakdown(reader.bytes())
        break
      default:
        reader.skipType(wireType)
    }
  }
  if (!sawUsedTokens && !sawMaxTokens && !breakdown) return undefined
  return {
    usedTokens,
    maxTokens,
    ...(breakdown ? { breakdown } : {}),
  }
}

/**
 * Read field #5 (`ConversationTokenDetails`) from Cursor's opaque
 * `ConversationStateStructure` checkpoint without decoding or re-encoding the
 * rest of the state. Unknown checkpoint fields therefore remain byte-exact.
 */
export function decodeConversationTokenDetails(
  checkpoint: Uint8Array | undefined,
): CursorConversationTokenDetails | undefined {
  if (!checkpoint?.length) return undefined
  try {
    const reader = protobuf.Reader.create(checkpoint)
    let details: CursorConversationTokenDetails | undefined
    while (reader.pos < reader.len) {
      const tag = reader.uint32()
      const wireType = tag & 7
      if ((tag >>> 3) === 5) {
        requireWireType(wireType, 2, "conversation token details")
        details = decodeTokenDetails(reader.bytes())
      } else {
        reader.skipType(wireType)
      }
    }
    return details
  } catch {
    return undefined
  }
}

export function cursorContextUsageMetadata(
  details: CursorConversationTokenDetails,
  source: CursorContextUsageSource = "checkpoint-current-run",
): {
  contextUsageVersion: number
  source: CursorContextUsageSource
  stale: boolean
  usedTokens: number
  maxTokens: number
  remainingTokens: number
  usedPercent?: number
  breakdown?: CursorPromptTokenBreakdown
} {
  const usedPercent = details.maxTokens > 0
    ? Math.max(0, Math.min(100, Math.round(details.usedTokens / details.maxTokens * 1_000) / 10))
    : undefined
  return {
    contextUsageVersion: 2,
    source,
    stale: source === "checkpoint-previous-turn",
    usedTokens: details.usedTokens,
    maxTokens: details.maxTokens,
    remainingTokens: Math.max(0, details.maxTokens - details.usedTokens),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(details.breakdown ? { breakdown: details.breakdown } : {}),
  }
}
