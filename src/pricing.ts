/**
 * Cursor model token pricing for OpenCode cost reporting.
 *
 * Rates come from Cursor's public docs (Cursor Models + Other Models tables).
 * Generated data lives in `pricing-data.ts`; regenerate with
 * `bun run generate:pricing`. Unknown / unpublished models get no `cost`.
 */

import { CURSOR_MODEL_COSTS } from "./pricing-data.js"

/** Classic OpenCode / models.dev cost shape used in provider config. */
export type OpenCodeModelCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: OpenCodeModelCost
}

/** OpenCode 2.0 `Model.Info.cost` entry (array of tiered rates). */
export type OpenCode2ModelCost = {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export type CursorPricingCoverage = {
  priced: string[]
  missing: string[]
}

/**
 * Models we expose that Cursor does not currently publish numeric rates for
 * (Auto is billed at the routed model's list price).
 */
export const CURSOR_UNPRICED_MODEL_IDS = ["default"] as const

const UNPRICED = new Set<string>(CURSOR_UNPRICED_MODEL_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function collectCostValidationErrors(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  if (!isNonNegativeFiniteNumber(value.input)) {
    errors.push(`${path}.input must be a non-negative finite number`)
  }
  if (!isNonNegativeFiniteNumber(value.output)) {
    errors.push(`${path}.output must be a non-negative finite number`)
  }
  if (value.cache_read !== undefined && !isNonNegativeFiniteNumber(value.cache_read)) {
    errors.push(`${path}.cache_read must be a non-negative finite number`)
  }
  if (value.cache_write !== undefined && !isNonNegativeFiniteNumber(value.cache_write)) {
    errors.push(`${path}.cache_write must be a non-negative finite number`)
  }
  if (value.context_over_200k !== undefined) {
    collectCostValidationErrors(value.context_over_200k, `${path}.context_over_200k`, errors)
  }
}

export function validateOpenCodeModelCost(
  value: unknown,
  path = "cost",
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  collectCostValidationErrors(value, path, errors)
  return { valid: errors.length === 0, errors }
}

export function isOpenCodeModelCost(value: unknown): value is OpenCodeModelCost {
  return validateOpenCodeModelCost(value).valid
}

/** Strip synthetic context suffixes (`…-1m`, `…-500k`, `…-500k-2-fast`, …). */
export function wireModelIdForPricing(modelId: string): {
  baseId: string
  longContextEntry: boolean
} {
  const match = /^(.*)-\d+(?:\.\d+)?[km](?:-\d+)?(-fast)?$/.exec(modelId)
  if (match) {
    return { baseId: `${match[1]!}${match[2] ?? ""}`, longContextEntry: true }
  }
  return { baseId: modelId, longContextEntry: false }
}

/**
 * True when Cursor publishes a distinct Fast rate for this wire model id.
 * Catalog code uses this to split Fast variants into a `-fast` entry.
 */
export function hasCursorFastPricing(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURSOR_MODEL_COSTS, `${modelId}-fast`)
}

function asMutableCost(value: OpenCodeModelCost): OpenCodeModelCost {
  const copy: OpenCodeModelCost = { input: value.input, output: value.output }
  if (value.cache_read !== undefined) copy.cache_read = value.cache_read
  if (value.cache_write !== undefined) copy.cache_write = value.cache_write
  if (value.context_over_200k) {
    copy.context_over_200k = asMutableCost(value.context_over_200k)
  }
  return copy
}

/**
 * Look up classic OpenCode cost for a catalog / wire model id.
 * Synthetic `-1m` entries retain both base and documented long-context rates.
 * Synthetic `-fast` entries are stored as their own keys.
 */
export function getCursorModelCost(modelId: string): OpenCodeModelCost | undefined {
  const costs = CURSOR_MODEL_COSTS as Record<string, OpenCodeModelCost>
  const baseId = wireModelIdForPricing(modelId).baseId
  // A priced wire id wins over suffix stripping (`-<n>k` / `-<n>m` may be real).
  const found = Object.hasOwn(costs, modelId)
    ? costs[modelId]
    : Object.hasOwn(costs, baseId) ? costs[baseId] : undefined
  if (!found) return undefined
  return asMutableCost(found)
}

export function applyCursorModelCost<T extends Record<string, unknown>>(
  modelId: string,
  entry: T,
): T & { cost?: OpenCodeModelCost } {
  const modelCost = getCursorModelCost(modelId)
  if (!modelCost) return entry
  return { ...entry, cost: modelCost }
}

/** Convert classic cost → OpenCode 2.0 `Model.Info.cost` array. */
export function toOpenCode2Costs(cost: OpenCodeModelCost | undefined): OpenCode2ModelCost[] {
  if (!cost) return []
  const out: OpenCode2ModelCost[] = [
    {
      input: cost.input,
      output: cost.output,
      cache: {
        read: cost.cache_read ?? 0,
        write: cost.cache_write ?? 0,
      },
    },
  ]
  if (cost.context_over_200k) {
    out.push({
      tier: { type: "context", size: 200_000 },
      input: cost.context_over_200k.input,
      output: cost.context_over_200k.output,
      cache: {
        read: cost.context_over_200k.cache_read ?? 0,
        write: cost.context_over_200k.cache_write ?? 0,
      },
    })
  }
  return out
}

/**
 * Coverage helper for CI / maintainer checks.
 * Intentionally unpriced first-party ids are counted as priced (covered).
 */
export function checkCursorPricingCoverage(modelIds: string[]): CursorPricingCoverage {
  const priced: string[] = []
  const missing: string[] = []
  for (const modelId of modelIds) {
    const { baseId } = wireModelIdForPricing(modelId)
    if (UNPRICED.has(baseId) || getCursorModelCost(modelId)) priced.push(modelId)
    else missing.push(modelId)
  }
  return { priced, missing }
}
