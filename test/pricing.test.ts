import { describe, expect, it } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  assertSelectablePriced,
  buildContextTable,
  buildPricing,
  buildPricingTable,
  catalogIdForPricingDisplayName,
  assemblePricing,
  loadOfflinePricing,
  loadSavedModelPages,
  loadSelectableCatalog,
  modelPageSource,
  pageIdsForSelectableGaps,
  parseArgs,
  parseOpenAiFastPrices,
  priceFromModelPages,
  priceFromProviderPages,
  PROVIDER_PRICING_URL,
  type PricingBuild,
  type SelectableCatalogModel,
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
    expect(hasCursorFastPricing("claude-fable-5-2")).toBe(true)
    expect(hasCursorFastPricing("gpt-5.2")).toBe(true)
    expect(hasCursorFastPricing("gpt-5.3-codex")).toBe(true)
    expect(getCursorModelCost("claude-fable-5-2-fast")).toEqual({
      input: 16, output: 80, cache_read: 0.4, cache_write: 20,
    })
    expect(getCursorModelCost("gpt-5.2-fast")).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    expect(getCursorModelCost("gpt-5.3-codex-fast")).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
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

  it("does not infer a long-context price from a markdown note", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Yes | Long context supports up to 1M tokens with 2x input pricing |
`

    expect(buildPricingTable(markdown, { "GPT-5.4": 272_000 })["gpt-5.4"]).toEqual({
      input: 2.5,
      output: 15,
      cache_read: 0.25,
    })
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

  it("prices explicit Fast rows and ignores Fast notes", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Fast mode is 15% faster with 2x pricing |
| GPT-5.5 | OpenAI | $5 | - | $0.5 | $30 | Fast mode is available at higher rates |
| Claude Opus 5 | Anthropic | $10 | $12.5 | $1 | $50 | Fast mode (\`claude-opus-5-fast\`) |
| Claude 4.7 Opus | Anthropic | $10 | $12.5 | $1 | $50 | Fast mode is available at 2x pricing |
| Claude Opus 4.7 (fast mode) | Anthropic | $30 | $37.5 | $3 | $150 | |
| Claude Opus 4.8 | Anthropic | $5 | $6.25 | $0.5 | $25 | Fast mode is 3x lower per-token pricing than Opus 4.7 fast mode |
| Composer 2.5 | Cursor | $0.5 | - | $0.2 | $2.5 | Fast mode is available at 2x pricing |
| Composer 2.5 (Fast) | Cursor | $3 | - | $0.5 | $15 | |
`
    const pricing = buildPricing(markdown)
    expect(pricing.costs["composer-2.5-fast"]).toEqual({ input: 3, output: 15, cache_read: 0.5 })
    expect(pricing.costs["claude-opus-4-7-fast"]).toEqual({
      input: 30,
      output: 150,
      cache_read: 3,
      cache_write: 37.5,
    })
    expect(pricing.costs["gpt-5.4-fast"]).toBeUndefined()
    expect(pricing.costs["claude-opus-4-8-fast"]).toBeUndefined()
    expect(pricing.costs["claude-opus-5-fast"]).toBeUndefined()
    expect(pricing.unpriced).toEqual({})
  })

  it("does not derive Opus 4.8 Fast from the Opus 4.7 note", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 | Anthropic | $5 | $6.25 | $0.5 | $25 | Fast mode is 3x lower per-token pricing than Opus 4.7 fast mode |
`
    const pricing = buildPricing(markdown)
    expect(pricing.costs["claude-opus-4-8"]).toEqual({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
    })
    expect(pricing.costs["claude-opus-4-8-fast"]).toBeUndefined()
  })

  it("does not price a long-context tier from a markdown note", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | $5 | $0.5 | $0.5 | $30 | Above 272k input tokens use 2x input pricing |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Long context supports up to 1M tokens with 2x input pricing |
| Claude Haiku 5.5 | Anthropic | $0.1 | $0.125 | $0.01 | $0.5 | Requests above 100k input tokens bill at 5x the standard rates ($0.50/M input, $0.625/M cache write, $0.05/M cache read, $2.50/M output) |
`
    const pricing = buildPricing(markdown, { "GPT-5.4": 272_000 })
    expect(pricing.costs["gpt-5.4"]?.tiers).toBeUndefined()
    expect(pricing.costs["gpt-5.5"]?.tiers).toBeUndefined()
    expect(pricing.costs["claude-haiku-5-5"]?.tiers).toBeUndefined()
    expect(pricing.unpriced).toEqual({})
  })

  it("keeps Auto at the manual staff rate", () => {
    const auto = { input: 1.25, output: 6, cache_read: 0.25 }
    expect(getCursorModelCost("default")).toEqual(auto)
    expect(applyCursorModelCost("default", { name: "Auto" })).toEqual({ name: "Auto", cost: auto })
    const pricing: PricingBuild = {
      costs: { default: { input: 9, output: 9 } },
      unpriced: { default: "docs publish no rate" },
      markdownDefault: { input: 9, output: 9 },
      disagreements: [],
      longCoveredByBase: new Set(),
    }
    applyCursorStaffAutoRate(pricing)
    expect(pricing.costs.default).toEqual(auto)
    expect(pricing.unpriced.default).toBeUndefined()
    expect(pricing.disagreements).toEqual([{
      id: "default",
      part: "base",
      kept: auto,
      other: { input: 9, output: 9 },
      keptSource: "manual",
      otherSource: "markdown",
    }])
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
    const pricing = buildPricing(markdown, contexts)
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
    const pricing = buildPricing(markdown, { "GPT-5.6 Sol": 272_000 })
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
<script>Fast is at 2x the standard price. Above 272k, input pricing doubles and output pricing is 1.5x the standard rate. All GPT-5.4 prompts bill at the base per-token rates in the table above, including when context goes above 200k. There is no separate long-context multiplier.</script >
<p>Standard rates only.</p>
`
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | Fast mode is 15% faster with 2x pricing |
`
    const pricing = buildPricing(markdown, { "GPT-5.4": 272_000 })
    const derived = priceFromModelPages(pricing, [{ modelId: "gpt-5.4", html }], {
      "GPT-5.4": 272_000,
    })
    expect(derived).toEqual([])
    expect(pricing.costs["gpt-5.4-fast"]).toBeUndefined()
    expect(pricing.costs["gpt-5.4"]?.tiers).toBeUndefined()
  })

  it("copies a stated same-rate long-context rule and a Fast row on that page", () => {
    const html = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>Claude Opus 4.8</td><td>$5</td><td>$6.25</td><td>$0.5</td><td>$25</td></tr>
<tr><td>Claude Opus 4.8 (Fast Mode)</td><td>$10</td><td>$12.5</td><td>$1</td><td>$50</td></tr>
</table>
<p>It is 3x lower than the standard price of some other mode.</p>
<p>All Opus 4.8 prompts bill at the base per-token rates in the table above, including when context goes above 300k. There is no separate long-context multiplier for Opus 4.8. Context windows up to 1M tokens use the same rates.</p>
`
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 | Anthropic | $5 | $6.25 | $0.5 | $25 | Up to 1M tokens in a note is not a price |
| Claude 4.7 Opus | Anthropic | $5 | $6.25 | $0.5 | $25 | |
| Claude Opus 4.7 (fast mode) | Anthropic | $30 | $37.5 | $3 | $150 | Up to 1M tokens with extended context at the same per-token rates |
`
    const pricing = buildPricing(markdown)
    const opus47 = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>Claude 4.7 Opus</td><td>$5</td><td>$6.25</td><td>$0.5</td><td>$25</td></tr>
</table>
<p>All Opus 4.7 prompts bill at the base per-token rates in the table above, including when context goes above 300k. There is no separate long-context multiplier for Opus 4.7. Context windows up to 1M tokens use the same rates.</p>
<p>Context window 300k. Max context 1M.</p>
`
    const derived = priceFromModelPages(pricing, [
      { modelId: "claude-opus-4-8", html },
      { modelId: "claude-opus-4-7", html: opus47 },
    ])
    const standard = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }
    const fast = { input: 10, output: 50, cache_read: 1, cache_write: 12.5 }
    expect(pricing.costs["claude-opus-4-8"]).toEqual(standard)
    expect(pricing.costs["claude-opus-4-8-fast"]).toEqual(fast)
    expect(pricing.costs["claude-opus-4-7"]).toEqual(standard)
    expect(pricing.longCoveredByBase.has("claude-opus-4-8")).toBe(true)
    expect(pricing.longCoveredByBase.has("claude-opus-4-7")).toBe(true)
    // The page never mentions Fast, so the markdown Fast row stays flat.
    expect(pricing.costs["claude-opus-4-7-fast"]).toEqual({
      input: 30, output: 150, cache_read: 3, cache_write: 37.5,
    })
    expect(derived.find((price) => price.id === "claude-opus-4-8")?.formula).toContain(
      "All Opus 4.8 prompts bill at the base per-token rates in the table above, including when context goes above 300k.",
    )
    expect(derived.find((price) => price.id === "claude-opus-4-8")?.formula).toContain(
      "Context windows up to 1M tokens use the same rates.",
    )
    expect(derived.some((price) => price.id === "claude-opus-4-7-fast")).toBe(false)
  })

  it("reads the 200k and Max Mode same-rate wordings, and a stated Fast multiplier", () => {
    const sonnet = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>Claude 4.6 Sonnet</td><td>$3</td><td>$3.75</td><td>$0.3</td><td>$15</td></tr>
</table>
<p>All Sonnet 4.6 prompts bill at the base per-token rates in the table above, including when context goes above 200k. Anthropic no longer applies a separate long-context multiplier for Sonnet 4.6.</p>
`
    const muse = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>Muse Spark 1.3</td><td>$1.25</td><td>-</td><td>$0.15</td><td>$4.25</td></tr>
</table>
<p>Prompts bill at the base per-token rates above, including in Max Mode above 300k tokens. Cached input is billed at $0.15 per million tokens; there is no long-context multiplier and no cache-write charge.</p>
<p>300k token context window, or 1M in Max Mode at the same per-token rates.</p>
`
    const scaled = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>Grok 4.5</td><td>$1</td><td>$0.2</td><td>$0.1</td><td>$2</td></tr>
</table>
<p>Fast mode is 3x the standard rates.</p>
`
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude 4.6 Sonnet | Anthropic | $3 | $3.75 | $0.3 | $15 | |
| Muse Spark 1.3 | Meta | $1.25 | - | $0.15 | $4.25 | |
| Grok 4.5 | Cursor | $1 | $0.2 | $0.1 | $2 | |
`
    const pricing = buildPricing(markdown)
    const derived = priceFromModelPages(pricing, [
      { modelId: "claude-sonnet-4-6", html: sonnet },
      { modelId: "muse-spark-1.3", html: muse },
      { modelId: "grok-4.5", html: scaled },
    ])
    expect(pricing.costs["claude-sonnet-4-6"]).toEqual({
      input: 3, output: 15, cache_read: 0.3, cache_write: 3.75,
    })
    expect(pricing.costs["muse-spark-1.3"]).toEqual({
      input: 1.25, output: 4.25, cache_read: 0.15,
    })
    expect(pricing.longCoveredByBase.has("claude-sonnet-4-6")).toBe(true)
    expect(pricing.longCoveredByBase.has("muse-spark-1.3")).toBe(true)
    expect(pricing.costs["grok-4.5-fast"]).toEqual({ input: 3, output: 6, cache_read: 0.3, cache_write: 0.6 })
    expect(derived.find((price) => price.id === "claude-sonnet-4-6")?.formula).toContain(
      "Anthropic no longer applies a separate long-context multiplier for Sonnet 4.6.",
    )
    expect(derived.find((price) => price.id === "grok-4.5-fast")?.formula).toContain("multiplied by 3")
  })

  it("does not invent a price from a context spec, an effort variant, or a future rate", () => {
    const html = (name: string, money: string, prose: string) => `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>${name}</td><td>${money}</td></tr>
</table>
<p>${prose}</p>
`
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.2 | OpenAI | $1.75 | - | $0.175 | $14 | |
| Claude Fable 5.2 | Anthropic | $8 | $10 | $0.2 | $40 | |
| Gemini 4 Carbon | Google | $2 | - | $0.1 | $10 | |
`
    const pricing = buildPricing(markdown)
    priceFromModelPages(pricing, [
      {
        modelId: "gpt-5.2",
        html: html(
          "GPT-5.2",
          "$1.75</td><td>-</td><td>$0.175</td><td>$14",
          "A high reasoning effort variant (gpt-5.2-high) is available for tasks that need deeper analysis. Context window 272k. Max context -.",
        ),
      },
      {
        modelId: "claude-fable-5-2",
        html: html(
          "Claude Fable 5.2",
          "$8</td><td>$10</td><td>$0.2</td><td>$40",
          "Input and output rates are about 2x Claude Opus 5.5. Context window 300k. Max context 1M.",
        ),
      },
      {
        modelId: "gemini-4-carbon",
        html: html(
          "Gemini 4 Carbon",
          "$2</td><td>-</td><td>$0.1</td><td>$10",
          "From December 1, 2026, Gemini 4 Carbon is billed at $4 input, $0.20 cache read, and $20 output per million tokens. Speed Fast. Context window 200k. Max context 1M.",
        ),
      },
    ])
    expect(pricing.costs["gpt-5.2-fast"]).toBeUndefined()
    expect(pricing.costs["gpt-5.2"]).toEqual({ input: 1.75, output: 14, cache_read: 0.175 })
    expect(pricing.longCoveredByBase.has("gpt-5.2")).toBe(false)
    expect(pricing.costs["claude-fable-5-2-fast"]).toBeUndefined()
    expect(pricing.costs["claude-fable-5-2"]).toEqual({
      input: 8, output: 40, cache_read: 0.2, cache_write: 10,
    })
    expect(pricing.longCoveredByBase.has("claude-fable-5-2")).toBe(true)
    expect(pricing.costs["gemini-4-carbon"]).toEqual({ input: 2, output: 10, cache_read: 0.1 })
    expect(pricing.costs["gemini-4-carbon-fast"]).toBeUndefined()
    expect(pricing.longCoveredByBase.has("gemini-4-carbon")).toBe(true)
    const haiku = buildPricing(`
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Haiku 5.5 | Anthropic | $0.1 | $0.125 | $0.01 | $0.5 | |
`)
    priceFromModelPages(haiku, [{
      modelId: "claude-haiku-5-5",
      html: html(
        "Claude Haiku 5.5",
        "$0.1</td><td>$0.125</td><td>$0.01</td><td>$0.5",
        "Requests above 100k input tokens bill at 5x the standard rates.",
      ),
    }])
    expect(haiku.costs["claude-haiku-5-5-fast"]).toBeUndefined()
    expect(haiku.costs["claude-haiku-5-5"]).toEqual({
      input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125,
    })
    expect(() => priceFromModelPages(buildPricing(markdown), [{
      modelId: "gpt-5.2",
      html: html(
        "GPT-5.2",
        "$1.75</td><td>-</td><td>$0.175</td><td>$14",
        "Fast is 2x the standard price. Fast is 3x the standard rates.",
      ),
    }])).toThrow(/Conflicting Fast multipliers/)
    expect(() => priceFromModelPages(buildPricing(`
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | |
`), [{
      modelId: "gpt-5.4",
      html: html(
        "GPT-5.4",
        "$2.5</td><td>-</td><td>$0.25</td><td>$15",
        "When input exceeds 272k tokens (long context), input pricing doubles and output pricing is 1.5x the standard rate. All GPT-5.4 prompts bill at the base per-token rates in the table above, including when context goes above 200k. There is no separate long-context multiplier.",
      ),
    }])).toThrow(/both a long-context multiplier and a same-rate rule/)
  })

  it("keeps a markdown row when the page disagrees and fills only the missing Fast price", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | $5 | - | $0.5 | $30 | Fast mode is available at higher rates |
| Composer 2.5 | Cursor | $0.5 | - | $0.2 | $2.5 | |
| Composer 2.5 (Fast) | Cursor | $3 | - | $0.5 | $15 | |
`
    const context = `
| Model | Provider | Default context | Max context | Capabilities | Notes |
| --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | 272k | 1M | Agent | |
| Composer 2.5 | Cursor | 200k | - | Agent | |
`
    const catalog: SelectableCatalogModel[] = [
      {
        id: "gpt-5.5",
        maxContext: 272_000,
        variants: [{ parameterValues: [{ id: "fast", value: "true" }, { id: "context", value: "1m" }], isMaxMode: true }],
      },
      {
        id: "composer-2.5",
        maxContext: 200_000,
        variants: [{ parameterValues: [{ id: "fast", value: "true" }] }],
      },
    ]
    expect(pageIdsForSelectableGaps(markdown, context, catalog)).toEqual(["gpt-5.5"])
    const pricing = buildPricing(markdown, { "GPT-5.5": 272_000, "Composer 2.5": 200_000 })
    const html = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>GPT-5.5</td><td>$9</td><td>-</td><td>$0.9</td><td>$40</td></tr>
<tr><td>GPT-5.5 Fast</td><td>$12.5</td><td>-</td><td>$1.25</td><td>$75</td></tr>
</table>
`
    priceFromModelPages(pricing, [{ modelId: "gpt-5.5", html }], { "GPT-5.5": 272_000 })
    expect(pricing.costs["gpt-5.5"]).toEqual({ input: 5, output: 30, cache_read: 0.5 })
    expect(pricing.costs["gpt-5.5-fast"]).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
    expect(pricing.costs["composer-2.5-fast"]).toEqual({ input: 3, output: 15, cache_read: 0.5 })
    expect(pricing.disagreements).toEqual([{
      id: "gpt-5.5",
      part: "base",
      kept: { input: 5, output: 30, cache_read: 0.5 },
      other: { input: 9, output: 40, cache_read: 0.9 },
      keptSource: "markdown",
      otherSource: "page",
    }])
  })

  it("prices saved model pages without fetching, and keeps local markdown offline", () => {
    expect(modelPageSource(parseArgs([
      "--from-file", "pricing.md",
      "--context-from-file", "docs.md",
    ]))).toBe("offline")
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
      const pricing = buildPricing(markdown, { "GPT-5.5": 272_000 })
      priceFromModelPages(pricing, pages, { "GPT-5.5": 272_000 })
      expect(pricing.costs["gpt-5.5"].input).toBe(5)
      expect(pricing.costs["gpt-5.5-fast"]).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
      expect(pricing.costs["gpt-5.5"]?.tiers?.[0]?.output).toBe(45)
      expect(takeNetworkAttempts()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails generation when a selectable model has no price and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pricing-out-"))
    const dest = join(dir, "pricing-data.ts")
    const catalog: SelectableCatalogModel[] = [{ id: "gpt-5.5", variants: [] }]
    const pricing = buildPricing(`
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | |
`)
    try {
      expect(() => {
        assertSelectablePriced(catalog, pricing.costs)
        writeFileSync(dest, "should not be written")
      }).toThrow(/Unpriced selectable model: gpt-5\.5/)
      expect(existsSync(dest)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reproduces committed prices from saved files and does not fetch", () => {
    // pages/ holds only the selectable gaps. A markdown row needs no file.
    const root = join(import.meta.dir, "fixtures", "pricing-offline")
    const pricingMarkdown = readFileSync(join(root, "pricing.md"), "utf8")
    const contextMarkdown = readFileSync(join(root, "context.md"), "utf8")
    const pageIds = pageIdsForSelectableGaps(pricingMarkdown, contextMarkdown, loadSelectableCatalog())
    const pages = loadSavedModelPages(join(root, "pages"), pageIds)
    const providerPages = [
      { provider: "anthropic" as const, html: readFileSync(join(root, "providers", "anthropic.html"), "utf8") },
      { provider: "openai" as const, html: readFileSync(join(root, "providers", "openai.html"), "utf8") },
    ]
    const priced = assemblePricing(
      pricingMarkdown,
      contextMarkdown,
      pages,
      loadSelectableCatalog(),
      providerPages,
    )
    expect(takeNetworkAttempts()).toEqual([])
    expect(priced.unpriced).toEqual(CURSOR_UNPRICED_MODEL_REASONS)
    expect(priced.contexts).toEqual(CURSOR_MODEL_CONTEXTS as unknown as typeof priced.contexts)
    expect(priced.pageIds).not.toContain("grok-4.7")
    expect(priced.pageIds).toContain("gpt-5.5")
    expect(Object.keys(priced.costs).sort()).toEqual(
      Object.keys(CURSOR_MODEL_COSTS).sort(),
    )
    const flatOf = (cost: {
      input: number
      output: number
      cache_read?: number
      cache_write?: number
    }) => {
      const flat: {
        input: number
        output: number
        cache_read?: number
        cache_write?: number
      } = { input: cost.input, output: cost.output }
      if (cost.cache_read !== undefined) flat.cache_read = cost.cache_read
      if (cost.cache_write !== undefined) flat.cache_write = cost.cache_write
      return flat
    }
    for (const [id, committed] of Object.entries(CURSOR_MODEL_COSTS)) {
      expect(priced.costs[id]).toEqual(committed as typeof priced.costs[string])
    }
    expect(flatOf(priced.costs["claude-opus-4-6"]!)).toEqual(flatOf(CURSOR_MODEL_COSTS["claude-opus-4-6"]))
    const formula = (id: string) => priced.derived.find((price) => price.id === id)?.formula ?? ""
    expect(formula("claude-opus-4-6")).toContain(
      "Anthropic no longer applies a separate long-context multiplier for Opus 4.6.",
    )
    expect(formula("claude-opus-4-7")).toContain("Context windows up to 1M tokens use the same rates.")
    expect(formula("claude-opus-4-7-fast")).toBe("")
    expect(formula("muse-spark-1.3")).toContain("no long-context multiplier and no cache-write charge.")
    expect(formula("claude-opus-4-8-fast")).toContain("The Fast row's published rate applies above that threshold")
    expect(formula("claude-fable-5")).toContain("That rate applies across the whole window")
    expect(formula("gemini-4-carbon")).toContain("Context window 200k. Max context 1M")
    expect(formula("gemini-4-carbon")).not.toContain("December 1, 2026")
    expect(formula("gpt-5.2-fast")).toContain("Fast tier gpt-5.2")
    expect(formula("gpt-5.2-fast")).toContain(PROVIDER_PRICING_URL.openai)
    expect(formula("gpt-5.3-codex-fast")).toContain("marks gpt-5.3-codex deprecated")
    expect(formula("claude-fable-5-2-fast")).toContain("Claude Fable 5.2 $16 USD / MTok $80 USD / MTok")
    expect(formula("claude-fable-5-2-fast")).toContain("cache read 0.025x")
    expect(formula("claude-fable-5-2-fast")).toContain("5-minute cache write 1.25x")
    expect(priced.costs["gpt-5.2-fast"]).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    expect(priced.costs["gpt-5.3-codex-fast"]).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    expect(priced.costs["claude-fable-5-2-fast"]).toEqual({
      input: 16, output: 80, cache_read: 0.4, cache_write: 20,
    })
    expect(priced.costs["gpt-5.2"]).toEqual({ input: 1.75, output: 14, cache_read: 0.175 })
    const offline = loadOfflinePricing({
      pricingFile: join(root, "pricing.md"),
      contextFile: join(root, "context.md"),
      pagesDir: join(root, "pages"),
      providerPagesDir: join(root, "providers"),
    })
    expect(offline.costs).toEqual(priced.costs)
    expect(takeNetworkAttempts()).toEqual([])
    expect(() => loadOfflinePricing({
      pricingFile: join(root, "pricing.md"),
      contextFile: join(root, "context.md"),
      pagesDir: join(root, "pages"),
    })).toThrow(/Refusing to fetch provider pricing pages[\s\S]*anthropic\.html/)
    expect(() => loadOfflinePricing({
      pricingFile: join(root, "pricing.md"),
      contextFile: join(root, "context.md"),
    })).toThrow(/Refusing to fetch[\s\S]*gpt-5\.5/)
    expect(takeNetworkAttempts()).toEqual([])
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

  it("refuses to write when a required gpt-5.5 page has no table or no Fast row", () => {
    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.5 | OpenAI | $5 | - | $0.5 | $30 | |
`
    const fastCatalog: SelectableCatalogModel[] = [{
      id: "gpt-5.5",
      variants: [{ parameterValues: [{ id: "fast", value: "true" }] }],
    }]
    const standardOnly = `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>GPT-5.5</td><td>$5</td><td>-</td><td>$0.5</td><td>$30</td></tr>
</table>
<p>Fast mode is available at higher rates.</p>`
    const context = readFileSync(join(import.meta.dir, "fixtures", "pricing-offline", "context.md"), "utf8")
    const dir = mkdtempSync(join(tmpdir(), "pricing-out-"))
    const dest = join(dir, "pricing-data.ts")
    try {
      expect(() => {
        assemblePricing(markdown, context, [{ modelId: "gpt-5.5", html: "<p>GPT-5.5</p>" }], fastCatalog)
        writeFileSync(dest, "written")
      }).toThrow(/gpt-5\.5: https:\/\/cursor\.com\/docs\/models\/gpt-5-5 has no pricing table/)
      expect(existsSync(dest)).toBe(false)
      expect(() => {
        assemblePricing(markdown, context, [{ modelId: "gpt-5.5", html: standardOnly }], fastCatalog)
        writeFileSync(dest, "written")
      }).toThrow(/gpt-5\.5-fast[\s\S]*standard rate is not a Fast price/)
      expect(existsSync(dest)).toBe(false)
      const complete = readFileSync(join(import.meta.dir, "fixtures", "pricing-offline", "pages", "gpt-5.5.html"), "utf8")
      const priced = assemblePricing(markdown, context, [{ modelId: "gpt-5.5", html: complete }], [{
        id: "gpt-5.5",
        variants: [
          { parameterValues: [{ id: "fast", value: "true" }] },
          { parameterValues: [{ id: "context", value: "1m" }] },
        ],
      }])
      expect(priced.costs["gpt-5.5-fast"]).toEqual({ input: 12.5, output: 75, cache_read: 1.25 })
      expect(priced.costs["gpt-5.5"]?.tiers?.[0]?.input).toBe(10)
      expect(priced.costs["gpt-5.5"]?.tiers?.[0]?.output).toBe(45)
      expect(existsSync(dest)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("prices an unstated Fast variant from the provider list price, never the standard row", () => {
    const root = join(import.meta.dir, "fixtures", "pricing-offline", "providers")
    const openai = readFileSync(join(root, "openai.html"), "utf8")
    const anthropic = readFileSync(join(root, "anthropic.html"), "utf8")
    const parsed = parseOpenAiFastPrices(openai, new Set(["gpt-5.2", "gpt-5.3-codex", "gpt-5", "gpt-5.6-sol"]))
    expect(parsed.get("gpt-5.2")?.cost).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    expect(parsed.get("gpt-5.3-codex")).toMatchObject({
      deprecated: true,
      cost: { input: 3.5, output: 28, cache_read: 0.35 },
    })
    expect(parsed.get("gpt-5")?.cost).toEqual({ input: 2.5, output: 20, cache_read: 0.25 })
    expect(parsed.get("gpt-5.6-sol")?.cost).toEqual({
      input: 8, output: 40, cache_read: 0.8, cache_write: 10,
    })
    expect(JSON.stringify([...parsed.values()])).not.toContain("1.75")

    const markdown = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-5.2 | OpenAI | $1.75 | - | $0.175 | $14 | |
| GPT-5.4 | OpenAI | $2.5 | - | $0.25 | $15 | |
| Claude Fable 5.2 | Anthropic | $8 | $10 | $0.2 | $40 | |
`
    const context = `
| Model | Provider | Default context | Max context | Capabilities | Notes |
| --- | --- | --- | --- | --- | --- |
| GPT-5.2 | OpenAI | 272k | - | Agent | |
| GPT-5.4 | OpenAI | 272k | 1M | Agent | |
| Claude Fable 5.2 | Anthropic | 300k | 1M | Agent | |
`
    const standard = (name: string, cells: string) => `
<table>
<tr><th>Name</th><th>Input</th><th>Cache write</th><th>Cache read</th><th>Output</th></tr>
<tr><td>${name}</td><td>${cells}</td></tr>
</table>`
    const catalog: SelectableCatalogModel[] = [
      { id: "gpt-5.2", variants: [{ parameterValues: [{ id: "fast", value: "true" }] }] },
      { id: "claude-fable-5-2", variants: [{ parameterValues: [{ id: "fast", value: "true" }, { id: "context", value: "1m" }], isMaxMode: true }] },
    ]
    const pages = [
      { modelId: "gpt-5.2", html: standard("GPT-5.2", "$1.75</td><td>-</td><td>$0.175</td><td>$14") },
      { modelId: "claude-fable-5-2", html: `${standard("Claude Fable 5.2", "$8</td><td>$10</td><td>$0.2</td><td>$40")}<p>Context window 300k. Max context 1M.</p>` },
    ]
    expect(() => assemblePricing(markdown, context, pages, catalog)).toThrow(
      new RegExp(`${PROVIDER_PRICING_URL.anthropic.replace(/[.]/g, "\\.")}[\\s\\S]*standard rate is not a Fast price`),
    )
    expect(() => assemblePricing(markdown, context, pages, [catalog[0]!])).toThrow(
      new RegExp(`${PROVIDER_PRICING_URL.openai.replace(/[.]/g, "\\.")}[\\s\\S]*standard rate is not a Fast price`),
    )
    const priced = assemblePricing(markdown, context, pages, catalog, [
      { provider: "openai", html: openai },
      { provider: "anthropic", html: anthropic },
    ])
    expect(priced.costs["gpt-5.2"]).toEqual({ input: 1.75, output: 14, cache_read: 0.175 })
    expect(priced.costs["gpt-5.2-fast"]).toEqual({ input: 3.5, output: 28, cache_read: 0.35 })
    expect(priced.costs["claude-fable-5-2"]).toEqual({
      input: 8, output: 40, cache_read: 0.2, cache_write: 10,
    })
    expect(priced.costs["claude-fable-5-2-fast"]).toEqual({
      input: 16, output: 80, cache_read: 0.4, cache_write: 20,
    })
    expect(priced.costs["claude-fable-5-2-fast"]).not.toEqual(priced.costs["claude-fable-5-2"])
    expect(priced.derived.find((price) => price.id === "claude-fable-5-2")?.formula)
      .toContain("That rate applies across the whole window")
    const doubled = assemblePricing(markdown, context, [{
      modelId: "gpt-5.4",
      html: `${standard("GPT-5.4", "$2.5</td><td>-</td><td>$0.25</td><td>$15")}<p>Fast is 2x the standard price.</p>`,
    }], [{ id: "gpt-5.4", variants: [{ parameterValues: [{ id: "fast", value: "true" }] }] }])
    expect(doubled.costs["gpt-5.4-fast"]).toEqual({ input: 5, output: 30, cache_read: 0.5 })
    const pricing = buildPricing(markdown)
    expect(() => priceFromProviderPages(pricing, ["claude-fable-5-2"], [{
      provider: "anthropic",
      html: anthropic
        .replace("Claude Fable 5.2 and Claude Mythos 5.2 0.025x", "Claude Fable 5.2 and Claude Mythos 5.2 see")
        .replace("All other models 0.1x", "All other models see"),
    }])).toThrow(/no single cache hit multiplier/)
    expect(pricing.costs["claude-fable-5-2-fast"]).toBeUndefined()
    expect(takeNetworkAttempts()).toEqual([])
  })
})
