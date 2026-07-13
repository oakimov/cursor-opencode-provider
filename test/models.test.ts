import { describe, it, expect } from "bun:test"
import { mapAvailableModelsResponse, isCacheFresh, cacheFilePath } from "../src/models.js"

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
})

describe("isCacheFresh", () => {
  it("returns true for recently fetched cache", () => {
    const cache = { models: [], fetchedAt: Date.now() }
    expect(isCacheFresh(cache)).toBe(true)
  })

  it("returns false for expired cache", () => {
    const cache = { models: [], fetchedAt: Date.now() - 86400_000 - 1000 }
    expect(isCacheFresh(cache)).toBe(false)
  })

  it("respects custom TTL", () => {
    const cache = { models: [], fetchedAt: Date.now() - 5000 }
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
