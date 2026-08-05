#!/usr/bin/env bun
/**
 * Check that known Cursor model ids resolve to pricing (or are intentionally unpriced).
 *
 *   bun run check:pricing
 *   bun run check:pricing -- --models-file test/fixtures/cursor-pricing-models.txt
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
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

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const modelIds = loadModelIds(options)
  const coverage = checkCursorPricingCoverage(modelIds)
  const failed = coverage.missing.length > 0

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          source: CURSOR_PRICING_SOURCE,
          modelCount: modelIds.length,
          intentionallyUnpriced: CURSOR_UNPRICED_MODEL_IDS,
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
    console.log(`Intentionally unpriced: ${CURSOR_UNPRICED_MODEL_IDS.join(", ")}`)
    if (coverage.missing.length > 0) {
      console.log("Missing pricing:")
      for (const id of coverage.missing) console.log(`  ${id}`)
    }
  }

  if (failed) process.exit(1)
}

main()
