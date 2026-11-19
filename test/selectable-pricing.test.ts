import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { modelsToConfig } from "../src/model-config.js"
import type { ModelInfo } from "../src/models.js"
import { modelsToCatalogModelMap } from "../src/opencode2/catalog.js"
import {
  CURSOR_UNPRICED_MODEL_IDS,
  getCursorModelCost,
  toOpenCode2Costs,
  wireModelIdForPricing,
} from "../src/pricing.js"
import { CURSOR_UNPRICED_MODEL_REASONS } from "../src/pricing-data.js"

/**
 * Recorded AvailableModels catalog (this account, 2026-11-19). The provider
 * publishes one OpenCode entry per context tier and, where Cursor publishes a
 * distinct Fast mode, per speed. Effort and thinking variants stay on that
 * entry and share its rate. Tests must not fetch Cursor.
 */
const catalog = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/selectable-catalog.json"), "utf8"),
) as ModelInfo[]

describe("selectable catalog pricing", () => {
  const config = modelsToConfig(catalog)
  const catalog2 = modelsToCatalogModelMap(catalog)
  const unpriced = new Set<string>(CURSOR_UNPRICED_MODEL_IDS)

  it("prices every selectable entry, or lists it as unpriced", () => {
    expect(Object.keys(config).sort()).toEqual(Object.keys(catalog2).sort())
    const uncovered: string[] = []
    for (const id of Object.keys(config)) {
      const cost = getCursorModelCost(id)
      const baseId = wireModelIdForPricing(id).baseId
      if (cost) {
        expect(config[id].cost).toEqual(cost)
        expect(catalog2[id]?.cost).toEqual(toOpenCode2Costs(cost))
        continue
      }
      if (unpriced.has(id) || unpriced.has(baseId)) {
        expect(config[id].cost).toBeUndefined()
        expect(catalog2[id]?.cost ?? []).toEqual([])
        expect(CURSOR_UNPRICED_MODEL_REASONS[baseId as keyof typeof CURSOR_UNPRICED_MODEL_REASONS]).toBeTruthy()
        continue
      }
      uncovered.push(id)
    }
    expect(uncovered).toEqual([])
  })

  it("keeps effort and thinking variants on the entry price, and splits Fast", () => {
    expect(Object.keys(config["gpt-5.4"].variants).length).toBeGreaterThan(1)
    expect(Object.values(config["gpt-5.4"].variants).every((variant) =>
      !(variant as { cursorVariantParameters?: { id: string; value: string }[] }).cursorVariantParameters
        ?.some((parameter) => parameter.id === "fast" && parameter.value === "true"),
    )).toBe(true)
    expect(Object.keys(config["gpt-5.4-fast"].variants).length).toBeGreaterThan(1)
    expect(config["gpt-5.4-1m"].cost).toEqual(getCursorModelCost("gpt-5.4"))
    // This account's GPT-5.4 and GPT-5.5 catalogs offer Fast only at 272k.
    expect(config["gpt-5.4-1m-fast"]).toBeUndefined()
    expect(config["gpt-5.5-1m-fast"]).toBeUndefined()
    // Docs don't state a Fast price for these, so Fast stays on the base rate.
    expect(config["claude-fable-5-2-fast"]).toBeUndefined()
    expect(config["gpt-5.2-fast"]).toBeUndefined()
    expect(config["gpt-5.3-codex-fast"]).toBeUndefined()
    expect(config["gpt-5.6-sol-1m-fast"].cost).toEqual(getCursorModelCost("gpt-5.6-sol-fast"))
    expect(catalog2["gpt-5.6-sol-1m"]?.cost?.[1]?.tier).toEqual({ type: "context", size: 272_000 })
    expect(catalog2["gpt-5.6-sol-1m"]?.cost?.[1]?.input).toBe(8)
    expect(catalog2["gpt-5.6-sol-1m-fast"]?.cost?.[1]?.input).toBe(16)
    expect(catalog2["gpt-5.6-sol-1m-fast"]?.cost?.[1]?.cache).toEqual({ read: 0.8, write: 10 })
    expect(config["claude-haiku-5-5"].cost?.tiers?.[0]?.tier.size).toBe(100_000)
    expect(config["grok-4.7-500k"].cost?.tiers?.[0]?.tier.size).toBe(256_000)
    expect(config["grok-4.7-500k-fast"].cost?.tiers?.[0]?.input).toBe(6)
    expect(config["gpt-5.5-fast"].cost).toBeUndefined()
    expect(config["claude-opus-5-fast"].cost).toBeUndefined()
    expect(config["claude-opus-5-5-1m-fast"].cost).toBeUndefined()
    expect(config["default"].cost).toBeUndefined()
  })
})
