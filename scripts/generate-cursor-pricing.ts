#!/usr/bin/env bun
/**
 * Fetch Cursor's models-and-pricing markdown and regenerate src/pricing-data.ts.
 *
 * Source of truth: https://cursor.com/docs/models-and-pricing.md
 * First-party Cursor models (Auto / Composer / Grok) are omitted when the page
 * does not publish numeric rates — fill those via CURSOR_PRICING_OVERRIDES.
 *
 * Usage:
 *   bun run generate:pricing
 *   bun run generate:pricing -- --from-file /tmp/cursor-pricing.md
 *   bun run generate:pricing -- --check   # exit 1 if committed data is stale
 *
 * Also runs automatically before npm publish (GitHub Actions publish.yml and
 * package.json prepublishOnly) so released packages carry current docs rates.
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const CURSOR_PRICING_DOC_URL = "https://cursor.com/docs/models-and-pricing.md"
export const CURSOR_PRICING_DOC_HTML_URL = "https://cursor.com/docs/models-and-pricing"

/** Classic OpenCode / models.dev cost shape (plugin config). */
export type OpenCodeModelCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: OpenCodeModelCost
}

/**
 * Docs display name → our Cursor wire / catalog model id.
 * Fast-mode-only rows and models we do not expose are omitted (see SKIP_DISPLAY_NAMES).
 */
const DISPLAY_NAME_TO_MODEL_ID: Record<string, string> = {
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
  "Gemini 2.5 Flash": "gemini-2.5-flash",
  "Gemini 3 Flash": "gemini-3-flash",
  "Gemini 3.1 Pro": "gemini-3.1-pro",
  "Gemini 3.5 Flash": "gemini-3.5-flash",
  "Gemini 3.6 Flash": "gemini-3.6-flash",
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
  "Kimi K2.7 Code": "kimi-k2.7-code",
  "Kimi K3": "kimi-k3",
}

/** Rows we intentionally ignore (variant-only pricing, unused models, duplicates). */
const SKIP_DISPLAY_NAMES = new Set([
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
  // default (Auto), composer-2.5, grok-4.5 — no numeric rates on the markdown page.
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

type Options = {
  fromFile?: string
  check: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--from-file" && argv[i + 1]) {
      options.fromFile = argv[++i]
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

function renderPricingDataModule(
  table: Record<string, OpenCodeModelCost>,
  sourceUrl: string,
): string {
  const body = JSON.stringify(table, null, 2)
  // Keep this module free of imports so it cannot cycle with pricing.ts.
  return `/**
 * AUTO-GENERATED by scripts/generate-cursor-pricing.ts — do not edit by hand.
 * Source: ${sourceUrl}
 * Regenerate: bun run generate:pricing
 */

export const CURSOR_PRICING_SOURCE = ${JSON.stringify(sourceUrl)} as const

export const CURSOR_MODEL_COSTS = ${body} as const
`
}

function repoRoot(): string {
  return path.resolve(import.meta.dir, "..")
}

function outputPath(): string {
  return path.join(repoRoot(), "src", "pricing-data.ts")
}

async function loadMarkdown(options: Options): Promise<{ text: string; source: string }> {
  if (options.fromFile) {
    return { text: readFileSync(options.fromFile, "utf8"), source: options.fromFile }
  }
  const response = await fetch(CURSOR_PRICING_DOC_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${CURSOR_PRICING_DOC_URL}: HTTP ${response.status}`)
  }
  return { text: await response.text(), source: CURSOR_PRICING_DOC_URL }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const { text, source } = await loadMarkdown(options)
  const table = buildPricingTable(text)
  const next = renderPricingDataModule(table, source)
  const dest = outputPath()

  if (options.check) {
    const current = readFileSync(dest, "utf8")
    if (current !== next) {
      console.error("src/pricing-data.ts is stale. Run: bun run generate:pricing")
      process.exit(1)
    }
    console.log(`OK: ${Object.keys(table).length} priced models; pricing-data.ts up to date`)
    return
  }

  writeFileSync(dest, next)
  console.log(`Wrote ${path.relative(repoRoot(), dest)} (${Object.keys(table).length} models)`)
  console.log(`Source: ${source}`)
  console.log(`Docs (HTML): ${CURSOR_PRICING_DOC_HTML_URL}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
