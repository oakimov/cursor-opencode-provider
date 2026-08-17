#!/usr/bin/env bun
/**
 * Fetch Cursor's models-and-pricing markdown and regenerate src/pricing-data.ts
 * with published pricing, context-window, and image-input metadata.
 *
 * Sources of truth:
 *   - pricing: https://cursor.com/docs/models-and-pricing.md
 *   - context: https://cursor.com/docs.md
 * First-party Cursor models (Auto / Composer / Grok) are omitted when the page
 * does not publish numeric rates — fill those via CURSOR_PRICING_OVERRIDES.
 *
 * Usage:
 *   bun run generate:pricing
 *   bun run generate:pricing -- --from-file /tmp/pricing.md --context-from-file /tmp/docs.md
 *   bun run generate:pricing -- --check   # exit 1 if committed data is stale
 *
 * Also runs automatically before npm publish (GitHub Actions publish.yml and
 * package.json prepublishOnly) so released packages carry current docs rates.
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const CURSOR_PRICING_DOC_URL = "https://cursor.com/docs/models-and-pricing.md"
export const CURSOR_PRICING_DOC_HTML_URL = "https://cursor.com/docs/models-and-pricing"
export const CURSOR_CONTEXT_DOC_URL = "https://cursor.com/docs.md"
export const CURSOR_CONTEXT_DOC_HTML_URL = "https://cursor.com/docs"

/** Classic OpenCode / models.dev cost shape (plugin config). */
export type OpenCodeModelCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: OpenCodeModelCost
}

export type CursorModelContext = {
  maxContext?: number
  maxContextForMaxMode?: number
}

export type CursorModelCapabilities = {
  supportsImages: boolean
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
  "Claude Opus 4.8": "claude-opus-4-8",
  "Claude Opus 5": "claude-opus-5",
  "Claude Sonnet 5": "claude-sonnet-5",
  "Composer 2.5": "composer-2.5",
  "Gemini 2.5 Flash": "gemini-2.5-flash",
  "Gemini 3 Flash": "gemini-3-flash",
  "Gemini 3.1 Pro": "gemini-3.1-pro",
  "Gemini 3.5 Flash": "gemini-3.5-flash",
  "Gemini 3.6 Flash": "gemini-3.6-flash",
  "Gemini 3.7 Flash": "gemini-3.7-flash",
  "GLM 5.2": "glm-5.2",
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
  "Kimi K2.7 Code": "kimi-k2.7-code",
  "Kimi K3": "kimi-k3",
}

/** Rows we intentionally ignore (variant-only pricing, unused models, duplicates). */
const SKIP_DISPLAY_NAMES = new Set([
  "Composer 1",
  "Claude Opus 4.7 (fast mode)",
  "Gemini 3 Pro",
  "Gemini 3 Pro Image Preview",
  "GPT-5",
  "GPT-5 Fast",
  "GPT-5-Codex",
  "GPT-5.1 Codex Max",
  "GPT-5.1 Codex Mini",
  "GPT-5.2 Codex",
])

/**
 * Manual rates for models Cursor does not publish in the Other Models table.
 * Leave empty until the docs publish numbers (or a maintainer verifies rates).
 */
const CURSOR_PRICING_OVERRIDES: Record<string, OpenCodeModelCost> = {
  // default (Auto), composer-2.5, grok-4.5, grok-4.6 — no numeric rates on the markdown page.
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
  supportsImages: boolean
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
      supportsImages: cells[4]!.split(",").some((capability) => capability.trim() === "Images"),
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

function withLongContext(base: OpenCodeModelCost, longContext: OpenCodeModelCost): OpenCodeModelCost {
  return { ...base, context_over_200k: longContext }
}

/** Double input-side rates for notes that say long context is "2x input pricing". */
function doubleInputSide(base: OpenCodeModelCost): OpenCodeModelCost {
  const long = cost(base.input * 2, base.output, base.cache_read !== undefined ? base.cache_read * 2 : undefined, base.cache_write !== undefined ? base.cache_write * 2 : undefined)
  return long
}

function notesImplyInput2xLongContext(notes: string): boolean {
  const lower = notes.toLowerCase()
  if (/no long-context surcharge|same per-token rates/.test(lower)) return false
  return (
    /2x (?:when (?:the )?input exceeds 200k|input pricing)/i.test(notes) ||
    /long context supports up to 1m tokens with 2x input pricing/i.test(notes)
  )
}

function parsePricingTable(markdown: string): ParsedRow[] {
  const rows: ParsedRow[] = []
  let inTable = false
  let sawHeader = false

  for (const line of markdown.split(/\r?\n/)) {
    if (/^###\s+Model pricing\b/i.test(line)) {
      inTable = true
      sawHeader = false
      continue
    }
    if (inTable && /^##\s+/.test(line)) break
    if (!inTable || !line.startsWith("|")) continue

    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
    if (cells.length < 6) {
      throw new Error(`Pricing table row has fewer than 6 cells: ${line}`)
    }

    if (!sawHeader) {
      const header = cells.map((c) => c.toLowerCase())
      if (
        header[0] !== "model" ||
        header[1] !== "provider" ||
        header[2] !== "input" ||
        !header[3]?.includes("cache write") ||
        !header[4]?.includes("cache read") ||
        header[5] !== "output"
      ) {
        throw new Error(
          `Unexpected pricing table header: ${cells.join(" | ")}. ` +
            `Update scripts/generate-cursor-pricing.ts for the new schema.`,
        )
      }
      sawHeader = true
      continue
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
      notes: cells[6] ?? "",
      isExplicitLongContextRow: /\b1M\b/i.test(displayName),
    })
  }

  if (!sawHeader || rows.length === 0) {
    throw new Error("Could not find the Model pricing table in Cursor docs markdown")
  }
  return rows
}

export function buildPricingTable(markdown: string): Record<string, OpenCodeModelCost> {
  const table: Record<string, OpenCodeModelCost> = { ...CURSOR_PRICING_OVERRIDES }
  const longContextById = new Map<string, OpenCodeModelCost>()

  for (const row of parsePricingTable(markdown)) {
    if (SKIP_DISPLAY_NAMES.has(row.displayName)) continue
    if (/\(fast mode\)/i.test(row.displayName)) continue

    const modelId = DISPLAY_NAME_TO_MODEL_ID[row.displayName]
    if (!modelId) {
      throw new Error(
        `Unmapped pricing display name ${JSON.stringify(row.displayName)}. ` +
          `Add it to DISPLAY_NAME_TO_MODEL_ID or SKIP_DISPLAY_NAMES.`,
      )
    }

    const entry = cost(row.input, row.output, row.cacheRead, row.cacheWrite)

    if (row.isExplicitLongContextRow) {
      longContextById.set(modelId, entry)
      continue
    }

    if (notesImplyInput2xLongContext(row.notes)) {
      table[modelId] = withLongContext(entry, doubleInputSide(entry))
    } else {
      table[modelId] = entry
    }
  }

  for (const [modelId, longCost] of longContextById) {
    const base = table[modelId]
    if (!base) {
      // Rare: only a 1M row exists — treat it as the base rate.
      table[modelId] = longCost
      continue
    }
    table[modelId] = withLongContext(base, longCost)
  }

  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
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

export function buildCapabilityTable(
  markdown: string,
): Record<string, CursorModelCapabilities> {
  const table: Record<string, CursorModelCapabilities> = {}

  for (const row of parseContextTable(markdown)) {
    if (SKIP_DISPLAY_NAMES.has(row.displayName)) continue

    const modelId = DISPLAY_NAME_TO_MODEL_ID[row.displayName]
    if (!modelId) {
      throw new Error(
        `Unmapped capability display name ${JSON.stringify(row.displayName)}. ` +
          `Add it to DISPLAY_NAME_TO_MODEL_ID or SKIP_DISPLAY_NAMES.`,
      )
    }

    const current = table[modelId]
    if (current && current.supportsImages !== row.supportsImages) {
      throw new Error(
        `Conflicting supportsImages values for ${modelId}: ` +
          `${current.supportsImages} and ${row.supportsImages}`,
      )
    }
    table[modelId] = { supportsImages: row.supportsImages }
  }

  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
}

function renderPricingDataModule(
  pricingTable: Record<string, OpenCodeModelCost>,
  contextTable: Record<string, CursorModelContext>,
  capabilityTable: Record<string, CursorModelCapabilities>,
  pricingSource: string,
  contextSource: string,
): string {
  const pricingBody = JSON.stringify(pricingTable, null, 2)
  const contextBody = JSON.stringify(contextTable, null, 2)
  const capabilityBody = JSON.stringify(capabilityTable, null, 2)
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

export const CURSOR_MODEL_CONTEXTS = ${contextBody} as const

export const CURSOR_MODEL_CAPABILITIES = ${capabilityBody} as const
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
  const pricingTable = buildPricingTable(pricingDoc.text)
  const contextTable = buildContextTable(contextDoc.text)
  const capabilityTable = buildCapabilityTable(contextDoc.text)
  const next = renderPricingDataModule(
    pricingTable,
    contextTable,
    capabilityTable,
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
        `${Object.keys(contextTable).length} context entries, ` +
        `${Object.keys(capabilityTable).length} capability entries; pricing-data.ts up to date`,
    )
    return
  }

  writeFileSync(dest, next)
  console.log(
    `Wrote ${path.relative(repoRoot(), dest)} ` +
      `(${Object.keys(pricingTable).length} priced models, ` +
      `${Object.keys(contextTable).length} context entries, ` +
      `${Object.keys(capabilityTable).length} capability entries)`,
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
