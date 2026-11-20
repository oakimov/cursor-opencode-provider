#!/usr/bin/env bun
/**
 * Fetch Cursor's models-and-pricing markdown and regenerate src/pricing-data.ts
 * with published pricing and context-window metadata.
 *
 * The pricing markdown is the price for every row it publishes. Context
 * windows come from https://cursor.com/docs.md. A note is not a price.
 * A rendered model page, https://cursor.com/docs/models/<slug>, is fetched
 * only for a selectable model or variant that has no markdown row. A page
 * never replaces a markdown row. Fast rows become synthetic `<id>-fast` ids.
 * A required page with no pricing table fails the run before anything is
 * written. A Fast or long-context gap is filled from that page's row, or from
 * a rule the page states. A Fast multiplier ("Nx the standard price") scales
 * the standard row. A same-rate sentence, or a page that lists Max context 1M
 * with one rate, means that rate applies across the window, so the published
 * row is the long-context price. A page that does not name Fast mode uses that
 * same row for Fast. A page that names Fast mode and states no rate still
 * fails, and the base rate is not written as a new row in its place. Auto
 * (`default`) is the hand-edited
 * `CURSOR_STAFF_AUTO_RATE` constant. Generation also fails, and writes
 * nothing, when a selectable model has no price. The live refresh stays a
 * manual step before a version bump.
 *
 * Usage:
 *   bun run generate:pricing
 *   bun run generate:pricing -- --from-file pricing.md --context-from-file docs.md --pages-from-dir pages
 *   bun run generate:pricing -- --check   # exit 1 if committed data is stale
 *
 * `--from-file` together with `--context-from-file` makes no network request.
 * A page needed for a gap must be `<model-id>.html` in `--pages-from-dir`.
 * A missing file fails the run and names the id. It is not fetched.
 *
 * Also runs automatically before npm publish (GitHub Actions publish.yml and
 * package.json prepublishOnly) so released packages carry current docs rates.
 * Run and commit a successful refresh before any version bump or v* tag —
 * unmapped display names fail publish CI.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
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
 * Not a lab price. Generation copies this constant. A docs row does not replace it.
 */
export const CURSOR_STAFF_AUTO_RATE: OpenCodeModelCost = {
  input: 1.25,
  output: 6,
  cache_read: 0.25,
}

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
  pagesFromDir?: string
  check: boolean
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--from-file" && argv[i + 1]) {
      options.fromFile = argv[++i]
    } else if (arg === "--context-from-file" && argv[i + 1]) {
      options.contextFromFile = argv[++i]
    } else if (arg === "--pages-from-dir" && argv[i + 1]) {
      options.pagesFromDir = argv[++i]
    } else if (arg === "--check") {
      options.check = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Where model-page HTML comes from.
 * `offline` is both markdown file flags and no pages directory: no network,
 * and a later gap check fails if a page is required.
 */
export function modelPageSource(options: Options): "directory" | "offline" | "live" {
  if (options.pagesFromDir) return "directory"
  if (options.fromFile && options.contextFromFile) return "offline"
  return "live"
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

export type PriceDisagreement = {
  id: string
  part: "base" | "fast" | "long" | "fast-long"
  kept: OpenCodeModelCost
  other: OpenCodeModelCost
  keptSource: "markdown" | "manual"
  otherSource: "page" | "markdown"
}

export type PricingBuild = {
  costs: Record<string, OpenCodeModelCost>
  /** Always empty. A selectable model with no price fails generation. */
  unpriced: Record<string, string>
  /** Markdown row for Auto, when one exists. The manual constant replaces it. */
  markdownDefault?: OpenCodeModelCost
  disagreements: PriceDisagreement[]
  /**
   * The published standard row is this model's Fast price. The page does not
   * name a Fast mode, so no separate `<id>-fast` entry is written.
   */
  fastCoveredByBase: Set<string>
  /**
   * The published standard row applies across the whole context window,
   * including Max context 1M. No separate tier is written.
   */
  longCoveredByBase: Set<string>
  /** The pricing-markdown note names a distinct Fast mode for this model. */
  fastNamedInNotes: Set<string>
}

/** A recorded AvailableModels entry. Generation uses it to find pricing gaps. */
export type SelectableCatalogModel = {
  id: string
  maxContext?: number
  variants?: ReadonlyArray<{
    isMaxMode?: boolean
    parameterValues?: ReadonlyArray<{ id: string; value: string }>
  }>
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

function contextWindowForRow(displayName: string, defaults: Readonly<Record<string, number>>): number {
  const baseName = displayName
    .replace(/\s+\((?:fast mode|Fast)\)$/i, "")
    .replace(/\s+(?:1M|500k)$/i, "")
  const threshold = defaults[baseName]
  if (!threshold) {
    throw new Error(
      `No context window for ${JSON.stringify(displayName)}. ` +
        `An explicit long-context row uses the default window from the context table.`,
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

function catalogContext(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(value.trim())
  if (!match) return undefined
  const limit = Number(match[1]) * (match[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000)
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
}

function variantRequestsFast(model: SelectableCatalogModel): boolean {
  return (model.variants ?? []).some((variant) =>
    variant.parameterValues?.some((parameter) => parameter.id === "fast" && parameter.value === "true"),
  )
}

function variantRequestsSeparateContext(model: SelectableCatalogModel): boolean {
  return (model.variants ?? []).some((variant) => {
    const context = catalogContext(variant.parameterValues?.find((parameter) => parameter.id === "context")?.value)
    if (context === 1_000_000) return true
    return variant.isMaxMode === true && context !== undefined && context !== model.maxContext
  })
}

type PricingGap = {
  id: string
  needs: Array<"base" | "fast" | "long">
}

/** Selectable models whose markdown rows do not cover a base, Fast, or long-context price. */
function selectablePricingGaps(
  markdown: string,
  contextMarkdown: string,
  catalog: readonly SelectableCatalogModel[],
): PricingGap[] {
  const pricing = buildPricing(markdown, defaultContextByDisplayName(contextMarkdown))
  const gaps: PricingGap[] = []
  for (const model of catalog) {
    if (model.id === "default") continue
    const base = pricing.costs[model.id]
    const needs: PricingGap["needs"] = []
    if (!base) needs.push("base")
    if (variantRequestsFast(model) && !pricing.costs[`${model.id}-fast`]) needs.push("fast")
    if (
      variantRequestsSeparateContext(model)
      && !longPart(base)
      && !longPart(pricing.costs[`${model.id}-fast`])
    ) needs.push("long")
    if (needs.length === 0) continue
    if (!Object.hasOwn(MODEL_PAGE_SLUG, model.id)) {
      throw new Error(
        `Selectable model ${model.id} has no pricing-markdown row for ` +
          `${needs.join(", ")} and has no docs page slug.`,
      )
    }
    gaps.push({ id: model.id, needs })
  }
  return gaps.sort((left, right) => left.id.localeCompare(right.id))
}

export function pageIdsForSelectableGaps(
  markdown: string,
  contextMarkdown: string,
  catalog: readonly SelectableCatalogModel[],
): string[] {
  return selectablePricingGaps(markdown, contextMarkdown, catalog).map((gap) => gap.id)
}

/**
 * A page fetched for a gap must contain a pricing table and a price for the
 * variant that gap needed: a row, a stated multiplier, or the published
 * standard row when the page says that row covers the variant. A missing
 * table, or a named Fast mode with no rate, is a refusal.
 */
export function assertRequiredPageRows(
  gaps: readonly PricingGap[],
  pages: readonly ModelPageInput[],
  costs: Readonly<Record<string, OpenCodeModelCost>>,
  coverage: { fast: ReadonlySet<string>; long: ReadonlySet<string> } = {
    fast: new Set(),
    long: new Set(),
  },
): void {
  const byId = new Map(pages.map((page) => [page.modelId, page]))
  const problems: string[] = []
  for (const gap of gaps) {
    const url = pageUrl(gap.id)
    const page = byId.get(gap.id)
    if (!page || parseModelPagePricing(page.html).length === 0) {
      problems.push(`${gap.id}: ${url} has no pricing table`)
      continue
    }
    if (gap.needs.includes("base") && !Object.hasOwn(costs, gap.id)) {
      problems.push(`${gap.id}: ${url} has no base price row`)
    }
    if (
      gap.needs.includes("fast")
      && !Object.hasOwn(costs, `${gap.id}-fast`)
      && !coverage.fast.has(gap.id)
    ) {
      problems.push(`${gap.id}-fast: ${url} has no Fast row or stated Fast price`)
    }
    if (
      gap.needs.includes("long")
      && !longPart(costs[gap.id])
      && !longPart(costs[`${gap.id}-fast`])
      && !coverage.long.has(gap.id)
    ) {
      problems.push(`${gap.id} long context: ${url} has no long-context row or stated long-context price`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to write. A required model page has no pricing table or no stated price for the variant that was needed:\n${problems.join("\n")}`,
    )
  }
}

export function missingSavedPagesMessage(ids: readonly string[]): string {
  const lines = ids.map((id) => `${id}: ${pageUrl(id)} (saved as ${id}.html)`)
  return `Refusing to fetch model pages. A selectable price is missing from the pricing markdown:\n${lines.join("\n")}`
}

/** Fail when a selectable catalog entry has no price of its own. Does not write. */
export function assertSelectablePriced(
  catalog: readonly SelectableCatalogModel[],
  costs: Readonly<Record<string, OpenCodeModelCost>>,
  coverage: { fast: ReadonlySet<string>; long: ReadonlySet<string> } = {
    fast: new Set(),
    long: new Set(),
  },
): void {
  const missing: string[] = []
  for (const model of catalog) {
    if (model.id !== "default" && !Object.hasOwn(costs, model.id)) missing.push(model.id)
    if (
      variantRequestsFast(model)
      && !Object.hasOwn(costs, `${model.id}-fast`)
      && !coverage.fast.has(model.id)
    ) {
      missing.push(`${model.id}-fast`)
    }
    if (
      variantRequestsSeparateContext(model)
      && !longPart(costs[model.id])
      && !longPart(costs[`${model.id}-fast`])
      && !coverage.long.has(model.id)
    ) {
      missing.push(`${model.id} long context`)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Unpriced selectable model${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
        `Generation writes nothing.`,
    )
  }
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

/** One pass. A replacement is not scanned again, so `&amp;lt;` stays `&lt;`. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#x27|#39|gt|lt|quot|amp);/g, (entity) => {
    switch (entity) {
      case "&gt;": return ">"
      case "&lt;": return "<"
      case "&quot;": return "\""
      case "&#x27;":
      case "&#39;": return "'"
      case "&amp;": return "&"
      default: return entity
    }
  })
}

function stripComments(value: string): string {
  let out = ""
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf("<!--", cursor)
    if (start < 0) return out + value.slice(cursor)
    out += value.slice(cursor, start)
    const end = value.indexOf("-->", start + 4)
    if (end < 0) return out
    cursor = end + 3
  }
  return out
}

function cellText(raw: string): string {
  return decodeEntities(stripComments(raw).replace(/<[^>]+>/g, " "))
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

function stripElement(html: string, name: string): string {
  const lower = html.toLowerCase()
  const open = `<${name}`
  const close = `</${name}`
  let out = ""
  let cursor = 0
  while (cursor < html.length) {
    const start = lower.indexOf(open, cursor)
    if (start < 0) return out + html.slice(cursor)
    const boundary = lower[start + open.length]
    if (boundary !== ">" && boundary !== "/" && !/\s/.test(boundary ?? "")) {
      out += html.slice(cursor, start + open.length)
      cursor = start + open.length
      continue
    }
    out += html.slice(cursor, start)
    const end = lower.indexOf(close, start + open.length)
    if (end < 0) return out
    const tagEnd = lower.indexOf(">", end + close.length)
    cursor = tagEnd < 0 ? html.length : tagEnd + 1
  }
  return out
}

function pageText(html: string): string {
  return decodeEntities(
    stripElement(stripElement(stripComments(html), "script"), "style").replace(/<[^>]+>/g, " "),
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

function flatCostOf(entry: OpenCodeModelCost): OpenCodeModelCost {
  return cost(entry.input, entry.output, entry.cache_read, entry.cache_write)
}

function sameFlat(left: OpenCodeModelCost, right: OpenCodeModelCost): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.cache_read === right.cache_read
    && left.cache_write === right.cache_write
}

function pageUrl(modelId: string): string {
  return `${CURSOR_MODEL_PAGE_URL}/${MODEL_PAGE_SLUG[modelId] ?? modelId}`
}

function tokensFromThousands(raw: string, evidence: string): number {
  const tokens = Number(raw) * 1_000
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error(`Invalid threshold in ${JSON.stringify(evidence)}`)
  }
  return tokens
}

/** Split on sentence boundaries. A decimal such as "4.6" or "$0.15" stays intact. */
function sentences(text: string): string[] {
  return text.split(/(?<=\.)\s+(?=[A-Z])/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "")
}

function statesNoLongContextMultiplier(sentence: string): boolean {
  return /\bno (?:separate )?long-context multiplier\b/i.test(sentence)
    || /\bno longer applies a separate long-context multiplier\b/i.test(sentence)
}

/**
 * A page sentence that says the published rate continues past a named
 * threshold. "No long-context multiplier" and "the same rates" are that
 * price. A max-context spec alone is not.
 */
function statedSameRateLongContext(text: string): { threshold: number; evidence: string } | undefined {
  const parts = sentences(text)
  const matches: Array<{ threshold: number; evidence: string }> = []
  for (let index = 0; index < parts.length; index++) {
    const current = parts[index]!
    const following = parts[index + 1] ?? ""
    const above = /\bincluding when context goes above\s+(\d+)\s*k\b/i.exec(current)
    const maxMode = /\bincluding in Max Mode above\s+(\d+)\s*k tokens\b/i.exec(current)
    const amount = above?.[1] ?? maxMode?.[1]
    if (!amount) continue
    const where = statesNoLongContextMultiplier(current)
      ? current
      : statesNoLongContextMultiplier(following) ? following : undefined
    if (!where) continue
    // The pricing table has no sentence boundary, so the split can start in a cell.
    const keywordAt = above?.index ?? maxMode?.index ?? 0
    const head = current.slice(0, keywordAt)
    let start = 0
    for (const marker of [" All ", " Prompts "]) {
      const at = head.lastIndexOf(marker)
      if (at + 1 > start) start = at + 1
    }
    const clause = current.slice(start).trim()
    let evidence = where === current ? clause : `${clause} ${following}`
    const third = parts[index + (where === current ? 1 : 2)] ?? ""
    if (/^Context windows up to 1M tokens use the same rates\.?$/i.test(third)) {
      evidence = `${evidence} ${third}`
    }
    matches.push({ threshold: tokensFromThousands(amount, evidence), evidence })
  }
  if (matches.length === 0) return undefined
  const threshold = matches[0]!.threshold
  if (matches.some((match) => match.threshold !== threshold)) {
    throw new Error(
      `Conflicting same-rate long-context thresholds: ${matches.map((match) => match.evidence).join(" | ")}`,
    )
  }
  return matches[0]
}

/**
 * "Context window 300k. Max context 1M" with one published rate. The rate
 * applies to every token in that window. "Max context -" is not this rule.
 */
function statedWholeWindowRate(text: string): { evidence: string } | undefined {
  const match = /Context window\s+\d+\s*k\s*\.?\s*Max context\s+1M\b/i.exec(text)
  if (!match) return undefined
  return { evidence: match[0].replace(/\s+/g, " ").trim() }
}

/** The page names Fast mode as its own price. A speed label is not that. */
function pageNamesFastMode(text: string): boolean {
  return /\bfast mode\b/i.test(text)
}

/** The pricing-markdown note names a distinct Fast mode. A cost comparison is not one. */
function notesNameFastMode(notes: string): boolean {
  return /\bfast mode\b/i.test(notes) || /\bhigher rates\b/i.test(notes)
}

/**
 * "Nx the standard price/rates" for a Fast mode the page does not tabulate.
 * The sentence, or the one before it, has to name Fast mode. A long-context
 * line such as "above 100k ... 5x the standard rates" is not a Fast price.
 */
function statedFastMultiplier(text: string): { factor: number; evidence: string } | undefined {
  const found: Array<{ factor: number; evidence: string }> = []
  const parts = sentences(text)
  for (let index = 0; index < parts.length; index++) {
    const sentence = parts[index]!
    const previous = parts[index - 1] ?? ""
    const namesFast = (value: string) => /\bfast mode\b/i.test(value) || /\bfast is\b/i.test(value)
    if (!namesFast(sentence) && !namesFast(previous)) continue
    for (const match of sentence.matchAll(/(?:^|[^0-9.])(\d+(?:\.\d+)?)x the standard (?:price|rates)/gi)) {
      const factor = Number(match[1])
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error(`Invalid Fast multiplier in ${JSON.stringify(match[0])}`)
      }
      found.push({ factor, evidence: match[0].replace(/\s+/g, " ").trim() })
    }
  }
  if (found.length === 0) return undefined
  const factor = found[0]!.factor
  if (found.some((item) => item.factor !== factor)) {
    throw new Error(`Conflicting Fast multipliers: ${found.map((item) => item.evidence).join(" | ")}`)
  }
  return found[0]
}

/**
 * Fill prices the markdown does not have. A markdown row is kept. When the
 * page states a different number for that row, the difference is recorded
 * and the markdown value stays. Page prose fills a gap only when the page
 * table has no row for it, and only with a multiplier or same-rate rule the
 * page states. Max context 1M beside one rate means that rate covers the
 * window. A page that does not name Fast mode uses the same row for Fast.
 * A named Fast mode with no rate is left unpriced.
 */
export function priceFromModelPages(
  pricing: PricingBuild,
  pages: readonly ModelPageInput[],
  defaultContexts: Readonly<Record<string, number>> = {},
): DerivedModelPrice[] {
  const derived: DerivedModelPrice[] = []
  for (const page of pages) {
    const rows = parseModelPagePricing(page.html)
    // An unreadable page must not supply a price from leftover prose.
    if (rows.length === 0) continue
    const text = pageText(page.html)
    const sameRate = statedSameRateLongContext(text)
    const wholeWindow = sameRate ? undefined : statedWholeWindowRate(text)
    const fastMultiplier = statedFastMultiplier(text)
    const base = oneRow(rows.filter((row) => !row.fast && !row.longContext), "standard", page.modelId)
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
    const markdownBase = pricing.costs[page.modelId]
    const keptBase = markdownBase ? flatCostOf(markdownBase) : base?.cost
    if (base && markdownBase && !sameFlat(flatCostOf(markdownBase), base.cost)) {
      pricing.disagreements.push({
        id: page.modelId,
        part: "base",
        kept: flatCostOf(markdownBase),
        other: base.cost,
        keptSource: "markdown",
        otherSource: "page",
      })
    } else if (base && !markdownBase) {
      pricing.costs[page.modelId] = base.cost
    }

    const markdownLong = longPart(markdownBase)
    if (markdownLong && longContext) {
      const pageLong = {
        threshold: pageThreshold(longContext, page.modelId, defaultContexts),
        cost: longContext.cost,
      }
      if (markdownLong.threshold !== pageLong.threshold || !sameFlat(markdownLong.cost, pageLong.cost)) {
        pricing.disagreements.push({
          id: page.modelId,
          part: "long",
          kept: markdownLong.cost,
          other: pageLong.cost,
          keptSource: "markdown",
          otherSource: "page",
        })
      }
    } else if (!markdownLong && pricing.costs[page.modelId] && longContext) {
      pricing.costs[page.modelId] = withThreshold(
        flatCostOf(pricing.costs[page.modelId]!),
        pageThreshold(longContext, page.modelId, defaultContexts),
        longContext.cost,
      )
    } else if (!markdownLong && keptBase && !longContext) {
      const stated = /input exceeds\s+(\d+)\s*k tokens \(long context\), input pricing doubles and output pricing is 1\.5x the standard rate/i.exec(text)
      if (stated && sameRate) {
        throw new Error(`${page.modelId} states both a long-context multiplier and a same-rate rule`)
      }
      if (stated) {
        const tier = scaleComponents(keptBase, { input: 2, output: 1.5, cache: 1 })
        const threshold = Number(stated[1]) * 1_000
        pricing.costs[page.modelId] = withThreshold(flatCostOf(pricing.costs[page.modelId] ?? keptBase), threshold, tier)
        derived.push({
          id: page.modelId,
          cost: tier,
          formula:
            `${pageUrl(page.modelId)} has no long-context row. Its prose says that above ` +
            `${threshold} input tokens, input doubles and output is 1.5x the standard row. ` +
            `Cache is unchanged because the page does not state a cache change.`,
        })
      } else if (sameRate) {
        // The published row already is that price at every size. Recording a
        // copy as a tier would change the committed file without changing the rate.
        pricing.longCoveredByBase.add(page.modelId)
        derived.push({
          id: page.modelId,
          cost: flatCostOf(keptBase),
          formula:
            `${pageUrl(page.modelId)} has no long-context row. ${sameRate.evidence} ` +
            `The published standard row applies above that threshold because the page states no long-context multiplier.`,
        })
      } else if (wholeWindow) {
        pricing.longCoveredByBase.add(page.modelId)
        derived.push({
          id: page.modelId,
          cost: flatCostOf(keptBase),
          formula:
            `${pageUrl(page.modelId)} lists one rate and ${wholeWindow.evidence}. ` +
            `That rate applies across the whole window, including the 1M max context.`,
        })
      }
    }

    const markdownFast = pricing.costs[fastId]
    if (markdownFast && fast && !sameFlat(flatCostOf(markdownFast), fast.cost)) {
      pricing.disagreements.push({
        id: fastId,
        part: "fast",
        kept: flatCostOf(markdownFast),
        other: fast.cost,
        keptSource: "markdown",
        otherSource: "page",
      })
    }
    const markdownFastLong = longPart(markdownFast)
    if (markdownFastLong && fastLong) {
      const pageFastLong = {
        threshold: pageThreshold(fastLong, page.modelId, defaultContexts),
        cost: fastLong.cost,
      }
      if (markdownFastLong.threshold !== pageFastLong.threshold || !sameFlat(markdownFastLong.cost, pageFastLong.cost)) {
        pricing.disagreements.push({
          id: fastId,
          part: "fast-long",
          kept: markdownFastLong.cost,
          other: pageFastLong.cost,
          keptSource: "markdown",
          otherSource: "page",
        })
      }
    }

    if (!markdownFast && fast) {
      let fastCost = fast.cost
      if (!markdownFastLong && fastLong) {
        fastCost = withThreshold(
          fastCost,
          pageThreshold(fastLong, page.modelId, defaultContexts),
          fastLong.cost,
        )
      } else if (
        !markdownFastLong
        && /long-context requests bill at 2x the Fast input, cache write, and cache read rates, and 1\.5x the Fast output rate/i.test(text)
      ) {
        const threshold = longContext
          ? pageThreshold(longContext, page.modelId, defaultContexts)
          : longContextThreshold(text)
        if (!threshold) {
          throw new Error(`${page.modelId} states Fast long-context pricing without a threshold`)
        }
        const ratioBase = base?.cost ?? keptBase
        if (!ratioBase) throw new Error(`${page.modelId} states Fast long-context pricing without a standard row`)
        const tier = longContext
          ? scaleComponents(fast.cost, longContextFactors(ratioBase, longContext.cost))
          : scaleComponents(fast.cost, { input: 2, output: 1.5, cache: 2 })
        fastCost = withThreshold(fastCost, threshold, tier)
        derived.push({
          id: fastId,
          cost: tier,
          formula:
            `${pageUrl(page.modelId)} has no combined Fast long-context row. Above ${threshold}, ` +
            `the Fast row is scaled by the page's long-context ratios.`,
        })
      }
      pricing.costs[fastId] = fastCost
    } else if (!markdownFast && !fast && keptBase && fastMultiplier) {
      const fastCost = scaleAll(keptBase, fastMultiplier.factor)
      pricing.costs[fastId] = fastCost
      derived.push({
        id: fastId,
        cost: fastCost,
        formula:
          `${pageUrl(page.modelId)} has no Fast row. Its prose says Fast is ${fastMultiplier.factor}x ` +
          `the standard price (${fastMultiplier.evidence}), so every component of the standard row ` +
          `is multiplied by ${fastMultiplier.factor}.`,
      })
    } else if (markdownFast && !markdownFastLong && fastLong) {
      pricing.costs[fastId] = withThreshold(
        flatCostOf(markdownFast),
        pageThreshold(fastLong, page.modelId, defaultContexts),
        fastLong.cost,
      )
    }

    // A Fast row on the same page keeps its own published components. The
    // same-rate sentence does not add a second copy of that row.
    if (sameRate && fast && pricing.costs[fastId] && !longPart(pricing.costs[fastId])) {
      pricing.longCoveredByBase.add(page.modelId)
      derived.push({
        id: fastId,
        cost: flatCostOf(pricing.costs[fastId]!),
        formula:
          `${pageUrl(page.modelId)} has no Fast long-context row. ${sameRate.evidence} ` +
          `The Fast row's published rate applies above that threshold because the page states no long-context multiplier.`,
      })
    }

    // No named Fast mode: the standard row is the Fast price. A page or note
    // that names Fast mode and gives no rate does not take this path.
    if (
      !Object.hasOwn(pricing.costs, fastId)
      && !fast
      && !fastMultiplier
      && keptBase
      && base
      && !pageNamesFastMode(text)
      && !pricing.fastNamedInNotes.has(page.modelId)
    ) {
      pricing.fastCoveredByBase.add(page.modelId)
      derived.push({
        id: fastId,
        cost: flatCostOf(keptBase),
        formula:
          `${pageUrl(page.modelId)} does not name a Fast mode. Fast uses the standard row ` +
          `published on the pricing markdown and on this page.`,
      })
    }
  }
  pricing.costs = sortRecord(pricing.costs)
  pricing.unpriced = sortRecord(pricing.unpriced)
  return derived
}

/**
 * Auto is the hand-edited staff rate. A markdown row for `default` does not
 * replace it. A difference is recorded.
 */
export function applyCursorStaffAutoRate(pricing: PricingBuild): void {
  const manual = { ...CURSOR_STAFF_AUTO_RATE }
  if (pricing.markdownDefault && !sameFlat(pricing.markdownDefault, manual)) {
    pricing.disagreements.push({
      id: "default",
      part: "base",
      kept: manual,
      other: pricing.markdownDefault,
      keptSource: "manual",
      otherSource: "markdown",
    })
  }
  delete pricing.costs.default
  delete pricing.unpriced.default
  pricing.costs.default = manual
  pricing.costs = sortRecord(pricing.costs)
  pricing.unpriced = sortRecord(pricing.unpriced)
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Prices from pricing-table cells only. A note is not a price. An explicit
 * `1M` or `500k` row becomes a tier at the context table's default window.
 * `(Fast)` and `(fast mode)` rows become `<id>-fast`. Auto is not priced here.
 */
export function buildPricing(
  markdown: string,
  defaultContexts: Readonly<Record<string, number>> = {},
): PricingBuild {
  const costs: Record<string, OpenCodeModelCost> = {}
  const explicitLong = new Map<string, { cost: OpenCodeModelCost; displayName: string }>()
  const explicitFast = new Map<string, OpenCodeModelCost>()
  const baseRows: Array<{
    displayName: string
    modelId: string
    entry: OpenCodeModelCost
  }> = []
  const fastNamedInNotes = new Set<string>()
  let markdownDefault: OpenCodeModelCost | undefined

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
    if (modelId === "default") {
      markdownDefault = entry
      continue
    }
    if (notesNameFastMode(row.notes)) fastNamedInNotes.add(modelId)
    if (row.isExplicitLongContextRow) {
      explicitLong.set(modelId, { cost: entry, displayName: row.displayName })
      continue
    }
    baseRows.push({ displayName: row.displayName, modelId, entry })
  }

  for (const row of baseRows) {
    const publishedLong = explicitLong.get(row.modelId)
    costs[row.modelId] = publishedLong
      ? withThreshold(
          row.entry,
          contextWindowForRow(publishedLong.displayName, defaultContexts),
          publishedLong.cost,
        )
      : row.entry
  }

  for (const [modelId, published] of explicitFast) {
    const fastId = `${modelId}-fast`
    if (costs[fastId]) continue
    const fastLong = explicitLong.get(fastId)
    costs[fastId] = fastLong
      ? withThreshold(published, contextWindowForRow(fastLong.displayName, defaultContexts), fastLong.cost)
      : published
  }

  for (const [modelId, publishedLong] of explicitLong) {
    if (costs[modelId]) continue
    costs[modelId] = publishedLong.cost
  }

  return {
    costs: sortRecord(costs),
    unpriced: {},
    markdownDefault,
    disagreements: [],
    fastCoveredByBase: new Set(),
    longCoveredByBase: new Set(),
    fastNamedInNotes,
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
 * Pricing source: markdown rows in ${pricingSource}.
 * A model page fills a selectable variant that has no markdown row.
 * Context source: ${contextSource}
 * Auto (\`default\`) is the hand-edited staff rate, not a fetched docs row.
 * Cursor staff stated $1.25/M input,
 * $0.25/M cache read, $6/M output (@deanrie, 2026-03-11,
 * https://forum.cursor.com/t/how-do-the-auto-cursor-1-5-tokens-work/154514;
 * @kevinn, 2026-05-04, restated input and output,
 * https://forum.cursor.com/t/gpt-5-5-medium-is-too-costly/159707).
 * Regenerate: bun run generate:pricing
 */

export const CURSOR_PRICING_SOURCE = ${JSON.stringify(pricingSource)} as const
export const CURSOR_CONTEXT_SOURCE = ${JSON.stringify(contextSource)} as const

export const CURSOR_MODEL_COSTS = ${pricingBody} as const

/** Empty. Generation fails instead of recording an unpriced selectable model. */
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

/**
 * Read `<model-id>.html` files. Each id in `requiredIds` must be present.
 * A missing file is an error. This function does not fetch.
 */
export function loadSavedModelPages(dir: string, requiredIds: readonly string[] = []): ModelPageInput[] {
  const known = new Set(Object.keys(MODEL_PAGE_SLUG))
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read model pages from ${dir}: ${message}`)
  }
  const pages = new Map<string, ModelPageInput>()
  for (const name of names) {
    if (!name.endsWith(".html")) continue
    const modelId = name.slice(0, -".html".length)
    if (!known.has(modelId)) throw new Error(`Unknown model page ${name} in ${dir}`)
    pages.set(modelId, { modelId, html: readFileSync(path.join(dir, name), "utf8") })
  }
  const missing = requiredIds.filter((id) => !pages.has(id))
  if (missing.length > 0) {
    const lines = missing.map((id) => `${id}: ${path.join(dir, `${id}.html`)}`)
    throw new Error(`Missing saved model page${missing.length === 1 ? "" : "s"}. Refusing to fetch.\n${lines.join("\n")}`)
  }
  if (requiredIds.length > 0) return requiredIds.map((id) => pages.get(id)!)
  if (pages.size === 0) {
    throw new Error(`No model pages in ${dir}. Expected <model-id>.html files.`)
  }
  return [...pages.values()]
}

export type PricingAssembly = {
  costs: Record<string, OpenCodeModelCost>
  unpriced: Record<string, string>
  contexts: Record<string, CursorModelContext>
  derived: DerivedModelPrice[]
  disagreements: PriceDisagreement[]
  pageIds: string[]
}

export function assemblePricing(
  pricingMarkdown: string,
  contextMarkdown: string,
  pages: readonly ModelPageInput[],
  catalog?: readonly SelectableCatalogModel[],
): PricingAssembly {
  const defaultContexts = defaultContextByDisplayName(contextMarkdown)
  const pricing = buildPricing(pricingMarkdown, defaultContexts)
  const gaps = catalog ? selectablePricingGaps(pricingMarkdown, contextMarkdown, catalog) : []
  const derived = priceFromModelPages(pricing, pages, defaultContexts)
  applyCursorStaffAutoRate(pricing)
  if (catalog) {
    const coverage = { fast: pricing.fastCoveredByBase, long: pricing.longCoveredByBase }
    assertRequiredPageRows(gaps, pages, pricing.costs, coverage)
    assertSelectablePriced(catalog, pricing.costs, coverage)
  }
  return {
    costs: pricing.costs,
    unpriced: pricing.unpriced,
    contexts: buildContextTable(contextMarkdown),
    derived,
    disagreements: pricing.disagreements,
    pageIds: pages.map((page) => page.modelId).sort(),
  }
}

export function selectableCatalogPath(): string {
  return path.join(repoRoot(), "test", "fixtures", "selectable-catalog.json")
}

export function loadSelectableCatalog(file = selectableCatalogPath()): SelectableCatalogModel[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(parsed)) throw new Error(`Selectable catalog ${file} is not a list`)
  return parsed as SelectableCatalogModel[]
}

/** Read local markdown and only the pages selectable gaps need. Does not fetch. */
export function loadOfflinePricing(paths: {
  pricingFile: string
  contextFile: string
  pagesDir?: string
  catalogFile?: string
}): PricingAssembly {
  const pricingMarkdown = readFileSync(paths.pricingFile, "utf8")
  const contextMarkdown = readFileSync(paths.contextFile, "utf8")
  const catalog = loadSelectableCatalog(paths.catalogFile)
  const pageIds = pageIdsForSelectableGaps(pricingMarkdown, contextMarkdown, catalog)
  if (pageIds.length > 0 && !paths.pagesDir) {
    throw new Error(missingSavedPagesMessage(pageIds))
  }
  const pages = pageIds.length === 0 || !paths.pagesDir
    ? []
    : loadSavedModelPages(paths.pagesDir, pageIds)
  return assemblePricing(pricingMarkdown, contextMarkdown, pages, catalog)
}

async function loadModelPages(modelIds: readonly string[]): Promise<ModelPageInput[]> {
  const entries = modelIds.map((modelId) => [modelId, MODEL_PAGE_SLUG[modelId]!] as const)
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
  const offline = Boolean(options.fromFile && options.contextFromFile)
  const pricingDoc = await loadMarkdown(CURSOR_PRICING_DOC_URL, options.fromFile)
  const contextDoc = await loadMarkdown(CURSOR_CONTEXT_DOC_URL, options.contextFromFile)
  const catalog = loadSelectableCatalog()
  const pageIds = pageIdsForSelectableGaps(pricingDoc.text, contextDoc.text, catalog)
  let pages: ModelPageInput[]
  if (pageIds.length === 0) {
    pages = []
  } else if (options.pagesFromDir) {
    pages = loadSavedModelPages(options.pagesFromDir, pageIds)
  } else if (offline) {
    throw new Error(missingSavedPagesMessage(pageIds))
  } else {
    pages = await loadModelPages(pageIds)
  }
  const assembled = assemblePricing(pricingDoc.text, contextDoc.text, pages, catalog)
  const derived = assembled.derived
  const pricingTable = assembled.costs
  const contextTable = assembled.contexts
  const next = renderPricingDataModule(
    pricingTable,
    assembled.unpriced,
    contextTable,
    pricingDoc.source,
    contextDoc.source,
  )
  const dest = outputPath()
  console.log(`Model pages: ${pages.length}${options.pagesFromDir ? ` from ${options.pagesFromDir}` : ""}`)
  if (pageIds.length > 0) console.log(`Page gaps: ${pageIds.join(", ")}`)
  console.log(`Derived prices: ${derived.length}`)
  for (const price of derived) {
    console.log(`  ${price.id}: ${JSON.stringify(price.cost)}`)
    console.log(`    ${price.formula}`)
  }
  if (assembled.disagreements.length === 0) {
    console.log("Markdown/page disagreements: none")
  } else {
    console.log(`Markdown/page disagreements: ${assembled.disagreements.length}`)
    for (const disagreement of assembled.disagreements) {
      console.log(
        `  ${disagreement.id} ${disagreement.part}: keep ${disagreement.keptSource} ${JSON.stringify(disagreement.kept)}; ` +
          `${disagreement.otherSource} says ${JSON.stringify(disagreement.other)}`,
      )
    }
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
