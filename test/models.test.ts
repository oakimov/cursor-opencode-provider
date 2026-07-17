import { afterEach, describe, it, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  mapAvailableModelsResponse,
  isCacheFresh,
  cacheFilePath,
  normalizeModelCache,
  parseCursorContextLimit,
  readCache,
  refreshModelCache,
  resolveVariantParameters,
  paramsImplyMaxMode,
  extractCursorVariantParameters,
  writeCache,
  CURSOR_VARIANT_PARAMETERS_KEY,
  CURSOR_WIRE_MODEL_ID_KEY,
  resolveCursorWireModelId,
  type ModelCache,
} from "../src/models.js"
import { modelInfoToConfig, modelsToConfig } from "../src/plugin.js"

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-provider-models-"))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

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

  it("rejects non-string parameter values instead of coercing them", () => {
    expect(() => mapAvailableModelsResponse({
      models: [{
        name: "invalid",
        variants: [{ parameter_values: [{ id: "effort", value: true }] }],
      }],
    })).toThrow(/invalid parameter values/)
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
    expect(cfg.limit.output).toBe(32_000)
  })

  it("does not infer max mode from an intrinsic *-max model id", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "claude-opus-4-8-max",
      maxContext: 200000,
      maxContextForMaxMode: 1000000,
    } as any)
    expect(cfg.limit.context).toBe(200000)
  })

  it("uses the base context for a -max entry with no max-mode limit", () => {
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

  it("advertises a models.dev-parity output cap for the long-context tier", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "claude-opus-4-8",
      maxContext: 300000,
      maxContextForMaxMode: 1000000,
    } as any, { contextTier: "long" })
    expect(cfg.limit).toEqual({ context: 1_000_000, output: 128_000 })
  })
})

describe("modelsToConfig (context-tier materialization)", () => {
  // Mirrors the relevant OpenCode provider-parser contract: config `id` is
  // used to find an existing model, whose variants are merged into the new
  // entry before it is stored under modelID.
  const materializeVariantKeysLikeOpenCode = (config: Record<string, any>) => {
    const parsed: Record<string, { variants: Record<string, unknown> }> = {}
    for (const [modelID, model] of Object.entries(config)) {
      const existing = parsed[model.id ?? modelID]
      parsed[modelID] = {
        variants: {
          ...(existing?.variants ?? {}),
          ...(model.variants ?? {}),
        },
      }
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([id, model]) => [id, Object.keys(model.variants)]),
    )
  }

  const model: Parameters<typeof modelsToConfig>[0][number] = {
    id: "claude-opus-4-8",
    displayName: "Opus 4.8",
    maxContext: 300_000,
    maxContextForMaxMode: 1_000_000,
    variants: [
      {
        key: "claude-opus-4-8",
        displayName: "Opus 4.8 High",
        isDefaultNonMax: true,
        isDefaultMax: false,
        parameterValues: [
          { id: "context", value: "300k" },
          { id: "effort", value: "high" },
        ],
      },
      {
        key: "claude-opus-4-8",
        displayName: "Opus 4.8 1M High",
        isDefaultNonMax: false,
        isDefaultMax: true,
        parameterValues: [
          { id: "context", value: "1m" },
          { id: "effort", value: "high" },
        ],
      },
    ],
  }

  it("keeps base and 1m variants distinct while carrying the real Cursor wire id", () => {
    const config = modelsToConfig([model])

    expect(Object.keys(config)).toEqual(["claude-opus-4-8", "claude-opus-4-8-1m"])
    expect(config["claude-opus-4-8"].limit).toEqual({ context: 300_000, output: 32_000 })
    expect(config["claude-opus-4-8-1m"]).toMatchObject({
      name: "Opus 4.8 1M",
      limit: { context: 1_000_000, output: 128_000 },
      options: {
        [CURSOR_WIRE_MODEL_ID_KEY]: "claude-opus-4-8",
        [CURSOR_VARIANT_PARAMETERS_KEY]: [
          { id: "context", value: "1m" },
          { id: "effort", value: "high" },
        ],
      },
    })
    // OpenCode uses config `id` to look up an existing model and merge its
    // variants. Keeping the synthetic id avoids inheriting the base variants;
    // the real Cursor id travels in options instead.
    expect(config["claude-opus-4-8-1m"]).not.toHaveProperty("id")
    expect(Object.keys(config["claude-opus-4-8"].variants)).toEqual(["Opus 4.8 High"])
    expect(Object.keys(config["claude-opus-4-8-1m"].variants)).toEqual(["Opus 4.8 1M High"])
    expect(materializeVariantKeysLikeOpenCode(config)).toEqual({
      "claude-opus-4-8": ["Opus 4.8 High"],
      "claude-opus-4-8-1m": ["Opus 4.8 1M High"],
    })

    const picked = extractCursorVariantParameters(config["claude-opus-4-8-1m"].options)
    const resolved = resolveVariantParameters(model, { picked })
    expect(resolved.find((p) => p.id === "context")?.value).toBe("1m")
    expect(paramsImplyMaxMode(resolved)).toBe(true)
  })

  it("avoids collisions with a real model id ending in -1m", () => {
    const config = modelsToConfig([
      model,
      { id: "claude-opus-4-8-1m", displayName: "Real 1M model", variants: [] },
    ])
    expect(config).toHaveProperty("claude-opus-4-8-1m-2")
    expect(config["claude-opus-4-8-1m-2"]).not.toHaveProperty("id")
    expect(config["claude-opus-4-8-1m-2"].options[CURSOR_WIRE_MODEL_ID_KEY]).toBe("claude-opus-4-8")
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

  it("rejects stale or reordered picked parameters instead of silently defaulting", () => {
    const picked = [
      { id: "context", value: "999k" },
      { id: "effort", value: "ultra" },
    ]
    expect(() => resolveVariantParameters(opus, { picked })).toThrow(/exact parameter tuple/)

    const valid = opus.variants[0]!.parameterValues
    expect(() => resolveVariantParameters(opus, { picked: [...valid].reverse() })).toThrow(
      /exact parameter tuple/,
    )
  })
})

describe("extractCursorVariantParameters", () => {
  it("extracts only the dedicated variant payload", () => {
    expect(extractCursorVariantParameters({
      temperature: 0.2,
      thinkingConfig: { enabled: true },
      [CURSOR_VARIANT_PARAMETERS_KEY]: [
        { id: "context", value: "1m" },
        { id: "fast", value: "true" },
      ],
    })).toEqual([
      { id: "context", value: "1m" },
      { id: "fast", value: "true" },
    ])
  })

  it("does not reinterpret unrelated provider options as Cursor parameters", () => {
    expect(extractCursorVariantParameters({
      context: "1m",
      fast: true,
      thinkingConfig: { enabled: true },
    })).toBeUndefined()
  })

  it("rejects malformed dedicated payloads instead of silently ignoring them", () => {
    expect(() => extractCursorVariantParameters({
      [CURSOR_VARIANT_PARAMETERS_KEY]: [{ id: "thinking", value: { enabled: true } }],
    })).toThrow(/malformed/)
  })

  it("preserves an explicit empty tuple for a parameterless variant", () => {
    const picked = extractCursorVariantParameters({
      [CURSOR_VARIANT_PARAMETERS_KEY]: [],
    })
    expect(picked).toEqual([])
    expect(resolveVariantParameters({
      id: "parameterless",
      variants: [{
        key: "parameterless",
        displayName: "Parameterless",
        parameterValues: [],
        isDefaultNonMax: true,
        isDefaultMax: false,
      }],
    }, { picked })).toEqual([])
  })
})

describe("resolveCursorWireModelId", () => {
  it("uses the dedicated wire id for a synthetic OpenCode model", () => {
    expect(resolveCursorWireModelId({
      [CURSOR_WIRE_MODEL_ID_KEY]: "gpt-5.6-sol",
    }, "gpt-5.6-sol-1m")).toBe("gpt-5.6-sol")
  })

  it("falls back for missing or malformed aliases", () => {
    expect(resolveCursorWireModelId(undefined, "gpt-5.6-sol")).toBe("gpt-5.6-sol")
    expect(resolveCursorWireModelId({ [CURSOR_WIRE_MODEL_ID_KEY]: "" }, "gpt-5.6-sol")).toBe("gpt-5.6-sol")
    expect(resolveCursorWireModelId({ [CURSOR_WIRE_MODEL_ID_KEY]: 42 }, "gpt-5.6-sol")).toBe("gpt-5.6-sol")
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

  it("treats zero-valued proto context defaults as absent", () => {
    const models = mapAvailableModelsResponse({
      models: [{
        name: "zero-defaults",
        context_token_limit: 0,
        context_token_limit_for_max_mode: 0,
        variants: [],
      }],
    })
    expect(models[0].maxContext).toBeUndefined()
    expect(models[0].maxContextForMaxMode).toBeUndefined()
  })
})

describe("paramsImplyMaxMode", () => {
  it("recognizes equivalent one-million-token context labels", () => {
    expect(paramsImplyMaxMode([{ id: "context", value: "1m" }])).toBe(true)
    expect(paramsImplyMaxMode([{ id: "context", value: "1000k" }])).toBe(true)
    expect(paramsImplyMaxMode([{ id: "context", value: "300k" }])).toBe(false)
    expect(paramsImplyMaxMode([])).toBe(false)
  })
})

describe("parseCursorContextLimit", () => {
  it("parses scalable context labels without a fixed tier table", () => {
    expect(parseCursorContextLimit("200k")).toBe(200_000)
    expect(parseCursorContextLimit("480K")).toBe(480_000)
    expect(parseCursorContextLimit("2.5 M")).toBe(2_500_000)
    expect(parseCursorContextLimit("1000000")).toBe(1_000_000)
    expect(parseCursorContextLimit("auto")).toBeUndefined()
    expect(parseCursorContextLimit("0m")).toBeUndefined()
  })
})

function testCache(id = "cached"): ModelCache {
  return {
    fetchedAt: Date.now(),
    schemaVersion: 2,
    models: [{
      id,
      variants: [{
        key: id,
        displayName: id,
        parameterValues: [{ id: "effort", value: "high" }],
        isDefaultNonMax: true,
        isDefaultMax: false,
      }],
    }],
  }
}

describe("model cache integrity", () => {
  it("rejects an entire malformed cache rather than exposing a partial catalog", async () => {
    const directory = await tempDir()
    const cache = testCache()
    const malformed = {
      ...cache,
      models: [...cache.models, {
        ...cache.models[0],
        id: "bad",
        variants: [{
          ...cache.models[0]!.variants[0],
          parameterValues: [{ id: "effort", value: true }],
        }],
      }],
    }
    await fs.writeFile(cacheFilePath(directory), JSON.stringify(malformed))

    expect(normalizeModelCache(malformed)).toBeNull()
    expect(await readCache(directory)).toBeNull()
  })

  it("writes atomically and preserves the previous cache after validation fails", async () => {
    const directory = await tempDir()
    const cache = testCache()
    await writeCache(directory, cache)
    const invalid = {
      ...cache,
      models: [{
        ...cache.models[0],
        variants: [{
          ...cache.models[0]!.variants[0],
          parameterValues: [{ id: "", value: "high" }],
        }],
      }],
    } as unknown as ModelCache

    await expect(writeCache(directory, invalid)).rejects.toThrow(/invalid Cursor model cache/)
    expect(await readCache(directory)).toEqual(cache)
    expect((await fs.readdir(directory)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  it("coalesces concurrent refreshes for the same cache directory", async () => {
    const directory = await tempDir()
    let fetches = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = refreshModelCache(directory, async () => {
      fetches++
      await gate
      return testCache("first").models
    })
    const second = refreshModelCache(directory, async () => {
      fetches++
      return testCache("second").models
    })

    expect(fetches).toBe(1)
    release()
    const [firstModels, secondModels] = await Promise.all([first, second])
    expect(secondModels).toEqual(firstModels)
    expect((await readCache(directory))?.models).toEqual(firstModels)
  })
})
