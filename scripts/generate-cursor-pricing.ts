#!/usr/bin/env bun
/**
 * Fetch Cursor's models-and-pricing markdown and regenerate src/pricing-data.ts
 * with published pricing and context-window metadata.
 *
 * Sources of truth:
 *   - pricing: https://cursor.com/docs/models-and-pricing.md
 *   - context: https://cursor.com/docs.md
 * Cursor Models (Composer / Grok) and Other Models tables are both imported.
 * Fast rows become synthetic `<id>-fast` catalog ids (same pattern as `-1m`).
 * Auto is omitted when the page does not publish numeric rates.
 *
 * Usage:
 *   bun run generate:pricing
 *   bun run generate:pricing -- --from-file /tmp/pricing.md --context-from-file /tmp/docs.md
 *   bun run generate:pricing -- --check   # exit 1 if committed data is stale
 *
 * Also runs automatically before npm publish (GitHub Actions publish.yml and
 * package.json prepublishOnly) so released packages carry current docs rates.
 * Run and commit a successful refresh before any version bump or v* tag —
 * unmapped display names fail publish CI.
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const CURSOR_PRICING_DOC_URL = "https://cursor.com/docs/models-and-pricing.md"
export const CURSOR_PRICING_DOC_HTML_URL = "https://cursor.com/docs/models-and-pricing"
export const CURSOR_CONTEXT_DOC_URL = "https://cursor.com/docs.md"
export const CURSOR_CONTEXT_DOC_HTML_URL = "https://cursor.com/docs"

/** Classic OpenCode / models.dev cost shape (plugin config). */
export type OpenCodeCostTier = {
  tier: { type: "context"; size: number }
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

export type OpenCodeModelCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  /**
   * OpenCode maps this field to a threshold of exactly 200k tokens.
   * Any other threshold is `tiers`, which OpenCode 1.19.6 and 2.3.2 both
   * select when the prompt is larger than `tier.size`.
   */
  context_over_200k?: OpenCodeModelCost
  tiers?: OpenCodeCostTier[]
}

export type CursorModelContext = {
  maxContext?: number
  maxContextForMaxMode?: number
}

/**
 * Docs display name → our Cursor wire / catalog model id.
 * Fast-mode-only rows and models we do not expose are omitted (see SKIP_DISPLAY_NAMES).
 */
const DISPLAY_NAME_TO_MODEL_ID: Record<string, string> = {
  "Auto Cost": "default",
  "Claude 4 Sonnet": "claude-sonnet-4",
  "Claude 4 Sonnet 1M": "claude-sonnet-4",
  "Claude 4.5 Haiku": "claude-haiku-4-5",
  "Claude 4.5 Opus": "claude-opus-4-5",
  "Claude 4.5 Sonnet": "claude-sonnet-4-5",
  "Claude 4.6 Opus": "claude-opus-4-6",
  "Claude 4.6 Sonnet": "claude-sonnet-4-6",
  "Claude 4.7 Opus": "claude-opus-4-7",
  "Claude Fable 5": "claude-fable-5",
  "Claude Fable 5.1": "claude-fable-5-1",
  "Claude Fable 5.2": "claude-fable-5-2",
  "Claude Haiku 5.5": "claude-haiku-5-5",
  "Claude Opus 4.8": "claude-opus-4-8",
  "Claude Opus 5": "claude-opus-5",
  "Claude Opus 5.5": "claude-opus-5-5",
  "Claude Sonnet 5": "claude-sonnet-5",
  "Claude Sonnet 5.5": "claude-sonnet-5-5",
  "Composer 2.5": "composer-2.5",
  "DeepSeek V4.1 Flash 1017": "deepseek-v41-flash-1017",
  "Gemini 2.5 Flash": "gemini-2.5-flash",
  "Gemini 3 Flash": "gemini-3-flash",
  "Gemini 3.1 Pro": "gemini-3.1-pro",
  "Gemini 3.5 Flash": "gemini-3.5-flash",
  "Gemini 3.6 Flash": "gemini-3.6-flash",
  "Gemini 3.7 Flash": "gemini-3.7-flash",
  "Gemini 3.8 Flash": "gemini-3.8-flash",
  "Gemini 4 Argon": "gemini-4-argon",
  // AvailableModels serves these as gemini-4-* ids, matching the docs names.
  "Gemini 4 Carbon": "gemini-4-carbon",
  "Gemini 4 Hydrogen": "gemini-4-hydrogen",
  "Gemini 4 Neon": "gemini-4-neon",
  "GLM 5.2": "glm-5.2",
  // Live AvailableModels serves the 5.3 pair as glm-5p3 ids, not glm-5.3.
  "GLM 5.3": "glm-5p3",
  "GLM 5.3 Flash": "glm-5p3-flash",
  "GPT-5 Mini": "gpt-5-mini",
  // Cursor lists Codex-branded GPT-5.1 rows; our AvailableModels id is gpt-5.1.
  "GPT-5.1 Codex": "gpt-5.1",
  "GPT-5.2": "gpt-5.2",
  "GPT-5.3 Codex": "gpt-5.3-codex",
  "GPT-5.4": "gpt-5.4",
  "GPT-5.4 Mini": "gpt-5.4-mini",
  "GPT-5.4 Nano": "gpt-5.4-nano",
  "GPT-5.5": "gpt-5.5",
  "GPT-5.6 Luna": "gpt-5.6-luna",
  "GPT-5.6 Sol": "gpt-5.6-sol",
  "GPT-5.6 Terra": "gpt-5.6-terra",
  "Grok 4.5": "grok-4.5",
  "Grok 4.6": "grok-4.6",
  "Grok 4.7": "grok-4.7",
  // Explicit long-context row; same wire id as the base model (like Claude 1M).
  "Grok 4.7 500k": "grok-4.7",
  "Kimi K2.7 Code": "kimi-k2.7-code",
  "Kimi K3": "kimi-k3",
  "Muse Spark 1.3": "muse-spark-1.3",
  "Muse Wonder": "muse-wonder-1.0",
}

/** Rows we intentionally ignore (variant-only pricing, unused models, duplicates). */
const SKIP_DISPLAY_NAMES = new Set([
  "Composer 1",
  "Claude Opus 4.7 (fast mode)",
  "Gemini 3 Pro",
  "Gemini 3 Pro Image Preview",
  // Auto-review classifier only; not selectable as a chat/agent model.
  "Gemini 3.5 Flash Lite",
  "GPT-5",
  "GPT-5 Fast",
  "GPT-5-Codex",
  "GPT-5.1 Codex Max",
  "GPT-5.1 Codex Mini",
  "GPT-5.2 Codex",
  // Enterprise-only Auto pricing row; not a catalog model we expose.
  "Legacy Enterprise Auto",
])

/**
 * Manual rates for models Cursor does not publish in any pricing table.
 * Leave empty until the docs publish numbers (or a maintainer verifies rates).
 */
const CURSOR_PRICING_OVERRIDES: Record<string, OpenCodeModelCost> = {
  // default (Auto) — billed at the routed model's list price, no Auto-specific row.
}

type ParsedRow = {
  displayName: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  notes: string
  isExplicitLongContextRow: boolean
}

type ParsedContextRow = CursorModelContext & {
  displayName: string
}

type Options = {
  fromFile?: string
  contextFromFile?: string
  check: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--from-file" && argv[i + 1]) {
      options.fromFile = argv[++i]
    } else if (arg === "--context-from-file" && argv[i + 1]) {
      options.contextFromFile = argv[++i]
    } else if (arg === "--check") {
      options.check = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function stripMarkdownLink(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim()
}

function parseMoney(value: string): number | undefined {
  const text = value.trim()
  if (text === "-" || text === "—" || text === "") return undefined
  const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(text)
  if (!match) throw new Error(`Expected money cell, got ${JSON.stringify(value)}`)
  return Number(match[1])
}

function parseContextLimit(value: string): number | undefined {
  const text = value.trim()
  if (text === "-" || text === "—" || text === "") return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(text)
  if (!match) throw new Error(`Expected context limit cell, got ${JSON.stringify(value)}`)
  const multiplier = match[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000
  const limit = Number(match[1]) * multiplier
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Invalid context limit cell: ${JSON.stringify(value)}`)
  }
  return limit
}

function parseContextTable(markdown: string): ParsedContextRow[] {
  const rows: ParsedContextRow[] = []
  let inTable = false

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) {
      if (inTable && rows.length > 0) break
      continue
    }

    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())

    if (!inTable) {
      const header = cells.map((cell) => cell.toLowerCase())
      if (
        header[0] === "model" &&
        header[1] === "provider" &&
        header[2] === "default context" &&
        header[3] === "max context" &&
        header[4] === "capabilities"
      ) {
        inTable = true
      }
      continue
    }

    if (cells.every((cell) => /^[-:\s]+$/.test(cell))) continue
    if (cells.length < 5) {
      throw new Error(`Context table row has fewer than 5 cells: ${line}`)
    }

    rows.push({
      displayName: stripMarkdownLink(cells[0]!),
      maxContext: parseContextLimit(cells[2]!),
      maxContextForMaxMode: parseContextLimit(cells[3]!),
    })
  }

  if (!inTable || rows.length === 0) {
    throw new Error("Could not find the model context table in Cursor docs markdown")
  }
  return rows
}

function cost(
  input: number,
  output: number,
  cacheRead?: number,
  cacheWrite?: number,
): OpenCodeModelCost {
  const entry: OpenCodeModelCost = { input, output }
  if (cacheRead !== undefined) entry.cache_read = cacheRead
  if (cacheWrite !== undefined) entry.cache_write = cacheWrite
  return entry
}

/** The first "above/>/exceeds Nk" threshold in a pricing note. */
export function longContextThreshold(notes: string): number | undefined {
  const match = /(?:above|>|exceeds)\s*(\d+)\s*k\b/i.exec(notes)
  if (!match) return undefined
  const tokens = Number(match[1]) * 1_000
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error(`Invalid long-context threshold in notes: ${notes}`)
  }
  return tokens
}

function roundRate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function scaleAll(base: OpenCodeModelCost, factor: number): OpenCodeModelCost {
  return cost(
    roundRate(base.input * factor),
    roundRate(base.output * factor),
    base.cache_read !== undefined ? roundRate(base.cache_read * factor) : undefined,
    base.cache_write !== undefined ? roundRate(base.cache_write * factor) : undefined,
  )
}

/** "2x input pricing" doubles input and leaves cache and output alone. */
function scaleInput(base: OpenCodeModelCost, factor: number): OpenCodeModelCost {
  return cost(roundRate(base.input * factor), base.output, base.cache_read, base.cache_write)
}

/**
 * Attach a long-context rate at the threshold the docs state.
 * 200k uses `context_over_200k` because that is the only threshold that field
 * means. Every other threshold is a `tiers` entry.
 */
function withThreshold(
  base: OpenCodeModelCost,
  threshold: number,
  longContext: OpenCodeModelCost,
): OpenCodeModelCost {
  if (threshold === 200_000) return { ...base, context_over_200k: longContext }
  const tier: OpenCodeCostTier = {
    tier: { type: "context", size: threshold },
    input: longContext.input,
    output: longContext.output,
  }
  if (longContext.cache_read !== undefined) tier.cache_read = longContext.cache_read
  if (longContext.cache_write !== undefined) tier.cache_write = longContext.cache_write
  return { ...base, tiers: [tier] }
}

function noteForbidsLongSurcharge(notes: string): boolean {
  return /no long-context surcharge|same per-token rates/i.test(notes)
}

/** Note-only long context that doubles input, with no separate table row. */
function noteDoublesInputOnly(notes: string): boolean {
  if (noteForbidsLongSurcharge(notes)) return false
  return /2x input pricing/i.test(notes)
}

/**
 * "above 100k … 5x the standard rates ($0.50/M input, …)" publishes every
 * component. The parenthetical numbers are the rate; the factor is a check.
 */
function pricedMultipleFromNote(notes: string, base: OpenCodeModelCost): OpenCodeModelCost | undefined {
  const match = /above\s+(\d+)\s*k input tokens bill at\s+(\d+(?:\.\d+)?)x the standard rates(?:\s+\(([^)]+)\))?/i.exec(notes)
  if (!match) return undefined
  const factor = Number(match[2])
  const paren = match[3]
  if (!paren) return scaleAll(base, factor)
  const money = (label: string) => {
    const found = new RegExp(`\\$([0-9]+(?:\\.[0-9]+)?)\\s*/\\s*M\\s+${label}`, "i").exec(paren)
    return found ? Number(found[1]) : undefined
  }
  const input = money("input")
  const output = money("output")
  const cacheRead = money("cache read")
  const cacheWrite = money("cache write")
  if (input === undefined || output === undefined) {
    throw new Error(`Long-context note is missing input or output: ${notes}`)
  }
  const expected = scaleAll(base, factor)
  const mismatch = (label: string, published: number | undefined, scaled: number | undefined) =>
    published !== undefined && scaled !== undefined && published !== scaled
      ? `${label} ${published} is not ${factor}x ${label === "input" ? base.input : label === "output" ? base.output : label === "cache read" ? base.cache_read : base.cache_write}`
      : undefined
  const problems = [
    mismatch("input", input, expected.input),
    mismatch("output", output, expected.output),
    mismatch("cache read", cacheRead, expected.cache_read),
    mismatch("cache write", cacheWrite, expected.cache_write),
  ].filter((problem): problem is string => problem !== undefined)
  if (problems.length > 0) {
    throw new Error(`Published long-context rates disagree with the stated factor: ${problems.join("; ")}`)
  }
  return cost(input, output, cacheRead, cacheWrite)
}

type FastNote =
  | { kind: "multiply" }
  | { kind: "unpriced"; reason: string }
  | { kind: "opus47FastDividedBy3" }

/**
 * A Fast price the docs state in prose, when the table has no Fast row.
 * "2x pricing" scales every published component. "Higher rates" and a named
 * Fast id with no figure stay unpriced.
 */
export function fastNote(notes: string): FastNote | undefined {
  if (/fast mode is available at higher rates/i.test(notes)) {
    return {
      kind: "unpriced",
      reason: "Cursor's pricing note says Fast mode is available at higher rates and publishes no rate",
    }
  }
  if (/3x lower per-token pricing than opus 4\.7 fast mode/i.test(notes)) {
    return { kind: "opus47FastDividedBy3" }
  }
  if (/fast mode is (?:15% faster with |available at )?2x pricing/i.test(notes)) {
    return { kind: "multiply" }
  }
  const named = /fast mode \(\\?`([^`\\]+)\\?`\)/i.exec(notes)
  if (named) {
    return {
      kind: "unpriced",
      reason: `Cursor names Fast mode \`${named[1]}\` and publishes no Fast rate`,
    }
  }
  return undefined
}

function fastLongDoublesFastInput(notes: string): boolean {
  return /2x fast input pricing/i.test(notes)
}

function fastModeBaseName(displayName: string): string | undefined {
  return /^(.*) \(fast mode\)$/i.exec(displayName)?.[1]
}

function isPricingTableHeader(cells: string[]): boolean {
  const header = cells.map((cell) => cell.toLowerCase())
  return (
    header[0] === "model" &&
    header[1] === "provider" &&
    header[2] === "input" &&
    !!header[3]?.includes("cache write") &&
    !!header[4]?.includes("cache read") &&
    header[5] === "output"
  )
}

/**
 * Map a docs display name onto a catalog / pricing id.
 * `Model (Fast)` rows become synthetic `<id>-fast` entries, matching the `-1m`
 * long-context split. Unmapped names return undefined so the caller can throw.
 */
export function catalogIdForPricingDisplayName(displayName: string): string | undefined {
  const direct = DISPLAY_NAME_TO_MODEL_ID[displayName]
  if (direct) return direct
  const fast = /^(.*) \(Fast\)$/.exec(displayName)
  if (!fast) return undefined
  const baseId = DISPLAY_NAME_TO_MODEL_ID[fast[1]!]
  return baseId ? `${baseId}-fast` : undefined
}

function parsePricingTables(markdown: string): ParsedRow[] {
  const rows: ParsedRow[] = []
  let inTable = false
  let notesIndex = -1

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) {
      inTable = false
      continue
    }

    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())

    if (!inTable) {
      if (cells.length >= 6 && isPricingTableHeader(cells)) {
        inTable = true
        notesIndex = cells.findIndex((cell) => cell.toLowerCase() === "notes")
      }
      continue
    }

    if (cells.length < 6) {
      throw new Error(`Pricing table row has fewer than 6 cells: ${line}`)
    }
    if (cells.every((cell) => /^[-:\s]+$/.test(cell))) continue

    const displayName = stripMarkdownLink(cells[0]!)
    const input = parseMoney(cells[2]!)
    const cacheWrite = parseMoney(cells[3]!)
    const cacheRead = parseMoney(cells[4]!)
    const output = parseMoney(cells[5]!)
    if (input === undefined || output === undefined) {
      throw new Error(`Missing required input/output price for ${displayName}`)
    }

    rows.push({
      displayName,
      input,
      output,
      cacheRead,
      cacheWrite,
      notes: cells[notesIndex] ?? "",
      // Cursor publishes some long-context rates as separate rows (`1M`, `500k`)
      // instead of only as a note on the base model.
      isExplicitLongContextRow: /\b1M\b/i.test(displayName) || /\b500k\b/i.test(displayName),
    })
  }

  if (rows.length === 0) {
    throw new Error("Could not find a Model pricing table in Cursor docs markdown")
  }
  return rows
}

const AUTO_UNPRICED_REASON = "Cursor publishes no numeric Auto rate"

export type PricingBuild = {
  costs: Record<string, OpenCodeModelCost>
  /** Catalog ids whose docs name a variant and publish no number. */
  unpriced: Record<string, string>
}

/**
 * Default context window from the model-context table, keyed by display name.
 * A "2x input pricing" note that does not name its own threshold starts at
 * this window (GPT-5.4 is 272k). Missing both is an error, never 200k.
 */
export function defaultContextByDisplayName(markdown: string): Record<string, number> {
  const contexts: Record<string, number> = {}
  for (const row of parseContextTable(markdown)) {
    if (row.maxContext !== undefined) contexts[row.displayName] = row.maxContext
  }
  return contexts
}

function requireThreshold(notes: string, displayName: string, defaults: Readonly<Record<string, number>>): number {
  const threshold = longContextThreshold(notes) ?? defaults[displayName]
  if (!threshold) {
    throw new Error(
      `No long-context threshold for ${JSON.stringify(displayName)}. ` +
        `The note has no above/exceeds Nk figure and the context table has no default context.`,
    )
  }
  return threshold
}

function fastModeModelId(displayName: string): string | undefined {
  const base = fastModeBaseName(displayName)
  if (!base) return undefined
  // The base row is "Claude 4.7 Opus"; the fast-mode row says "Claude Opus 4.7".
  if (base === "Claude Opus 4.7") return "claude-opus-4-7"
  return DISPLAY_NAME_TO_MODEL_ID[base]
}

/**
 * Prices from the docs tables and notes.
 * An explicit long-context row wins over a note. A note that only says
 * "2x input pricing" doubles input. "2x pricing" on Fast doubles every
 * component. A Fast long-context note that says "2x Fast input pricing"
 * doubles that Fast input again and leaves Fast cache and output in place.
 */
export function buildPricing(
  markdown: string,
  defaultContexts: Readonly<Record<string, number>> = {},
): PricingBuild {
  const costs: Record<string, OpenCodeModelCost> = { ...CURSOR_PRICING_OVERRIDES }
  const unpriced: Record<string, string> = { default: AUTO_UNPRICED_REASON }
  const explicitLong = new Map<string, { cost: OpenCodeModelCost; notes: string }>()
  const explicitFast = new Map<string, OpenCodeModelCost>()
  const baseRows: Array<{
    displayName: string
    modelId: string
    entry: OpenCodeModelCost
    notes: string
  }> = []

  for (const row of parsePricingTables(markdown)) {
    const fastModeId = fastModeModelId(row.displayName)
    if (fastModeId) {
      explicitFast.set(fastModeId, cost(row.input, row.output, row.cacheRead, row.cacheWrite))
      continue
    }
    if (SKIP_DISPLAY_NAMES.has(row.displayName)) continue

    const modelId = catalogIdForPricingDisplayName(row.displayName)
    if (!modelId) {
      throw new Error(
        `Unmapped pricing display name ${JSON.stringify(row.displayName)}. ` +
          `Add it to DISPLAY_NAME_TO_MODEL_ID or SKIP_DISPLAY_NAMES.`,
      )
    }

    const entry = cost(row.input, row.output, row.cacheRead, row.cacheWrite)
    if (row.isExplicitLongContextRow) {
      explicitLong.set(modelId, { cost: entry, notes: row.notes })
      continue
    }
    baseRows.push({ displayName: row.displayName, modelId, entry, notes: row.notes })
  }

  const explicitFastIds = new Set<string>([
    ...baseRows.filter((row) => row.modelId.endsWith("-fast")).map((row) => row.modelId),
    ...[...explicitFast.keys()].map((id) => `${id}-fast`),
  ])

  for (const row of baseRows) {
    const publishedLong = explicitLong.get(row.modelId)
    let priced = row.entry
    if (publishedLong) {
      priced = withThreshold(
        row.entry,
        requireThreshold(`${publishedLong.notes}\n${row.notes}`, row.displayName, defaultContexts),
        publishedLong.cost,
      )
    } else {
      const multiple = pricedMultipleFromNote(row.notes, row.entry)
      if (multiple) {
        priced = withThreshold(
          row.entry,
          requireThreshold(row.notes, row.displayName, defaultContexts),
          multiple,
        )
      } else if (noteDoublesInputOnly(row.notes)) {
        priced = withThreshold(
          row.entry,
          requireThreshold(row.notes, row.displayName, defaultContexts),
          scaleInput(row.entry, 2),
        )
      }
    }
    costs[row.modelId] = priced

    if (row.modelId.endsWith("-fast")) continue
    const fastId = `${row.modelId}-fast`
    if (explicitFastIds.has(fastId)) {
      const published = explicitFast.get(row.modelId)
      if (published) costs[fastId] = published
      continue
    }

    const fast = fastNote(row.notes)
    if (!fast) continue
    if (fast.kind === "unpriced") {
      unpriced[fastId] = fast.reason
      continue
    }
    if (fast.kind === "opus47FastDividedBy3") {
      const source = explicitFast.get("claude-opus-4-7")
      if (!source) {
        throw new Error("Claude Opus 4.7 (fast mode) row is required to price Claude Opus 4.8 Fast")
      }
      costs[fastId] = scaleAll(source, 1 / 3)
      continue
    }

    let fastCost = scaleAll(row.entry, 2)
    if (fastLongDoublesFastInput(row.notes)) {
      fastCost = withThreshold(
        fastCost,
        requireThreshold(row.notes, row.displayName, defaultContexts),
        scaleInput(fastCost, 2),
      )
    }
    costs[fastId] = fastCost
  }

  for (const [modelId, publishedLong] of explicitLong) {
    if (costs[modelId]) continue
    costs[modelId] = publishedLong.cost
  }

  return {
    costs: Object.fromEntries(Object.entries(costs).sort(([a], [b]) => a.localeCompare(b))),
    unpriced: Object.fromEntries(Object.entries(unpriced).sort(([a], [b]) => a.localeCompare(b))),
  }
}

export function buildPricingTable(
  markdown: string,
  defaultContexts: Readonly<Record<string, number>> = {},
): Record<string, OpenCodeModelCost> {
  return buildPricing(markdown, defaultContexts).costs
}

export function buildUnpricedModelReasons(
  markdown: string,
  defaultContexts: Readonly<Record<string, number>> = {},
): Record<string, string> {
  return buildPricing(markdown, defaultContexts).unpriced
}

export function buildContextTable(markdown: string): Record<string, CursorModelContext> {
  const table: Record<string, CursorModelContext> = {}

  for (const row of parseContextTable(markdown)) {
    if (row.maxContext === undefined && row.maxContextForMaxMode === undefined) continue
    if (SKIP_DISPLAY_NAMES.has(row.displayName)) continue

    const modelId = DISPLAY_NAME_TO_MODEL_ID[row.displayName]
    if (!modelId) {
      throw new Error(
        `Unmapped context display name ${JSON.stringify(row.displayName)}. ` +
          `Add it to DISPLAY_NAME_TO_MODEL_ID or SKIP_DISPLAY_NAMES.`,
      )
    }

    const current = table[modelId] ?? {}
    for (const key of ["maxContext", "maxContextForMaxMode"] as const) {
      const value = row[key]
      if (value === undefined) continue
      if (current[key] !== undefined && current[key] !== value) {
        throw new Error(
          `Conflicting ${key} values for ${modelId}: ${current[key]} and ${value}`,
        )
      }
      current[key] = value
    }
    table[modelId] = current
  }

  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
}

function renderPricingDataModule(
  pricingTable: Record<string, OpenCodeModelCost>,
  unpriced: Record<string, string>,
  contextTable: Record<string, CursorModelContext>,
  pricingSource: string,
  contextSource: string,
): string {
  const pricingBody = JSON.stringify(pricingTable, null, 2)
  const unpricedBody = JSON.stringify(unpriced, null, 2)
  const contextBody = JSON.stringify(contextTable, null, 2)
  // Keep this module free of imports so it cannot cycle with pricing.ts.
  return `/**
 * AUTO-GENERATED by scripts/generate-cursor-pricing.ts — do not edit by hand.
 * Pricing source: ${pricingSource}
 * Context source: ${contextSource}
 * Regenerate: bun run generate:pricing
 */

export const CURSOR_PRICING_SOURCE = ${JSON.stringify(pricingSource)} as const
export const CURSOR_CONTEXT_SOURCE = ${JSON.stringify(contextSource)} as const

export const CURSOR_MODEL_COSTS = ${pricingBody} as const

/** Catalog ids the docs name without a numeric rate. Keys are the unpriced ids. */
export const CURSOR_UNPRICED_MODEL_REASONS = ${unpricedBody} as const

export const CURSOR_MODEL_CONTEXTS = ${contextBody} as const
`
}

function repoRoot(): string {
  return path.resolve(import.meta.dir, "..")
}

function outputPath(): string {
  return path.join(repoRoot(), "src", "pricing-data.ts")
}

async function loadMarkdown(
  url: string,
  fromFile?: string,
): Promise<{ text: string; source: string }> {
  if (fromFile) {
    return { text: readFileSync(fromFile, "utf8"), source: fromFile }
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  }
  return { text: await response.text(), source: url }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pricingDoc = await loadMarkdown(CURSOR_PRICING_DOC_URL, options.fromFile)
  const contextDoc = await loadMarkdown(CURSOR_CONTEXT_DOC_URL, options.contextFromFile)
  const defaultContexts = defaultContextByDisplayName(contextDoc.text)
  const pricing = buildPricing(pricingDoc.text, defaultContexts)
  const pricingTable = pricing.costs
  const contextTable = buildContextTable(contextDoc.text)
  const next = renderPricingDataModule(
    pricingTable,
    pricing.unpriced,
    contextTable,
    pricingDoc.source,
    contextDoc.source,
  )
  const dest = outputPath()

  if (options.check) {
    const current = readFileSync(dest, "utf8")
    if (current !== next) {
      console.error("src/pricing-data.ts is stale. Run: bun run generate:pricing")
      process.exit(1)
    }
    console.log(
      `OK: ${Object.keys(pricingTable).length} priced models, ` +
        `${Object.keys(contextTable).length} context entries; pricing-data.ts up to date`,
    )
    return
  }

  writeFileSync(dest, next)
  console.log(
    `Wrote ${path.relative(repoRoot(), dest)} ` +
      `(${Object.keys(pricingTable).length} priced models, ` +
      `${Object.keys(contextTable).length} context entries)`,
  )
  console.log(`Pricing source: ${pricingDoc.source}`)
  console.log(`Context source: ${contextDoc.source}`)
  console.log(`Pricing docs (HTML): ${CURSOR_PRICING_DOC_HTML_URL}`)
  console.log(`Context docs (HTML): ${CURSOR_CONTEXT_DOC_HTML_URL}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
