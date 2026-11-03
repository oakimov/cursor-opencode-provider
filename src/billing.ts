/**
 * What OpenCode is told a Cursor turn costs at catalog rates.
 *
 * OpenCode prices every step finish and adds it to the session: OpenCode 1.x
 * from `providerMetadata.copilot.totalNanoAiu` when present
 * (`session/session.ts` getUsage), OpenCode 2 always from the step's tokens at
 * the model's catalog rates. Each step's token total must also stay equal to
 * Cursor's context occupancy, because both hosts show context use and decide
 * compaction from the latest step's tokens. Cursor reports token counters only
 * once, in `TurnEnded`, aggregated over every model call of its Run.
 *
 * So each tool step is billed an estimate shaped like one model call (the
 * context carried over from the previous step read from cache, the output it
 * streamed as output, the rest new input), and the turn's last step settles the
 * difference to its catalog-priced cost: its input/cache split is chosen so the
 * token-priced cost approaches the outstanding amount, and the same amount goes
 * into `totalNanoAiu`. Both hosts then bill identical amounts at the unmodified
 * catalog rates. What a final step cannot carry stays outstanding for a later
 * priced turn-end. Settlement is bounded by minimum and maximum token prices
 * and whole-token rounding; negative balances cannot refund prior host charges.
 *
 * Output tokens follow the same ledger: a tool step reports a char/4 estimate
 * of what it streamed, and the turn's last step reports Cursor's `output_tokens`
 * (and `reasoning_tokens`) minus that Run's estimates. Already delivered
 * estimates cannot be retracted; an overestimate never reduces a later Run's
 * output. The host's one-token display minimum can also exceed the remainder.
 */
import type { LanguageModelV3Usage } from "@ai-sdk/provider"
import { getCursorModelCost, hasCursorFastPricing, type OpenCodeModelCost } from "./pricing.js"
import { buildLanguageModelV3UsageFromCounters, type CursorUsageCounters } from "./usage.js"

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
 * Catalog-priced Run cost from aggregate `TurnEnded` counters. The final
 * context less the Run's output approximates the prompt tier, as hosts choose
 * it for the settling step, bounded by total input. Per-call tiers are unavailable: a Run crossing
 * tiers or compacting internally cannot be priced exactly from these totals.
 * A cache category without its own published rate is priced as input.
 */
export function turnEndedCostUsd(
  cost: OpenCodeModelCost | undefined,
  counters: CursorUsageCounters,
  contextTokens: number,
): number | undefined {
  if (!cost) return undefined
  // Reuse the canonical partition guard; inconsistent cache counters must not
  // create billable input beyond input_tokens. Keep the raw fields diagnostic.
  const usage = buildLanguageModelV3UsageFromCounters(counters)
  const input = usage.inputTokens
  const promptTokens = Math.min(input.total ?? 0, Math.max(0, contextTokens - (usage.outputTokens.total ?? 0)))
  const tier = cost.context_over_200k && promptTokens > CONTEXT_TIER_TOKENS ? cost.context_over_200k : cost
  return ((input.noCache ?? 0) * tier.input
    + (input.cacheRead ?? 0) * (tier.cache_read ?? tier.input)
    + (input.cacheWrite ?? 0) * (tier.cache_write ?? tier.input)
    + (usage.outputTokens.total ?? 0) * tier.output) / PER_MILLION
}

type InputCategory = "noCache" | "cacheRead" | "cacheWrite"

function usageOf(split: Record<InputCategory, number>, output: number, reasoning: number): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: split.noCache + split.cacheRead + split.cacheWrite,
      noCache: split.noCache,
      cacheRead: split.cacheRead,
      cacheWrite: split.cacheWrite,
    },
    outputTokens: { total: output, text: output - reasoning, reasoning },
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
 * Occupancy-shaped usage for one step: `usedTokens` in total, `outputTokens` of
 * it output (at least 1, at most the occupancy), `prefixTokens` of the rest read
 * from cache and the remainder new input. With `targetUsd`, the input split
 * moves between input and cache read (and cache write only when those two
 * cannot reach it) so the host-priced cost meets the target as closely as the
 * total allows.
 */
export function shapeStepUsage(input: {
  usedTokens: number
  prefixTokens: number
  outputTokens: number
  reasoningTokens?: number
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
  const output = Math.min(used, Math.max(1, wholeTokens(input.outputTokens)))
  const reasoning = Math.min(output, wholeTokens(input.reasoningTokens ?? 0))
  const inputTokens = used - output
  const cacheRead = Math.min(inputTokens, Math.max(0, Math.trunc(input.prefixTokens)))
  let split: Record<InputCategory, number> = { noCache: inputTokens - cacheRead, cacheRead, cacheWrite: 0 }
  const prices = input.prices
  if (prices && input.targetUsd !== undefined) {
    const budget = input.targetUsd - output * prices.output
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
  const usage = usageOf(split, output, reasoning)
  return { usage, costUsd: prices ? hostUsageCostUsd(prices, usage) : 0 }
}

/**
 * The most output a step of `usedTokens` can report while {@link shapeStepUsage}
 * can still keep its cost at `targetUsd`: the rest of the step at the cheapest
 * input category, the output at the output rate.
 */
export function maxOutputWithinUsd(usedTokens: number, prices: StepPrices, targetUsd: number): number {
  const used = wholeTokens(usedTokens)
  const cheapestInput = Math.min(prices.input, prices.cacheRead, prices.cacheWrite)
  const premium = prices.output - cheapestInput
  if (premium <= 0) return used
  return Math.min(used, Math.max(1, Math.floor((targetUsd - used * cheapestInput) / premium)))
}

function wholeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** `providerMetadata.copilot.totalNanoAiu` for a step that costs `usd`. */
export function nanoAiuForUsd(usd: number): number {
  return Math.max(0, Math.round(usd * NANO_AIU_PER_USD))
}

/** Estimates belong to one Run and are replaced only by that Run's counters. */
export type RunCostEstimate = {
  estimatedUsd?: number
  estimatedOutputTokens?: number
  estimatedReasoningTokens?: number
  ledgerEpoch?: object
}
/** Output tokens, `reasoning` a subset of `output` as in Cursor's `TurnEnded`. */
export type OutputTokens = { output: number; reasoning: number }
type LedgerTotals = { realUsd: number; billedUsd: number }
type LedgerEntry = LedgerTotals & {
  estimatedUsd: number
  realOutput: OutputTokens
  reportedOutput: OutputTokens
  pendingOutput: OutputTokens
}

const NO_OUTPUT: OutputTokens = { output: 0, reasoning: 0 }

function outputTokens(tokens: OutputTokens): OutputTokens {
  const output = wholeTokens(tokens.output)
  return { output, reasoning: Math.min(output, wholeTokens(tokens.reasoning)) }
}

const MAX_LEDGERS = 1_024

/**
 * Per OpenCode session: catalog-priced cost and output tokens (from
 * `TurnEnded`) and what this provider has reported to the host. Turn-ends
 * reconcile the balances.
 */
export class BillingLedger {
  constructor(private readonly entries = new Map<string, LedgerEntry>()) {}

  private entry(key: string): LedgerEntry {
    let entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
    } else {
      entry = {
        realUsd: 0,
        billedUsd: 0,
        estimatedUsd: 0,
        realOutput: { ...NO_OUTPUT },
        reportedOutput: { ...NO_OUTPUT },
        pendingOutput: { ...NO_OUTPUT },
      }
      while (this.entries.size >= MAX_LEDGERS) {
        const oldest = this.entries.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.entries.delete(oldest)
      }
    }
    this.entries.set(key, entry)
    return entry
  }

  /** A Run's `TurnEnded`: its cost (0 when unpriced) and output replace its estimates. */
  recordReal(key: string, usd: number, run?: RunCostEstimate, output: OutputTokens = NO_OUTPUT): void {
    if (!Number.isFinite(usd) || usd < 0) return
    const entry = this.entry(key)
    entry.realUsd += usd
    const real = outputTokens(output)
    entry.realOutput.output += real.output
    entry.realOutput.reasoning += real.reasoning
    // Missing TurnEnded is unknown cost, not free work. Other Runs' estimates
    // stay provisionally covered, including Runs already closed by the host.
    const ownEstimates = run?.ledgerEpoch === entry
    entry.estimatedUsd = Math.max(0, entry.estimatedUsd - (ownEstimates ? run.estimatedUsd ?? 0 : 0))
    // Reconcile within the owning Run. Delivered estimates cannot be refunded,
    // but their excess must never consume another Run's measured output.
    const remaining = Math.max(0, real.output - (run?.estimatedOutputTokens ?? 0))
    const reasoning = Math.max(0, real.reasoning - (run?.estimatedReasoningTokens ?? 0))
    entry.pendingOutput.output += remaining
    entry.pendingOutput.reasoning += Math.min(remaining, reasoning)
    if (run) {
      run.estimatedUsd = 0
      run.estimatedOutputTokens = 0
      run.estimatedReasoningTokens = 0
    }
  }

  /** A step delivered to the host; with `run`, its amounts are that Run's estimates. */
  recordBilled(key: string, usd: number, run?: RunCostEstimate, output: OutputTokens = NO_OUTPUT): void {
    const billedUsd = Number.isFinite(usd) && usd > 0 ? usd : 0
    const reported = outputTokens(output)
    if (billedUsd <= 0 && reported.output <= 0) return
    const entry = this.entry(key)
    entry.billedUsd += billedUsd
    entry.reportedOutput.output += reported.output
    entry.reportedOutput.reasoning += reported.reasoning
    if (run) {
      // An evicted session starts a new cost ledger; its old cost estimate
      // must not replace another Run's estimates there. Output estimates stay
      // with the live Run, whose counters still cover all its delivered steps.
      if (run.ledgerEpoch !== entry) {
        run.estimatedUsd = 0
      }
      run.ledgerEpoch = entry
      entry.estimatedUsd += billedUsd
      run.estimatedUsd = (run.estimatedUsd ?? 0) + billedUsd
      run.estimatedOutputTokens = (run.estimatedOutputTokens ?? 0) + reported.output
      run.estimatedReasoningTokens = (run.estimatedReasoningTokens ?? 0) + reported.reasoning
    } else {
      entry.pendingOutput.output = Math.max(0, entry.pendingOutput.output - reported.output)
      entry.pendingOutput.reasoning = Math.min(
        entry.pendingOutput.output,
        Math.max(0, entry.pendingOutput.reasoning - reported.reasoning),
      )
    }
  }

  /** Confirmed plus unconfirmed cost minus the amount reported to the host. */
  outstanding(key: string): number {
    const entry = this.entries.get(key)
    return entry ? entry.realUsd + entry.estimatedUsd - entry.billedUsd : 0
  }

  /**
   * Measured output not yet reported to the host, after reconciling each Run's
   * own estimates. Surplus estimates and display tokens create no future debt.
   */
  outstandingOutput(key: string): OutputTokens {
    const entry = this.entries.get(key)
    if (!entry) return { ...NO_OUTPUT }
    return { ...entry.pendingOutput }
  }

  outputTotals(key: string): { real: OutputTokens; reported: OutputTokens } {
    const entry = this.entries.get(key)
    return entry
      ? { real: { ...entry.realOutput }, reported: { ...entry.reportedOutput } }
      : { real: { ...NO_OUTPUT }, reported: { ...NO_OUTPUT } }
  }

  estimated(key: string): number {
    return this.entries.get(key)?.estimatedUsd ?? 0
  }

  totals(key: string): LedgerTotals {
    const entry = this.entries.get(key)
    return entry ? { realUsd: entry.realUsd, billedUsd: entry.billedUsd } : { realUsd: 0, billedUsd: 0 }
  }

  clear(): void {
    this.entries.clear()
  }
}

// Plugin and SDK loaders can evaluate separate copies of this package in one
// process. Share plain ledger data, rather than a class instance owned by one
// module graph, so session balances survive those loader transitions.
const BILLING_ENTRIES = Symbol.for("cursor-opencode-provider.billing-ledger.v4")
const processState = globalThis as typeof globalThis & {
  [BILLING_ENTRIES]?: Map<string, LedgerEntry>
}
const sharedEntries = processState[BILLING_ENTRIES] ??= new Map<string, LedgerEntry>()
export const billingLedger = new BillingLedger(sharedEntries)

/** The catalog cost entry for this Run's model, if Cursor publishes one. */
export function cursorRunCost(
  wireModelId: string,
  parameterValues: ReadonlyArray<{ id: string; value: string }>,
): OpenCodeModelCost | undefined {
  return getCursorModelCost(cursorPricingId(wireModelId, parameterValues))
}
