import { afterEach, describe, it, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  mapAvailableModelsResponse,
  discoverModels,
  isCacheFresh,
  cacheFilePath,
  normalizeModelCache,
  parseCursorContextLimit,
  readCache,
  refreshModelCache,
  resolveVariantParameters,
  paramsImplyMaxMode,
  resolveVariantMaxMode,
  extractCursorVariantParameters,
  writeCache,
  CURSOR_VARIANT_PARAMETERS_KEY,
  CURSOR_WIRE_MODEL_ID_KEY,
  resolveCursorWireModelId,
  variantsSupportReasoning,
  type ModelCache,
  type ModelInfo,
  type ModelVariant,
} from "../src/models.js"
import { cursorModelFamily, modelInfoToConfig, modelsToConfig } from "../src/model-config.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"

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
          supports_images: true,
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

  it("ignores AvailableModels image support, like Cursor CLI", () => {
    const models = mapAvailableModelsResponse({
      models: [
        { name: "vision", supportsImages: true, variants: [] },
        { name: "text", supports_images: false, variants: [] },
        { name: "malformed", supports_images: "yes", variants: [] },
      ],
    })
    expect(models.map(model => ({
      id: model.id,
      supportsImages: Object.prototype.hasOwnProperty.call(model, "supportsImages"),
    }))).toEqual([
      { id: "vision", supportsImages: false },
      { id: "text", supportsImages: false },
      { id: "malformed", supportsImages: false },
    ])
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

describe("cursorModelFamily", () => {
  it("drops version segments the way models.dev names families", () => {
    expect(cursorModelFamily("claude-haiku-4-5")).toBe("claude-haiku")
    expect(cursorModelFamily("claude-opus-5-5")).toBe("claude-opus")
    expect(cursorModelFamily("claude-4.5-sonnet")).toBe("claude-sonnet")
    expect(cursorModelFamily("gemini-3.8-flash")).toBe("gemini-flash")
    expect(cursorModelFamily("gemini-2.5-flash-lite")).toBe("gemini-flash-lite")
    expect(cursorModelFamily("gpt-5.6-luna")).toBe("gpt-luna")
    expect(cursorModelFamily("gpt-5.4-nano")).toBe("gpt-nano")
    expect(cursorModelFamily("gpt-5.5")).toBe("gpt")
    expect(cursorModelFamily("glm-5p3-flash")).toBe("glm-flash")
    expect(cursorModelFamily("composer-2.5")).toBe("composer")
  })

  it("leaves Cursor Auto without a family", () => {
    expect(cursorModelFamily("default")).toBeUndefined()
  })

  it("keeps context and speed suffixes out of the family", () => {
    const suffixed = [
      ["claude-sonnet-4-1m", "claude-sonnet"],
      ["gpt-5.4-1m", "gpt"],
      ["gpt-5.6-sol-1m", "gpt-sol"],
      ["composer-2.5-fast", "composer"],
      ["grok-4.7-fast", "grok"],
      ["claude-opus-5-5-1m-fast", "claude-opus"],
    ] as const
    expect(suffixed.map(([id]) => [id, cursorModelFamily(id)])).toEqual(suffixed.map(([id, family]) => [id, family]))
  })

  it("groups Kimi minor versions and code speeds within their major family", () => {
    expect(cursorModelFamily("kimi-k2.6")).toBe("kimi-k2")
    expect(cursorModelFamily("kimi-k2.7-code")).toBe("kimi-k2")
    expect(cursorModelFamily("kimi-k2.7-code-highspeed")).toBe("kimi-k2")
    expect(cursorModelFamily("kimi-k3")).toBe("kimi-k3")
  })
})

describe("modelInfoToConfig family", () => {
  it("sets the family OpenCode uses to pick its small model", () => {
    // OpenCode 2.0 Model.small: gpt-luna, gemini-flash-lite, gemini-flash, claude-haiku;
    // OpenCode 1.x: gemini-flash, gpt-nano, claude-haiku. No family means titles run on the session model.
    expect(modelInfoToConfig({ id: "claude-haiku-4-5", variants: [] }).family).toBe("claude-haiku")
    expect(modelInfoToConfig({ id: "default", variants: [] }).family).toBeUndefined()
  })

  it("prefers a non-empty family supplied in cache metadata", () => {
    expect(modelInfoToConfig({ id: "claude-haiku-4-5", family: "  claude-haiku-x  ", variants: [] }).family)
      .toBe("claude-haiku-x")
  })

  it("derives family when cached metadata contains an empty or whitespace family", () => {
    expect(modelInfoToConfig({ id: "claude-haiku-4-5", family: "", variants: [] }).family).toBe("claude-haiku")
    expect(modelInfoToConfig({ id: "gpt-5.6-luna", family: "   ", variants: [] }).family).toBe("gpt-luna")
  })

  it("keeps the wire model family on long-context and Fast entries", () => {
    const config = modelsToConfig([{
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      maxContext: 300_000,
      maxContextForMaxMode: 1_000_000,
      variants: [
        { key: "a", displayName: "High", isDefaultNonMax: true, isDefaultMax: false, parameterValues: [{ id: "effort", value: "high" }] },
        { key: "b", displayName: "High 1M", isDefaultNonMax: false, isDefaultMax: true, parameterValues: [{ id: "effort", value: "high" }, { id: "context", value: "1m" }] },
      ],
    }])
    const families = Object.values(config).map(entry => entry.family)
    expect(families.length).toBeGreaterThan(1)
    expect(families.filter(family => family !== "claude-opus")).toEqual([])
  })

  it("maps pricing-fixture ids onto OpenCode small-model families", async () => {
    // OpenCode 2.0 Model.small: gpt-luna, gemini-flash-lite, gemini-flash, claude-haiku;
    // OpenCode 1.x getSmallModel: gemini-flash, gpt-nano, claude-haiku. Titles fall
    // back to the session model when none of these appear. gemini-flash-lite is
    // only required when the fixture includes a matching id.
    const required = ["gpt-luna", "gpt-nano", "gemini-flash", "claude-haiku"] as const
    const fixturePath = path.join(import.meta.dir, "fixtures/cursor-pricing-models.txt")
    const ids = (await fs.readFile(fixturePath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
    const families = new Set(ids.map((id) => cursorModelFamily(id)).filter((f): f is string => !!f))
    expect(required.filter(family => !families.has(family))).toEqual([])
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

  it("falls back to 256000 for Cursor Auto when no static maxContext exists", () => {
    const cfg = modelInfoToConfig({ ...base, id: "default" } as any)
    expect(cfg.limit.context).toBe(256000)
  })

  it("falls back to generated Cursor docs metadata before 200000", () => {
    const grok = modelInfoToConfig({ ...base, id: "grok-4.5" } as any)
    const grok46 = modelInfoToConfig({ ...base, id: "grok-4.6" } as any)
    const gpt = modelInfoToConfig({ ...base, id: "gpt-5.2" } as any)
    expect(grok.limit.context).toBe(256000)
    expect(grok46.limit.context).toBe(256000)
    expect(gpt.limit.context).toBe(272000)
  })

  it("prefers AvailableModels context over generated docs metadata", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "grok-4.5",
      maxContext: 300000,
    } as any)
    expect(cfg.limit.context).toBe(300000)
  })

  it("advertises image input only where the live probe recorded it, not Cursor's flag", () => {
    const [readsDespiteFlag, textDespiteFlag, unrecorded] = mapAvailableModelsResponse({ models: [
      { name: "composer-2.5", supports_images: false },
      { name: "kimi-k3", supports_images: true },
      { name: "unrecorded-model", supports_images: true },
    ] })
    const reads = modelInfoToConfig(readsDespiteFlag!)
    expect(reads.attachment).toBe(true)
    expect(reads.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    for (const model of [textDespiteFlag!, unrecorded!]) {
      const cfg = modelInfoToConfig(model)
      expect(cfg.attachment).toBe(false)
      expect(cfg.modalities).toEqual({ input: ["text"], output: ["text"] })
    }
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

  it("keeps inner text while stripping markup from display names", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "marked-up-model",
      displayName: '<span style="color:red">Medium</span> & <script',
    } as any)
    expect(cfg.name).toBe("Medium script")
  })

  it("sanitizes long unterminated markup without backtracking", () => {
    const cfg = modelInfoToConfig({
      ...base,
      id: "pathological-label",
      displayName: `${"<".repeat(50_000)}Visible`,
    } as any)
    expect(cfg.name).toBe("Visible")
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

  it("materializes an equivalent 1000k long-context label as the 1m tier", () => {
    const equivalent = {
      ...model,
      variants: model.variants.map((variant) => ({
        ...variant,
        parameterValues: variant.parameterValues.map((parameter) =>
          parameter.id === "context" && parameter.value === "1m"
            ? { ...parameter, value: "1000k" }
            : parameter,
        ),
      })),
    }

    const config = modelsToConfig([equivalent])
    expect(Object.keys(config)).toEqual(["claude-opus-4-8", "claude-opus-4-8-1m"])
    expect(Object.keys(config["claude-opus-4-8-1m"].variants)).toEqual(["Opus 4.8 1M High"])
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

  it("splits Composer Fast into a synthetic catalog id with the same wire model", () => {
    const composer: Parameters<typeof modelsToConfig>[0][number] = {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      variants: [
        {
          key: "composer-2.5",
          displayName: "Composer 2.5",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [{ id: "fast", value: "false" }],
        },
        {
          key: "composer-2.5",
          displayName: "Composer 2.5",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [{ id: "fast", value: "true" }],
        },
      ],
    }

    const config = modelsToConfig([composer])
    expect(Object.keys(config)).toEqual(["composer-2.5", "composer-2.5-fast"])
    expect(config["composer-2.5"].name).toBe("Composer 2.5")
    expect(config["composer-2.5-fast"]).toMatchObject({
      name: "Composer 2.5 Fast",
      options: {
        [CURSOR_WIRE_MODEL_ID_KEY]: "composer-2.5",
        [CURSOR_VARIANT_PARAMETERS_KEY]: [{ id: "fast", value: "true" }],
      },
    })
    expect(config["composer-2.5"].cost).toEqual({
      input: 0.5,
      output: 2.5,
      cache_read: 0.2,
    })
    expect(config["composer-2.5-fast"].cost).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.5,
    })
    expect(Object.keys(config["composer-2.5"].variants)).toEqual(["Composer 2.5 default"])
    expect(Object.keys(config["composer-2.5-fast"].variants)).toEqual(["Composer 2.5 Fast"])
  })

  it("keeps a Fast-only Composer catalog id on the wire model id", () => {
    const composer: Parameters<typeof modelsToConfig>[0][number] = {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      variants: [
        {
          key: "composer-2.5",
          displayName: "Composer 2.5",
          isDefaultNonMax: true,
          isDefaultMax: true,
          parameterValues: [{ id: "fast", value: "true" }],
        },
      ],
    }

    const config = modelsToConfig([composer])
    expect(Object.keys(config)).toEqual(["composer-2.5"])
    expect(config["composer-2.5"].name).toBe("Composer 2.5 Fast")
    expect(config["composer-2.5"].cost).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.5,
    })
    expect(config["composer-2.5"].options[CURSOR_WIRE_MODEL_ID_KEY]).toBe("composer-2.5")
  })

  it("does not split Claude Fast variants when Cursor publishes one price", () => {
    const opus = {
      ...model,
      variants: [
        ...model.variants,
        {
          key: "claude-opus-4-8",
          displayName: "Opus 4.8 Fast",
          isDefaultNonMax: false,
          isDefaultMax: false,
          parameterValues: [
            { id: "context", value: "300k" },
            { id: "fast", value: "true" },
          ],
        },
      ],
    }

    const config = modelsToConfig([opus])
    expect(Object.keys(config)).toEqual(["claude-opus-4-8", "claude-opus-4-8-1m"])
    expect(Object.keys(config["claude-opus-4-8"].variants)).toEqual([
      "Opus 4.8 High",
      "Opus 4.8 Fast",
    ])
  })

  it("combines Fast and 1M into a -1m-fast catalog id", () => {
    const composer: Parameters<typeof modelsToConfig>[0][number] = {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      maxContext: 200_000,
      maxContextForMaxMode: 1_000_000,
      variants: [
        {
          key: "slow",
          displayName: "Composer 2.5",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [
            { id: "fast", value: "false" },
            { id: "context", value: "200k" },
          ],
        },
        {
          key: "fast",
          displayName: "Composer 2.5 Fast",
          isDefaultNonMax: false,
          isDefaultMax: false,
          parameterValues: [
            { id: "fast", value: "true" },
            { id: "context", value: "200k" },
          ],
        },
        {
          key: "long",
          displayName: "Composer 2.5 1M",
          isDefaultNonMax: false,
          isDefaultMax: false,
          parameterValues: [
            { id: "fast", value: "false" },
            { id: "context", value: "1m" },
          ],
        },
        {
          key: "long-fast",
          displayName: "Composer 2.5 1M Fast",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [
            { id: "fast", value: "true" },
            { id: "context", value: "1m" },
          ],
        },
      ],
    }

    const config = modelsToConfig([composer])
    expect(Object.keys(config)).toEqual([
      "composer-2.5",
      "composer-2.5-fast",
      "composer-2.5-1m",
      "composer-2.5-1m-fast",
    ])
    expect(config["composer-2.5-1m-fast"]).toMatchObject({
      name: "Composer 2.5 Fast 1M",
      limit: { context: 1_000_000, output: 128_000 },
      options: {
        [CURSOR_WIRE_MODEL_ID_KEY]: "composer-2.5",
        [CURSOR_VARIANT_PARAMETERS_KEY]: [
          { id: "fast", value: "true" },
          { id: "context", value: "1m" },
        ],
      },
    })
    expect(config["composer-2.5-1m-fast"].cost).toEqual(config["composer-2.5-fast"].cost)
  })

  it("avoids collisions with a real model id ending in -1m-fast", () => {
    const composer: Parameters<typeof modelsToConfig>[0][number] = {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      maxContext: 200_000,
      maxContextForMaxMode: 1_000_000,
      variants: [
        {
          key: "slow",
          displayName: "Composer 2.5",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [
            { id: "fast", value: "false" },
            { id: "context", value: "200k" },
          ],
        },
        {
          key: "fast",
          displayName: "Composer 2.5 Fast",
          isDefaultNonMax: false,
          isDefaultMax: false,
          parameterValues: [
            { id: "fast", value: "true" },
            { id: "context", value: "200k" },
          ],
        },
        {
          key: "long",
          displayName: "Composer 2.5 1M",
          isDefaultNonMax: false,
          isDefaultMax: false,
          parameterValues: [
            { id: "fast", value: "false" },
            { id: "context", value: "1m" },
          ],
        },
        {
          key: "long-fast",
          displayName: "Composer 2.5 1M Fast",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [
            { id: "fast", value: "true" },
            { id: "context", value: "1m" },
          ],
        },
      ],
    }
    const config = modelsToConfig([
      composer,
      { id: "composer-2.5-1m-fast", displayName: "Real 1M Fast model", variants: [] },
    ])
    expect(Object.keys(config)).toContain("composer-2.5-1m-2-fast")
    expect(config["composer-2.5-1m-2-fast"].options[CURSOR_WIRE_MODEL_ID_KEY]).toBe("composer-2.5")
    expect(config["composer-2.5-1m-fast"].name).toBe("Real 1M Fast model")
  })

  it("avoids collisions with a real model id ending in -fast", () => {
    const composer: Parameters<typeof modelsToConfig>[0][number] = {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      variants: [
        {
          key: "slow",
          displayName: "Composer 2.5",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [{ id: "fast", value: "false" }],
        },
        {
          key: "fast",
          displayName: "Composer 2.5 Fast",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [{ id: "fast", value: "true" }],
        },
      ],
    }
    const config = modelsToConfig([
      composer,
      { id: "composer-2.5-fast", displayName: "Real Fast model", variants: [] },
    ])
    expect(Object.keys(config)).toContain("composer-2.5-fast-2")
    expect(config["composer-2.5-fast-2"].options[CURSOR_WIRE_MODEL_ID_KEY]).toBe("composer-2.5")
    expect(config["composer-2.5-fast"].name).toBe("Real Fast model")
  })
})

describe("isCacheFresh", () => {
  it("refreshes schema-4 caches that collapsed absent max markers to false", () => {
    expect(isCacheFresh({ models: [], fetchedAt: Date.now(), schemaVersion: 4 })).toBe(false)
  })

  it("returns true for recently fetched cache with current schema", () => {
    const cache = { models: [], fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION }
    expect(isCacheFresh(cache)).toBe(true)
  })

  it("returns false when schemaVersion is missing (forces upgrade refetch)", () => {
    const cache = { models: [], fetchedAt: Date.now() }
    expect(isCacheFresh(cache)).toBe(false)
  })

  it("returns false for expired cache", () => {
    const cache = { models: [], fetchedAt: Date.now() - 86400_000 - 1000, schemaVersion: MODEL_CACHE_SCHEMA_VERSION }
    expect(isCacheFresh(cache)).toBe(false)
  })

  it("respects custom TTL", () => {
    const cache = { models: [], fetchedAt: Date.now() - 5000, schemaVersion: MODEL_CACHE_SCHEMA_VERSION }
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

describe("resolveVariantParameters (reasoning_effort models)", () => {
  const argon: Parameters<typeof resolveVariantParameters>[0] = {
    id: "gemini-4-argon",
    maxContext: 1_000_000,
    maxContextForMaxMode: 1_000_000,
    variants: [
      { key: "argon", displayName: "Argon Low", isDefaultNonMax: false, isDefaultMax: false,
        parameterValues: [{ id: "reasoning_effort", value: "low" }] },
      { key: "argon", displayName: "Argon Medium", isDefaultNonMax: true, isDefaultMax: true,
        parameterValues: [{ id: "reasoning_effort", value: "medium" }] },
      { key: "argon", displayName: "Argon High", isDefaultNonMax: false, isDefaultMax: false,
        parameterValues: [{ id: "reasoning_effort", value: "high" }] },
    ],
  }

  it("honors a reasoning effort hint when the parameter id is reasoning_effort", () => {
    expect(resolveVariantParameters(argon, { reasoningEffort: "high" })).toEqual([
      { id: "reasoning_effort", value: "high" },
    ])
    expect(resolveVariantParameters(argon, { reasoningEffort: "low" })).toEqual([
      { id: "reasoning_effort", value: "low" },
    ])
  })

  it("keeps the default variant when no effort hint is given", () => {
    expect(resolveVariantParameters(argon)).toEqual([{ id: "reasoning_effort", value: "medium" }])
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

  it("rejects stale picked parameters without rejecting a reordered equivalent tuple", () => {
    const picked = [
      { id: "context", value: "999k" },
      { id: "effort", value: "ultra" },
    ]
    expect(() => resolveVariantParameters(opus, { picked })).toThrow(/exact parameter tuple/)

    const valid = opus.variants[0]!.parameterValues
    expect(resolveVariantParameters(opus, { picked: [...valid].reverse() })).toEqual(valid)
    expect(() => resolveVariantParameters(opus, { picked: [...valid, valid[0]!] })).toThrow(
      /exact parameter tuple/,
    )
  })

  it("does not let a reasoningEffort hint override an explicitly picked variant", () => {
    const picked = [
      { id: "context", value: "1m" },
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]
    const params = resolveVariantParameters(opus, { picked, reasoningEffort: "medium" })
    expect(params).toEqual(picked)
  })

  it("sets max mode for a picked 1m variant despite a false hint", () => {
    const picked = [
      { id: "context", value: "1m" },
      { id: "effort", value: "low" },
      { id: "fast", value: "false" },
    ]
    const params = resolveVariantParameters(opus, { picked, maxMode: false })
    expect(resolveVariantMaxMode(params, { picked, maxMode: false })).toBe(true)
  })

  it("does not let a true maxMode hint override a picked base variant", () => {
    const picked = [
      { id: "context", value: "300k" },
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]
    const params = resolveVariantParameters(opus, { picked, maxMode: true })
    expect(params).toEqual(picked)
    expect(resolveVariantMaxMode(params, { picked, maxMode: true })).toBe(false)
  })

  it("uses max and effort hints to select an unpicked 1m variant", () => {
    const params = resolveVariantParameters(opus, {
      reasoningEffort: "high",
      maxMode: true,
    })
    expect(params.find((p) => p.id === "context")?.value).toBe("1m")
    expect(params.find((p) => p.id === "effort")?.value).toBe("high")
    expect(resolveVariantMaxMode(params, { maxMode: true })).toBe(true)
  })

  it("keeps an effort-only unpicked resolution out of max mode", () => {
    const params = resolveVariantParameters(opus, { reasoningEffort: "high" })
    expect(params.find((p) => p.id === "effort")?.value).toBe("high")
    expect(resolveVariantMaxMode(params)).toBe(false)
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
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
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

describe("variantsSupportReasoning", () => {
  function variant(parameterValues: ModelVariant["parameterValues"]): ModelVariant {
    return {
      key: "variant",
      displayName: "Variant",
      parameterValues,
      isDefaultNonMax: true,
      isDefaultMax: false,
    }
  }

  const deepseek: ModelInfo = {
    id: "deepseek-v41-flash-1017",
    displayName: "DeepSeek V4.1 Flash 1017",
    supportsThinking: false,
    supportsAgent: true,
    maxContext: 1_048_576,
    variants: [variant([{ id: "reasoning_effort", value: "max" }])],
  }

  it("shares one effort vocabulary with variant resolution", () => {
    for (const id of ["effort", "reasoning", "reasoning_effort"]) {
      // The default is `low`, so only a recognised effort id can select `high`.
      const model: ModelInfo = {
        id: "effort-params",
        variants: [
          variant([{ id, value: "low" }]),
          { ...variant([{ id, value: "high" }]), isDefaultNonMax: false },
        ],
      }
      expect(resolveVariantParameters(model, { reasoningEffort: "high" }), id)
        .toEqual([{ id, value: "high" }])
      expect(variantsSupportReasoning(model.variants), id).toBe(true)
    }
    const unknown: ModelInfo = {
      id: "effort-params",
      variants: [
        variant([{ id: "speed", value: "low" }]),
        { ...variant([{ id: "speed", value: "high" }]), isDefaultNonMax: false },
      ],
    }
    expect(resolveVariantParameters(unknown, { reasoningEffort: "high" })).toEqual([{ id: "speed", value: "low" }])
    expect(variantsSupportReasoning(unknown.variants)).toBe(false)
  })

  it("infers reasoning from non-off effort variants", () => {
    expect(variantsSupportReasoning(deepseek.variants)).toBe(true)
    expect(modelInfoToConfig(deepseek).reasoning).toBe(true)
    expect(modelsToConfig([deepseek])[deepseek.id].reasoning).toBe(true)
  })

  it("lets a published thinking parameter decide, even beside effort values", () => {
    const allThinkingFalse: ModelInfo = {
      ...deepseek,
      variants: [
        variant([{ id: "thinking", value: "false" }, { id: "reasoning_effort", value: "high" }]),
        variant([{ id: "thinking", value: "false" }, { id: "effort", value: "max" }]),
      ],
    }
    expect(variantsSupportReasoning(allThinkingFalse.variants)).toBe(false)
    expect(modelInfoToConfig(allThinkingFalse).reasoning).toBe(false)
    expect(modelsToConfig([allThinkingFalse])[allThinkingFalse.id].reasoning).toBe(false)

    const thinkingTrue: ModelInfo = {
      ...deepseek,
      variants: [variant([{ id: "thinking", value: "true" }, { id: "effort", value: "high" }])],
    }
    expect(variantsSupportReasoning(thinkingTrue.variants)).toBe(true)
    expect(modelInfoToConfig(thinkingTrue).reasoning).toBe(true)

    for (const value of ["true", "enabled", "on"]) {
      expect(variantsSupportReasoning([variant([{ id: "thinking", value }])]), value).toBe(true)
    }
    for (const value of ["false", "off", "disabled", "none", ""]) {
      expect(variantsSupportReasoning([variant([{ id: "thinking", value }])]), value).toBe(false)
    }
  })

  it("does not infer reasoning from off or false variants", () => {
    const off = [
      [{ id: "reasoning_effort", value: "none" }],
      [{ id: "effort", value: "off" }],
      [{ id: "reasoning", value: "FALSE" }],
    ]
    for (const parameterValues of off) {
      const model: ModelInfo = { ...deepseek, variants: [variant(parameterValues)] }
      expect(variantsSupportReasoning(model.variants), JSON.stringify(parameterValues)).toBe(false)
      // Discovery still owns `supportsThinking`; the helper only adds a signal.
      expect(modelInfoToConfig({ ...model, supportsThinking: true }).reasoning).toBe(true)
    }
  })

  it("checks each entry against the variants it advertises", () => {
    const tiered: ModelInfo = {
      id: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      supportsThinking: false,
      maxContext: 200_000,
      variants: [
        {
          key: "base",
          displayName: "Claude Sonnet 5.5",
          parameterValues: [{ id: "context", value: "200k" }, { id: "reasoning_effort", value: "high" }],
          isDefaultNonMax: true,
          isDefaultMax: false,
          isMaxMode: false,
        },
        {
          key: "long",
          displayName: "Claude Sonnet 5.5 1M",
          parameterValues: [{ id: "context", value: "1m" }],
          isDefaultNonMax: false,
          isDefaultMax: true,
          isMaxMode: true,
        },
      ],
    }
    const config = modelsToConfig([tiered])
    expect(Object.keys(config).sort()).toEqual([tiered.id, `${tiered.id}-1m`])
    // The base entry advertises the effort variant; its 1M entry does not.
    expect(config[tiered.id].reasoning).toBe(true)
    expect(config[`${tiered.id}-1m`].reasoning).toBe(false)
  })
})

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

  it("runs an account refresh after an older in-flight cache write", async () => {
    const directory = await tempDir()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const oldRefresh = refreshModelCache(directory, async () => {
      calls.push("old")
      await gate
      return testCache("old-account").models
    })
    const accountRefresh = refreshModelCache(directory, async () => {
      calls.push("new")
      return testCache("new-account").models
    }, { forceAfterInflight: true })

    expect(calls).toEqual(["old"])
    release()
    await Promise.all([oldRefresh, accountRefresh])
    expect(calls).toEqual(["old", "new"])
    expect((await readCache(directory))?.models.map((model) => model.id)).toEqual([
      "new-account",
    ])
  })

  it("force-refreshes a fresh cache for a newly selected account", async () => {
    const directory = await tempDir()
    await writeCache(directory, testCache("old-account"))
    let authorization = null as string | null
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization")
        return Response.json({
          models: [{
            name: "new-account",
            client_display_name: "New Account Model",
            supports_agent: true,
            variants: [],
          }],
        })
      },
    })
    const previousVersion = process.env.CURSOR_CLIENT_VERSION
    process.env.CURSOR_CLIENT_VERSION = "cli-test"
    resetClientVersionCache()
    try {
      const models = await discoverModels("new-account-token", directory, {
        baseURL: server.url.origin,
        forceRefresh: true,
      })
      expect(authorization).toBe("Bearer new-account-token")
      expect(models.map((model) => model.id)).toEqual(["new-account"])
      expect((await readCache(directory))?.models.map((model) => model.id)).toEqual([
        "new-account",
      ])
    } finally {
      if (previousVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = previousVersion
      resetClientVersionCache()
    }
  })

  it("does not serve another account's cache when a forced refresh fails", async () => {
    const directory = await tempDir()
    await writeCache(directory, testCache("old-account"))
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("unauthorized", { status: 401 })
      },
    })
    const previousVersion = process.env.CURSOR_CLIENT_VERSION
    process.env.CURSOR_CLIENT_VERSION = "cli-test"
    resetClientVersionCache()
    try {
      await expect(discoverModels("new-account-token", directory, {
        baseURL: server.url.origin,
        forceRefresh: true,
      })).rejects.toThrow(/authentication failed/i)
      expect((await readCache(directory))?.models.map((model) => model.id)).toEqual([
        "old-account",
      ])
    } finally {
      if (previousVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = previousVersion
      resetClientVersionCache()
    }
  })
})

describe("resolveVariantParameters (declared default is a Fast variant)", () => {
  const variant = (effort: string, fast: boolean, isDefaultNonMax = false) => ({
    key: "grok",
    displayName: `${effort} ${fast ? "fast" : "standard"}`,
    isDefaultNonMax,
    isDefaultMax: false,
    parameterValues: [
      { id: "effort", value: effort },
      { id: "fast", value: String(fast) },
    ],
  })
  // Mirrors Grok 4.6: lowest effort listed first, "High Fast" declared as the default.
  const grok: Parameters<typeof resolveVariantParameters>[0] = {
    id: "grok-4.6",
    maxContext: 256_000,
    maxContextForMaxMode: 256_000,
    variants: [
      variant("low", false),
      variant("low", true),
      variant("medium", false),
      variant("medium", true),
      variant("high", false),
      variant("high", true, true),
    ],
  }

  it("sends the non-Fast twin of the declared default when no hint is given", () => {
    expect(resolveVariantParameters(grok)).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ])
  })

  it("still sends a picked Fast variant verbatim", () => {
    const picked = [
      { id: "effort", value: "low" },
      { id: "fast", value: "true" },
    ]
    expect(resolveVariantParameters(grok, { picked })).toEqual(picked)
  })

  it("keeps a non-Fast declared default as is", () => {
    const plain = {
      ...grok,
      variants: [variant("low", false), variant("medium", false, true), variant("high", false)],
    }
    expect(resolveVariantParameters(plain)).toEqual([
      { id: "effort", value: "medium" },
      { id: "fast", value: "false" },
    ])
  })
})

describe("max mode from Cursor's isMaxMode marker", () => {
  it.each(["isMaxMode", "is_max_mode"])("preserves absent, false and true %s markers through the cache", (key) => {
    const [model] = mapAvailableModelsResponse({ models: [{ name: "optional-marker", variants: [
      { parameterValues: [{ id: "context", value: "1m" }] },
      { [key]: false, parameterValues: [{ id: "context", value: "1000k" }] },
      { [key]: true, parameterValues: [{ id: "context", value: "500k" }] },
    ] }] })
    expect(model!.variants[0]).not.toHaveProperty("isMaxMode")
    expect(model!.variants.map((v) => v.isMaxMode)).toEqual([undefined, false, true])
    const restored = normalizeModelCache(JSON.parse(JSON.stringify({
      models: [model], fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    })))!
    const cached = restored.models[0]!
    expect(cached.variants).toEqual(model!.variants)
    for (const [index, maxMode] of [true, false, true].entries()) {
      const picked = cached.variants[index]!.parameterValues
      expect(resolveVariantMaxMode(picked, { model: cached, picked })).toBe(maxMode)
    }
    expect(resolveVariantParameters(cached, { maxMode: true })).toEqual(cached.variants[0]!.parameterValues)
    expect(resolveVariantParameters(cached, { maxMode: false })).toEqual(cached.variants[1]!.parameterValues)
    for (const invalid of [null, "false", 0]) {
      expect(() => mapAvailableModelsResponse({ models: [{ name: "invalid-marker", variants: [
        { [key]: invalid, parameterValues: [] },
      ] }] })).toThrow(/non-boolean/)
    }
  })

  // AvailableModels JSON shaped like Grok 4.7 (#67): a 500k max tier over a 256k
  // base, `reasoning_effort` ids, Fast variants as both declared defaults, and
  // proto3 JSON omitting false booleans.
  const grokEntry = {
    name: "grok-4.7",
    variants: ["256k", "500k"].flatMap((context) =>
      ["low", "medium", "high"].flatMap((effort) =>
        [false, true].map((fast) => ({
          displayName: `Grok 4.7 ${effort}${fast ? " Fast" : ""}${context === "500k" ? " 500k" : ""}`,
          parameterValues: [
            { id: "context", value: context },
            { id: "reasoning_effort", value: effort },
            { id: "fast", value: String(fast) },
          ],
          ...(context === "500k" ? { isMaxMode: true } : {}),
          ...(effort === "high" && fast && context === "256k" ? { isDefaultNonMaxConfig: true } : {}),
          ...(effort === "high" && fast && context === "500k" ? { isDefaultMaxConfig: true } : {}),
        })),
      ),
    ),
  }
  // GPT-5.2 shape: no context parameter, max default "High Fast", no isMaxMode.
  const gptEntry = {
    name: "gpt-5.2",
    variants: ["low", "medium", "high"].flatMap((reasoning) =>
      [false, true].map((fast) => ({
        displayName: `GPT-5.2 ${reasoning}${fast ? " Fast" : ""}`,
        parameterValues: [
          { id: "reasoning", value: reasoning },
          { id: "fast", value: String(fast) },
        ],
        ...(reasoning === "medium" && !fast ? { isDefaultNonMaxConfig: true } : {}),
        ...(reasoning === "high" && fast ? { isDefaultMaxConfig: true } : {}),
      })),
    ),
  }
  const [grok, gpt] = mapAvailableModelsResponse({ models: [grokEntry, gptEntry] })
  const grok500kHigh = [
    { id: "context", value: "500k" },
    { id: "reasoning_effort", value: "high" },
    { id: "fast", value: "false" },
  ]

  it("records the marker from AvailableModels and keeps it through the cache", () => {
    expect(grok!.variants.filter((v) => v.isMaxMode).map((v) => v.parameterValues[0]!.value))
      .toEqual(Array(6).fill("500k"))
    expect(grok!.variants.filter((v) => v.isMaxMode === undefined)).toHaveLength(6)
    const restored = normalizeModelCache(JSON.parse(JSON.stringify({
      models: [grok], fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    })))
    expect(restored?.models[0]?.variants).toEqual(grok!.variants)
    const malformed = { ...grok!, variants: [{ ...grok!.variants[0]!, isMaxMode: "yes" }] }
    expect(normalizeModelCache({ models: [malformed], fetchedAt: Date.now() })).toBeNull()
  })

  it("runs a picked 500k variant in max mode (#67)", () => {
    const params = resolveVariantParameters(grok, { picked: grok500kHigh })
    expect(params).toEqual(grok500kHigh)
    expect(resolveVariantMaxMode(params, { picked: grok500kHigh, model: grok })).toBe(true)
    const base = grok500kHigh.map((p) => (p.id === "context" ? { ...p, value: "256k" } : p))
    expect(resolveVariantMaxMode(base, { picked: base, model: grok })).toBe(false)
  })

  it("takes the non-Fast twin of a Fast declared max default for a maxMode hint", () => {
    const params = resolveVariantParameters(grok, { maxMode: true })
    expect(params).toEqual(grok500kHigh)
    expect(resolveVariantMaxMode(params, { maxMode: true, model: grok })).toBe(true)
    expect(resolveVariantParameters(gpt, { maxMode: true })).toEqual([
      { id: "reasoning", value: "high" },
      { id: "fast", value: "false" },
    ])
    expect(resolveVariantParameters(gpt)).toEqual([
      { id: "reasoning", value: "medium" },
      { id: "fast", value: "false" },
    ])
  })

  it("matches an effort hint within the marked max tier", () => {
    expect(resolveVariantParameters(grok, { maxMode: true, reasoningEffort: "low" })).toEqual([
      { id: "context", value: "500k" },
      { id: "reasoning_effort", value: "low" },
      { id: "fast", value: "false" },
    ])
  })
})
