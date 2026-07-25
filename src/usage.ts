import type { LanguageModelV3Usage } from "@ai-sdk/provider"

/** Non-negative integer counter from a Cursor `turn_ended` field. */
export function turnEndedCounter(te: Record<string, unknown>, key: string): number {
  const value = te[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

/**
 * Map authoritative Cursor TurnEnded counters to AI SDK V3 usage (Kilo/OpenCode
 * flatten via input total = noCache + cacheRead + cacheWrite).
 *
 * Contract: `input_tokens` is non-cached input; cache fields are separate.
 * Cursor's agent wire currently sends `cache_write=0` even when later turns
 * report large `cache_read`; we still forward the counter when non-zero.
 * If production semantics differ (input_tokens already total), adjust here.
 */
export function buildLanguageModelV3UsageFromTurnEnded(
  te: Record<string, unknown>,
): LanguageModelV3Usage {
  const input_tokens = turnEndedCounter(te, "input_tokens")
  const output_tokens = turnEndedCounter(te, "output_tokens")
  const cache_read = turnEndedCounter(te, "cache_read")
  const cache_write = turnEndedCounter(te, "cache_write")
  const reasoning_tokens = turnEndedCounter(te, "reasoning_tokens")
  return {
    inputTokens: {
      total: input_tokens + cache_read + cache_write,
      noCache: input_tokens,
      cacheRead: cache_read,
      cacheWrite: cache_write,
    },
    outputTokens: {
      total: output_tokens + reasoning_tokens,
      text: output_tokens,
      reasoning: reasoning_tokens,
    },
  }
}

export type CursorUsageEstimate = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  reasoningTokens: number
}

/** Mid-turn finish (e.g. tool-calls) before `turn_ended` — keep non-zero estimates. */
export function buildLanguageModelV3UsageFromEstimate(
  est: CursorUsageEstimate,
  promptTokens: number,
  outputChars: number,
  estimateCharsToTokens: (chars: number) => number,
): LanguageModelV3Usage {
  const hasInputBreakdown =
    est.cacheRead > 0 || est.cacheWrite > 0 || est.inputTokens > 0
  const inputNoCache = hasInputBreakdown ? est.inputTokens : promptTokens
  const cacheRead = est.cacheRead
  const cacheWrite = est.cacheWrite
  const outputFromChars = estimateCharsToTokens(outputChars)
  const outputText =
    est.outputTokens > 0 ? est.outputTokens : outputFromChars
  const reasoning = est.reasoningTokens
  const outputTotal = outputText + reasoning
  return {
    inputTokens: {
      total: inputNoCache + cacheRead + cacheWrite,
      noCache: inputNoCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: outputTotal,
      text: outputText,
      reasoning: reasoning > 0 ? reasoning : undefined,
    },
  }
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