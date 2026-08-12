import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { modelsToConfig } from "../src/model-config.js"
import type { ModelInfo } from "../src/models.js"
import {
  applyCursorModelCost,
  checkCursorPricingCoverage,
  getCursorModelCost,
  isOpenCodeModelCost,
  toOpenCode2Costs,
  validateOpenCodeModelCost,
  wireModelIdForPricing,
} from "../src/pricing.js"

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

  it("retains tiered rates for synthetic -1m catalog ids", () => {
    expect(wireModelIdForPricing("claude-sonnet-4-1m")).toEqual({
      baseId: "claude-sonnet-4",
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
  })

  it("leaves Auto / Composer / Grok unpriced when docs omit rates", () => {
    expect(getCursorModelCost("default")).toBeUndefined()
    expect(getCursorModelCost("composer-2.5")).toBeUndefined()
    expect(getCursorModelCost("grok-4.5")).toBeUndefined()
    expect(getCursorModelCost("grok-4.6")).toBeUndefined()
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
