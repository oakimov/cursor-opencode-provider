import type { LanguageModelV3Usage } from "@ai-sdk/provider"

export type CursorUsageCounters = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  reasoningTokens: number
}

/** Non-negative integer counter from a Cursor `turn_ended` field. */
export function turnEndedCounter(te: Record<string, unknown>, key: string): number {
  const value = te[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

export function cursorUsageCountersFromTurnEnded(
  te: Record<string, unknown>,
): CursorUsageCounters {
  return {
    inputTokens: turnEndedCounter(te, "input_tokens"),
    outputTokens: turnEndedCounter(te, "output_tokens"),
    cacheRead: turnEndedCounter(te, "cache_read"),
    cacheWrite: turnEndedCounter(te, "cache_write"),
    reasoningTokens: turnEndedCounter(te, "reasoning_tokens"),
  }
}

/**
 * Map Cursor counters to AI SDK V3. Cursor's `input_tokens` already includes
 * cache reads/writes, and `output_tokens` already includes reasoning.
 */
export function buildLanguageModelV3UsageFromCounters(
  counters: CursorUsageCounters,
): LanguageModelV3Usage {
  const cacheRead = Math.min(counters.cacheRead, counters.inputTokens)
  const cacheWrite = Math.min(counters.cacheWrite, counters.inputTokens - cacheRead)
  const reasoning = Math.min(counters.reasoningTokens, counters.outputTokens)
  return {
    inputTokens: {
      total: counters.inputTokens,
      noCache: Math.max(counters.inputTokens - cacheRead - cacheWrite, 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: counters.outputTokens,
      text: Math.max(counters.outputTokens - reasoning, 0),
      reasoning,
    },
  }
}

export function buildLanguageModelV3UsageFromTurnEnded(
  te: Record<string, unknown>,
): LanguageModelV3Usage {
  return buildLanguageModelV3UsageFromCounters(cursorUsageCountersFromTurnEnded(te))
}

/** OpenCode requires a usage object at every step boundary. */
export function emptyLanguageModelV3Usage(): LanguageModelV3Usage {
  return buildLanguageModelV3UsageFromCounters({
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
  })
}

/** Mirror Kilo `Session.getUsage` / AI SDK flat fields from V3 nested usage. */
export function kiloShapedUsageFromV3(usage: LanguageModelV3Usage): {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
} {
  const input = usage.inputTokens
  const output = usage.outputTokens
  const noCache = input.noCache ?? 0
  const cacheRead = input.cacheRead ?? 0
  const cacheWrite = input.cacheWrite ?? 0
  const reasoning = output.reasoning ?? 0
  const text = output.text ?? Math.max(0, (output.total ?? 0) - reasoning)
  return {
    inputTokens: noCache,
    outputTokens: text,
    reasoningTokens: reasoning,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
  }
}
