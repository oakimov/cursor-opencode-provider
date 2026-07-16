import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CursorPlugin, modelInfoToConfig, thinkingSuffixBaseNames } from "../src/plugin.js"
import { CURSOR_VARIANT_PARAMETERS_KEY, readCache, writeCache, type ModelInfo } from "../src/models.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { resetAgentUrlCache } from "../src/agent-url.js"
import { CURSOR_COMPACTION_OPTION } from "../src/shared.js"

// Characters safeLabel must remove from emitted names/keys (issue #2).
const INVALID = new RegExp("[()<>&\"'`]")
const variantParams = (params: Array<{ id: string; value: string }>) => ({
  [CURSOR_VARIANT_PARAMETERS_KEY]: params,
})

describe("modelInfoToConfig", () => {
  it("strips markup-breaking chars and parens from name + variant keys, keeps names readable", () => {
    // The HTML-tag strip keeps inner text, so <span>…</span>Opus becomes Opus.
    const mi: ModelInfo = {
      id: "claude-opus-4-8",
      displayName: 'Claude <span style="color: var(--cursor-text-tertiary);">Opus</span> 4.8',
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

    // Model name: HTML tags stripped, parens and markup chars gone, the
    // plain-text tokens adjacent to the markup are preserved.
    expect(config.name).toBe("Claude Opus 4.8")
    expect(config.name).not.toMatch(INVALID)

    // Variant keys: parens removed, no markup chars, unique, params intact.
    const keys = Object.keys(config.variants)
    expect(keys).toEqual(["Claude Opus 4.8 Low", "Claude Opus 4.8 Max"])
    for (const k of keys) expect(k).not.toMatch(INVALID)
    expect(config.variants["Claude Opus 4.8 Low"]).toEqual(
      variantParams([{ id: "effort", value: "low" }]),
    )
    expect(config.variants["Claude Opus 4.8 Max"]).toEqual(
      variantParams([{ id: "effort", value: "max" }]),
    )
  })

  it("leaves already-clean names unchanged and omits variants when none exist", () => {
    const mi: ModelInfo = { id: "gpt-5", displayName: "GPT 5", variants: [] }
    const config = modelInfoToConfig(mi)
    expect(config.name).toBe("GPT 5")
    expect(config.variants).toBeUndefined()
  })

  it("disambiguates variants that share a display name by tagging distinguishing params", () => {
    // Mirrors Cursor's Composer 2.5: both variants render the same base
    // display name (the "Fast" suffix is in a <span> that safeLabel drops);
    // without disambiguation the colliding variant would silently overwrite
    // the first under the same key. The first variant's key also gets
    // suffixed so it never equals the model name itself.
    const mi: ModelInfo = {
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

    const config = modelInfoToConfig(mi)
    const keys = Object.keys(config.variants)
    expect(keys).toHaveLength(2)
    expect(keys).toEqual(["Composer 2.5 default", "Composer 2.5 Fast"])
    expect(config.variants["Composer 2.5 default"]).toEqual(
      variantParams([{ id: "fast", value: "false" }]),
    )
    expect(config.variants["Composer 2.5 Fast"]).toEqual(
      variantParams([{ id: "fast", value: "true" }]),
    )
  })

  it("disambiguates variant keys that collide after sanitization", () => {
    // Two variants share a sanitized display name and differ only by the
    // `fast` param; the second should be tagged Fast so the picker keeps
    // both visible.
    const mi: ModelInfo = {
      id: "m",
      variants: [
        {
          key: "m",
          displayName: "Same (x)",
          isDefaultNonMax: true,
          isDefaultMax: false,
          parameterValues: [{ id: "fast", value: "false" }],
        },
        {
          key: "m",
          displayName: "Same (x)",
          isDefaultNonMax: false,
          isDefaultMax: true,
          parameterValues: [{ id: "fast", value: "true" }],
        },
      ],
    }
    const config = modelInfoToConfig(mi)
    expect(Object.keys(config.variants)).toEqual(["Same x", "Same x Fast"])
    expect(config.variants["Same x"]).toEqual(
      variantParams([{ id: "fast", value: "false" }]),
    )
    expect(config.variants["Same x Fast"]).toEqual(
      variantParams([{ id: "fast", value: "true" }]),
    )
  })

  it("falls back to default when the colliding variant has no distinguishing param", () => {
    const mi: ModelInfo = {
      id: "m",
      displayName: "M",
      variants: [
        { key: "m", displayName: "M", isDefaultNonMax: true, isDefaultMax: false,
          parameterValues: [{ id: "effort", value: "low" }] },
        { key: "m", displayName: "M", isDefaultNonMax: false, isDefaultMax: true,
          parameterValues: [{ id: "effort", value: "high" }] },
      ],
    }
    const config = modelInfoToConfig(mi)
    // First variant collides with the model name itself, gets suffixed.
    // Second variant collides with the first, also gets default since
    // "effort" is not in the distinguishing set.
    expect(Object.keys(config.variants)).toEqual(["M default", "M default 2"])
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

describe("CursorPlugin compaction marker", () => {
  it("marks only the OpenCode compaction agent in provider options", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const compaction = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]?.({
      sessionID: "ses_1",
      agent: "compaction",
      model: { providerID: "cursor" },
    } as never, compaction as never)
    expect(compaction.options[CURSOR_COMPACTION_OPTION]).toBe(true)

    const normal = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]?.({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "cursor" },
    } as never, normal as never)
    expect(normal.options[CURSOR_COMPACTION_OPTION]).toBeUndefined()
  })
})

const originalHome = process.env.HOME
const originalXdgCache = process.env.XDG_CACHE_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const originalTelemetry = process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCache
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  if (originalTelemetry === undefined) delete process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY
  else process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY = originalTelemetry
})

describe("CursorPlugin config hook", () => {
  it("loads cached models from ~/.cache/opencode, not input.directory", async () => {
    const fakeHome = path.join(os.tmpdir(), `cursor-plugin-test-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_CACHE_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
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
    delete process.env.OPENCODE_AUTH_CONTENT
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

function fakeJwt(expOffsetSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64")
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }),
  ).toString("base64")
  return `${header}.${payload}.sig`
}

const INSTALLER_FIXTURE = `
DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.07.09-a3815c0/\${OS}/\${ARCH}/agent-cli-package.tar.gz"
`

describe("loadModels on cache miss", () => {
  let fakeHome: string
  let projectDir: string
  let cacheDir: string
  let dataDir: string
  let realFetch: typeof globalThis.fetch
  let availableModelsCalls: number
  let serverConfigCalls: number
  let serverConfigBodies: string[]
  let refreshCalls: number
  let persisted: unknown[]

  async function writeAuth(cursor: unknown): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, "auth.json"), JSON.stringify({ cursor }))
  }

  function pluginInput() {
    return {
      directory: projectDir,
      client: {
        auth: {
          set: async (opts: { body: unknown }) => {
            persisted.push(opts.body)
            return { data: true }
          },
        },
      },
    } as never
  }

  beforeEach(async () => {
    fakeHome = path.join(os.tmpdir(), `cursor-miss-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY
    projectDir = path.join(fakeHome, "project")
    cacheDir = path.join(fakeHome, ".cache", "opencode")
    dataDir = path.join(fakeHome, ".local", "share", "opencode")
    await mkdir(projectDir, { recursive: true })
    availableModelsCalls = 0
    serverConfigCalls = 0
    serverConfigBodies = []
    refreshCalls = 0
    persisted = []
    realFetch = globalThis.fetch
    resetClientVersionCache()
    resetAgentUrlCache()

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/auth/token")) {
        refreshCalls += 1
        return Response.json({
          accessToken: fakeJwt(3600),
          refreshToken: "new-refresh",
        })
      }
      if (url.includes("AvailableModels")) {
        availableModelsCalls += 1
        return Response.json({
          models: [{ name: "fetched-model", clientDisplayName: "Fetched" }],
        })
      }
      if (url.includes("GetServerConfig")) {
        serverConfigCalls += 1
        serverConfigBodies.push(typeof init?.body === "string" ? init.body : "")
        return Response.json({
          agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" },
        })
      }
      if (url.includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    resetClientVersionCache()
    resetAgentUrlCache()
    await rm(fakeHome, { recursive: true, force: true })
  })

  it("fetches and caches models when oauth auth exists and cache is empty", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(3600),
      refresh: "refresh-tok",
      expires: Date.now() + 3_600_000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(availableModelsCalls).toBe(1)
    expect(refreshCalls).toBe(0)
    expect((await readCache(cacheDir))?.models[0]?.id).toBe("fetched-model")
  })

  it("refreshes an old-schema nonempty cache before config materializes models", async () => {
    await writeCache(cacheDir, {
      fetchedAt: Date.now(),
      models: [{ id: "stale-model", displayName: "Stale", variants: [] }],
    })
    await writeAuth({
      type: "oauth",
      access: fakeJwt(3600),
      refresh: "refresh-tok",
      expires: Date.now() + 3_600_000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(config.provider?.cursor?.models).not.toHaveProperty("stale-model")
    expect(availableModelsCalls).toBe(1)
    expect(await readCache(cacheDir)).toMatchObject({
      schemaVersion: 2,
      models: [{ id: "fetched-model" }],
    })
  })

  it("refreshes expired oauth, preserves extras, then fetches models", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(-60),
      refresh: "old-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-1",
      enterpriseUrl: "https://enterprise.example",
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(refreshCalls).toBe(1)
    expect(availableModelsCalls).toBe(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      type: "oauth",
      refresh: "new-refresh",
      accountId: "acct-1",
      enterpriseUrl: "https://enterprise.example",
    })
  })

  it("returns empty models when auth.json is absent", async () => {
    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toEqual({})
    expect(availableModelsCalls).toBe(0)
  })

  it("returns empty models when oauth refresh is missing and token is expired", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(-60),
      refresh: "",
      expires: Date.now() - 60_000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toEqual({})
    expect(availableModelsCalls).toBe(0)
    expect(refreshCalls).toBe(0)
    expect(persisted).toHaveLength(0)
  })

  it("returns empty models when refresh fails and does not persist half-state", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(-60),
      refresh: "bad-refresh",
      expires: Date.now() - 60_000,
      enterpriseUrl: "https://enterprise.example",
    })

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/auth/token")) {
        refreshCalls += 1
        return new Response("nope", { status: 500 })
      }
      if (url.includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toEqual({})
    expect(refreshCalls).toBe(1)
    expect(availableModelsCalls).toBe(0)
    expect(persisted).toHaveLength(0)
  })

  it("still uses refreshed oauth token when persistAuth fails", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(-60),
      refresh: "old-refresh",
      expires: Date.now() - 60_000,
    })

    const plugin = await CursorPlugin({
      directory: projectDir,
      client: {
        auth: {
          set: async () => {
            throw new Error("auth.set failed")
          },
        },
      },
    } as never)
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(refreshCalls).toBe(1)
    expect(availableModelsCalls).toBe(1)
  })

  it("fetches and caches models when api auth exists and cache is empty", async () => {
    await writeAuth({
      type: "api",
      key: fakeJwt(3600),
      metadata: { refreshToken: "api-refresh" },
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(availableModelsCalls).toBe(1)
    expect(refreshCalls).toBe(0)
    expect((await readCache(cacheDir))?.models[0]?.id).toBe("fetched-model")
  })

  it("refreshes expired api key via metadata.refreshToken, then fetches models", async () => {
    await writeAuth({
      type: "api",
      key: fakeJwt(-60),
      metadata: { refreshToken: "api-refresh", note: "keep-me" },
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(refreshCalls).toBe(1)
    expect(availableModelsCalls).toBe(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      type: "api",
      metadata: { refreshToken: "new-refresh", note: "keep-me" },
    })
  })

  it("loader skips discoverModels when config already wrote a fresh cache", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(3600),
      refresh: "refresh-tok",
      expires: Date.now() + 3_600_000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)
    expect(availableModelsCalls).toBe(1)

    const auth = plugin.auth
    if (!auth || !("loader" in auth) || !auth.loader) throw new Error("missing loader")
    await auth.loader(async () => ({
      type: "oauth",
      access: fakeJwt(3600),
      refresh: "refresh-tok",
      expires: Date.now() + 3_600_000,
    }), {} as never)

    // Fresh cache from config — no second AvailableModels (and no background kick).
    expect(availableModelsCalls).toBe(1)
    expect(serverConfigCalls).toBe(1)
    expect(JSON.parse(serverConfigBodies[0])).toEqual({ telem_enabled: false })
  })

  it("loader honors CURSOR_GET_SERVER_CONFIG_TELEMETRY for agent-url warmup", async () => {
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY = "1"
    await writeAuth({
      type: "oauth",
      access: fakeJwt(3600),
      refresh: "refresh-tok",
      expires: Date.now() + 3_600_000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    const auth = plugin.auth
    if (!auth || !("loader" in auth) || !auth.loader) throw new Error("missing loader")
    await auth.loader(async () => ({
      type: "oauth",
      access: fakeJwt(3600),
      refresh: "refresh-tok",
      expires: Date.now() + 3_600_000,
    }), {} as never)

    expect(serverConfigCalls).toBe(1)
    expect(JSON.parse(serverConfigBodies[0])).toEqual({ telem_enabled: true })
  })

  it("loader falls back to session token when getAuth refresh fails after config already refreshed", async () => {
    await writeAuth({
      type: "oauth",
      access: fakeJwt(-60),
      refresh: "one-shot-refresh",
      expires: Date.now() - 60_000,
    })

    let refreshPhase = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/auth/token")) {
        refreshCalls += 1
        refreshPhase += 1
        if (refreshPhase === 1) {
          return Response.json({
            accessToken: fakeJwt(3600),
            refreshToken: "new-refresh",
          })
        }
        return new Response("reuse denied", { status: 401 })
      }
      if (url.includes("AvailableModels")) {
        availableModelsCalls += 1
        return Response.json({
          models: [{ name: "fetched-model", clientDisplayName: "Fetched" }],
        })
      }
      if (url.includes("GetServerConfig")) {
        return Response.json({
          agentUrlConfig: { agentnUrl: "https://agentn.us.api5.cursor.sh" },
        })
      }
      if (url.includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const plugin = await CursorPlugin({
      directory: projectDir,
      client: {
        auth: {
          set: async () => {
            throw new Error("auth.set failed")
          },
        },
      },
    } as never)
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)
    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")

    const auth = plugin.auth
    if (!auth || !("loader" in auth) || !auth.loader) throw new Error("missing loader")
    // getAuth still returns pre-refresh credentials; second refresh fails.
    const opts = await auth.loader(async () => ({
      type: "oauth",
      access: fakeJwt(-60),
      refresh: "one-shot-refresh",
      expires: Date.now() - 60_000,
    }), {} as never)

    expect(opts.accessToken).toBeDefined()
    expect(availableModelsCalls).toBe(1)
  })
})
