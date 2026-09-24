import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { modelsToConfig } from "../src/model-config.js"
import type { ModelInfo } from "../src/models.js"
import {
  applyCursorModelCost,
  checkCursorPricingCoverage,
  getCursorModelCost,
  hasCursorFastPricing,
  isOpenCodeModelCost,
  toOpenCode2Costs,
  validateOpenCodeModelCost,
  wireModelIdForPricing,
} from "../src/pricing.js"
import {
  buildPricingTable,
  catalogIdForPricingDisplayName,
} from "../scripts/generate-cursor-pricing.js"

describe("pricing", () => {
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
    expect(getCursorModelCost("gpt-5.5")?.context_over_200k).toEqual({
      input: 10,
      output: 30,
      cache_read: 1,
    })
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
      context_over_200k: {
        input: 4,
        output: 12,
        cache_read: 1,
      },
    })
    expect(getCursorModelCost("grok-4.7-fast")).toEqual({
      input: 4,
      output: 12,
      cache_read: 1,
      context_over_200k: {
        input: 6,
        output: 18,
        cache_read: 1.5,
      },
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
    expect(hasCursorFastPricing("claude-opus-4-8")).toBe(false)
    expect(hasCursorFastPricing("claude-sonnet-4-5")).toBe(false)
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
| Claude 4.7 Opus (fast mode) | Anthropic | $10 | $12.5 | $1 | $50 | skip |
`

    expect(buildPricingTable(markdown)).toEqual({
      "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      "composer-2.5": { input: 0.5, output: 2.5, cache_read: 0.2 },
      "composer-2.5-fast": { input: 3, output: 15, cache_read: 0.5 },
      "grok-4.6": { input: 2, output: 6, cache_read: 0.5 },
      "grok-4.6-fast": { input: 4, output: 12, cache_read: 1 },
    })
  })

  it("leaves Auto unpriced when docs omit an Auto-specific rate", () => {
    expect(getCursorModelCost("default")).toBeUndefined()
    expect(applyCursorModelCost("default", { name: "Auto" })).toEqual({ name: "Auto" })
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
      }),
    ).toEqual({
      valid: false,
      errors: [
        "cost.output must be a non-negative finite number",
        "cost.context_over_200k.output must be a non-negative finite number",
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
})
