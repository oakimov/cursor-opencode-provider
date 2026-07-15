import { describe, it, expect, afterEach } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CursorPlugin, modelInfoToConfig, thinkingSuffixBaseNames } from "../src/plugin.js"
import { writeCache, type ModelInfo } from "../src/models.js"

// Characters safeLabel must remove from emitted names/keys (issue #2).
const INVALID = new RegExp("[()<>&\"'`]")

describe("modelInfoToConfig", () => {
  it("strips markup-breaking chars and parens from name + variant keys, keeps names readable", () => {
    const mi: ModelInfo = {
      id: "claude-opus-4-8",
      displayName: 'Claude <opus> "4.8"',
      supportsThinking: false,
      supportsAgent: true,
      maxContext: 300000,
      supportsMaxMode: true,
      variants: [
        {
          key: "claude-opus-4-8",
          displayName: "Claude Opus 4.8 (Low)",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [{ id: "effort", value: "low" }],
        },
        {
          key: "claude-opus-4-8",
          displayName: "Claude Opus 4.8 (Max)",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [{ id: "effort", value: "max" }],
        },
      ],
    }

    const config = modelInfoToConfig(mi)

    // Model name: < > " removed, readable text preserved.
    expect(config.name).toBe("Claude opus 4.8")
    expect(config.name).not.toMatch(INVALID)

    // Variant keys: parens removed, no markup chars, unique, params intact.
    const keys = Object.keys(config.variants)
    expect(keys).toEqual(["Claude Opus 4.8 Low", "Claude Opus 4.8 Max"])
    for (const k of keys) expect(k).not.toMatch(INVALID)
    expect(config.variants["Claude Opus 4.8 Low"]).toEqual({ effort: "low" })
    expect(config.variants["Claude Opus 4.8 Max"]).toEqual({ effort: "max" })
  })

  it("leaves already-clean names unchanged and omits variants when none exist", () => {
    const mi: ModelInfo = { id: "gpt-5", displayName: "GPT 5", variants: [] }
    const config = modelInfoToConfig(mi)
    expect(config.name).toBe("GPT 5")
    expect(config.variants).toBeUndefined()
  })

  it("disambiguates variant keys that collide after sanitization", () => {
    const mi: ModelInfo = {
      id: "m",
      variants: [
        {
          key: "m",
          displayName: "Same (x)",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [{ id: "effort", value: "low" }],
        },
        {
          key: "m",
          displayName: "Same (x)",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [{ id: "effort", value: "high" }],
        },
      ],
    }
    const config = modelInfoToConfig(mi)
    expect(Object.keys(config.variants)).toEqual(["Same x", "Same x--2"])
    expect(config.variants["Same x"]).toEqual({ effort: "low" })
    expect(config.variants["Same x--2"]).toEqual({ effort: "high" })
  })

  it("tags only the thinking model of an ambiguous pair (Cursor's Claude convention)", () => {
    // Real pair from cursor-models.json: same displayName, differs only by -thinking-.
    const models: ModelInfo[] = [
      { id: "claude-opus-4-8-low", displayName: "Opus 4.8 Low", supportsThinking: false, variants: [] },
      { id: "claude-opus-4-8-thinking-low", displayName: "Opus 4.8 Low", supportsThinking: true, variants: [] },
    ]
    const ambiguous = thinkingSuffixBaseNames(models)
    expect(ambiguous).toEqual(new Set(["Opus 4.8 Low"]))

    const standard = modelInfoToConfig(models[0], { thinkingSuffix: false })
    const thinking = modelInfoToConfig(models[1], {
      thinkingSuffix: ambiguous.has("Opus 4.8 Low"),
    })
    expect(standard.name).toBe("Opus 4.8 Low")
    expect(thinking.name).toBe("Opus 4.8 Low Thinking")
  })

  it("leaves GPT models untagged when the tier is already baked into the name (incl. 'None')", () => {
    // Cursor's GPT family encodes the reasoning tier in the displayName itself,
    // so no two share a base name across the thinking/non-thinking boundary.
    const models: ModelInfo[] = [
      { id: "gpt-5.5-none", displayName: "GPT-5.5 None", supportsThinking: false, variants: [] },
      { id: "gpt-5.5-low", displayName: "GPT-5.5 Low", supportsThinking: true, variants: [] },
      { id: "gpt-5.5-medium", displayName: "GPT-5.5", supportsThinking: true, variants: [] },
      { id: "gpt-5.5-high", displayName: "GPT-5.5 High", supportsThinking: true, variants: [] },
    ]
    expect(thinkingSuffixBaseNames(models)).toEqual(new Set())
    for (const m of models) {
      expect(modelInfoToConfig(m, { thinkingSuffix: false }).name).toBe(m.displayName)
    }
  })
})

const originalHome = process.env.HOME
const originalXdgCache = process.env.XDG_CACHE_HOME

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCache
})

describe("CursorPlugin config hook", () => {
  it("loads cached models from ~/.cache/opencode, not input.directory", async () => {
    const fakeHome = path.join(os.tmpdir(), `cursor-plugin-test-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_CACHE_HOME
    const projectDir = path.join(fakeHome, "project")
    const cacheDir = path.join(fakeHome, ".cache", "opencode")
    await mkdir(cacheDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await writeCache(cacheDir, {
      fetchedAt: Date.now(),
      models: [{ id: "cursor-test-model", variants: [] }],
    })

    try {
      const plugin = await CursorPlugin({ directory: projectDir } as never)
      const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
      await plugin.config?.(config as never)

      expect(config.provider?.cursor?.models).toHaveProperty("cursor-test-model")
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it("loads cached models from $XDG_CACHE_HOME/opencode when set", async () => {
    const fakeHome = path.join(os.tmpdir(), `cursor-plugin-test-${process.pid}-${Date.now()}`)
    const xdgCache = path.join(fakeHome, "xdg-cache")
    process.env.HOME = fakeHome
    process.env.XDG_CACHE_HOME = xdgCache
    const projectDir = path.join(fakeHome, "project")
    const cacheDir = path.join(xdgCache, "opencode")
    await mkdir(cacheDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await writeCache(cacheDir, {
      fetchedAt: Date.now(),
      models: [{ id: "cursor-xdg-model", variants: [] }],
    })

    try {
      const plugin = await CursorPlugin({ directory: projectDir } as never)
      const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
      await plugin.config?.(config as never)

      expect(config.provider?.cursor?.models).toHaveProperty("cursor-xdg-model")
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })
})
