import type { LanguageModelV3Usage } from "@ai-sdk/provider"

/** Non-negative integer counter from a Cursor `turn_ended` field. */
export function turnEndedCounter(te: Record<string, unknown>, key: string): number {
  const value = te[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

/**
 * Map request-local Cursor TurnEnded counters to AI SDK V3 usage (Kilo/OpenCode
 * flatten via input total = noCache + cacheRead + cacheWrite). Only use this
 * for a Run with no prior tool boundary; multi-step TurnEnded is cumulative.
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

/**
 * A single-step trust path for TurnEnded counters is only safe when the
 * totals are close to the request-local budget. Cursor reports cumulative
 * conversation/Run totals even on Runs that never crossed an OpenCode tool
 * boundary: single-step follow-up turns and parallel no-tools side calls
 * carry the whole conversation's `cache_read`. Treating those totals as
 * request-local inflates OpenCode's context usage and triggers premature
 * compaction (issue #20).
 */
export const CUMULATIVE_TURN_ENDED_RATIO = 3
export const MIN_TRUSTED_TURN_ENDED_TOTAL = 1024

export function exceedsRequestLocalBudget(
  te: Record<string, unknown>,
  budget: { inputTokens: number; outputTokens: number },
): boolean {
  const total =
    turnEndedCounter(te, "input_tokens") +
    turnEndedCounter(te, "cache_read") +
    turnEndedCounter(te, "cache_write")
  const requestLocal = budget.inputTokens + budget.outputTokens
  // Skip when the request-local seed is unknown; otherwise compare against
  // max(ratio × request-local, absolute floor) so tiny prompts still reject
  // multi-million-token conversation cache totals.
  if (requestLocal <= 0) return false
  const trustCeiling = Math.max(
    requestLocal * CUMULATIVE_TURN_ENDED_RATIO,
    MIN_TRUSTED_TURN_ENDED_TOTAL,
  )
  return total > trustCeiling
}

/**
 * Request-local usage for a held Cursor Run.
 *
 * `est.inputTokens` tracks the seed plus delivered tool results, while
 * `est.outputTokens` accumulates model output across earlier tool boundaries.
 * Move prior output into the current input estimate and report only this
 * doStream request's output. Cache counters are intentionally absent: the
 * only counters Cursor exposes at TurnEnded are cumulative for the whole Run.
 */
export function buildLanguageModelV3UsageFromEstimate(
  est: CursorUsageEstimate,
  promptTokens: number,
  outputChars: number,
  estimateCharsToTokens: (chars: number) => number,
): LanguageModelV3Usage {
  const outputText = estimateCharsToTokens(outputChars)
  const priorOutput = Math.max(0, est.outputTokens - outputText)
  const inputNoCache = Math.max(promptTokens, est.inputTokens + priorOutput)
  return {
    inputTokens: {
      total: inputNoCache,
      noCache: inputNoCache,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputText,
      text: outputText,
      reasoning: undefined,
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
