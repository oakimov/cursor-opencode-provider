/**
 * What OpenCode is told a Cursor turn costs.
 *
 * OpenCode prices every step finish and adds it to the session: OpenCode 1.x
 * from `providerMetadata.copilot.totalNanoAiu` when present
 * (`session/session.ts` getUsage), OpenCode 2 always from the step's tokens at
 * the model's catalog rates. Each step's token total must also stay equal to
 * Cursor's context occupancy, because both hosts show context use and decide
 * compaction from the latest step's tokens. Cursor reports what a turn really
 * cost only once, in `TurnEnded`, aggregated over every model call of its Run.
 *
 * So each tool step is billed an estimate shaped like one model call (the
 * context carried over from the previous step read from cache, the rest new
 * input), and the turn's last step settles the difference to Cursor's real
 * cost: its input/cache split is chosen so the token-priced cost equals the
 * outstanding amount, and the same amount goes into `totalNanoAiu`. Both hosts
 * then bill identical amounts. What a step cannot carry within its token total
 * stays outstanding for the next one.
 */
import type { LanguageModelV3Usage } from "@ai-sdk/provider"
import { getCursorModelCost, hasCursorFastPricing, type OpenCodeModelCost } from "./pricing.js"
import type { CursorUsageCounters } from "./usage.js"

/** USD per token for each category a host prices. */
export type StepPrices = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const PER_MILLION = 1_000_000
const CONTEXT_TIER_TOKENS = 200_000
/** OpenCode 1.x divides `totalNanoAiu` by 1e11 to get USD. */
const NANO_AIU_PER_USD = 100_000_000_000

/**
 * Price entry the catalog gave this model: `<wire>-fast` for a Fast variant
 * with its own published rate, else the wire id (a long-context entry is
 * priced from the base entry and its over-200k tier), as `model-config.ts` does.
 */
export function cursorPricingId(
  wireModelId: string,
  parameterValues: ReadonlyArray<{ id: string; value: string }>,
): string {
  const fast = parameterValues.some((parameter) => parameter.id === "fast" && parameter.value === "true")
  return fast && hasCursorFastPricing(wireModelId) ? `${wireModelId}-fast` : wireModelId
}

/** The rates a host applies to a step with `inputSideTokens` of prompt (its context tier). */
export function hostStepPrices(cost: OpenCodeModelCost | undefined, inputSideTokens: number): StepPrices | undefined {
  if (!cost) return undefined
  const tier = cost.context_over_200k && inputSideTokens > CONTEXT_TIER_TOKENS ? cost.context_over_200k : cost
  return {
    input: tier.input / PER_MILLION,
    output: tier.output / PER_MILLION,
    // Both hosts charge an unpriced cache category nothing.
    cacheRead: (tier.cache_read ?? 0) / PER_MILLION,
    cacheWrite: (tier.cache_write ?? 0) / PER_MILLION,
  }
}

/** What a host charges for `usage` at `prices`. */
export function hostUsageCostUsd(prices: StepPrices, usage: LanguageModelV3Usage): number {
  const input = usage.inputTokens
  return (input.noCache ?? 0) * prices.input
    + (input.cacheRead ?? 0) * prices.cacheRead
    + (input.cacheWrite ?? 0) * prices.cacheWrite
    + (usage.outputTokens.total ?? 0) * prices.output
}

/**
 * What Cursor billed for a Run from its `TurnEnded` counters. The tier follows
 * the final context, the largest prompt the Run sent. A cache category without
 * its own published rate is billed as input, as Cursor bills it.
 */
export function turnEndedCostUsd(
  cost: OpenCodeModelCost | undefined,
  counters: CursorUsageCounters,
  contextTokens: number,
): number | undefined {
  if (!cost) return undefined
  const tier = cost.context_over_200k && contextTokens > CONTEXT_TIER_TOKENS ? cost.context_over_200k : cost
  const uncached = Math.max(0, counters.inputTokens - counters.cacheRead - counters.cacheWrite)
  return (uncached * tier.input
    + counters.cacheRead * (tier.cache_read ?? tier.input)
    + counters.cacheWrite * (tier.cache_write ?? tier.input)
    + counters.outputTokens * tier.output) / PER_MILLION
}

type InputCategory = "noCache" | "cacheRead" | "cacheWrite"

function usageOf(split: Record<InputCategory, number>): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: split.noCache + split.cacheRead + split.cacheWrite,
      noCache: split.noCache,
      cacheRead: split.cacheRead,
      cacheWrite: split.cacheWrite,
    },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
}

/**
 * Split `inputTokens` between two categories so their cost is as close to
 * `budget` as whole tokens allow, clamped to what the pair can carry.
 */
function mix(
  inputTokens: number,
  budget: number,
  low: { category: InputCategory; price: number },
  high: { category: InputCategory; price: number },
): Record<InputCategory, number> {
  const split = { noCache: 0, cacheRead: 0, cacheWrite: 0 }
  const span = high.price - low.price
  const atHigh = span > 0
    ? Math.min(inputTokens, Math.max(0, Math.round((budget - inputTokens * low.price) / span)))
    : 0
  split[high.category] += atHigh
  split[low.category] += inputTokens - atHigh
  return split
}

/**
 * Occupancy-shaped usage for one step: `usedTokens` in total (`output = 1`, so
 * hosts accept it as the context snapshot), `prefixTokens` of it read from
 * cache and the rest new input. With `targetUsd`, the split moves between
 * input and cache read (and cache write only when those two cannot reach it)
 * so the host-priced cost meets the target as closely as the total allows.
 */
export function shapeStepUsage(input: {
  usedTokens: number
  prefixTokens: number
  prices: StepPrices | undefined
  targetUsd?: number
}): { usage: LanguageModelV3Usage; costUsd: number } {
  const used = Math.max(0, Math.trunc(input.usedTokens))
  if (used <= 0) {
    return {
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      costUsd: 0,
    }
  }
  const inputTokens = used - 1
  const cacheRead = Math.min(inputTokens, Math.max(0, Math.trunc(input.prefixTokens)))
  let split: Record<InputCategory, number> = { noCache: inputTokens - cacheRead, cacheRead, cacheWrite: 0 }
  const prices = input.prices
  if (prices && input.targetUsd !== undefined) {
    const budget = input.targetUsd - prices.output
    const options: Array<{ category: InputCategory; price: number }> = [
      { category: "noCache", price: prices.input },
      { category: "cacheRead", price: prices.cacheRead },
    ]
    const [low, high] = [...options].sort((a, b) => a.price - b.price) as [typeof options[0], typeof options[0]]
    if (budget >= inputTokens * low.price && budget <= inputTokens * high.price) {
      split = mix(inputTokens, budget, low, high)
    } else {
      const write = { category: "cacheWrite" as const, price: prices.cacheWrite }
      const all = [...options, write].sort((a, b) => a.price - b.price)
      const cheapest = all[0]!
      const dearest = all[all.length - 1]!
      split = budget < inputTokens * low.price
        ? mix(inputTokens, budget, cheapest, low)
        : mix(inputTokens, budget, high, dearest)
    }
  }
  const usage = usageOf(split)
  return { usage, costUsd: prices ? hostUsageCostUsd(prices, usage) : 0 }
}

/** `providerMetadata.copilot.totalNanoAiu` for a step that costs `usd`. */
export function nanoAiuForUsd(usd: number): number {
  return Math.max(0, Math.round(usd * NANO_AIU_PER_USD))
}

type LedgerEntry = { realUsd: number; billedUsd: number }

const MAX_LEDGERS = 1_024

/**
 * Per OpenCode session: what Cursor really billed (from `TurnEnded`) and what
 * this provider has reported to the host. The next step settles the difference.
 */
export class BillingLedger {
  private readonly entries = new Map<string, LedgerEntry>()

  private entry(key: string): LedgerEntry {
    let entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
    } else {
      entry = { realUsd: 0, billedUsd: 0 }
      while (this.entries.size >= MAX_LEDGERS) {
        const oldest = this.entries.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.entries.delete(oldest)
      }
    }
    this.entries.set(key, entry)
    return entry
  }

  recordReal(key: string, usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.entry(key).realUsd += usd
  }

  recordBilled(key: string, usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.entry(key).billedUsd += usd
  }

  /** Real minus billed: positive when the host has been told too little so far. */
  outstanding(key: string): number {
    const entry = this.entries.get(key)
    return entry ? entry.realUsd - entry.billedUsd : 0
  }

  totals(key: string): LedgerEntry {
    const entry = this.entries.get(key)
    return entry ? { ...entry } : { realUsd: 0, billedUsd: 0 }
  }

  clear(): void {
    this.entries.clear()
  }
}

export const billingLedger = new BillingLedger()

/** The catalog cost entry for this Run's model, if Cursor publishes one. */
export function cursorRunCost(
  wireModelId: string,
  parameterValues: ReadonlyArray<{ id: string; value: string }>,
): OpenCodeModelCost | undefined {
  return getCursorModelCost(cursorPricingId(wireModelId, parameterValues))
}
