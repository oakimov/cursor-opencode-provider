import { describe, expect, it } from "bun:test"
import {
  CURSOR_VARIANT_PARAMETERS_KEY,
  mapAvailableModelsResponse,
  normalizeModelCache,
  resolveVariantMaxMode,
  resolveVariantParameters,
  type ModelInfo,
  type ModelVariant,
} from "../src/models.js"
import { modelsToConfig } from "../src/model-config.js"
import { getCursorModelCost, wireModelIdForPricing } from "../src/pricing.js"
import { modelsToCatalogModelMap } from "../src/opencode2/catalog.js"

function variant(context: string, effort: string, fast = false): ModelVariant {
  return {
    key: `${context}-${effort}-${fast}`,
    displayName: `${context} ${effort} ${fast}`,
    isDefaultNonMax: context === "256k" && effort === "high" && fast,
    isDefaultMax: context !== "256k" && effort === "high" && fast,
    isMaxMode: context !== "256k",
    parameterValues: [
      { id: "context", value: context },
      { id: "reasoning_effort", value: effort },
      { id: "fast", value: String(fast) },
    ],
  }
}

describe("adversarial model selection", () => {
  it("advertises recorded image input for every context/Fast entry on both hosts despite a false live flag", () => {
    const [model] = mapAvailableModelsResponse({ models: [{
      name: "grok-4.7", supportsImages: false,
      variants: ["256k", "500k"].flatMap((context) =>
        [false, true].map((fast) => variant(context, "high", fast)),
      ),
    }] })
    const classic = modelsToConfig([model!])
    const modern = modelsToCatalogModelMap([model!])
    for (const id of ["grok-4.7", "grok-4.7-fast", "grok-4.7-500k", "grok-4.7-500k-fast"]) {
      expect(classic[id].attachment).toBe(true)
      expect(classic[id].modalities.input).toEqual(["text", "image"])
      expect(modern[id]?.capabilities.input).toEqual(["text", "image"])
      expect(modern[id]?.modelID).toBe("grok-4.7")
    }
  })

  it("derives context limits from marked tiers when default flags are absent", () => {
    const [model] = mapAvailableModelsResponse({ models: [{ name: "tiered", variants: [
      variant("500k", "low"), variant("256k", "low"),
    ] }] })
    expect(model?.maxContext).toBe(256_000)
    expect(model?.maxContextForMaxMode).toBe(500_000)
  })

  it("skips contextless variants when deriving tier limits", () => {
    const contextless = { ...variant("256k", "low"), parameterValues: [] }
    const [model] = mapAvailableModelsResponse({ models: [{ name: "tiered", variants: [
      contextless, variant("500k", "low"), variant("256k", "low"),
    ] }] })
    expect(model?.maxContext).toBe(256_000)
  })

  it("materializes the 500k max tier with matching limits, defaults and pricing", () => {
    const model: ModelInfo = {
      id: "grok-4.7", maxContext: 256_000, maxContextForMaxMode: 500_000,
      variants: ["256k", "500k"].flatMap((context) =>
        ["low", "high"].flatMap((effort) => [false, true].map((fast) => variant(context, effort, fast))),
      ),
    }
    const config = modelsToConfig([model])
    expect(config["grok-4.7"].limit.context).toBe(256_000)
    expect(config["grok-4.7-500k"].limit.context).toBe(500_000)
    expect(config["grok-4.7-500k-fast"].limit.context).toBe(500_000)
    expect(config["grok-4.7-500k"].options[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(variant("500k", "high").parameterValues)
    expect(Object.values(config["grok-4.7"].variants)).toHaveLength(4)
    expect(Object.values(config["grok-4.7-500k"].variants)).toHaveLength(2)
    expect(config["grok-4.7-500k"].cost).toEqual(getCursorModelCost("grok-4.7"))
    const catalog2 = modelsToCatalogModelMap([model])
    expect(catalog2["grok-4.7-500k"]).toMatchObject({
      modelID: "grok-4.7", limit: { context: 500_000 },
      settings: { [CURSOR_VARIANT_PARAMETERS_KEY]: variant("500k", "high").parameterValues },
    })
    expect(catalog2["grok-4.7-500k-fast"]?.cost).toHaveLength(2)
    expect(wireModelIdForPricing("grok-4.7-500k-fast")).toEqual({
      baseId: "grok-4.7-fast", longContextEntry: true,
    })
    expect(getCursorModelCost("grok-4.7-500k-2-fast")).toEqual(getCursorModelCost("grok-4.7-fast"))
    const colliding = modelsToConfig([model, { id: "grok-4.7-500k", variants: [] },
      { id: "grok-4.7-500k-fast", variants: [] }])
    expect(colliding["grok-4.7-500k-2"].limit.context).toBe(500_000)
    expect(colliding["grok-4.7-500k-2-fast"].limit.context).toBe(500_000)
  })

  it("retains saved 500k variant ids on base and Fast entries in both host catalogs", () => {
    const slow = { ...variant("500k", "high"), displayName: "Grok 4.7 High 500k" }
    const fast = { ...variant("500k", "high", true), displayName: "Grok 4.7 High Fast 500k Fast" }
    const model: ModelInfo = {
      id: "grok-4.7", maxContext: 256_000, maxContextForMaxMode: 500_000,
      variants: [variant("256k", "high"), variant("256k", "high", true), slow, fast],
    }
    const classic = modelsToConfig([model])
    const modern = modelsToCatalogModelMap([model])
    for (const [id, saved] of [["grok-4.7", slow], ["grok-4.7-fast", fast]] as const) {
      const originalParams = saved.parameterValues
      const picked = classic[id].variants[saved.displayName]?.[CURSOR_VARIANT_PARAMETERS_KEY]
      expect(picked).toEqual(originalParams)
      expect(modern[id]?.variants.find((v) => v.id === saved.displayName)?.settings)
        .toEqual({ [CURSOR_VARIANT_PARAMETERS_KEY]: originalParams })
      expect(resolveVariantParameters(model, { picked })).toEqual(originalParams)
      expect(resolveVariantMaxMode(originalParams, { model, picked: originalParams })).toBe(true)
      expect(classic[id].limit.context).toBe(256_000)
    }
    expect(classic["grok-4.7-500k"].limit.context).toBe(500_000)
    expect(classic["grok-4.7-500k-fast"].limit.context).toBe(500_000)
    expect(classic["grok-4.7-fast"].options[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(variant("256k", "high", true).parameterValues)
  })

  it("keeps the old Fast entry when its only variants moved to a max tier", () => {
    const fast = variant("500k", "high", true)
    const model: ModelInfo = {
      id: "grok-4.7", maxContext: 256_000,
      variants: [variant("256k", "high"), fast],
    }
    const config = modelsToConfig([model])
    expect(config["grok-4.7-fast"].variants[fast.displayName]?.[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(fast.parameterValues)
    expect(config["grok-4.7-fast"].options[CURSOR_VARIANT_PARAMETERS_KEY]).toEqual(fast.parameterValues)
    expect(config["grok-4.7-500k-fast"].limit.context).toBe(500_000)
    expect(modelsToCatalogModelMap([model])["grok-4.7-fast"]?.variants[0]?.id).toBe(fast.displayName)
  })

  it("preserves pre-split collision labels without adding 1M variants to the base picker", () => {
    const max = { ...variant("500k", "high"), displayName: "Shared" }
    const base = { ...variant("256k", "high"), displayName: "Shared", isDefaultNonMax: true }
    const long = { ...variant("1m", "high"), displayName: "Long" }
    const model: ModelInfo = { id: "tiered", maxContext: 256_000, variants: [max, base, long] }
    const config = modelsToConfig([model])
    expect(config.tiered.variants.Shared[CURSOR_VARIANT_PARAMETERS_KEY]).toEqual(max.parameterValues)
    expect(config.tiered.variants["Shared 256k"][CURSOR_VARIANT_PARAMETERS_KEY]).toEqual(base.parameterValues)
    expect(config.tiered.variants.Long).toBeUndefined()
    expect(config["tiered-500k"].variants.Shared[CURSOR_VARIANT_PARAMETERS_KEY]).toEqual(max.parameterValues)
    expect(resolveVariantParameters(model)).toEqual(base.parameterValues)
  })

  it("keeps an intrinsic marked context on its original model id", () => {
    const model: ModelInfo = { id: "intrinsic", maxContext: 500_000,
      variants: [variant("500k", "high")] }
    const catalog = modelsToConfig([model])
    expect(Object.keys(catalog)).toEqual(["intrinsic"])
    expect(catalog.intrinsic.limit.context).toBe(500_000)
  })

  it("uses each advertised context limit when there are multiple max tiers", () => {
    const model: ModelInfo = { id: "multi-tier", maxContext: 256_000, maxContextForMaxMode: 500_000,
      variants: [variant("256k", "high"), variant("500k", "high"), variant("1m", "high")] }
    const catalog = modelsToConfig([model])
    expect(catalog["multi-tier-1m"].limit.context).toBe(1_000_000)
    expect(catalog["multi-tier-500k"].limit.context).toBe(500_000)
  })

  it("keeps effort-only selection in the base tier even when max is listed first", () => {
    const base = variant("256k", "high")
    const model: ModelInfo = { id: "tiered", variants: [variant("500k", "high"), base] }
    const params = resolveVariantParameters(model, { reasoningEffort: "high" })
    expect(params).toEqual(base.parameterValues)
    expect(resolveVariantMaxMode(params, { model })).toBe(false)
  })

  it("selects a Fast-only max tier before applying the non-Fast preference", () => {
    const max = variant("500k", "high", true)
    const model: ModelInfo = { id: "tiered", variants: [variant("256k", "low"), max] }
    for (const reasoningEffort of [undefined, "high"]) {
      const params = resolveVariantParameters(model, { maxMode: true, reasoningEffort })
      expect(params).toEqual(max.parameterValues)
      expect(resolveVariantMaxMode(params, { model, maxMode: true })).toBe(true)
    }
  })

  it("runs every variant in max mode when Cursor reports no non-max support", () => {
    // Cursor CLI: requiresMaxMode = supportsNonMaxMode === false || variant.isMaxMode.
    const unmarked = (effort: string, isDefaultNonMaxConfig = false) => ({
      parameterValues: [{ id: "reasoning_effort", value: effort }], isDefaultNonMaxConfig,
    })
    const [model] = mapAvailableModelsResponse({ models: [{ name: "max-only", supportsNonMaxMode: false,
      variants: [unmarked("low"), unmarked("high", true)] }] })
    expect(model?.supportsNonMaxMode).toBe(false)
    expect(normalizeModelCache({ models: [model], fetchedAt: 1 })?.models[0]?.supportsNonMaxMode).toBe(false)
    const picked = [{ id: "reasoning_effort", value: "low" }]
    expect(resolveVariantMaxMode(resolveVariantParameters(model, { picked }), { model, picked })).toBe(true)
    expect(resolveVariantMaxMode(resolveVariantParameters(model), { model })).toBe(true)
    const [plain] = mapAvailableModelsResponse({ models: [{ name: "plain", supportsNonMaxMode: true,
      variants: [unmarked("low")] }] })
    expect(resolveVariantMaxMode(resolveVariantParameters(plain), { model: plain })).toBe(false)
    expect(() => mapAvailableModelsResponse({ models: [{ name: "bad", supportsNonMaxMode: "no" }] }))
      .toThrow(/supportsNonMaxMode for bad/)
  })

  it("retains the declared max effort in a max tier that lacks the declared context", () => {
    const tiered = (context: string, effort: string, fast: boolean): ModelVariant => ({
      ...variant(context, effort, fast), isDefaultNonMax: false,
      isDefaultMax: context === "1m" && effort === "high" && fast,
    })
    const model: ModelInfo = { id: "multi-tier", maxContext: 256_000, maxContextForMaxMode: 1_000_000,
      variants: ["256k", "500k", "1m"].flatMap((context) =>
        ["low", "high"].flatMap((effort) => [false, true].map((fast) => tiered(context, effort, fast)))) }
    const catalog = modelsToConfig([model])
    expect(catalog["multi-tier-500k"].options[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(variant("500k", "high").parameterValues)
    // No separate Fast pricing, so the 1m entry holds the declared Fast default.
    expect(catalog["multi-tier-1m"].options[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(variant("1m", "high", true).parameterValues)
  })

  it("keeps a valid default tuple when the requested effort exists only in max mode", () => {
    const base = { ...variant("256k", "low"), isDefaultNonMax: true }
    const model: ModelInfo = { id: "tiered", variants: [variant("500k", "high"), base] }
    expect(resolveVariantParameters(model, { reasoningEffort: "high" })).toEqual(base.parameterValues)
  })
})
