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

  it("prices every selectable entry", () => {
    expect(CURSOR_UNPRICED_MODEL_IDS).toEqual(["default"])
    expect(CURSOR_UNPRICED_MODEL_REASONS).toHaveProperty("default")
    expect(Object.keys(config).sort()).toEqual(Object.keys(catalog2).sort())
    const uncovered: string[] = []
    for (const id of Object.keys(config)) {
      const cost = getCursorModelCost(id)
      if (id === "default") {
        expect(cost).toBeUndefined()
        expect(config[id].cost).toBeUndefined()
        expect(catalog2[id]?.cost).toEqual([])
        continue
      }
      if (!cost) {
        uncovered.push(id)
        continue
      }
      expect(config[id].cost).toEqual(cost)
      expect(catalog2[id]?.cost).toEqual(toOpenCode2Costs(cost))
    }
    expect(uncovered).toEqual([])
  })

  it("publishes probed image input and flat Gemini 4 and Kimi K3 rates on both hosts", () => {
    const models = [
      { id: "gemini-4-carbon", input: 2, output: 10, cacheRead: 0.1, hasLongEntry: true },
      { id: "gemini-4-hydrogen", input: 1.5, output: 7.5, cacheRead: 0.075, hasLongEntry: true },
      { id: "gemini-4-neon", input: 3, output: 15, cacheRead: 0.15, hasLongEntry: true },
      { id: "kimi-k3", input: 3, output: 15, cacheRead: 0.3, hasLongEntry: false },
    ]
    for (const { id, input, output, cacheRead, hasLongEntry } of models) {
      const entries = hasLongEntry ? [id, `${id}-1m`] : [id]
      for (const entry of entries) {
        expect(config[entry]).toMatchObject({
          attachment: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        })
        expect(config[entry].cost).toEqual({ input, output, cache_read: cacheRead })
        expect(catalog2[entry]).toMatchObject({
          modelID: id,
          capabilities: { input: ["text", "image"], output: ["text"] },
          cost: [{ input, output, cache: { read: cacheRead, write: 0 } }],
        })
      }
    }
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
    expect(config["claude-fable-5-2-fast"].cost).toEqual({
      input: 16, output: 80, cache_read: 0.4, cache_write: 20,
    })
    expect(config["claude-fable-5-2-1m-fast"].cost).toEqual(config["claude-fable-5-2-fast"].cost)
    expect(config["gpt-5.2-fast"].cost).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    expect(config["gpt-5.3-codex-fast"].cost).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    const keepsFastOff = (id: string) => Object.values(config[id].variants).every((variant) =>
      !(variant as { cursorVariantParameters?: { id: string; value: string }[] }).cursorVariantParameters
        ?.some((parameter) => parameter.id === "fast" && parameter.value === "true"),
    )
    expect(keepsFastOff("claude-fable-5-2")).toBe(true)
    expect(keepsFastOff("gpt-5.2")).toBe(true)
    expect(keepsFastOff("gpt-5.3-codex")).toBe(true)
    expect(config["gpt-5.6-sol-1m-fast"].cost).toEqual(getCursorModelCost("gpt-5.6-sol-fast"))
    expect(catalog2["gpt-5.6-sol-1m"]?.cost?.[1]?.tier).toEqual({ type: "context", size: 272_000 })
    expect(catalog2["gpt-5.6-sol-1m"]?.cost?.[1]?.input).toBe(8)
    expect(catalog2["gpt-5.6-sol-1m"]?.cost?.[1]?.output).toBe(30)
    expect(catalog2["gpt-5.6-sol-1m"]?.cost?.[1]?.cache).toEqual({ read: 0.8, write: 10 })
    expect(catalog2["gpt-5.6-sol-1m-fast"]?.cost?.[1]?.input).toBe(16)
    expect(catalog2["gpt-5.6-sol-1m-fast"]?.cost?.[1]?.output).toBe(60)
    expect(catalog2["gpt-5.6-sol-1m-fast"]?.cost?.[1]?.cache).toEqual({ read: 1.6, write: 20 })
    expect(config["claude-haiku-5-5"].cost?.tiers?.[0]?.tier.size).toBe(100_000)
    expect(config["grok-4.7-500k"].cost?.tiers?.[0]?.tier.size).toBe(256_000)
    expect(config["grok-4.7-500k-fast"].cost?.tiers?.[0]?.input).toBe(6)
    expect(config["gpt-5.5-fast"].cost).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
    expect(config["claude-opus-5-fast"].cost).toEqual({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    })
    expect(config["claude-opus-5-5-1m-fast"].cost).toEqual({
      input: 8,
      output: 40,
      cache_read: 0.4,
      cache_write: 10,
    })
  })
})
