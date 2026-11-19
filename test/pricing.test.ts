import { describe, expect, it } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { modelsToConfig } from "../src/model-config.js"
import type { ModelInfo } from "../src/models.js"
import {
  applyCursorModelCost,
  checkCursorPricingCoverage,
  costForPrompt,
  getCursorModelCost,
  hasCursorFastPricing,
  isOpenCodeModelCost,
  toOpenCode2Costs,
  validateOpenCodeModelCost,
  wireModelIdForPricing,
} from "../src/pricing.js"
import {
  applyCursorStaffAutoRate,
  buildContextTable,
  buildPricing,
  buildPricingTable,
  catalogIdForPricingDisplayName,
  loadOfflinePricing,
  loadSavedModelPages,
  modelPageSource,
  parseArgs,
  priceFromModelPages,
  type PricingBuild,
} from "../scripts/generate-cursor-pricing.js"
import { takeNetworkAttempts } from "./network-guard.js"
import { getDocumentedCursorModelContext } from "../src/model-metadata.js"
import { modelsToCatalogModelMap } from "../src/opencode2/catalog.js"
import { cursorRunCost } from "../src/billing.js"
import {
  CURSOR_MODEL_CONTEXTS,
  CURSOR_MODEL_COSTS,
  CURSOR_UNPRICED_MODEL_REASONS,
} from "../src/pricing-data.js"

describe("pricing", () => {
  it("keeps inherited object keys unpriced, including synthetic context suffixes", () => {
    for (const key of ["__proto__", "constructor", "toString"]) {
      for (const suffix of ["", "-500k", "-1m"]) {
        const id = key + suffix
        expect(getCursorModelCost(id)).toBeUndefined()
        expect(applyCursorModelCost(id, { name: id })).toEqual({ name: id })
        expect(checkCursorPricingCoverage([id])).toEqual({ priced: [], missing: [id] })
      }
    }
  })

  it("maps third-party Cursor docs rates onto wire model ids", () => {
    expect(getCursorModelCost("claude-sonnet-4-5")).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    })
    expect(getCursorModelCost("gpt-5.4-mini")).toEqual({
      input: 0.75,
      output: 4.5,
      cache_read: 0.075,
    })
  })

  it("prices a real wire id with a context-like suffix before stripping it", () => {
    const costs = CURSOR_MODEL_COSTS as Record<string, unknown>
    costs["grok-4.7-32k"] = { input: 9, output: 9 }
    try {
      expect(getCursorModelCost("grok-4.7-32k")).toEqual({ input: 9, output: 9 })
      expect(getCursorModelCost("grok-4.7-64k")?.input).toBe(2)
    } finally {
      delete costs["grok-4.7-32k"]
    }
  })

  it("attaches documented long-context rates", () => {
    expect(getCursorModelCost("claude-sonnet-4")).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
      context_over_200k: {
        input: 6,
        output: 22.5,
        cache_read: 0.6,
        cache_write: 7.5,
      },
    })
    expect(getCursorModelCost("gpt-5.4")).toEqual({
      input: 2.5,
      output: 15,
      cache_read: 0.25,
      tiers: [{ tier: { type: "context", size: 272_000 }, input: 5, output: 22.5, cache_read: 0.25 }],
    })
    expect(getCursorModelCost("gpt-5.5")).toEqual({
      input: 5,
      output: 30,
      cache_read: 0.5,
      tiers: [{ tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache_read: 1 }],
    })
    expect(getCursorModelCost("gpt-5.6-luna")).toEqual({
      input: 0.2,
      output: 1.2,
      cache_read: 0.02,
      cache_write: 0.25,
      tiers: [{
        tier: { type: "context", size: 272_000 },
        input: 0.4,
        output: 1.8,
        cache_read: 0.04,
        cache_write: 0.5,
      }],
    })
    expect(getCursorModelCost("gpt-5.6-sol")).toEqual({
      input: 4,
      output: 20,
      cache_read: 0.4,
      cache_write: 5,
      tiers: [{
        tier: { type: "context", size: 272_000 },
        input: 8,
        output: 30,
        cache_read: 0.8,
        cache_write: 10,
      }],
    })
    expect(getCursorModelCost("gpt-5.6-terra")).toEqual({
      input: 2,
      output: 12,
      cache_read: 0.2,
      cache_write: 2.5,
      tiers: [{
        tier: { type: "context", size: 272_000 },
        input: 4,
        output: 18,
        cache_read: 0.4,
        cache_write: 5,
      }],
    })
    expect(getCursorModelCost("gpt-5.4-mini")?.tiers).toBeUndefined()
    expect(getCursorModelCost("gpt-5.4-mini")?.context_over_200k).toBeUndefined()
    // A prompt of exactly 272k stays on the standard rate. The next token
    // uses the page's long-context rate (input 2x, output 1.5x, cache unchanged).
    expect(costForPrompt(getCursorModelCost("gpt-5.4")!, 272_000).input).toBe(2.5)
    expect(costForPrompt(getCursorModelCost("gpt-5.4")!, 272_001)).toEqual({
      input: 5,
      output: 22.5,
      cache_read: 0.25,
    })
    expect(costForPrompt(getCursorModelCost("claude-haiku-5-5")!, 100_000).input).toBe(0.1)
    expect(costForPrompt(getCursorModelCost("claude-haiku-5-5")!, 100_001)).toEqual({
      input: 0.5,
      output: 2.5,
      cache_read: 0.05,
      cache_write: 0.625,
    })
  })

  it("maps Gemini 4 Carbon, Hydrogen, and Neon onto served catalog ids", () => {
    const expected = [
      { displayName: "Gemini 4 Carbon", id: "gemini-4-carbon", cost: { input: 2, output: 10, cache_read: 0.1 } },
      { displayName: "Gemini 4 Hydrogen", id: "gemini-4-hydrogen", cost: { input: 1.5, output: 7.5, cache_read: 0.075 } },
      { displayName: "Gemini 4 Neon", id: "gemini-4-neon", cost: { input: 3, output: 15, cache_read: 0.15 } },
    ] as const
    for (const entry of expected) {
      expect(catalogIdForPricingDisplayName(entry.displayName)).toBe(entry.id)
      expect(getCursorModelCost(entry.id)).toEqual(entry.cost)
      expect(getDocumentedCursorModelContext(entry.id)).toEqual({
        maxContext: 200_000,
        maxContextForMaxMode: 1_000_000,
      })
    }
  })

  it("maps Cursor Models pool rates, including Fast variants", () => {
    expect(getCursorModelCost("grok-4.6")).toEqual({
      input: 2,
      output: 6,
      cache_read: 0.5,
    })
    expect(getCursorModelCost("grok-4.6-fast")).toEqual({
      input: 4,
      output: 12,
      cache_read: 1,
    })
    expect(getCursorModelCost("grok-4.5")).toEqual({
      input: 2,
      output: 6,
      cache_read: 0.5,
    })
    expect(getCursorModelCost("grok-4.5-fast")).toEqual({
      input: 4,
      output: 18,
      cache_read: 1,
    })
    expect(getCursorModelCost("grok-4.7")).toEqual({
      input: 2,
      output: 6,
      cache_read: 0.5,
      tiers: [{
        tier: { type: "context", size: 256_000 },
        input: 4,
        output: 12,
        cache_read: 1,
      }],
    })
    expect(getCursorModelCost("grok-4.7-fast")).toEqual({
      input: 4,
      output: 12,
      cache_read: 1,
      tiers: [{
        tier: { type: "context", size: 256_000 },
        input: 6,
        output: 18,
        cache_read: 1.5,
      }],
    })
    expect(getCursorModelCost("composer-2.5")).toEqual({
      input: 0.5,
      output: 2.5,
      cache_read: 0.2,
    })
    expect(getCursorModelCost("composer-2.5-fast")).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.5,
    })
  })

  it("strips synthetic -1m suffixes, including -1m-fast", () => {
    expect(wireModelIdForPricing("claude-sonnet-4-1m")).toEqual({
      baseId: "claude-sonnet-4",
      longContextEntry: true,
    })
    expect(wireModelIdForPricing("composer-2.5-fast")).toEqual({
      baseId: "composer-2.5-fast",
      longContextEntry: false,
    })
    expect(wireModelIdForPricing("composer-2.5-1m-fast")).toEqual({
      baseId: "composer-2.5-fast",
      longContextEntry: true,
    })
    expect(wireModelIdForPricing("composer-2.5-1m-2-fast")).toEqual({
      baseId: "composer-2.5-fast",
      longContextEntry: true,
    })
    expect(getCursorModelCost("claude-sonnet-4-1m")).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
      context_over_200k: {
        input: 6,
        output: 22.5,
        cache_read: 0.6,
        cache_write: 7.5,
      },
    })
    expect(getCursorModelCost("composer-2.5-1m-fast")).toEqual(
      getCursorModelCost("composer-2.5-fast"),
    )
  })

  it("splits Fast catalog pricing only when Cursor publishes a distinct Fast rate", () => {
    expect(hasCursorFastPricing("composer-2.5")).toBe(true)
    expect(hasCursorFastPricing("grok-4.5")).toBe(true)
    expect(hasCursorFastPricing("grok-4.6")).toBe(true)
    expect(hasCursorFastPricing("grok-4.7")).toBe(true)
    expect(hasCursorFastPricing("claude-opus-4-7")).toBe(true)
    expect(hasCursorFastPricing("claude-opus-4-8")).toBe(true)
    expect(hasCursorFastPricing("claude-opus-5")).toBe(true)
    expect(hasCursorFastPricing("claude-opus-5-5")).toBe(true)
    expect(hasCursorFastPricing("gpt-5.4")).toBe(true)
    expect(hasCursorFastPricing("gpt-5.5")).toBe(true)
    expect(hasCursorFastPricing("gpt-5.6-sol")).toBe(true)
    expect(hasCursorFastPricing("claude-sonnet-4-5")).toBe(false)
    expect(hasCursorFastPricing("claude-fable-5-2")).toBe(false)
    expect(getCursorModelCost("claude-opus-4-7-fast")).toEqual({
      input: 30,
      output: 150,
      cache_read: 3,
      cache_write: 37.5,
    })
    expect(getCursorModelCost("claude-opus-4-8-fast")).toEqual({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    })
    expect(getCursorModelCost("gpt-5.4-fast")).toEqual({ input: 5, output: 30, cache_read: 0.5 })
    expect(costForPrompt(getCursorModelCost("gpt-5.6-sol-fast")!, 272_001)).toEqual({
      input: 16,
      output: 60,
      cache_read: 1.6,
      cache_write: 20,
    })
    expect(getCursorModelCost("gpt-5.5-fast")).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
    expect(getCursorModelCost("claude-opus-5-fast")).toEqual({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
    })
    expect(getCursorModelCost("claude-opus-5-5-fast")).toEqual({
      input: 8,
      output: 40,
      cache_read: 0.4,
      cache_write: 10,
    })
  })

  it("maps Cursor Models (Fast) display names onto synthetic catalog ids", () => {
    expect(catalogIdForPricingDisplayName("Composer 2.5")).toBe("composer-2.5")
    expect(catalogIdForPricingDisplayName("Composer 2.5 (Fast)")).toBe("composer-2.5-fast")
    expect(catalogIdForPricingDisplayName("Grok 4.6 (Fast)")).toBe("grok-4.6-fast")
    expect(catalogIdForPricingDisplayName("Grok 4.7")).toBe("grok-4.7")
    expect(catalogIdForPricingDisplayName("Grok 4.7 (Fast)")).toBe("grok-4.7-fast")
    expect(catalogIdForPricingDisplayName("Grok 4.7 500k")).toBe("grok-4.7")
    expect(catalogIdForPricingDisplayName("Grok 4.7 500k (Fast)")).toBe("grok-4.7-fast")
    expect(catalogIdForPricingDisplayName("Unknown (Fast)")).toBeUndefined()
  })

  it("maps GLM 5.3 docs rows and catalogs onto served glm-5p3 ids", () => {
    const expected = [
      {
        displayName: "GLM 5.3",
        id: "glm-5p3",
        staleId: "glm-5.3",
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
        maxContext: 1_000_000,
      },
      {
        displayName: "GLM 5.3 Flash",
        id: "glm-5p3-flash",
        staleId: "glm-5.3-flash",
        cost: { input: 0.15, output: 0.5, cache_read: 0.029 },
        maxContext: 1_000_000,
      },
    ] as const

    const pricingTable = buildPricingTable(`
| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [GLM 5.3](https://z.ai) | Z.ai | $1.4 | - | $0.26 | $4.4 | Yes | Hidden by default; Same per-token rates as GLM 5.2 |
| [GLM 5.3 Flash](https://z.ai) | Z.ai | $0.15 | - | $0.029 | $0.5 | Yes | Hidden by default |
`)
    const contextTable = buildContextTable(`
| Model | Provider | Default context | Max context | Capabilities | Notes |
| --- | --- | --- | --- | --- | --- |
| [GLM 5.3](https://z.ai) | Z.ai | 1M | - | Agent, Thinking | Hidden by default; Same per-token rates as GLM 5.2 |
| [GLM 5.3 Flash](https://z.ai) | Z.ai | 1M | - | Agent, Thinking, Images | Hidden by default |
`)

    const served: ModelInfo[] = expected.map(({ id, displayName }) => ({
      id,
      displayName,
      supportsThinking: true,
      supportsAgent: true,
      variants: [],
    }))
    const config1x = modelsToConfig(served)
    const catalog2x = modelsToCatalogModelMap(served)

    for (const entry of expected) {
      expect(catalogIdForPricingDisplayName(entry.displayName)).toBe(entry.id)
      expect(pricingTable[entry.id]).toEqual(entry.cost)
      expect(contextTable[entry.id]).toEqual({ maxContext: entry.maxContext })
      expect(getCursorModelCost(entry.id)).toEqual(entry.cost)
      expect(getCursorModelCost(entry.staleId)).toBeUndefined()
      expect(getDocumentedCursorModelContext(entry.id)).toEqual({ maxContext: entry.maxContext })
      expect(getDocumentedCursorModelContext(entry.staleId)).toBeUndefined()
      expect(cursorRunCost(entry.id, [])).toEqual(entry.cost)
      expect(config1x[entry.id]).toMatchObject({
        cost: entry.cost,
        limit: { context: entry.maxContext },
      })
      expect(catalog2x[entry.id]).toMatchObject({
        cost: [
          {
            input: entry.cost.input,
            output: entry.cost.output,
            cache: { read: entry.cost.cache_read, write: 0 },
          },
        ],
        limit: { context: entry.maxContext },
      })
    }
  })

  it("reads the long-context surcharge from the Notes column after data residency", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Yes | Long context supports up to 1M tokens with 2x input pricing |
`

    expect(buildPricingTable(markdown, { "GPT-5.4": 272_000 })["gpt-5.4"]).toEqual({
      input: 2.5,
      output: 15,
      cache_read: 0.25,
      tiers: [{ tier: { type: "context", size: 272_000 }, input: 5, output: 15, cache_read: 0.25 }],
    })
    expect(() => buildPricingTable(markdown)).toThrow(/No long-context threshold/)
  })

  it("imports Fast rows from the Cursor Models table without folding them into Other Models", () => {
    const markdown = `
## Cursor Models

| Model | Provider | Input | Cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| Composer 2.5 | Cursor | $0.5 | - | $0.2 | $2.5 |
| Composer 2.5 (Fast) | Cursor | $3 | - | $0.5 | $15 |
| Grok 4.6 | Cursor | $2 | - | $0.5 | $6 |
| Grok 4.6 (Fast) | Cursor | $4 | - | $1 | $12 |

## Plans

| Plan | Price |
| --- | --- |
| Pro | $20 |

## Other Models

### Model pricing

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude 4 Sonnet | Anthropic | $3 | $3.75 | $0.3 | $15 | |
`

    expect(buildPricingTable(markdown)).toEqual({
      "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      "composer-2.5": { input: 0.5, output: 2.5, cache_read: 0.2 },
      "composer-2.5-fast": { input: 3, output: 15, cache_read: 0.5 },
      "grok-4.6": { input: 2, output: 6, cache_read: 0.5 },
      "grok-4.6-fast": { input: 4, output: 12, cache_read: 1 },
    })
  })

  it("prices Fast notes from the docs prose and keeps an explicit Fast row", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Fast mode is 15% faster with 2x pricing |
| GPT-5.4 Mini | OpenAI | $0.75 | - | $0.075 | $4.5 | Fast mode is available at 2x pricing |
| GPT-5.5 | OpenAI | $5 | - | $0.5 | $30 | Fast mode is available at higher rates |
| GPT-5.6 Sol | OpenAI | $4 | $5 | $0.4 | $20 | Fast mode is 2x pricing. Fast mode for long context (>272k) at 2x Fast input pricing |
| Claude Opus 5 | Anthropic | $10 | $12.5 | $1 | $50 | Fast mode (\`claude-opus-5-fast\`) |
| Claude 4.7 Opus | Anthropic | $10 | $12.5 | $1 | $50 | Fast mode is available at 2x pricing |
| Claude Opus 4.7 (fast mode) | Anthropic | $30 | $37.5 | $3 | $150 | |
| Claude Opus 4.8 | Anthropic | $5 | $6.25 | $0.5 | $25 | Fast mode is 3x lower per-token pricing than Opus 4.7 fast mode |
| Composer 2.5 | Cursor | $0.5 | - | $0.2 | $2.5 | Fast mode is available at 2x pricing |
| Composer 2.5 (Fast) | Cursor | $3 | - | $0.5 | $15 | |
`

    expect(buildPricing(markdown)).toEqual({
      costs: {
        "claude-opus-4-7": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        "claude-opus-4-7-fast": { input: 30, output: 150, cache_read: 3, cache_write: 37.5 },
        "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        "claude-opus-4-8-fast": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        "claude-opus-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
        "composer-2.5": { input: 0.5, output: 2.5, cache_read: 0.2 },
        "composer-2.5-fast": { input: 3, output: 15, cache_read: 0.5 },
        "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
        "gpt-5.4-fast": { input: 5, output: 30, cache_read: 0.5 },
        "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
        "gpt-5.4-mini-fast": { input: 1.5, output: 9, cache_read: 0.15 },
        "gpt-5.5": { input: 5, output: 30, cache_read: 0.5 },
        "gpt-5.6-sol": { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
        "gpt-5.6-sol-fast": {
          input: 8,
          output: 40,
          cache_read: 0.8,
          cache_write: 10,
          tiers: [{
            tier: { type: "context", size: 272_000 },
            input: 16,
            output: 40,
            cache_read: 0.8,
            cache_write: 10,
          }],
        },
      },
      unpriced: {
        "claude-opus-5-fast": "Cursor names Fast mode `claude-opus-5-fast` and publishes no Fast rate",
        default: "Cursor publishes no numeric Auto rate",
        "gpt-5.5-fast": "Cursor's pricing note says Fast mode is available at higher rates and publishes no rate",
      },
    })
  })

  it("refuses to price Opus 4.8 Fast without the Opus 4.7 fast-mode row", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 | Anthropic | $5 | $6.25 | $0.5 | $25 | Fast mode is 3x lower per-token pricing than Opus 4.7 fast mode |
`
    expect(() => buildPricing(markdown)).toThrow(
      "Claude Opus 4.7 (fast mode) row is required to price Claude Opus 4.8 Fast",
    )
  })

  it("prices long-context notes at the published threshold and leaves Fast unmentioned", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | $5 | $0.5 | $0.5 | $30 | Above 272k input tokens use 2x input pricing |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Long context supports up to 1M tokens with 2x input pricing |
| Claude Haiku 5.5 | Anthropic | $0.1 | $0.125 | $0.01 | $0.5 | Requests above 100k input tokens bill at 5x the standard rates ($0.50/M input, $0.625/M cache write, $0.05/M cache read, $2.50/M output) |
`
    expect(buildPricing(markdown, { "GPT-5.4": 272_000 })).toEqual({
      costs: {
        "claude-haiku-5-5": {
          input: 0.1,
          output: 0.5,
          cache_read: 0.01,
          cache_write: 0.125,
          tiers: [{
            tier: { type: "context", size: 100_000 },
            input: 0.5,
            output: 2.5,
            cache_read: 0.05,
            cache_write: 0.625,
          }],
        },
        "gpt-5.4": {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          tiers: [{ tier: { type: "context", size: 272_000 }, input: 5, output: 15, cache_read: 0.25 }],
        },
        "gpt-5.5": {
          input: 5,
          output: 30,
          cache_read: 0.5,
          cache_write: 0.5,
          tiers: [{
            tier: { type: "context", size: 272_000 },
            input: 10,
            output: 30,
            cache_read: 0.5,
            cache_write: 0.5,
          }],
        },
      },
      unpriced: {
        default: "Cursor publishes no numeric Auto rate",
      },
    })
    expect(() => buildPricing(markdown)).toThrow(/No long-context threshold for "GPT-5.4"/)
  })

  it("prices Auto at the Cursor staff forum rate", () => {
    const auto = { input: 1.25, output: 6, cache_read: 0.25 }
    expect(getCursorModelCost("default")).toEqual(auto)
    expect(applyCursorModelCost("default", { name: "Auto" })).toEqual({ name: "Auto", cost: auto })
    const pricing: PricingBuild = { costs: {}, unpriced: { default: "docs publish no rate" } }
    applyCursorStaffAutoRate(pricing)
    expect(pricing.unpriced.default).toBeUndefined()
    expect(pricing.costs.default).toEqual(auto)
    const published: PricingBuild = {
      costs: { default: { input: 9, output: 9 } },
      unpriced: {},
    }
    applyCursorStaffAutoRate(published)
    expect(published.costs.default).toEqual({ input: 9, output: 9 })
  })

  it("preserves entry fields while adding cost", () => {
    expect(
      applyCursorModelCost("gemini-3-flash", {
        name: "Gemini 3 Flash",
        tool_call: true,
      }),
    ).toEqual({
      name: "Gemini 3 Flash",
      tool_call: true,
      cost: {
        input: 0.5,
        output: 3,
        cache_read: 0.05,
      },
    })
  })

  it("converts classic cost into OpenCode 2.0 cost tiers", () => {
    expect(toOpenCode2Costs(getCursorModelCost("gpt-5.4"))).toEqual([
      { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
      {
        tier: { type: "context", size: 272_000 },
        input: 5,
        output: 22.5,
        cache: { read: 0.25, write: 0 },
      },
    ])
    expect(toOpenCode2Costs(getCursorModelCost("claude-sonnet-4"))).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
      {
        tier: { type: "context", size: 200_000 },
        input: 6,
        output: 22.5,
        cache: { read: 0.6, write: 7.5 },
      },
    ])
    expect(toOpenCode2Costs(undefined)).toEqual([])
  })

  it("reports coverage for the fixture model list", () => {
    const fixturePath = join(import.meta.dir, "fixtures/cursor-pricing-models.txt")
    const modelIds = readFileSync(fixturePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))

    expect(checkCursorPricingCoverage(modelIds)).toEqual({
      priced: modelIds,
      missing: [],
    })
  })

  it("validates OpenCode cost shapes", () => {
    expect(isOpenCodeModelCost(getCursorModelCost("gpt-5.5"))).toBe(true)
    expect(
      validateOpenCodeModelCost({
        input: 1,
        output: -1,
        context_over_200k: { input: 2 },
        tiers: "no",
      }),
    ).toEqual({
      valid: false,
      errors: [
        "cost.output must be a non-negative finite number",
        "cost.context_over_200k.output must be a non-negative finite number",
        "cost.tiers must be an array",
      ],
    })
    expect(
      validateOpenCodeModelCost({
        input: 1,
        output: 1,
        tiers: [
          null,
          { input: 1, output: 1, tier: { type: "tokens", size: 0 } },
        ],
      }),
    ).toEqual({
      valid: false,
      errors: [
        "cost.tiers[0] must be an object",
        "cost.tiers[1].tier must be { type: \"context\", size: positive integer }",
      ],
    })
  })

  it("wires cost into modelsToConfig for classic OpenCode", () => {
    const models: ModelInfo[] = [
      {
        id: "claude-sonnet-4",
        displayName: "Sonnet 4",
        supportsAgent: true,
        maxContext: 200_000,
        maxContextForMaxMode: 1_000_000,
        variants: [
          {
            key: "base",
            displayName: "Sonnet 4",
            parameterValues: [{ id: "context", value: "200k" }],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
          {
            key: "max",
            displayName: "Sonnet 4 1M",
            parameterValues: [{ id: "context", value: "1m" }],
            isDefaultNonMax: false,
            isDefaultMax: true,
          },
        ],
      },
    ]
    const config = modelsToConfig(models)
    expect(config["claude-sonnet-4"].cost).toEqual(getCursorModelCost("claude-sonnet-4"))
    expect(config["claude-sonnet-4-1m"].cost).toEqual(getCursorModelCost("claude-sonnet-4-1m"))
  })

  it("prices model-page tables ahead of main-table notes", () => {
    const page = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | $5 | - | $0.5 | $30 | Fast mode is available at higher rates; Long context supports up to 1M tokens with 2x input pricing |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Fast mode is 15% faster with 2x pricing; Long context supports up to 1M tokens with 2x input pricing |
| GPT-5.6 Sol | OpenAI | $4 | $5 | $0.4 | $20 | Fast mode is 2x pricing. Fast mode for long context (>272k) at 2x Fast input pricing |
| Grok 4.7 | Cursor | $2 | - | $0.5 | $6 | Fast mode is available at 2x pricing |
`
    const contexts = { "GPT-5.4": 272_000, "GPT-5.5": 272_000, "GPT-5.6 Sol": 272_000, "Grok 4.7": 256_000 }
    const pricing = buildPricing(markdown, contexts, {
      skipNoteModels: new Set(["gpt-5.5", "gpt-5.4", "gpt-5.6-sol", "grok-4.7"]),
    })
    const derived = priceFromModelPages(pricing, [
      { modelId: "gpt-5.5", html: page("model-page-gpt-5-5.html") },
      { modelId: "gpt-5.4", html: page("model-page-gpt-5-4.html") },
      { modelId: "gpt-5.6-sol", html: page("model-page-gpt-5-6-sol.html") },
      { modelId: "grok-4.7", html: page("model-page-grok-4-7.html") },
    ], contexts)
    expect(pricing.costs["gpt-5.5"]).toEqual({
      input: 5,
      output: 30,
      cache_read: 0.5,
      tiers: [{ tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache_read: 1 }],
    })
    expect(pricing.costs["gpt-5.5-fast"]).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
    expect(pricing.unpriced["gpt-5.5-fast"]).toBeUndefined()
    expect(pricing.costs["gpt-5.4-fast"]).toEqual({ input: 5, output: 30, cache_read: 0.5 })
    expect(pricing.costs["gpt-5.4"]?.tiers?.[0]).toEqual({
      tier: { type: "context", size: 272_000 },
      input: 5,
      output: 22.5,
      cache_read: 0.25,
    })
    expect(pricing.costs["gpt-5.6-sol-fast"]?.tiers?.[0]).toEqual({
      tier: { type: "context", size: 272_000 },
      input: 16,
      output: 60,
      cache_read: 1.6,
      cache_write: 20,
    })
    expect(pricing.costs["grok-4.7-fast"]?.tiers?.[0]?.tier.size).toBe(256_000)
    expect(pricing.costs["grok-4.7-fast"]?.tiers?.[0]?.input).toBe(6)
    expect(derived.map((price) => price.id).sort()).toEqual(["gpt-5.4", "gpt-5.4-fast"])
  })

  it("derives a missing Fast long-context row from the page's own ratios", () => {
    const html = readFileSync(join(import.meta.dir, "fixtures", "model-page-fast-long-derived.html"), "utf8")
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.6 Sol | OpenAI | $4 | $5 | $0.4 | $20 | |
`
    const pricing = buildPricing(markdown, { "GPT-5.6 Sol": 272_000 }, {
      skipNoteModels: new Set(["gpt-5.6-sol"]),
    })
    const derived = priceFromModelPages(pricing, [{ modelId: "gpt-5.6-sol", html }], {
      "GPT-5.6 Sol": 272_000,
    })
    expect(pricing.costs["gpt-5.6-sol-fast"]?.tiers?.[0]).toEqual({
      tier: { type: "context", size: 272_000 },
      input: 16,
      output: 60,
      cache_read: 1.6,
      cache_write: 20,
    })
    expect(derived).toEqual([{
      id: "gpt-5.6-sol-fast",
      cost: { input: 16, output: 60, cache_read: 1.6, cache_write: 20 },
      formula: expect.stringContaining("no combined Fast long-context row"),
    }])
  })

  it("ignores a Fast sentence that only appears inside a script", () => {
    const html = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>GPT-5.4</td><td>$2.5</td><td>-</td><td>$0.25</td><td>$15</td></tr>
</table>
<script>Fast is at 2x the standard price. Above 272k, input pricing doubles and output pricing is 1.5x the standard rate.</script >
<p>Standard rates only.</p>
`
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | |
`
    const pricing = buildPricing(markdown, { "GPT-5.4": 272_000 }, {
      skipNoteModels: new Set(["gpt-5.4"]),
    })
    const derived = priceFromModelPages(pricing, [{ modelId: "gpt-5.4", html }], {
      "GPT-5.4": 272_000,
    })
    expect(derived).toEqual([])
    expect(pricing.costs["gpt-5.4-fast"]).toBeUndefined()
    expect(pricing.costs["gpt-5.4"]?.tiers).toBeUndefined()
  })

  it("prices saved model pages without fetching, and keeps local markdown offline", () => {
    expect(modelPageSource(parseArgs([
      "--from-file", "pricing.md",
      "--context-from-file", "docs.md",
    ]))).toBe("refused")
    expect(modelPageSource(parseArgs(["--check"]))).toBe("live")
    const dir = mkdtempSync(join(tmpdir(), "pricing-pages-"))
    try {
      expect(modelPageSource(parseArgs([
        "--from-file", "pricing.md",
        "--context-from-file", "docs.md",
        "--pages-from-dir", dir,
      ]))).toBe("directory")
      writeFileSync(join(dir, "notes.txt"), "not a page")
      expect(() => loadSavedModelPages(dir)).toThrow(/No model pages/)
      writeFileSync(join(dir, "not-a-model.html"), "<table></table>")
      expect(() => loadSavedModelPages(dir)).toThrow(/Unknown model page/)
      rmSync(join(dir, "not-a-model.html"))
      writeFileSync(
        join(dir, "gpt-5.5.html"),
        readFileSync(join(import.meta.dir, "fixtures", "model-page-gpt-5-5.html"), "utf8"),
      )
      expect(() => loadSavedModelPages(dir, ["gpt-5.5", "gpt-5.4"])).toThrow(/Refusing to fetch/)
      expect(() => loadSavedModelPages(dir, ["gpt-5.5", "gpt-5.4"])).toThrow(/gpt-5\.4\.html/)
      const pages = loadSavedModelPages(dir, ["gpt-5.5"])
      expect(pages.map((page) => page.modelId)).toEqual(["gpt-5.5"])
      const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | $5 | - | $0.5 | $30 | Long context supports up to 1M tokens with 2x input pricing |
`
      const pricing = buildPricing(markdown, { "GPT-5.5": 272_000 }, {
        skipNoteModels: new Set(pages.map((page) => page.modelId)),
      })
      priceFromModelPages(pricing, pages, { "GPT-5.5": 272_000 })
      expect(pricing.costs["gpt-5.5-fast"]).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
      expect(pricing.costs["gpt-5.5"]?.tiers?.[0]?.output).toBe(45)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reproduces committed prices from saved files and does not fetch", () => {
    const root = join(import.meta.dir, "fixtures", "pricing-offline")
    const priced = loadOfflinePricing({
      pricingFile: join(root, "pricing.md"),
      contextFile: join(root, "context.md"),
      pagesDir: join(root, "pages"),
    })
    expect(takeNetworkAttempts()).toEqual([])
    expect(priced.costs).toEqual(CURSOR_MODEL_COSTS as unknown as typeof priced.costs)
    expect(priced.unpriced).toEqual(CURSOR_UNPRICED_MODEL_REASONS)
    expect(priced.contexts).toEqual(CURSOR_MODEL_CONTEXTS as unknown as typeof priced.contexts)
    const incomplete = mkdtempSync(join(tmpdir(), "pricing-pages-"))
    try {
      cpSync(join(root, "pages"), incomplete, { recursive: true })
      rmSync(join(incomplete, "gpt-5.5.html"))
      expect(() => loadOfflinePricing({
        pricingFile: join(root, "pricing.md"),
        contextFile: join(root, "context.md"),
        pagesDir: incomplete,
      })).toThrow(/Refusing to fetch[\s\S]*gpt-5\.5\.html/)
      expect(takeNetworkAttempts()).toEqual([])
    } finally {
      rmSync(incomplete, { recursive: true, force: true })
    }
  })
})
