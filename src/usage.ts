import type { LanguageModelV3Usage } from "@ai-sdk/provider"
import type {
  CursorContextUsageSource,
  CursorConversationTokenDetails,
} from "./protocol/token-details.js"

export type CursorUsageCounters = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  reasoningTokens: number
}

export type CursorUsageOptions = {
  /** Cursor checkpoint occupancy, including the current turn's output. */
  contextTotalTokens?: number
  /** Previous turn's occupancy. When Cursor's cache read covers this window, do not dilute the hit by multi-step TurnEnded aggregates. */
  priorContextTokens?: number
}

export type CursorCacheDiagnosticStats = {
  sessionKey?: string
  conversationId: string
  conversationGroupId?: string
  modelId?: string
  startedWithCheckpoint: boolean
  requestContextReused: boolean
  requestContextHash: string
  systemPromptHash?: string
  checkpointUpdates: number
  tokenDetailUpdates: number
  pumpPasses: number
  stepStarts: number
  stepCompletes: number
  displayToolCalls: number
  execRequests: number
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
  options: CursorUsageOptions = {},
): LanguageModelV3Usage {
  const rawInput = Math.max(0, Math.trunc(counters.inputTokens))
  const rawOutput = Math.max(0, Math.trunc(counters.outputTokens))
  const rawCacheRead = Math.min(Math.max(0, Math.trunc(counters.cacheRead)), rawInput)
  const rawCacheWrite = Math.min(
    Math.max(0, Math.trunc(counters.cacheWrite)),
    rawInput - rawCacheRead,
  )
  const rawReasoning = Math.min(Math.max(0, Math.trunc(counters.reasoningTokens)), rawOutput)
  const contextTotal = options.contextTotalTokens
  const hasContextTotal =
    typeof contextTotal === "number" && Number.isFinite(contextTotal) && contextTotal >= 0
  const total = hasContextTotal ? Math.trunc(contextTotal) : rawInput + rawOutput
  const output = Math.min(rawOutput, total)
  const input = Math.max(0, total - output)

  // TurnEnded can aggregate several internal model calls, so its absolute input
  // and cache counts can exceed the final checkpoint occupancy. Preserve the
  // cache proportions while normalizing the partition to Cursor's context total.
  const proportionalRead = rawInput > 0
    ? Math.min(input, Math.round(input * rawCacheRead / rawInput))
    : 0
  const priorContext = options.priorContextTokens
  const prefixRead =
    typeof priorContext === "number"
    && Number.isFinite(priorContext)
    && priorContext > 0
    && rawCacheRead >= priorContext
      ? Math.min(input, Math.trunc(priorContext))
      : 0
  const cacheRead = Math.min(input, Math.max(proportionalRead, prefixRead))
  const cacheWrite = rawInput > 0
    ? Math.min(input - cacheRead, Math.round(input * rawCacheWrite / rawInput))
    : 0
  const reasoning = rawOutput > 0
    ? Math.min(output, Math.round(output * rawReasoning / rawOutput))
    : 0
  return {
    inputTokens: {
      total: input,
      noCache: Math.max(input - cacheRead - cacheWrite, 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: Math.max(output - reasoning, 0),
      reasoning,
    },
  }
}

export function buildLanguageModelV3UsageFromTurnEnded(
  te: Record<string, unknown>,
  options: CursorUsageOptions = {},
): LanguageModelV3Usage {
  return buildLanguageModelV3UsageFromCounters(cursorUsageCountersFromTurnEnded(te), options)
}

function usageCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

function usageRatio(part: number, total: number): string {
  return total > 0 ? `${(part / total * 100).toFixed(1)}%` : "n/a"
}

function categoryTokens(
  details: CursorConversationTokenDetails | undefined,
): Map<string, number> {
  return new Map(
    details?.breakdown?.categories.map((category) => [
      category.id || category.label || "(unnamed)",
      category.estimatedTokens,
    ]) ?? [],
  )
}

/** Compact, parseable category snapshot for checkpoint-by-checkpoint traces. */
export function formatCursorTokenCategories(
  details: CursorConversationTokenDetails | undefined,
): string {
  const categories = Object.fromEntries(categoryTokens(details))
  return Object.keys(categories).length > 0 ? JSON.stringify(categories) : "unavailable"
}

/**
 * Explain Cursor's aggregate cache counters using the state visible to this
 * client. `stepStarts` is deliberately not called a model-call count: Cursor
 * does not expose per-model-call cache accounting on the Run stream.
 */
export function formatCursorCacheDiagnostics(
  counters: CursorUsageCounters,
  current: CursorConversationTokenDetails | undefined,
  prior: CursorConversationTokenDetails | undefined,
  stats: CursorCacheDiagnosticStats,
): string {
  const rawInput = Math.max(0, Math.trunc(counters.inputTokens))
  const rawRead = Math.min(rawInput, Math.max(0, Math.trunc(counters.cacheRead)))
  const rawWrite = Math.min(
    rawInput - rawRead,
    Math.max(0, Math.trunc(counters.cacheWrite)),
  )
  const rawUncached = Math.max(0, rawInput - rawRead - rawWrite)
  const priorCategories = categoryTokens(prior)
  const currentCategories = categoryTokens(current)
  const categoriesComparable = !!prior?.breakdown && !!current?.breakdown
  const categoryDelta: Record<string, number | "new" | "removed"> = {}
  let sameSizedCategoryTokens = 0
  if (categoriesComparable) {
    for (const id of new Set([...priorCategories.keys(), ...currentCategories.keys()])) {
      const before = priorCategories.get(id)
      const after = currentCategories.get(id)
      if (before === undefined) categoryDelta[id] = "new"
      else if (after === undefined) categoryDelta[id] = "removed"
      else {
        categoryDelta[id] = after - before
        if (after === before) sameSizedCategoryTokens += after
      }
    }
  }
  const continuity = stats.startedWithCheckpoint
    ? prior ? "warm" : "checkpoint-without-token-details"
    : "cold"
  const contextDelta = current && prior ? current.usedTokens - prior.usedTokens : undefined

  return [
    "cache diagnosis:",
    `sessionKey=${stats.sessionKey ?? "-"}`,
    `conversationId=${stats.conversationId}`,
    `conversationGroupId=${stats.conversationGroupId ?? "-"}`,
    `model=${stats.modelId ?? "-"}`,
    `continuity=${continuity}`,
    `rawInput=${rawInput}`,
    `rawCacheRead=${rawRead}`,
    `rawCacheWrite=${rawWrite}`,
    `rawUncached=${rawUncached}`,
    `rawReadRatio=${usageRatio(rawRead, rawInput)}`,
    `rawWriteRatio=${usageRatio(rawWrite, rawInput)}`,
    `priorContext=${prior?.usedTokens ?? "unavailable"}`,
    `currentContext=${current?.usedTokens ?? "unavailable"}`,
    `contextDelta=${contextDelta ?? "unavailable"}`,
    `rawReadVsPriorContext=${prior ? usageRatio(rawRead, prior.usedTokens) : "n/a"}`,
    `sameSizedCategoryTokens=${categoriesComparable ? sameSizedCategoryTokens : "unavailable"}`,
    `categoryDelta=${categoriesComparable && Object.keys(categoryDelta).length > 0 ? JSON.stringify(categoryDelta) : "unavailable"}`,
    `requestContext=${stats.requestContextReused ? "reused" : "built"}`,
    `requestContextHash=${stats.requestContextHash.slice(0, 16)}`,
    `systemPromptHash=${stats.systemPromptHash?.slice(0, 16) ?? "none"}`,
    `systemPromptSent=${!stats.startedWithCheckpoint}`,
    `checkpointUpdates=${stats.checkpointUpdates}`,
    `tokenDetailUpdates=${stats.tokenDetailUpdates}`,
    `pumpPasses=${stats.pumpPasses}`,
    `steps=${stats.stepStarts}/${stats.stepCompletes}`,
    `displayToolCalls=${stats.displayToolCalls}`,
    `execRequests=${stats.execRequests}`,
    "perModelCallCache=unavailable",
  ].join(" ")
}

/** One-line proof that Cursor, AI SDK, and projected OpenCode totals agree. */
export function formatTurnUsageValidation(
  counters: CursorUsageCounters,
  usage: LanguageModelV3Usage,
  tokenDetails?: CursorConversationTokenDetails,
  contextSource?: CursorContextUsageSource,
): string {
  const input = usageCount(usage.inputTokens.total)
  const noCache = usageCount(usage.inputTokens.noCache)
  const cacheRead = usageCount(usage.inputTokens.cacheRead)
  const cacheWrite = usageCount(usage.inputTokens.cacheWrite)
  const inputParts = noCache + cacheRead + cacheWrite
  const output = usageCount(usage.outputTokens.total)
  const text = usageCount(usage.outputTokens.text)
  const reasoning = usageCount(usage.outputTokens.reasoning)
  const outputParts = text + reasoning
  const sentTotal = input + output
  const projectedOpenCodeTotal = inputParts + outputParts
  const rawTotal = counters.inputTokens + counters.outputTokens
  const cursor = tokenDetails
    ? `${tokenDetails.usedTokens}/${tokenDetails.maxTokens}` +
      `(${usageRatio(tokenDetails.usedTokens, tokenDetails.maxTokens)})`
    : "unavailable"
  const totalMatch = tokenDetails ? String(sentTotal === tokenDetails.usedTokens) : "unavailable"
  const breakdown = tokenDetails?.breakdown
  const categorySum = breakdown?.categories.reduce(
    (sum, category) => sum + category.estimatedTokens,
    0,
  )
  const breakdownMatch = breakdown && categorySum !== undefined
    ? breakdown.totalUsedTokens === tokenDetails.usedTokens &&
      categorySum === breakdown.totalUsedTokens
    : undefined
  const rawCached = counters.cacheRead + counters.cacheWrite
  const sentCached = cacheRead + cacheWrite
  const proportionalCached = counters.inputTokens > 0 && input > 0
    ? Math.round(input * rawCached / counters.inputTokens)
    : 0
  const cacheRatioMatch = tokenDetails
    ? counters.inputTokens > 0 && input > 0
      ? Math.abs(rawCached / counters.inputTokens - sentCached / input) <= 1 / input
        || (sentCached >= proportionalCached && sentCached <= input)
      : rawCached === 0 && sentCached === 0
    : undefined
  const status =
    input === inputParts &&
    output === outputParts &&
    projectedOpenCodeTotal === sentTotal &&
    (cacheRatioMatch ?? true) &&
    (!tokenDetails || sentTotal === tokenDetails.usedTokens) &&
    (breakdownMatch ?? true)
      ? "ok"
      : "mismatch"

  return [
    "turn usage validation:",
    `status=${status}`,
    `source=${tokenDetails ? contextSource ?? "checkpoint-current-run" : "unavailable"}`,
    `cursor=${cursor}`,
    `rawTotal=${rawTotal}`,
    `sentTotal=${sentTotal}`,
    `totalMatch=${totalMatch}`,
    `input=${input}`,
    `inputParts=${inputParts}`,
    `inputMatch=${input === inputParts}`,
    `output=${output}`,
    `outputParts=${outputParts}`,
    `outputMatch=${output === outputParts}`,
    `opencodeProjectedTotal=${projectedOpenCodeTotal}`,
    `opencodeMatch=${projectedOpenCodeTotal === sentTotal}`,
    `breakdownTotal=${breakdown?.totalUsedTokens ?? "unavailable"}`,
    `categorySum=${categorySum ?? "unavailable"}`,
    `breakdownMatch=${breakdownMatch ?? "unavailable"}`,
    `rawCachedRatio=${usageRatio(rawCached, counters.inputTokens)}`,
    `sentCachedRatio=${usageRatio(sentCached, input)}`,
    `cacheRatioMatch=${cacheRatioMatch ?? "unavailable"}`,
  ].join(" ")
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

/** Project nested V3 usage into the common flat AI-SDK counter shape. */
export function flatUsageFromV3(usage: LanguageModelV3Usage): {
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
