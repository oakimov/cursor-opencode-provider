#!/usr/bin/env bun
/**
 * Fetch Cursor's models-and-pricing markdown and regenerate src/pricing-data.ts
 * with published pricing and context-window metadata.
 *
 * Sources of truth, in order:
 *   - each model's rendered page https://cursor.com/docs/models/<slug>
 *     (the raw `.md` omits the pricing table)
 *   - the main tables https://cursor.com/docs/models-and-pricing.md
 *     for a row the model page does not publish
 *   - context windows: https://cursor.com/docs.md
 * A main-table note such as "2x input pricing" is not a price when that
 * model's page has a table. Fast rows become synthetic `<id>-fast` ids.
 * Auto (`default`) uses the fixed rate Cursor staff stated on the forum;
 * the docs publish no Auto per-1M rate.
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
export const CURSOR_MODEL_PAGE_URL = "https://cursor.com/docs/models"
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
 * Auto (`default`). The docs publish no per-1M rate. Cursor staff stated this
 * fixed rate on the forum: $1.25/M input, $0.25/M cache read, $6/M output.
 * @deanrie, 2026-03-11, states all three:
 * https://forum.cursor.com/t/how-do-the-auto-cursor-1-5-tokens-work/154514
 * @kevinn, 2026-05-04, restates input and output:
 * https://forum.cursor.com/t/gpt-5-5-medium-is-too-costly/159707
 * Not a lab price and not inferred from another model's rate.
 */
export const CURSOR_STAFF_AUTO_RATE: OpenCodeModelCost = {
  input: 1.25,
  output: 6,
  cache_read: 0.25,
}

/**
 * Manual rates for models Cursor does not publish in any pricing table.
 * Auto is applied in `applyCursorStaffAutoRate` so a future docs row wins.
 */
const CURSOR_PRICING_OVERRIDES: Record<string, OpenCodeModelCost> = {}

/**
 * Wire id → docs slug. Dots become dashes. A few older Claude and Cursor
 * pages use a different order (`claude-4-sonnet`, `cursor-composer-2-5`).
 */
const MODEL_PAGE_SLUG: Record<string, string> = {
  "claude-fable-5": "claude-fable-5",
  "claude-fable-5-1": "claude-fable-5-1",
  "claude-fable-5-2": "claude-fable-5-2",
  "claude-haiku-4-5": "claude-4-5-haiku",
  "claude-haiku-5-5": "claude-haiku-5-5",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-5": "claude-opus-5",
  "claude-opus-5-5": "claude-opus-5-5",
  "claude-sonnet-4": "claude-4-sonnet",
  "claude-sonnet-4-5": "claude-4-5-sonnet",
  "claude-sonnet-4-6": "claude-4-6-sonnet",
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5-5": "claude-sonnet-5-5",
  "composer-2.5": "cursor-composer-2-5",
  "deepseek-v41-flash-1017": "deepseek-v4-1-flash-1017",
  "gemini-2.5-flash": "gemini-2-5-flash",
  "gemini-3-flash": "gemini-3-flash",
  "gemini-3.1-pro": "gemini-3-1-pro",
  "gemini-3.5-flash": "gemini-3-5-flash",
  "gemini-3.6-flash": "gemini-3-6-flash",
  "gemini-3.7-flash": "gemini-3-7-flash",
  "gemini-3.8-flash": "gemini-3-8-flash",
  "gemini-4-argon": "gemini-4-argon",
  "gemini-4-carbon": "gemini-4-carbon",
  "gemini-4-hydrogen": "gemini-4-hydrogen",
  "gemini-4-neon": "gemini-4-neon",
  "glm-5.2": "glm-5-2",
  "glm-5p3": "glm-5-3",
  "glm-5p3-flash": "glm-5-3-flash",
  "gpt-5-mini": "gpt-5-mini",
  "gpt-5.1": "gpt-5-1-codex",
  "gpt-5.2": "gpt-5-2",
  "gpt-5.3-codex": "gpt-5-3-codex",
  "gpt-5.4": "gpt-5-4",
  "gpt-5.4-mini": "gpt-5-4-mini",
  "gpt-5.4-nano": "gpt-5-4-nano",
  "gpt-5.5": "gpt-5-5",
  "gpt-5.6-luna": "gpt-5-6-luna",
  "gpt-5.6-sol": "gpt-5-6-sol",
  "gpt-5.6-terra": "gpt-5-6-terra",
  "grok-4.5": "grok-4-5",
  "grok-4.6": "grok-4-6",
  "grok-4.7": "grok-4-7",
  "kimi-k2.7-code": "kimi-k2-7-code",
  "kimi-k3": "kimi-k3",
  "muse-spark-1.3": "muse-spark-1-3",
  "muse-wonder-1.0": "muse-wonder",
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

export type ModelPageInput = {
  modelId: string
  html: string
}

export type DerivedModelPrice = {
  /** Catalog id. A long-context derivation is the base id; its cost is the tier. */
  id: string
  formula: string
  cost: OpenCodeModelCost
}

type PageRow = {
  label: string
  cost: OpenCodeModelCost
  fast: boolean
  longContext: boolean
  /** Token threshold parsed from "(>272k)" in the row label. */
  threshold?: number
}

function decodeHtml(value: string): string {
  return value
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
}

function cellText(raw: string): string {
  return decodeHtml(raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function parsePageMoney(value: string): number | undefined {
  const text = value.replace(/\s+/g, "")
  if (text === "-" || text === "—" || text === "") return undefined
  const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(text)
  if (!match) throw new Error(`Expected money cell, got ${JSON.stringify(value)}`)
  return Number(match[1])
}

/** Pricing tables in a rendered model page. The raw markdown page omits them. */
export function parseModelPagePricing(html: string): PageRow[] {
  const tables: string[][][] = []
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows: string[][] = []
    for (const row of table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        cellText(cell[1]!),
      )
      if (cells.some((cell) => cell !== "")) rows.push(cells)
    }
    if (rows.length > 0) tables.push(rows)
  }
  const pricing = tables.filter((rows) => {
    const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? []
    return header[0] === "name"
      && header.includes("input")
      && header.some((cell) => cell.includes("cache write"))
      && header.some((cell) => cell.includes("cache read"))
      && header.includes("output")
  })
  if (pricing.length === 0) return []
  const first = JSON.stringify(pricing[0])
  if (pricing.some((rows) => JSON.stringify(rows) !== first)) {
    throw new Error("Model page pricing tables disagree")
  }
  const header = pricing[0]![0]!
  const index = (name: string) => header.findIndex((cell) => cell.toLowerCase() === name)
  const inputAt = index("input")
  const outputAt = index("output")
  const cacheWriteAt = header.findIndex((cell) => cell.toLowerCase().includes("cache write"))
  const cacheReadAt = header.findIndex((cell) => cell.toLowerCase().includes("cache read"))
  return pricing[0]!.slice(1).map((cells) => {
    const label = cells[0] ?? ""
    const input = parsePageMoney(cells[inputAt] ?? "")
    const output = parsePageMoney(cells[outputAt] ?? "")
    if (input === undefined || output === undefined) {
      throw new Error(`Missing input or output on model page row ${JSON.stringify(label)}`)
    }
    const threshold = /\(\s*>\s*(\d+)\s*k\s*\)/i.exec(label)
    return {
      label,
      cost: cost(
        input,
        output,
        parsePageMoney(cells[cacheReadAt] ?? ""),
        parsePageMoney(cells[cacheWriteAt] ?? ""),
      ),
      fast: /\bfast\b/i.test(label),
      longContext: /long context|\b500k\b|\b1m\b/i.test(label),
      threshold: threshold ? Number(threshold[1]) * 1_000 : undefined,
    }
  })
}

function pageText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ")
}

function oneRow(rows: PageRow[], kind: string, modelId: string): PageRow | undefined {
  if (rows.length > 1) {
    throw new Error(`${modelId} page has ${rows.length} ${kind} rows`)
  }
  return rows[0]
}

function baseWindow(
  modelId: string,
  defaultContexts: Readonly<Record<string, number>>,
): number | undefined {
  const windows = Object.entries(DISPLAY_NAME_TO_MODEL_ID)
    .filter(([name, id]) => id === modelId && !/\b(?:1M|500k)\b/i.test(name))
    .map(([name]) => defaultContexts[name])
    .filter((value): value is number => value !== undefined)
  return windows.length > 0 ? Math.min(...windows) : undefined
}

function pageThreshold(
  row: PageRow,
  modelId: string,
  defaultContexts: Readonly<Record<string, number>>,
): number {
  if (row.threshold) return row.threshold
  const window = baseWindow(modelId, defaultContexts)
  if (window) return window
  throw new Error(`No long-context threshold for ${modelId} row ${JSON.stringify(row.label)}`)
}

function scaleComponents(
  base: OpenCodeModelCost,
  factors: { input: number; output: number; cache: number },
): OpenCodeModelCost {
  return cost(
    roundRate(base.input * factors.input),
    roundRate(base.output * factors.output),
    base.cache_read !== undefined ? roundRate(base.cache_read * factors.cache) : undefined,
    base.cache_write !== undefined ? roundRate(base.cache_write * factors.cache) : undefined,
  )
}

/**
 * Component ratio of a page's long-context row over its standard row.
 * Applied to the Fast row when the page states that Fast uses those
 * long-context ratios and does not publish the combined row.
 */
function longContextFactors(standard: OpenCodeModelCost, longContext: OpenCodeModelCost): {
  input: number
  output: number
  cache: number
} {
  const ratio = (label: string, over: number | undefined, under: number | undefined) => {
    if (over === undefined && under === undefined) return undefined
    if (over === undefined || under === undefined || under === 0) {
      throw new Error(`Cannot derive a ${label} long-context ratio`)
    }
    return over / under
  }
  const input = ratio("input", longContext.input, standard.input)
  const output = ratio("output", longContext.output, standard.output)
  const cacheRead = ratio("cache read", longContext.cache_read, standard.cache_read)
  const cacheWrite = ratio("cache write", longContext.cache_write, standard.cache_write)
  const cache = cacheRead ?? cacheWrite
  if (input === undefined || output === undefined || cache === undefined) {
    throw new Error("Long-context row is missing a component the standard row publishes")
  }
  if (cacheRead !== undefined && cacheWrite !== undefined && cacheRead !== cacheWrite) {
    throw new Error("Cache read and cache write long-context ratios differ")
  }
  return { input, output, cache }
}

function longPart(entry: OpenCodeModelCost | undefined): { threshold: number; cost: OpenCodeModelCost } | undefined {
  if (!entry) return undefined
  if (entry.context_over_200k) return { threshold: 200_000, cost: entry.context_over_200k }
  const tier = entry.tiers?.[0]
  if (!tier) return undefined
  return {
    threshold: tier.tier.size,
    cost: cost(tier.input, tier.output, tier.cache_read, tier.cache_write),
  }
}

/**
 * Replace main-table prices for models whose rendered page has a pricing
 * table. A page row wins. A page sentence fills only a variant the table
 * does not list. An explicit main-table row fills what the page leaves out.
 */
export function priceFromModelPages(
  pricing: PricingBuild,
  pages: readonly ModelPageInput[],
  defaultContexts: Readonly<Record<string, number>> = {},
): DerivedModelPrice[] {
  const derived: DerivedModelPrice[] = []
  for (const page of pages) {
    const rows = parseModelPagePricing(page.html)
    if (rows.length === 0) {
      throw new Error(`No pricing table on the ${page.modelId} model page`)
    }
    const text = pageText(page.html)
    const base = oneRow(rows.filter((row) => !row.fast && !row.longContext), "standard", page.modelId)
    if (!base) throw new Error(`No standard pricing row on the ${page.modelId} model page`)
    const longContext = oneRow(
      rows.filter((row) => !row.fast && row.longContext),
      "long-context",
      page.modelId,
    )
    const fast = oneRow(rows.filter((row) => row.fast && !row.longContext), "Fast", page.modelId)
    const fastLong = oneRow(
      rows.filter((row) => row.fast && row.longContext),
      "Fast long-context",
      page.modelId,
    )
    const fastId = `${page.modelId}-fast`
    let next = base.cost
    if (longContext) {
      next = withThreshold(next, pageThreshold(longContext, page.modelId, defaultContexts), longContext.cost)
    } else {
      const stated = /input exceeds\s+(\d+)\s*k tokens \(long context\), input pricing doubles and output pricing is 1\.5x the standard rate/i.exec(text)
      if (stated) {
        const tier = scaleComponents(base.cost, { input: 2, output: 1.5, cache: 1 })
        const threshold = Number(stated[1]) * 1_000
        next = withThreshold(next, threshold, tier)
        derived.push({
          id: page.modelId,
          cost: tier,
          formula:
            `${CURSOR_MODEL_PAGE_URL}/${MODEL_PAGE_SLUG[page.modelId] ?? page.modelId} ` +
            `has no long-context row. Its prose says that above ${threshold} input tokens, ` +
            `input doubles and output is 1.5x the standard row. Cache is unchanged because ` +
            `the page does not state a cache change.`,
        })
      } else {
        const published = longPart(pricing.costs[page.modelId])
        if (published) next = withThreshold(next, published.threshold, published.cost)
      }
    }
    pricing.costs[page.modelId] = next

    delete pricing.unpriced[fastId]
    if (fast) {
      let fastCost = fast.cost
      if (fastLong) {
        fastCost = withThreshold(
          fastCost,
          pageThreshold(fastLong, page.modelId, defaultContexts),
          fastLong.cost,
        )
      } else if (
        /long-context requests bill at 2x the Fast input, cache write, and cache read rates, and 1\.5x the Fast output rate/i.test(text)
      ) {
        const threshold = longContext
          ? pageThreshold(longContext, page.modelId, defaultContexts)
          : longContextThreshold(text)
        if (!threshold) {
          throw new Error(`${page.modelId} states Fast long-context pricing without a threshold`)
        }
        const tier = longContext
          ? scaleComponents(fast.cost, longContextFactors(base.cost, longContext.cost))
          : scaleComponents(fast.cost, { input: 2, output: 1.5, cache: 2 })
        fastCost = withThreshold(fastCost, threshold, tier)
        derived.push({
          id: fastId,
          cost: tier,
          formula:
            `${CURSOR_MODEL_PAGE_URL}/${MODEL_PAGE_SLUG[page.modelId] ?? page.modelId} ` +
            `has no combined Fast long-context row. Above ${threshold}, the Fast row is ` +
            `scaled by the page's long-context ratios.`,
        })
      }
      pricing.costs[fastId] = fastCost
    } else if (/2x the standard (?:price|rates)/i.test(text)) {
      const fastCost = scaleAll(base.cost, 2)
      pricing.costs[fastId] = fastCost
      derived.push({
        id: fastId,
        cost: fastCost,
        formula:
          `${CURSOR_MODEL_PAGE_URL}/${MODEL_PAGE_SLUG[page.modelId] ?? page.modelId} ` +
          `has no Fast row. Its prose says Fast is 2x the standard price, so every ` +
          `component of the standard row is doubled.`,
      })
    }
  }
  pricing.costs = sortRecord(pricing.costs)
  pricing.unpriced = sortRecord(pricing.unpriced)
  return derived
}

/**
 * Docs publish no Auto rate. Use the Cursor staff forum rate unless a docs
 * row already priced `default`.
 */
export function applyCursorStaffAutoRate(pricing: PricingBuild): void {
  if (pricing.costs.default) return
  delete pricing.unpriced.default
  pricing.costs.default = { ...CURSOR_STAFF_AUTO_RATE }
  pricing.costs = sortRecord(pricing.costs)
  pricing.unpriced = sortRecord(pricing.unpriced)
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Prices from the main docs tables and, where a model page is absent, notes.
 * An explicit long-context row wins over a note. A note that only says
 * "2x input pricing" doubles input. "2x pricing" on Fast doubles every
 * component. A Fast long-context note that says "2x Fast input pricing"
 * doubles that Fast input again and leaves Fast cache and output in place.
 * `skipNoteModels` are priced from their own pages instead.
 */
export function buildPricing(
  markdown: string,
  defaultContexts: Readonly<Record<string, number>> = {},
  options: { skipNoteModels?: ReadonlySet<string> } = {},
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
    const skipNotes = options.skipNoteModels?.has(row.modelId.replace(/-fast$/, "")) === true
    let priced = row.entry
    if (publishedLong) {
      priced = withThreshold(
        row.entry,
        requireThreshold(`${publishedLong.notes}\n${row.notes}`, row.displayName, defaultContexts),
        publishedLong.cost,
      )
    } else if (!skipNotes) {
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
    if (skipNotes) continue

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
 * Pricing source: each https://cursor.com/docs/models/<slug> table (rendered HTML).
 * The main table (${pricingSource}) fills a row the model page does not publish.
 * Context source: ${contextSource}
 * Auto (\`default\`) is not a docs rate. Cursor staff stated $1.25/M input,
 * $0.25/M cache read, $6/M output (@deanrie, 2026-03-11,
 * https://forum.cursor.com/t/how-do-the-auto-cursor-1-5-tokens-work/154514;
 * @kevinn, 2026-05-04, restated input and output,
 * https://forum.cursor.com/t/gpt-5-5-medium-is-too-costly/159707).
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

async function loadModelPages(): Promise<ModelPageInput[]> {
  const entries = Object.entries(MODEL_PAGE_SLUG)
  const pages: ModelPageInput[] = []
  const pending = [...entries]
  const worker = async () => {
    while (pending.length > 0) {
      const next = pending.shift()
      if (!next) return
      const [modelId, slug] = next
      const url = `${CURSOR_MODEL_PAGE_URL}/${slug}`
      const response = await fetch(url, { headers: { accept: "text/html" } })
      if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
      pages.push({ modelId, html: await response.text() })
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()))
  return pages
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pricingDoc = await loadMarkdown(CURSOR_PRICING_DOC_URL, options.fromFile)
  const contextDoc = await loadMarkdown(CURSOR_CONTEXT_DOC_URL, options.contextFromFile)
  const pages = await loadModelPages()
  const defaultContexts = defaultContextByDisplayName(contextDoc.text)
  const pricing = buildPricing(pricingDoc.text, defaultContexts, {
    skipNoteModels: new Set(pages.map((page) => page.modelId)),
  })
  const derived = priceFromModelPages(pricing, pages, defaultContexts)
  applyCursorStaffAutoRate(pricing)
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
  console.log(`Model pages: ${pages.length}`)
  console.log(`Derived prices: ${derived.length}`)
  for (const price of derived) {
    console.log(`  ${price.id}: ${JSON.stringify(price.cost)}`)
    console.log(`    ${price.formula}`)
  }

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
