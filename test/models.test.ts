import { describe, it, expect } from "bun:test"
import {
  mapAvailableModelsResponse,
  isCacheFresh,
  cacheFilePath,
  resolveVariantParameters,
  paramsImplyMaxMode,
} from "../src/models.js"
import { modelInfoToConfig } from "../src/plugin.js"

describe("mapAvailableModelsResponse", () => {
  it("returns empty array for empty models", () => {
    expect(mapAvailableModelsResponse({})).toEqual([])
  })

  it("maps a simple model entry", () => {
    const raw = {
      models: [
        {
          name: "default",
          client_display_name: "Default",
          supports_thinking: true,
          supports_agent: true,
          context_token_limit: 200000,
          supports_max_mode: false,
          variants: [
            {
              display_name: "Default",
              is_default_non_max_config: true,
              is_default_max_config: false,
              parameter_values: [{ id: "effort", value: "medium" }],
            },
          ],
        },
      ],
    }

    const models = mapAvailableModelsResponse(raw)
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe("default")
    expect(models[0].displayName).toBe("Default")
    expect(models[0].supportsThinking).toBe(true)
    expect(models[0].supportsAgent).toBe(true)
    expect(models[0].maxContext).toBe(200000)
    expect(models[0].variants).toHaveLength(1)
    expect(models[0].variants[0].parameterValues[0].id).toBe("effort")
    expect(models[0].variants[0].parameterValues[0].value).toBe("medium")
  })

  it("maps multiple model entries with multiple variants", () => {
    const raw = {
      models: [
        {
          name: "claude-opus-4-8",
          client_display_name: "Claude Opus 4.8",
          supports_thinking: true,
          supports_agent: true,
          context_token_limit: 300000,
          variants: [
            {
              display_name: "Claude Opus 4.8 (Low)",
              is_default_non_max_config: true,
              is_default_max_config: false,
              parameter_values: [
                { id: "thinking", value: "false" },
                { id: "effort", value: "low" },
              ],
            },
            {
              display_name: "Claude Opus 4.8 (Max)",
              is_default_non_max_config: false,
              is_default_max_config: true,
              parameter_values: [
                { id: "thinking", value: "true" },
                { id: "effort", value: "max" },
              ],
            },
          ],
        },
        {
          name: "gpt-5.5",
          client_display_name: "GPT 5.5",
          supports_thinking: false,
          supports_agent: true,
          context_token_limit: 272000,
          variants: [
            {
              display_name: "GPT 5.5",
              is_default_non_max_config: true,
              is_default_max_config: false,
              parameter_values: [{ id: "reasoning", value: "high" }],
            },
          ],
        },
      ],
    }

    const models = mapAvailableModelsResponse(raw)
    expect(models).toHaveLength(2)
    expect(models[0].id).toBe("claude-opus-4-8")
    expect(models[0].variants).toHaveLength(2)
    expect(models[0].variants[0].isDefaultNonMax).toBe(true)
    expect(models[0].variants[1].isDefaultMax).toBe(true)
    expect(models[1].id).toBe("gpt-5.5")
  })

  it("skips entries without a name", () => {
    const raw = {
      models: [
        { client_display_name: "No Name" },
        { name: "valid", client_display_name: "Valid" },
      ],
    }
    const models = mapAvailableModelsResponse(raw)
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe("valid")
  })

  it("handles models with zero variants", () => {
    const raw = {
      models: [
        {
          name: "empty-variants",
          client_display_name: "Empty Variants",
          variants: [],
        },
      ],
    }
    const models = mapAvailableModelsResponse(raw)
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe("empty-variants")
    expect(models[0].variants).toHaveLength(0)
  })

  it("captures context_token_limit_for_max_mode (field 16) in both cases", () => {
    const raw = {
      models: [
        {
          name: "sonnet-max",
          client_display_name: "Sonnet Max",
          context_token_limit: 200000,
          context_token_limit_for_max_mode: 1000000,
          supports_max_mode: true,
          variants: [],
        },
        {
          name: "gpt-5",
          client_display_name: "GPT 5",
          contextTokenLimit: 272000,
          contextTokenLimitForMaxMode: 400000,
          variants: [],
        },
      ],
    }
    const models = mapAvailableModelsResponse(raw)
    expect(models[0].maxContext).toBe(200000)
    expect(models[0].maxContextForMaxMode).toBe(1000000)
    expect(models[1].maxContext).toBe(272000)
    expect(models[1].maxContextForMaxMode).toBe(400000)
  })

  it("derives context from the variant `context` param (primary source)", () => {
    // Mirrors the real AvailableModels shape: one base model whose variants
    // carry `id: "context"` tiers. Opus → 300k base / 1m max.
    const ctx = (value: string) => ({ id: "context", value })
    const raw = {
      models: [
        {
          name: "claude-opus-4-8",
          client_display_name: "Opus 4.8",
          supports_max_mode: true,
          variants: [
            {
              display_name: "Opus Low",
              is_default_non_max_config: true,
              is_default_max_config: false,
              parameter_values: [ctx("300k"), { id: "effort", value: "low" }],
            },
            {
              display_name: "Opus Max",
              is_default_non_max_config: false,
              is_default_max_config: true,
              parameter_values: [ctx("1m"), { id: "effort", value: "high" }],
            },
          ],
        },
        {
          name: "gpt-5",
          client_display_name: "GPT 5",
          variants: [
            {
              display_name: "GPT 5",
              is_default_non_max_config: true,
              is_default_max_config: true,
              parameter_values: [ctx("272k")],
            },
          ],
        },
        {
          // No context param anywhere → stays undefined (200k fallback later).
          name: "composer-2.5",
          client_display_name: "Composer 2.5",
          variants: [
            {
              display_name: "Composer",
              is_default_non_max_config: true,
              is_default_max_config: true,
              parameter_values: [{ id: "fast", value: "false" }],
            },
          ],
        },
      ],
    }

    const models = mapAvailableModelsResponse(raw)
    expect(models[0].maxContext).toBe(300000)
    expect(models[0].maxContextForMaxMode).toBe(1000000)
    expect(models[1].maxContext).toBe(272000)
    expect(models[2].maxContext).toBeUndefined()
  })
})

describe("modelInfoToConfig (context window selection)", () => {
  const base = { displayName: "X", variants: [] }

  it("uses the base context for non-max entries", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "claude-opus-4-8-high",
      maxContext: 200000,
      maxContextForMaxMode: 1000000,
    } as any)
    expect(cfg.limit.context).toBe(200000)
  })

  it("uses the max-mode context for *-max entries", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "claude-opus-4-8-max",
      maxContext: 200000,
      maxContextForMaxMode: 1000000,
    } as any)
    expect(cfg.limit.context).toBe(1000000)
  })

  it("falls back to the base context for a -max entry with no max-mode limit", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "gpt-5-max",
      maxContext: 272000,
    } as any)
    expect(cfg.limit.context).toBe(272000)
  })

  it("falls back to 200000 when neither limit is present", () => {
    const cfg = modelInfoToConfig({ ...base, id: "unknown-model" } as any)
    expect(cfg.limit.context).toBe(200000)
  })
})

describe("isCacheFresh", () => {
  it("returns true for recently fetched cache with current schema", () => {
    const cache = { models: [], fetchedAt: Date.now(), schemaVersion: 2 }
    expect(isCacheFresh(cache)).toBe(true)
  })

  it("returns false when schemaVersion is missing (forces upgrade refetch)", () => {
    const cache = { models: [], fetchedAt: Date.now() }
    expect(isCacheFresh(cache)).toBe(false)
  })

  it("returns false for expired cache", () => {
    const cache = { models: [], fetchedAt: Date.now() - 86400_000 - 1000, schemaVersion: 2 }
    expect(isCacheFresh(cache)).toBe(false)
  })

  it("respects custom TTL", () => {
    const cache = { models: [], fetchedAt: Date.now() - 5000, schemaVersion: 2 }
    expect(isCacheFresh(cache, 10000)).toBe(true)
    expect(isCacheFresh(cache, 1000)).toBe(false)
  })
})

describe("cacheFilePath", () => {
  it("appends file name to config dir", () => {
    const result = cacheFilePath("/home/user/.config/cursor")
    expect(result).toContain("cursor-models.json")
    expect(result).toContain("/home/user/.config/cursor")
  })
})

describe("resolveVariantParameters (picked variant + max mode)", () => {
  // Mirrors the real Cursor shape: one model, 4 effort × 2 fast × 2 context
  // = 8 variants, with one isDefaultNonMax and one isDefaultMax.
  const opus: Parameters<typeof resolveVariantParameters>[0] = {
    id: "claude-opus-4-8",
    maxContext: 300_000,
    maxContextForMaxMode: 1_000_000,
    variants: [
      { key: "opus", displayName: "Opus 300k low", isDefaultNonMax: true, isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "300k" },
          { id: "effort", value: "low" },
          { id: "fast", value: "false" },
        ] },
      { key: "opus", displayName: "Opus 300k high", isDefaultNonMax: false, isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "300k" },
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ] },
      { key: "opus", displayName: "Opus 300k low fast", isDefaultNonMax: false, isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "300k" },
          { id: "effort", value: "low" },
          { id: "fast", value: "true" },
        ] },
      { key: "opus", displayName: "Opus 1m low", isDefaultNonMax: false, isDefaultMax: true,
        parameterValues: [
          { id: "context", value: "1m" },
          { id: "effort", value: "low" },
          { id: "fast", value: "false" },
        ] },
      { key: "opus", displayName: "Opus 1m high", isDefaultNonMax: false, isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "1m" },
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ] },
    ],
  }

  it("picks the exact variant whose params match what opencode forwarded (preserves context/fast)", () => {
    const picked = [
      { id: "context", value: "1m" },
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]
    const params = resolveVariantParameters(opus, { picked })
    expect(params).toEqual(picked)
  })

  it("defaults to the isDefaultNonMax variant when no pick is given", () => {
    const params = resolveVariantParameters(opus, {})
    expect(params.find((p) => p.id === "context")?.value).toBe("300k")
    expect(params.find((p) => p.id === "effort")?.value).toBe("low")
    expect(params.find((p) => p.id === "fast")?.value).toBe("false")
  })

  it("routes maxMode to the isDefaultMax variant (1m)", () => {
    const params = resolveVariantParameters(opus, { maxMode: true })
    expect(params.find((p) => p.id === "context")?.value).toBe("1m")
  })

  it("explicit reasoningEffort picks the matching variant (skips fast variants)", () => {
    const params = resolveVariantParameters(opus, { reasoningEffort: "high" })
    expect(params.find((p) => p.id === "effort")?.value).toBe("high")
    expect(params.find((p) => p.id === "fast")?.value).toBe("false")
  })

  it("preserves fast=true when the TUI forwards a fast variant", () => {
    const picked = [
      { id: "context", value: "300k" },
      { id: "effort", value: "low" },
      { id: "fast", value: "true" },
    ]
    const params = resolveVariantParameters(opus, { picked })
    expect(params).toEqual(picked)
  })

  it("scopes reasoningEffort to the max tier when maxMode is set", () => {
    const params = resolveVariantParameters(opus, {
      reasoningEffort: "high",
      maxMode: true,
    })
    expect(params.find((p) => p.id === "context")?.value).toBe("1m")
    expect(params.find((p) => p.id === "effort")?.value).toBe("high")
    expect(params.find((p) => p.id === "fast")?.value).toBe("false")
  })

  it("strips hint keys from picked before matching", () => {
    const params = resolveVariantParameters(opus, {
      picked: [
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
        { id: "reasoningEffort", value: "high" },
        { id: "maxMode", value: "true" },
      ],
      reasoningEffort: "high",
      maxMode: true,
    })
    expect(params).toEqual([
      { id: "context", value: "1m" },
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ])
  })

  it("forwards an unmatched picked paramMap instead of silently defaulting", () => {
    const picked = [
      { id: "context", value: "999k" },
      { id: "effort", value: "ultra" },
    ]
    expect(resolveVariantParameters(opus, { picked })).toEqual(picked)
  })
})

describe("mapAvailableModelsResponse (context tier edge cases)", () => {
  it("prefers a non-1m context for base when isDefaultNonMax is missing", () => {
    const models = mapAvailableModelsResponse({
      models: [
        {
          name: "weird",
          variants: [
            {
              display_name: "1m",
              is_default_max_config: true,
              parameter_values: [{ id: "context", value: "1m" }],
            },
            {
              display_name: "300k",
              parameter_values: [{ id: "context", value: "300k" }],
            },
          ],
        },
      ],
    })
    expect(models[0].maxContext).toBe(300_000)
    expect(models[0].maxContextForMaxMode).toBe(1_000_000)
  })

  it("leaves maxContext undefined for unknown non-numeric context tiers", () => {
    const models = mapAvailableModelsResponse({
      models: [
        {
          name: "x",
          variants: [
            {
              display_name: "x",
              is_default_non_max_config: true,
              parameter_values: [{ id: "context", value: "auto" }],
            },
          ],
        },
      ],
    })
    expect(models[0].maxContext).toBeUndefined()
  })
})

describe("paramsImplyMaxMode", () => {
  it("is true only for context=1m", () => {
    expect(paramsImplyMaxMode([{ id: "context", value: "1m" }])).toBe(true)
    expect(paramsImplyMaxMode([{ id: "context", value: "300k" }])).toBe(false)
    expect(paramsImplyMaxMode([])).toBe(false)
  })
})
