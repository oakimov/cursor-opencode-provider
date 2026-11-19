#!/usr/bin/env bun
/**
 * Check that every selectable model and variant resolves to a price.
 * The unpriced map has no escape hatch: it must be empty, and a listed id
 * is missing rather than covered.
 *
 *   bun run check:pricing
 *   bun run check:pricing -- --models-file test/fixtures/cursor-pricing-models.txt
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { modelsToConfig } from "../src/model-config.js"
import type { ModelInfo } from "../src/models.js"
import {
  CURSOR_UNPRICED_MODEL_IDS,
  checkCursorPricingCoverage,
} from "../src/pricing.js"
import { CURSOR_PRICING_SOURCE } from "../src/pricing-data.js"

type Options = {
  modelsFile?: string
  json: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--models-file" && argv[i + 1]) {
      options.modelsFile = argv[++i]
    } else if (arg === "--json") {
      options.json = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function loadModelIds(options: Options): string[] {
  const file =
    options.modelsFile ??
    fileURLToPath(new URL("../test/fixtures/cursor-pricing-models.txt", import.meta.url))
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
}

function selectableEntryIds(): string[] {
  const catalogPath = fileURLToPath(new URL("../test/fixtures/selectable-catalog.json", import.meta.url))
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as ModelInfo[]
  return Object.keys(modelsToConfig(catalog))
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const modelIds = [...new Set([...loadModelIds(options), ...selectableEntryIds()])].sort()
  const coverage = checkCursorPricingCoverage(modelIds)
  const unpriced = [...CURSOR_UNPRICED_MODEL_IDS]
  const failed = coverage.missing.length > 0 || unpriced.length > 0

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          source: CURSOR_PRICING_SOURCE,
          modelCount: modelIds.length,
          intentionallyUnpriced: unpriced,
          coverage,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`Pricing source: ${CURSOR_PRICING_SOURCE}`)
    console.log(`Models checked: ${modelIds.length}`)
    console.log(`Covered: ${coverage.priced.length}`)
    console.log(`Missing: ${coverage.missing.length}`)
    console.log(`Unpriced exceptions: ${unpriced.length === 0 ? "none" : unpriced.join(", ")}`)
    if (coverage.missing.length > 0) {
      console.log("Missing pricing:")
      for (const id of coverage.missing) console.log(`  ${id}`)
    }
  }

  if (failed) process.exit(1)
}

main()
