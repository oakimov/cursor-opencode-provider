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
 * row is the long-context price. A Fast variant Cursor does not price is read
 * from the provider's official pricing page (Anthropic or OpenAI). The
 * standard row is never that Fast price. A provider page that does not state
 * the variant fails the run. Auto (`default`) has route-dependent pricing.
 * Generation fails, and writes nothing, when another selectable model or
 * variant has no price. The live refresh stays a
 * manual step before a version bump.
 *
 * Usage:
 *   bun run generate:pricing
 *   bun run generate:pricing -- --from-file pricing.md --context-from-file docs.md --pages-from-dir pages --provider-pages-from-dir providers
 *   bun run generate:pricing -- --check   # exit 1 if committed data is stale
 *
 * `--from-file` together with `--context-from-file` makes no network request.
 * A page needed for a gap must be `<model-id>.html` in `--pages-from-dir`.
 * Saved provider inputs belong in `--provider-pages-from-dir` as
 * `anthropic.html`, `openai.html`, or `google.md`. Missing inputs fail the run.
 *
 * Also runs automatically before npm publish (GitHub Actions publish.yml and
 * package.json prepublishOnly) so released packages carry current docs rates.
 * Run and commit a successful refresh before any version bump or v* tag —
 * unmapped display names fail publish CI.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseCursorContextLimit } from "../src/models.js"

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

const AUTO_UNPRICED_REASON = "Cursor does not publish a uniform Auto token rate across routes and plans"
const GEMINI_PRO_ID = "gemini-3.1-pro"

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
  providerPagesFromDir?: string
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
    } else if (arg === "--provider-pages-from-dir" && argv[i + 1]) {
      options.providerPagesFromDir = argv[++i]
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
  keptSource: "markdown"
  otherSource: "page"
}

/**
 * Official list-price pages. Used only after the Cursor markdown and the
 * Cursor model page have no price for that variant.
 */
export const PROVIDER_PRICING_URL = {
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  google: "https://aistudio.google.com/docs/pricing.md",
  openai: "https://developers.openai.com/api/docs/pricing",
} as const

export type ProviderId = keyof typeof PROVIDER_PRICING_URL

export type ProviderPageInput = {
  provider: ProviderId
  html: string
}

export type PricingBuild = {
  costs: Record<string, OpenCodeModelCost>
  /** Explicit exceptions to the selectable price requirement. */
  unpriced: Record<string, string>
  disagreements: PriceDisagreement[]
  /**
   * Price ids whose own flat rate covers long context.
   */
  longCoveredByBase: Set<string>
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

function variantRequestsFast(model: SelectableCatalogModel): boolean {
  return (model.variants ?? []).some((variant) =>
    variant.parameterValues?.some((parameter) => parameter.id === "fast" && parameter.value === "true"),
  )
}

function variantRequestsSeparateContext(model: SelectableCatalogModel, fast: boolean): boolean {
  return (model.variants ?? []).some((variant) => {
    const isFast = variant.parameterValues?.some((parameter) => parameter.id === "fast" && parameter.value === "true") ?? false
    if (isFast !== fast) return false
    const context = parseCursorContextLimit(variant.parameterValues?.find((parameter) => parameter.id === "context")?.value)
    if (context === 1_000_000) return true
    return variant.isMaxMode === true && context !== undefined && context !== model.maxContext
  })
}

type PricingGap = {
  id: string
  needs: Array<"base" | "fast" | "long" | "fast-long">
}

function missingPriceParts(
  model: SelectableCatalogModel,
  pricing: {
    costs: Readonly<Record<string, OpenCodeModelCost>>
    longCoveredByBase: ReadonlySet<string>
  },
): PricingGap["needs"] {
  if (model.id === "default") return []
  const { costs, longCoveredByBase } = pricing
  const fastId = `${model.id}-fast`
  const missing: PricingGap["needs"] = []
  if (!Object.hasOwn(costs, model.id)) missing.push("base")
  if (variantRequestsFast(model) && !Object.hasOwn(costs, fastId)) missing.push("fast")
  // Cursor serves Gemini 3.1 Pro as a single 1M entry. Its price changes inside
  // that window, even though discovery does not advertise a separate variant.
  if ((variantRequestsSeparateContext(model, false) || (model.id === GEMINI_PRO_ID && (model.maxContext ?? 0) > 200_000))
    && !longPart(costs[model.id]) && !longCoveredByBase.has(model.id)) missing.push("long")
  if (variantRequestsSeparateContext(model, true)
    && !longPart(costs[fastId]) && !longCoveredByBase.has(fastId)) missing.push("fast-long")
  return missing
}

/** Selectable models whose markdown rows do not cover a base, Fast, or long-context price. */
function selectablePricingGaps(
  pricing: PricingBuild,
  catalog: readonly SelectableCatalogModel[],
): PricingGap[] {
  const gaps: PricingGap[] = []
  for (const model of catalog) {
    const needs = missingPriceParts(model, pricing)
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
  return selectablePricingGaps(buildPricing(markdown, defaultContextByDisplayName(contextMarkdown)), catalog)
    .map((gap) => gap.id)
}

/**
 * A page fetched for a gap must contain a pricing table and a price for the
 * standard variants the page can price. Validate before loading provider
 * pages. Fast and the documented Gemini gap can still use a provider page.
 */
function assertRequiredPageRows(
  gaps: readonly PricingGap[],
  pages: readonly ModelPageInput[],
  pricing: PricingBuild,
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
    if (gap.needs.includes("base") && !Object.hasOwn(pricing.costs, gap.id)) {
      problems.push(`${gap.id}: ${url} has no base price row`)
    }
    if (gap.id !== GEMINI_PRO_ID && gap.needs.includes("long")
      && !longPart(pricing.costs[gap.id]) && !pricing.longCoveredByBase.has(gap.id)) {
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
  coverage: { long: ReadonlySet<string> } = { long: new Set() },
): void {
  const missing: string[] = []
  const pricing = { costs, longCoveredByBase: coverage.long }
  for (const model of catalog) {
    for (const part of missingPriceParts(model, pricing)) {
      const id = part.startsWith("fast") ? `${model.id}-fast` : model.id
      missing.push(part.endsWith("long") ? `${id} long context` : id)
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

/**
 * "Nx the standard price/rates" for a Fast mode the page does not tabulate.
 * The sentence must name Fast mode or describe the speed of the Fast mode
 * named in the preceding sentence. A long-context
 * line such as "above 100k ... 5x the standard rates" is not a Fast price.
 */
function statedFastMultiplier(text: string): { factor: number; evidence: string } | undefined {
  const found: Array<{ factor: number; evidence: string }> = []
  const parts = sentences(text)
  for (const [index, sentence] of parts.entries()) {
    const namesFast = /\bfast (?:mode|is)\b/i
    const describesFastSpeed = /^it runs .+ faster\b/i.test(sentence) && namesFast.test(parts[index - 1] ?? "")
    if (!namesFast.test(sentence) && !describesFastSpeed) continue
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
 * window. A Fast gap with no stated rate stays empty. The standard row is
 * not copied into `<id>-fast`.
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
    const mentionsSurcharge = /input exceeds\s+\d+\s*k tokens \(long context\)[^.!?]*pricing increases/i.test(text)
    const wholeWindow = sameRate || mentionsSurcharge || rows.length !== 1 ? undefined : statedWholeWindowRate(text)
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

    let fastCost = markdownFast ?? fast?.cost
    const fastMultiplier = !fastCost && keptBase ? statedFastMultiplier(text) : undefined
    if (fastMultiplier && keptBase) {
      fastCost = scaleAll(keptBase, fastMultiplier.factor)
      derived.push({
        id: fastId,
        cost: fastCost,
        formula:
          `${pageUrl(page.modelId)} states ${fastMultiplier.evidence}, so each standard rate ` +
          `component is multiplied by ${fastMultiplier.factor} for Fast mode.`,
      })
    }
    if (fastCost && !markdownFastLong) {
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
        const ratioBase = base?.cost ?? keptBase
        if (!ratioBase) throw new Error(`${page.modelId} states Fast long-context pricing without a standard row`)
        const tier = longContext
          ? scaleComponents(fastCost, longContextFactors(ratioBase, longContext.cost))
          : scaleComponents(fastCost, { input: 2, output: 1.5, cache: 2 })
        fastCost = withThreshold(fastCost, threshold, tier)
        derived.push({
          id: fastId,
          cost: tier,
          formula:
            `${pageUrl(page.modelId)} has no combined Fast long-context row. Above ${threshold}, ` +
            `the Fast row is scaled by the page's long-context ratios.`,
        })
      }
    }
    if (fastCost) pricing.costs[fastId] = fastCost

    // A Fast row on the same page keeps its own published components. The
    // same-rate sentence does not add a second copy of that row. A page that
    // states no Fast price does not receive the standard row.
    if (sameRate && fast && pricing.costs[fastId] && !longPart(pricing.costs[fastId])) {
      pricing.longCoveredByBase.add(fastId)
      derived.push({
        id: fastId,
        cost: flatCostOf(pricing.costs[fastId]!),
        formula:
          `${pageUrl(page.modelId)} has no Fast long-context row. ${sameRate.evidence} ` +
          `The Fast row's published rate applies above that threshold because the page states no long-context multiplier.`,
      })
    }
  }
  pricing.costs = sortRecord(pricing.costs)
  pricing.unpriced = sortRecord(pricing.unpriced)
  return derived
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
  const longCoveredByBase = new Set<string>()

  for (const row of parsePricingTables(markdown)) {
    const fastModeId = fastModeModelId(row.displayName)
    if (fastModeId) {
      explicitFast.set(fastModeId, cost(row.input, row.output, row.cacheRead, row.cacheWrite))
      if (/\bat the same per-token rates as shorter context\b/i.test(row.notes)) {
        longCoveredByBase.add(`${fastModeId}-fast`)
      }
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
    if (modelId === "default") continue
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
    throw new Error(`Long-context row ${JSON.stringify(publishedLong.displayName)} has no corresponding base row`)
  }

  return {
    costs: sortRecord(costs),
    unpriced: {},
    disagreements: [],
    longCoveredByBase,
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
): string {
  const pricingBody = JSON.stringify(pricingTable, null, 2)
  const unpricedBody = JSON.stringify(unpriced, null, 2)
  const contextBody = JSON.stringify(contextTable, null, 2)
  // Keep this module free of imports so it cannot cycle with pricing.ts.
  return `/**
 * AUTO-GENERATED by scripts/generate-cursor-pricing.ts — do not edit by hand.
 * Pricing source: markdown rows in ${CURSOR_PRICING_DOC_URL}.
 * A model page fills a selectable variant that has no markdown row.
 * Gaps may use the provider's official pricing page.
 * Context source: ${CURSOR_CONTEXT_DOC_URL}
 * Regenerate: bun run generate:pricing
 */

export const CURSOR_PRICING_SOURCE = ${JSON.stringify(CURSOR_PRICING_DOC_URL)} as const
export const CURSOR_CONTEXT_SOURCE = ${JSON.stringify(CURSOR_CONTEXT_DOC_URL)} as const

export const CURSOR_MODEL_COSTS = ${pricingBody} as const

/** Selectable entries without a uniform token rate. */
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

function providerForModel(modelId: string): ProviderId | undefined {
  if (modelId.startsWith("claude-")) return "anthropic"
  if (modelId.startsWith("gpt-")) return "openai"
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function cursorDisplayName(modelId: string): string {
  const names = Object.entries(DISPLAY_NAME_TO_MODEL_ID)
    .filter(([, id]) => id === modelId)
    .map(([name]) => name)
    .filter((name) => !/\b(?:1M|500k|fast)\b/i.test(name))
  if (names.length !== 1) {
    throw new Error(
      `No single display name for ${modelId} on a provider pricing page: ${names.join(", ") || "none"}`,
    )
  }
  return names[0]!
}

/** Astro island props encode a value as [0, x] and a list as [1, xs]. */
function unwrapAstro(node: unknown): unknown {
  if (Array.isArray(node) && node.length === 2 && (node[0] === 0 || node[0] === 1)) {
    const inner = unwrapAstro(node[1])
    return node[0] === 1 && Array.isArray(inner) ? inner.map(unwrapAstro) : inner
  }
  if (Array.isArray(node)) return node.map(unwrapAstro)
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, unwrapAstro(value)]))
  }
  return node
}

function readIslandProps(html: string, exportName: string): Array<{ at: number; props: unknown }> {
  const marker = `component-export="${exportName}"`
  const found: Array<{ at: number; props: unknown }> = []
  let from = 0
  while (from < html.length) {
    const at = html.indexOf(marker, from)
    if (at < 0) break
    const propsKey = html.indexOf('props="', at)
    if (propsKey < 0 || propsKey - at > 800) {
      throw new Error(`OpenAI pricing page is missing props for ${exportName}`)
    }
    const start = propsKey + 'props="'.length
    const end = html.indexOf('"', start)
    if (end < 0) throw new Error(`OpenAI pricing page has an unclosed ${exportName} props attribute`)
    let parsed: unknown
    try {
      parsed = JSON.parse(decodeEntities(html.slice(start, end)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`OpenAI pricing page ${exportName} props are not JSON: ${message}`)
    }
    found.push({ at, props: unwrapAstro(parsed) })
    from = end + 1
  }
  return found
}

function nearestTierLabel(html: string, index: number): string | undefined {
  const before = html.slice(0, index)
  let last: string | undefined
  for (const match of before.matchAll(/>(Standard|Batch|Flex|Fast|Ultrafast)</g)) last = match[1]
  return last
}

function openAiLabel(cell: unknown): { label: string; deprecated: boolean } {
  if (typeof cell === "string") return { label: cell, deprecated: false }
  if (cell && typeof cell === "object" && "label" in cell && typeof cell.label === "string") {
    const deprecated = "deprecated" in cell && cell.deprecated === true
    return { label: cell.label, deprecated }
  }
  throw new Error(`OpenAI pricing row has no model label: ${JSON.stringify(cell)}`)
}

function openAiMoney(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null || value === "-" || value === "") return undefined
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Error(`OpenAI ${what} price is not a number: ${JSON.stringify(value)}`)
}

/**
 * Text-token rows follow the pricing component. Three values are input,
 * cached input, output. Four values are input, cached input, 30-minute
 * cache write, output. The rendered table shows output before the cache
 * columns; the props do not.
 */
function openAiTextCost(values: unknown[], label: string): OpenCodeModelCost {
  if (values.length === 3) {
    const input = openAiMoney(values[0], `${label} input`)
    const output = openAiMoney(values[2], `${label} output`)
    if (input === undefined || output === undefined) {
      throw new Error(`OpenAI Fast row ${label} has no input or output`)
    }
    return cost(input, output, openAiMoney(values[1], `${label} cached input`))
  }
  if (values.length === 4) {
    const input = openAiMoney(values[0], `${label} input`)
    const output = openAiMoney(values[3], `${label} output`)
    if (input === undefined || output === undefined) {
      throw new Error(`OpenAI Fast row ${label} has no input or output`)
    }
    return cost(
      input,
      output,
      openAiMoney(values[1], `${label} cached input`),
      openAiMoney(values[2], `${label} cache write`),
    )
  }
  throw new Error(`OpenAI Fast row ${label} has ${values.length} price cells`)
}

type OpenAiFastHit = { cost: OpenCodeModelCost; deprecated: boolean; evidence: string }

function rememberOpenAiFast(
  found: Map<string, OpenAiFastHit>,
  modelId: string,
  hit: OpenAiFastHit,
): void {
  const previous = found.get(modelId)
  if (previous && !sameFlat(previous.cost, hit.cost)) {
    throw new Error(
      `OpenAI Fast tier lists two prices for ${modelId}: ${JSON.stringify(previous.cost)} and ${JSON.stringify(hit.cost)}`,
    )
  }
  if (!previous) found.set(modelId, hit)
}

/**
 * Fast tier only. Standard, Batch, Flex, and Ultrafast rows are not prices
 * for a Cursor Fast variant.
 */
export function parseOpenAiFastPrices(
  html: string,
  needed: ReadonlySet<string>,
): Map<string, OpenAiFastHit> {
  const found = new Map<string, OpenAiFastHit>()
  for (const island of readIslandProps(html, "TextTokenPricingTables")) {
    const props = island.props
    if (!props || typeof props !== "object" || !("tier" in props) || !("rows" in props)) {
      throw new Error("OpenAI text pricing table has no tier")
    }
    if (props.tier !== "fast" || !Array.isArray(props.rows)) continue
    for (const row of props.rows) {
      if (!Array.isArray(row) || row.length < 2) {
        throw new Error("OpenAI Fast tier has a row without prices")
      }
      const identity = openAiLabel(row[0])
      const modelId = identity.label.replace(/\s+\([^)]*\)\s*$/, "").trim()
      if (!needed.has(modelId)) continue
      const costForRow = openAiTextCost(row.slice(1), identity.label)
      rememberOpenAiFast(found, modelId, {
        cost: costForRow,
        deprecated: identity.deprecated,
        evidence: `Fast tier ${identity.label}: ${JSON.stringify(costForRow)}`,
      })
    }
  }
  for (const island of readIslandProps(html, "GroupedPricingTable")) {
    if (nearestTierLabel(html, island.at) !== "Fast") continue
    const props = island.props
    if (!props || typeof props !== "object" || !("headings" in props) || !("groups" in props)) continue
    const headings = props.headings
    const groups = props.groups
    if (!Array.isArray(headings) || !headings.every((heading) => typeof heading === "string")) {
      continue
    }
    if (!Array.isArray(groups)) continue
    const headingNames = headings as string[]
    const modelAt = headingNames.indexOf("Model")
    if (modelAt < 0 || !headingNames.includes("Input") || !headingNames.includes("Output")) continue
    for (const group of groups) {
      if (!group || typeof group !== "object" || !("rows" in group) || !Array.isArray(group.rows)) continue
      for (const row of group.rows) {
        if (!Array.isArray(row)) throw new Error("OpenAI Fast grouped row is empty")
        const identity = openAiLabel(row[0])
        const modelId = identity.label.replace(/\s+\([^)]*\)\s*$/, "").trim()
        if (!needed.has(modelId)) continue
        const at = (name: string) => {
          const index = headingNames.findIndex((heading) => heading.toLowerCase() === name.toLowerCase())
          if (index < 0) return undefined
          return row[index - modelAt]
        }
        const input = openAiMoney(at("input"), `${identity.label} input`)
        const output = openAiMoney(at("output"), `${identity.label} output`)
        if (input === undefined || output === undefined) {
          throw new Error(`OpenAI Fast grouped row ${identity.label} has no input or output`)
        }
        const cachedName = headingNames.find((heading) => heading.toLowerCase() === "cached input")
        const writeName = headingNames.find((heading) => heading.toLowerCase().includes("30m"))
        rememberOpenAiFast(found, modelId, {
          cost: cost(
            input,
            output,
            cachedName ? openAiMoney(at("cached input"), `${identity.label} cached input`) : undefined,
            writeName ? openAiMoney(at(writeName), `${identity.label} cache write`) : undefined,
          ),
          deprecated: identity.deprecated,
          evidence:
            `Fast tier headings ${headingNames.join(", ")}: ${identity.label} ` +
            `input ${input}, output ${output}` +
            (cachedName ? `, cached input ${String(at("cached input"))}` : ""),
        })
      }
    }
  }
  return found
}

function anthropicFastParts(text: string, name: string): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  hit: number
  write: number
  evidence: string
} {
  if (!/Fast mode pricing applies across the full context window/i.test(text)) {
    throw new Error(
      `${PROVIDER_PRICING_URL.anthropic} does not say Fast mode pricing applies across the full context window`,
    )
  }
  if (!/Prompt caching multipliers apply on top of fast mode pricing/i.test(text)) {
    throw new Error(
      `${PROVIDER_PRICING_URL.anthropic} does not say prompt caching multipliers apply on top of fast mode pricing`,
    )
  }
  const anchor = text.search(/Fast mode pricing applies across the full context window/i)
  const tableAt = text.indexOf("Model Input Output", anchor)
  const tableEnd = text.indexOf("Fast mode pricing stacks", tableAt)
  if (tableAt < 0 || tableEnd < 0) {
    throw new Error(`${PROVIDER_PRICING_URL.anthropic} has no Fast mode pricing table`)
  }
  const row = new RegExp(
    `${escapeRegExp(name)}\\s+\\$(\\d+(?:\\.\\d+)?)\\s+USD\\s*/\\s*MTok\\s+\\$(\\d+(?:\\.\\d+)?)\\s+USD\\s*/\\s*MTok`,
    "g",
  )
  const rows = [...text.slice(tableAt, tableEnd).matchAll(row)]
  if (rows.length !== 1) {
    throw new Error(
      `${PROVIDER_PRICING_URL.anthropic} Fast mode table has ${rows.length} rows for ${name}`,
    )
  }
  const input = Number(rows[0]![1])
  const output = Number(rows[0]![2])
  const writeMatches = [...text.matchAll(/5-minute cache write\s+(\d+(?:\.\d+)?)x base input price/gi)]
  if (writeMatches.length === 0) {
    throw new Error(`${PROVIDER_PRICING_URL.anthropic} does not state a 5-minute cache write multiplier`)
  }
  const write = Number(writeMatches[0]![1])
  if (writeMatches.some((match) => Number(match[1]) !== write)) {
    throw new Error(`${PROVIDER_PRICING_URL.anthropic} states conflicting 5-minute cache write multipliers`)
  }
  const hitAt = text.search(/What a cache hit costs depends on the model/i)
  if (hitAt < 0) {
    throw new Error(`${PROVIDER_PRICING_URL.anthropic} does not state cache hit multipliers`)
  }
  const hitSection = text.slice(hitAt)
  const groups = [...hitSection.matchAll(/((?:Claude|All other models)[^$]*?)\s(\d+(?:\.\d+)?)x\b/g)]
  const named = groups.filter((group) =>
    new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|$)`).test(group[1]!),
  )
  const chosen = named.length > 0
    ? named
    : groups.filter((group) => /All other models/.test(group[1]!))
  if (chosen.length !== 1) {
    throw new Error(`${PROVIDER_PRICING_URL.anthropic} has no single cache hit multiplier for ${name}`)
  }
  const hit = Number(chosen[0]![2])
  if (![input, output, write, hit].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`${PROVIDER_PRICING_URL.anthropic} Fast price for ${name} is not a positive rate`)
  }
  return {
    input,
    output,
    cacheRead: roundRate(input * hit),
    cacheWrite: roundRate(input * write),
    hit,
    write,
    evidence: rows[0]![0].replace(/\s+/g, " "),
  }
}

/**
 * Fill Fast prices the Cursor markdown and model page do not state.
 * Reads only the provider page for that family. Never copies the standard row.
 */
export function priceFromProviderPages(
  pricing: PricingBuild,
  modelIds: readonly string[],
  pages: readonly ProviderPageInput[],
): DerivedModelPrice[] {
  const derived: DerivedModelPrice[] = []
  const byProvider = new Map(pages.map((page) => [page.provider, page]))
  const openAiNeeded = new Set(modelIds.filter((id) => providerForModel(id) === "openai"))
  const openAiPage = byProvider.get("openai")
  const openAiPrices = openAiNeeded.size > 0 && openAiPage
    ? parseOpenAiFastPrices(openAiPage.html, openAiNeeded)
    : undefined
  for (const modelId of modelIds) {
    const fastId = `${modelId}-fast`
    if (Object.hasOwn(pricing.costs, fastId)) continue
    const provider = providerForModel(modelId)
    if (!provider) {
      throw new Error(
        `${fastId} has no Cursor Fast price and no provider pricing page. The standard rate is not a Fast price.`,
      )
    }
    const page = byProvider.get(provider)
    if (!page) {
      throw new Error(
        `Refusing to fetch ${PROVIDER_PRICING_URL[provider]} for ${fastId}. The standard rate is not a Fast price.`,
      )
    }
    if (provider === "anthropic") {
      const name = cursorDisplayName(modelId)
      const parts = anthropicFastParts(pageText(page.html), name)
      const fastCost = cost(parts.input, parts.output, parts.cacheRead, parts.cacheWrite)
      pricing.costs[fastId] = fastCost
      pricing.longCoveredByBase.add(fastId)
      derived.push({
        id: fastId,
        cost: fastCost,
        formula:
          `${PROVIDER_PRICING_URL.anthropic} Fast mode pricing: ${parts.evidence}. ` +
          `Fast mode pricing applies across the full context window, so this rate has no separate long-context tier. ` +
          `Prompt caching multipliers apply on top of fast mode pricing: cache read ${parts.hit}x and ` +
          `5-minute cache write ${parts.write}x.`,
      })
      continue
    }
    const hit = openAiPrices?.get(modelId)
    if (!hit) {
      throw new Error(
        `${PROVIDER_PRICING_URL.openai} has no Fast price for ${modelId}. The standard rate is not a Fast price.`,
      )
    }
    pricing.costs[fastId] = hit.cost
    derived.push({
      id: fastId,
      cost: hit.cost,
      formula:
        `${PROVIDER_PRICING_URL.openai} ${hit.evidence}.` +
        (hit.deprecated ? ` The page marks ${modelId} deprecated and still lists that Fast tier.` : ""),
    })
  }
  pricing.costs = sortRecord(pricing.costs)
  return derived
}

export function fastModelIdsMissingPrice(
  catalog: readonly SelectableCatalogModel[],
  costs: Readonly<Record<string, OpenCodeModelCost>>,
): string[] {
  return catalog
    .filter((model) => variantRequestsFast(model) && !Object.hasOwn(costs, `${model.id}-fast`))
    .map((model) => model.id)
    .sort()
}

export function providersForFastModels(modelIds: readonly string[]): ProviderId[] {
  const providers = new Set<ProviderId>()
  for (const modelId of modelIds) {
    const provider = providerForModel(modelId)
    if (!provider) {
      throw new Error(
        `${modelId}-fast has no Cursor Fast price and no provider pricing page. The standard rate is not a Fast price.`,
      )
    }
    providers.add(provider)
  }
  return [...providers].sort()
}

function geminiLongRateMissing(gaps: readonly PricingGap[], pricing: PricingBuild): boolean {
  return gaps.some((gap) => gap.id === GEMINI_PRO_ID && gap.needs.includes("long"))
    && !longPart(pricing.costs[GEMINI_PRO_ID])
    && !pricing.longCoveredByBase.has(GEMINI_PRO_ID)
}

function applyGeminiLongRate(pricing: PricingBuild, markdown: string): DerivedModelPrice {
  // Read only the paid Standard token rows for the model Cursor calls Gemini 3.1 Pro.
  const section = markdown.split(/^## /m).find((part) => part.startsWith("Gemini 3.1 Pro Preview "))
  const standard = /\{% tab title="Standard" %\}([\s\S]*?)\{% \/tab %\}/.exec(section ?? "")?.[1] ?? ""
  const rows = standard.replace(/\r\n/g, "\n").split(/^\s*---\s*$/m)
  const rateFor = (label: string) => {
    const row = rows.find((part) => part.trimStart().startsWith(`* ${label}\n`)) ?? ""
    const pair = /\$(\d+(?:\.\d+)?), prompts <= (\d+)k[^\n]*\n\s*\$(\d+(?:\.\d+)?), prompts > (\d+)k\b/.exec(row)
    if (!pair || pair[2] !== pair[4]) {
      throw new Error(`${PROVIDER_PRICING_URL.google} has no unambiguous Gemini 3.1 Pro Standard tier for ${label}`)
    }
    return { base: Number(pair[1]), long: Number(pair[3]), threshold: tokensFromThousands(pair[2]!, label) }
  }
  const input = rateFor("Input price")
  const output = rateFor("Output price (including thinking tokens)")
  const cache = rateFor("Context caching price")
  const rates = [input, output, cache]
  const base = pricing.costs[GEMINI_PRO_ID]!
  if (rates.some((rate) => rate.threshold !== input.threshold || !Number.isFinite(rate.base) || !Number.isFinite(rate.long))
    || !sameFlat(base, cost(input.base, output.base, cache.base))) {
    throw new Error(`${PROVIDER_PRICING_URL.google} Gemini 3.1 Pro Standard tiers disagree with each other or Cursor's base rate`)
  }
  const long = cost(input.long, output.long, cache.long)
  pricing.costs[GEMINI_PRO_ID] = withThreshold(base, input.threshold, long)
  return { id: GEMINI_PRO_ID, cost: long, formula: `${PROVIDER_PRICING_URL.google} Gemini 3.1 Pro Standard rate above ${input.threshold} tokens` }
}

function providerPageFilename(provider: ProviderId): string {
  return provider === "google" ? "google.md" : `${provider}.html`
}

/** Read the required saved provider inputs without fetching. */
export function loadSavedProviderPages(
  dir: string,
  required: readonly ProviderId[],
): ProviderPageInput[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read provider pricing pages from ${dir}: ${message}`)
  }
  const unknown = names.filter((name) => name.endsWith(".html") && !Object.hasOwn(PROVIDER_PRICING_URL, name.slice(0, -".html".length)))
  if (unknown.length > 0) {
    throw new Error(`Unknown provider pricing page ${unknown.join(", ")} in ${dir}`)
  }
  return required.map((provider) => {
    const file = path.join(dir, providerPageFilename(provider))
    if (!existsSync(file)) {
      throw new Error(
        `Refusing to fetch ${PROVIDER_PRICING_URL[provider]}. Missing ${file}.`,
      )
    }
    return { provider, html: readFileSync(file, "utf8") }
  })
}

export function assemblePricing(
  pricingMarkdown: string,
  contextMarkdown: string,
  pages: readonly ModelPageInput[],
  catalog?: readonly SelectableCatalogModel[],
  providerPages: readonly ProviderPageInput[] = [],
): PricingAssembly {
  const prepared = preparePricing(pricingMarkdown, contextMarkdown, catalog)
  const supplied = applyModelPages(prepared, pages)
  return completePricing(prepared, supplied, pages, providerPages)
}

function preparePricing(pricingMarkdown: string, contextMarkdown: string, catalog?: readonly SelectableCatalogModel[]) {
  const defaultContexts = defaultContextByDisplayName(contextMarkdown)
  const pricing = buildPricing(pricingMarkdown, defaultContexts)
  const gaps = catalog ? selectablePricingGaps(pricing, catalog) : []
  return { pricing, defaultContexts, gaps, catalog, contexts: buildContextTable(contextMarkdown) }
}

function applyModelPages(prepared: ReturnType<typeof preparePricing>, pages: readonly ModelPageInput[]) {
  const { pricing, defaultContexts, gaps, catalog } = prepared
  const derived = priceFromModelPages(pricing, pages, defaultContexts)
  assertRequiredPageRows(gaps, pages, pricing)
  const fastIds = catalog ? fastModelIdsMissingPrice(catalog, pricing.costs) : []
  const providers = providersForFastModels(fastIds)
  const geminiGap = geminiLongRateMissing(gaps, pricing)
  if (geminiGap) providers.push("google")
  return { derived, fastIds, providers, geminiGap }
}

function completePricing(
  prepared: ReturnType<typeof preparePricing>,
  supplied: ReturnType<typeof applyModelPages>,
  pages: readonly ModelPageInput[],
  providerPages: readonly ProviderPageInput[],
): PricingAssembly {
  const { pricing, catalog, contexts } = prepared
  const { derived, fastIds, geminiGap } = supplied
  delete pricing.costs.default
  pricing.unpriced.default = AUTO_UNPRICED_REASON
  if (geminiGap) {
    const google = providerPages.find((page) => page.provider === "google")
    if (!google) throw new Error(`Refusing to fetch ${PROVIDER_PRICING_URL.google} for ${GEMINI_PRO_ID} long context`)
    derived.push(applyGeminiLongRate(pricing, google.html))
  }
  if (catalog) {
    derived.push(...priceFromProviderPages(pricing, fastIds, providerPages))
    assertSelectablePriced(catalog, pricing.costs, { long: pricing.longCoveredByBase })
  }
  return {
    costs: pricing.costs,
    unpriced: pricing.unpriced,
    contexts,
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
  providerPagesDir?: string
  catalogFile?: string
}): PricingAssembly {
  const pricingMarkdown = readFileSync(paths.pricingFile, "utf8")
  const contextMarkdown = readFileSync(paths.contextFile, "utf8")
  const catalog = loadSelectableCatalog(paths.catalogFile)
  const prepared = preparePricing(pricingMarkdown, contextMarkdown, catalog)
  const pageIds = prepared.gaps.map((gap) => gap.id)
  if (pageIds.length > 0 && !paths.pagesDir) {
    throw new Error(missingSavedPagesMessage(pageIds))
  }
  const pages = pageIds.length === 0 || !paths.pagesDir
    ? []
    : loadSavedModelPages(paths.pagesDir, pageIds)
  const supplied = applyModelPages(prepared, pages)
  const { providers } = supplied
  if (providers.length > 0 && !paths.providerPagesDir) {
    const lines = providers.map((provider) =>
      `${provider}: ${PROVIDER_PRICING_URL[provider]} (saved as ${providerPageFilename(provider)})`,
    )
    throw new Error(`Refusing to fetch provider pricing pages.\n${lines.join("\n")}`)
  }
  const providerPages = providers.length === 0 || !paths.providerPagesDir
    ? []
    : loadSavedProviderPages(paths.providerPagesDir, providers)
  return completePricing(prepared, supplied, pages, providerPages)
}

async function loadProviderPages(providers: readonly ProviderId[]): Promise<ProviderPageInput[]> {
  const pages: ProviderPageInput[] = []
  for (const provider of providers) {
    const url = PROVIDER_PRICING_URL[provider]
    const response = await fetch(url, {
      headers: {
        accept: provider === "google" ? "text/markdown" : "text/html",
        "user-agent": "Mozilla/5.0",
      },
    })
    if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
    pages.push({ provider, html: await response.text() })
  }
  return pages
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
  const prepared = preparePricing(pricingDoc.text, contextDoc.text, catalog)
  const pageIds = prepared.gaps.map((gap) => gap.id)
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
  const supplied = applyModelPages(prepared, pages)
  const { providers } = supplied
  let providerPages: ProviderPageInput[] = []
  if (providers.length > 0) {
    if (options.providerPagesFromDir) {
      providerPages = loadSavedProviderPages(options.providerPagesFromDir, providers)
    } else if (offline) {
      const lines = providers.map((provider) =>
        `${provider}: ${PROVIDER_PRICING_URL[provider]} (saved as ${providerPageFilename(provider)})`,
      )
      throw new Error(`Refusing to fetch provider pricing pages.\n${lines.join("\n")}`)
    } else {
      providerPages = await loadProviderPages(providers)
    }
  }
  const assembled = completePricing(prepared, supplied, pages, providerPages)
  const derived = assembled.derived
  const pricingTable = assembled.costs
  const contextTable = assembled.contexts
  const next = renderPricingDataModule(
    pricingTable,
    assembled.unpriced,
    contextTable,
  )
  const dest = outputPath()
  console.log(`Model pages: ${pages.length}${options.pagesFromDir ? ` from ${options.pagesFromDir}` : ""}`)
  if (pageIds.length > 0) console.log(`Page gaps: ${pageIds.join(", ")}`)
  if (providers.length > 0) {
    console.log(
      `Provider pages: ${providers.join(", ")}` +
        `${options.providerPagesFromDir ? ` from ${options.providerPagesFromDir}` : ""}`,
    )
  }
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
