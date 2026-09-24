import { describe, expect, test, beforeEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin-opencode2.js"
import { CursorPlugin } from "../src/plugin.js"
import { applyCursorProviderInventory, CURSOR_AISDK_PACKAGE } from "../src/opencode2/catalog.js"
import { applyCursorIntegration, accessTokenFromCredential } from "../src/opencode2/integration.js"
import { clearCompactionSessions, isCompactionSession, markCompactionSession } from "../src/compaction-marker.js"
import { clearSessionDirectories, getSessionDirectory } from "../src/session-directory.js"
import {
  flushPlanExecutionKickoff,
  hasPlanExecutionKickoff,
  queuePlanExecutionKickoff,
  resetPlanExecutionKickoffForTests,
} from "../src/plan-execution-kickoff.js"
import {
  flushHostAgentModeSwitch,
  queueHostAgentModeSwitch,
  resetHostAgentModeSwitchForTests,
} from "../src/host-agent-mode.js"
import { registerCursorShellCall } from "../src/shell-timeout.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { writeCache } from "../src/models.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import {
  getActiveCursorMode,
  resetActiveCursorModesForTests,
  setActiveCursorMode,
} from "../src/protocol/switch-mode.js"
import type {
  IntegrationDraft,
  IntegrationMethodRegistration,
  ModelInfo2,
  ProviderEditor,
  ProviderInfo,
} from "../src/opencode2/types.js"
import type { ModelInfo } from "../src/models.js"

// ── Fake provider editor ──

function fakeProviderEditor() {
  const providers = new Map<string, ProviderInfo>()
  const models = new Map<string, ModelInfo2>()
  const editor: ProviderEditor = {
    add(input) {
      providers.set(input.info.id, { ...input.info })
      for (const key of [...models.keys()]) {
        if (key.startsWith(`${input.info.id}/`)) models.delete(key)
      }
      for (const model of input.models) {
        models.set(`${input.info.id}/${model.id}`, { ...model, providerID: input.info.id })
      }
    },
  }
  return { editor, providers, models }
}

/** Host-shaped editor: extra methods exist, but publishing must go through `add`. */
function fakeHostProviderEditor() {
  const inner = fakeProviderEditor()
  const calls: string[] = []
  const unused = (name: string) => {
    calls.push(name)
    throw new Error(`${name} is not how this plugin publishes the Cursor inventory`)
  }
  const editor = {
    list: () => unused("list"),
    get: () => unused("get"),
    add(input: { info: ProviderInfo; models: readonly ModelInfo2[] }) {
      calls.push("add")
      inner.editor.add(input)
    },
    update: () => unused("update"),
    remove: () => unused("remove"),
    models: {
      set: () => unused("models.set"),
      update: () => unused("models.update"),
      remove: () => unused("models.remove"),
    },
  }
  return { editor, providers: inner.providers, models: inner.models, calls }
}

const baseModel: ModelInfo = {
  id: "claude-4.5-sonnet",
  displayName: "Sonnet 4.5",
  supportsAgent: true,
  supportsThinking: false,
  supportsImages: true,
  maxContext: 200_000,
  variants: [],
}

describe("opencode2 provider inventory", () => {
  test("skips registration while the inventory is empty", () => {
    const { editor, providers, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [])
    expect(providers.size).toBe(0)
    expect(models.size).toBe(0)
  })

  test("registers the cursor provider on the aisdk path with an integration link", () => {
    const { editor, providers } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])

    const provider = providers.get("cursor")
    expect(provider).toBeDefined()
    expect(provider!.package).toBe(CURSOR_AISDK_PACKAGE)
    // `aisdk:` is what selects the hook-driven path we supply the SDK through.
    expect(provider!.package.startsWith("aisdk:")).toBe(true)
    expect(provider!.integrationID).toBe("cursor")
    expect(provider!.activation).toBe("enabled")
  })

  test("maps a model into the 2.0 shape", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])

    const model = models.get("cursor/claude-4.5-sonnet")
    expect(model).toBeDefined()
    expect(model!.name).toBe("Sonnet 4.5")
    expect(model!.modelID).toBe("claude-4.5-sonnet")
    expect(model!.capabilities.tools).toBe(true)
    expect(model!.capabilities.input).toEqual(["text", "image"])
    expect(model!.capabilities.output).toEqual(["text"])
    expect(model!.limit.context).toBe(200_000)
    expect(model!.enabled).toBe(true)
    // Test fixture uses a legacy id that is not in the current pricing table.
    expect(model!.cost).toEqual([])
  })

  test("attaches published Cursor token rates to catalog cost tiers", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        ...baseModel,
        id: "claude-sonnet-4-5",
        displayName: "Sonnet 4.5",
      },
    ])

    const model = models.get("cursor/claude-sonnet-4-5")
    expect(model!.cost).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    ])
  })

  test("long-context entries keep a distinct id but address the same wire model", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        ...baseModel,
        maxContextForMaxMode: 1_000_000,
        variants: [
          {
            key: "base",
            displayName: "Sonnet 4.5",
            parameterValues: [],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
          {
            key: "max",
            displayName: "Sonnet 4.5 1M",
            parameterValues: [{ id: "context", value: "1000000" }],
            isDefaultNonMax: false,
            isDefaultMax: true,
          },
        ],
      },
    ])

    const long = models.get("cursor/claude-4.5-sonnet-1m")
    expect(long).toBeDefined()
    // Synthetic OpenCode id, real Cursor id on the wire.
    expect(long!.id).toBe("claude-4.5-sonnet-1m")
    expect(long!.modelID).toBe("claude-4.5-sonnet")
    expect(long!.limit.context).toBe(1_000_000)
  })

  test("Fast entries keep a distinct id but address the same wire model", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        supportsAgent: true,
        variants: [
          {
            key: "slow",
            displayName: "Composer 2.5",
            parameterValues: [{ id: "fast", value: "false" }],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
          {
            key: "fast",
            displayName: "Composer 2.5 Fast",
            parameterValues: [{ id: "fast", value: "true" }],
            isDefaultNonMax: false,
            isDefaultMax: true,
          },
        ],
      },
    ])

    const fast = models.get("cursor/composer-2.5-fast")
    expect(fast).toBeDefined()
    expect(fast!.id).toBe("composer-2.5-fast")
    expect(fast!.modelID).toBe("composer-2.5")
    expect(fast!.name).toBe("Composer 2.5 Fast")
    expect(fast!.cost).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.5, write: 0 },
      },
    ])
  })

  test("variants become an array carrying their parameters in settings", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        ...baseModel,
        variants: [
          {
            key: "thinking",
            displayName: "Sonnet 4.5 Thinking",
            parameterValues: [{ id: "thinking", value: "true" }],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
        ],
      },
    ])

    const model = models.get("cursor/claude-4.5-sonnet")!
    expect(Array.isArray(model.variants)).toBe(true)
    expect(model.variants).toHaveLength(1)
    expect(model.variants[0].id).toBe("Sonnet 4.5 Thinking")
    expect(model.variants[0].settings).toBeDefined()
  })

  test("re-applying is idempotent (host replays transforms on reload)", () => {
    const { editor, models, providers } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])
    applyCursorProviderInventory(editor, [baseModel])

    expect(providers.size).toBe(1)
    expect(models.size).toBe(1)
  })

  test("replaces the previous inventory instead of merging", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      baseModel,
      { ...baseModel, id: "gpt-5", displayName: "GPT-5" },
    ])
    expect(models.has("cursor/gpt-5")).toBe(true)

    applyCursorProviderInventory(editor, [baseModel])
    expect([...models.keys()]).toEqual(["cursor/claude-4.5-sonnet"])
  })

  test("binds sourceConnection onto editor.add when provided", () => {
    const seen: unknown[] = []
    const editor: ProviderEditor = {
      add(input) {
        seen.push(input.sourceConnection)
      },
    }
    applyCursorProviderInventory(editor, [baseModel], { type: "env", name: "CURSOR_API_KEY" })
    expect(seen).toEqual([{ type: "env", name: "CURSOR_API_KEY" }])
  })

  test("publishes through editor.add on a host-shaped editor", () => {
    const { editor, providers, models, calls } = fakeHostProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])

    expect(calls).toEqual(["add"])
    expect(providers.get("cursor")?.package.startsWith("aisdk:")).toBe(true)
    expect(models.get("cursor/claude-4.5-sonnet")?.modelID).toBe("claude-4.5-sonnet")
  })
})

// ── Fake integration draft ──

function fakeIntegrationDraft() {
  const refs = new Map<string, { id: string; name: string }>()
  const methods: IntegrationMethodRegistration[] = []
  const draft: IntegrationDraft = {
    update(id, update) {
      const current = refs.get(id) ?? { id, name: id }
      refs.set(id, current)
      update(current)
    },
    method: {
      update(input) {
        methods.push(input)
      },
    },
  }
  return { draft, refs, methods }
}

describe("opencode2 integration", () => {
  test("registers oauth, key, and env connection methods", () => {
    const { draft, refs, methods } = fakeIntegrationDraft()
    applyCursorIntegration(draft)

    expect(refs.get("cursor")?.name).toBe("Cursor")
    const types = methods.map((m) => m.method.type)
    expect(types).toContain("oauth")
    expect(types).toContain("key")
    expect(types).toContain("env")
  })

  test("the oauth method supplies authorize and refresh", () => {
    const { draft, methods } = fakeIntegrationDraft()
    applyCursorIntegration(draft)

    const oauth = methods.find((m) => m.method.type === "oauth")
    expect(oauth).toBeDefined()
    // Promise-valued in 2.0 (Effect-valued in the 1.18 v2 API).
    expect(typeof (oauth as any).authorize).toBe("function")
    expect(typeof (oauth as any).refresh).toBe("function")
  })

  test("env method advertises CURSOR_API_KEY", () => {
    const { draft, methods } = fakeIntegrationDraft()
    applyCursorIntegration(draft)

    const env = methods.find((m) => m.method.type === "env")
    expect((env!.method as any).names).toContain("CURSOR_API_KEY")
  })

  test("a non-expiring oauth credential is used as-is", async () => {
    // exp far in the future
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 }),
    ).toString("base64url")
    const jwt = `h.${payload}.s`
    const token = await accessTokenFromCredential({
      type: "oauth",
      methodID: "oauth",
      access: jwt,
      refresh: "r",
      expires: Date.now() + 86_400_000,
    })
    expect(token).toBe(jwt)
  })

  test("an already-exchanged key credential is passed through unchanged", async () => {
    // Non-`crsr_` keys are treated as JWTs, so no network exchange is attempted.
    const token = await accessTokenFromCredential({ type: "key", key: "already.a.jwt" })
    expect(token).toBe("already.a.jwt")
  })

  test("a missing credential yields no token", async () => {
    expect(await accessTokenFromCredential(undefined)).toBeUndefined()
  })
})

describe("compaction marker", () => {
  beforeEach(() => clearCompactionSessions())

  test("records and clears by session id", () => {
    markCompactionSession("s1", true)
    expect(isCompactionSession("s1")).toBe(true)
    markCompactionSession("s1", false)
    expect(isCompactionSession("s1")).toBe(false)
  })

  test("ignores unknown and undefined session ids", () => {
    expect(isCompactionSession("nope")).toBe(false)
    expect(isCompactionSession(undefined)).toBe(false)
  })

  test("is bounded so a long-lived server cannot leak session ids", () => {
    for (let i = 0; i < 300; i++) markCompactionSession(`s${i}`, true)
    // Oldest entries evicted; newest retained.
    expect(isCompactionSession("s299")).toBe(true)
    expect(isCompactionSession("s0")).toBe(false)
  })
})

describe("opencode2 plugin shape", () => {
  test("default export is a 2.0 plugin definition", () => {
    expect(plugin.id).toBe("cursor.provider")
    expect(typeof plugin.setup).toBe("function")
    expect(plugin.server).toBe(CursorPlugin)
  })
})

// ── setup() against a fake host context ──

function fakeContext(events: readonly unknown[] = []) {
  const registered: string[] = []
  const disposed: string[] = []
  const reloads: string[] = []
  const hooks = new Map<string, (input: any) => any>()
  const transforms = new Map<string, (draft: any) => void>()
  const inventory = fakeProviderEditor()

  const registration = (label: string) => {
    registered.push(label)
    return { dispose: async () => void disposed.push(label) }
  }
  const hookDomain = (domain: string) => ({
    hook: async (name: string, callback: (input: any) => any) => {
      hooks.set(`${domain}.${name}`, callback)
      return registration(`${domain}.${name}`)
    },
  })
  const transformDomain = (domain: string) => ({
    transform: async (callback: (draft: any) => void) => {
      transforms.set(domain, callback)
      return registration(`${domain}.transform`)
    },
    reload: async () => {},
  })

  let activeConnection: any = undefined
  const sessionLocations = new Map<string, string>()

  const ctx: any = {
    app: { name: "opencode", version: "2.0", channel: "latest" },
    location: { directory: "/workspace" },
    options: {},
    aisdk: hookDomain("aisdk"),
    event: {
      subscribe: () => events.length
        ? (async function* () {
            for (const event of events) yield event
          })()
        : undefined,
    },
    integration: {
      ...transformDomain("integration"),
      connection: {
        active: async () => activeConnection,
        resolve: async () => undefined,
      },
    },
    session: {
      ...hookDomain("session"),
      get: async ({ sessionID }: { sessionID: string }) => {
        const directory = sessionLocations.get(sessionID)
        if (!directory) throw new Error(`no fake location for session ${sessionID}`)
        return { id: sessionID, location: { directory } }
      },
      switchAgent: async () => {},
      synthetic: async () => ({}),
      prompt: async () => ({}),
    },
    websearch: transformDomain("websearch"),
    shell: hookDomain("shell"),
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.set("provider", callback)
        return registration("provider.transform")
      },
      reload: async () => {
        reloads.push("provider")
        transforms.get("provider")?.(inventory.editor)
      },
    },
  }
  ctx.tool = {
    hook: hookDomain("tool").hook,
    transform: transformDomain("tool").transform,
  }

  return { ctx, registered, disposed, hooks, transforms, sessionLocations, reloads, inventory }
}

describe("opencode2 setup", () => {
  beforeEach(() => {
    resetPlanExecutionKickoffForTests()
    resetHostAgentModeSwitchForTests()
    resetActiveCursorModesForTests()
  })

  test("reloads the provider inventory from cache without writing opencode.json", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-config-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCache(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, registered, reloads, inventory } = fakeContext()

      const cleanup = await plugin.setup(ctx)

      expect(registered).toContain("provider.transform")
      expect(reloads).toEqual(["provider"])
      expect(inventory.providers.get("cursor")?.package).toContain("aisdk:")
      expect(inventory.providers.get("cursor")?.integrationID).toBe("cursor")
      expect(inventory.models.get(`cursor/${baseModel.id}`)?.providerID).toBe("cursor")
      expect(existsSync(join(configDir, "opencode.json"))).toBe(false)
      expect(existsSync(join(configDir, "opencode.jsonc"))).toBe(false)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("does not rewrite an existing opencode.json", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-broken-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    const existing = '{ "plugin": ["example"] }\n'
    const path = join(configDir, "opencode.json")
    writeFileSync(path, existing)
    try {
      await writeCache(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx } = fakeContext()
      const cleanup = await plugin.setup(ctx)
      expect(readFileSync(path, "utf8")).toBe(existing)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("registers every domain it needs and returns a cleanup", async () => {
    const { ctx, registered, transforms } = fakeContext()
    const cleanup = await plugin.setup(ctx)

    expect(registered).toContain("integration.transform")
    expect(registered).toContain("provider.transform")
    expect(registered).toContain("aisdk.sdk")
    expect(registered).toContain("aisdk.language")
    expect(registered).toContain("tool.transform")
    expect(registered).toContain("tool.execute.before")
    expect(registered).toContain("tool.execute.after")
    expect(registered).toContain("session.context")
    expect(registered).toContain("session.compaction")
    expect(registered).toContain("session.generate")
    expect(registered).toContain("session.title")
    expect(registered).toContain("shell.create.before")
    expect(registered).toContain("websearch.transform")
    expect(typeof cleanup).toBe("function")

    const tools: Array<{
      name: string
      output?: unknown
      options?: { codemode?: boolean }
    }> = []
    transforms.get("tool")!({ add: (tool: { name: string; output?: unknown; options?: { codemode?: boolean } }) => tools.push(tool) })
    // OpenCode 2 intentionally removed session todos; the provider fallback is
    // opt-in through CURSOR_OPENCODE2_TODOS and is covered separately.
    expect(tools).toEqual([])
  })

  test("leaves permission-gated web and image tools to the OpenCode 2 host", async () => {
    const { ctx, transforms } = fakeContext()
    await plugin.setup(ctx)
    const tools: Array<{ name: string }> = []
    transforms.get("tool")!({
      add: (tool: { name: string }) => tools.push(tool),
      get: (id: string) => id === "websearch"
        ? { id: "websearch", name: "websearch", description: "", input: {}, execute: async () => ({}) }
        : undefined,
    })
    expect(tools).toEqual([])
    expect(tools.map((t) => t.name)).not.toContain("custom_websearch")
    expect(tools.map((t) => t.name)).not.toContain("cursor_image_save")
  })

  test.each(["id", "callID"] as const)("accepts the %s tool execution identifier", async (field) => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)

    const executionID = `cursor_shell_${field}`
    registerCursorShellCall(executionID, {
      background_shell_spawn: true,
      command: "echo hello",
      working_directory: "/tmp",
    })
    const input = { command: "echo hello" }
    await hooks.get("tool.execute.before")!({
      tool: "bash",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      [field]: executionID,
      input,
    })
    // OpenCode 2.0 injects the wrapper via shell.create.before for bash/zsh,
    // so the advertised command stays the original user payload.
    expect(typeof input.command).toBe("string")

    const result = { output: "hello\n", metadata: {} }
    await hooks.get("tool.execute.after")!({
      tool: "bash",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      [field]: executionID,
      input,
      status: "completed",
      result,
    })
    expect(result.output).toBe("hello\n")
  })

  test("cleanup disposes every registration", async () => {
    const { ctx, registered, disposed } = fakeContext()
    const cleanup = await plugin.setup(ctx)
    await (cleanup as () => Promise<void>)()

    expect(disposed.sort()).toEqual([...registered].sort())
  })

  test("the provider transform is a no-op until models are published", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-empty-"))
    setHostCacheDirOverride(cacheDir)
    try {
      const { ctx, inventory } = fakeContext()
      await plugin.setup(ctx)
      expect(inventory.providers.size).toBe(0)
    } finally {
      setHostCacheDirOverride(undefined)
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("a transform replay with no models leaves an existing inventory in place", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-keep-"))
    setHostCacheDirOverride(cacheDir)
    try {
      const { ctx, inventory } = fakeContext()
      const kept: ModelInfo2 = {
        id: "keep-me",
        modelID: "keep-me",
        providerID: "cursor",
        name: "Keep",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1, output: 1 },
      }
      inventory.editor.add({
        info: { id: "cursor", name: "Cursor", package: "aisdk:keep", activation: "enabled" },
        models: [kept],
      })

      const cleanup = await plugin.setup(ctx)
      await ctx.provider.reload()

      expect(inventory.models.get("cursor/keep-me")?.name).toBe("Keep")
      expect(inventory.providers.get("cursor")?.package).toBe("aisdk:keep")
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("a failed provider.reload after cache seed does not throw and does not publish", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-reload-fail-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-reload-fail-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCache(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, inventory } = fakeContext()
      let attempts = 0
      ctx.provider.reload = async () => {
        attempts++
        throw new Error("reload failed")
      }

      const cleanup = await plugin.setup(ctx)
      await new Promise((r) => setTimeout(r, 20))

      expect(inventory.providers.size).toBe(0)
      expect(inventory.models.size).toBe(0)
      expect(attempts).toBeGreaterThan(0)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("the aisdk language hook resolves the wire model id", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)

    const asked: string[] = []
    const event: any = {
      model: { providerID: "cursor", id: "sonnet-1m", modelID: "sonnet" },
      sdk: {
        languageModel: (id: string) => {
          asked.push(id)
          return { id }
        },
      },
      options: {},
    }
    await hooks.get("aisdk.language")!(event)
    expect(asked).toEqual(["sonnet"])
    expect(event.language).toEqual({ id: "sonnet" })
  })

  test("the aisdk language hook ignores other providers", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)

    const event: any = {
      model: { providerID: "anthropic", id: "x", modelID: "x" },
      sdk: { languageModel: () => ({}) },
      options: {},
    }
    await hooks.get("aisdk.language")!(event)
    expect(event.language).toBeUndefined()
  })

  test("retries credential resolution after a first-run miss", async () => {
    // Regression: on a fresh install setup() runs before /connect, so the first
    // token resolution necessarily fails. Memoizing that failure pinned the
    // plugin to "no credentials" for the whole process and models never loaded,
    // even after a successful login — a restart was required.
    const { ctx } = fakeContext()
    let connected = false
    let activeCalls = 0
    ctx.integration.connection.active = async () => {
      activeCalls++
      return connected ? { type: "credential", id: "c1", label: "Cursor" } : undefined
    }
    ctx.integration.connection.resolve = async () => ({ type: "key", key: "already.a.jwt" })

    await plugin.setup(ctx)
    await new Promise((r) => setTimeout(r, 10))
    const beforeLogin = activeCalls
    expect(beforeLogin).toBeGreaterThan(0)

    // Simulate the user completing /connect, then any host activity.
    connected = true
    await new Promise((r) => setTimeout(r, 10))

    // The failed lookup must not have been cached: a later attempt re-resolves.
    const connection = await ctx.integration.connection.active("cursor")
    expect(connection).toBeDefined()
    expect(activeCalls).toBeGreaterThan(beforeLogin)
  })

  test("credential updates replace a fresh cache with the selected account's inventory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-account-switch-"))
    const previousApiBase = process.env.CURSOR_API_BASE_URL
    const previousVersion = process.env.CURSOR_CLIENT_VERSION
    setHostCacheDirOverride(cacheDir)
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("/AvailableModels")) {
          return Response.json({
            models: [{
              name: "new-account",
              client_display_name: "New Account Model",
              supports_agent: true,
              variants: [],
            }],
          })
        }
        return Response.json({})
      },
    })
    process.env.CURSOR_API_BASE_URL = server.url.origin
    process.env.CURSOR_CLIENT_VERSION = "cli-test"
    resetClientVersionCache()
    try {
      await writeCache(cacheDir, {
        models: [{ ...baseModel, id: "old-account", displayName: "Old Account Model" }],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, inventory } = fakeContext([{
        type: "credential.updated",
        data: { integrationID: "cursor" },
      }])
      ctx.integration.connection.active = async () => ({
        type: "credential",
        id: "new-account-credential",
        label: "Cursor",
      })
      ctx.integration.connection.resolve = async () => ({
        type: "key",
        key: "new.account.jwt",
      })

      const cleanup = await plugin.setup(ctx)
      try {
        for (let i = 0; i < 100 && !inventory.models.has("cursor/new-account"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(inventory.models.has("cursor/new-account")).toBe(true)
        expect(inventory.models.has("cursor/old-account")).toBe(false)
      } finally {
        await cleanup()
      }
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousApiBase === undefined) delete process.env.CURSOR_API_BASE_URL
      else process.env.CURSOR_API_BASE_URL = previousApiBase
      if (previousVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = previousVersion
      resetClientVersionCache()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("the session hook records the compaction agent", async () => {
    clearCompactionSessions()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-compact", "/proj")
    sessionLocations.set("s-normal", "/proj")
    await plugin.setup(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s-compact", agent: "compaction", model: { providerID: "cursor" } })
    await hook({ sessionID: "s-normal", agent: "build", model: { providerID: "cursor" } })

    expect(isCompactionSession("s-compact")).toBe(true)
    expect(isCompactionSession("s-normal")).toBe(false)
  })

  test("the session context carries the active host agent into provider options", async () => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-plan-agent", "/proj")
    await plugin.setup(ctx)

    const event: any = {
      sessionID: "s-plan-agent",
      agent: "plan",
      model: { providerID: "cursor" },
      options: {},
    }
    await hooks.get("session.context")!(event)
    expect(event.options.opencodeHostAgent).toBe("plan")
    expect(getActiveCursorMode("s-plan-agent")).toBe("plan")

    event.agent = "build"
    await hooks.get("session.context")!(event)
    expect(getActiveCursorMode("s-plan-agent")).toBe("agent")

    setActiveCursorMode("s-plan-agent", "chat")
    await hooks.get("session.context")!(event)
    expect(getActiveCursorMode("s-plan-agent")).toBe("chat")
  })

  test("the session hook records the session's real directory, not the daemon cwd", async () => {
    clearSessionDirectories()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s1", "/home/user/projects/my-app")
    await plugin.setup(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s1", agent: "build", model: { providerID: "cursor" } })

    expect(getSessionDirectory("s1")).toBe("/home/user/projects/my-app")
  })

  test("the session hook records the session directory from info.directory (flat OpenCode 2.0 shape)", async () => {
    clearSessionDirectories()
    const { ctx, hooks } = fakeContext()
    ctx.session.get = async ({ sessionID }: { sessionID: string }) => ({
      id: sessionID,
      directory: "/home/user/projects/flat-app",
    })
    await plugin.setup(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s-flat", agent: "build", model: { providerID: "cursor" } })

    expect(getSessionDirectory("s-flat")).toBe("/home/user/projects/flat-app")
  })

  test("a failed session lookup does not throw and leaves the directory unset", async () => {
    clearSessionDirectories()
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s-unknown", agent: "build", model: { providerID: "cursor" } })

    expect(getSessionDirectory("s-unknown")).toBeUndefined()
  })

  test("installs a plan-execution kickoff via switchAgent + synthetic input", async () => {
    resetPlanExecutionKickoffForTests()
    const { ctx } = fakeContext()
    const switched: string[] = []
    const synthetic: Array<{ sessionID: string; text: string }> = []
    const prompted: Array<{ sessionID: string; text: string }> = []
    ctx.session.switchAgent = async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
      switched.push(`${sessionID}:${agent}`)
    }
    ctx.session.synthetic = async (input: { sessionID: string; text: string }) => {
      synthetic.push(input)
      return {}
    }
    ctx.session.prompt = async (input: { sessionID: string; text: string }) => {
      prompted.push(input)
      return {}
    }
    const cleanup = await plugin.setup(ctx)
    expect(hasPlanExecutionKickoff()).toBe(true)
    expect(queuePlanExecutionKickoff({ sessionID: "s-plan", planPath: "/tmp/plan.md" })).toBe(true)
    expect(await flushPlanExecutionKickoff("s-plan", { terminal: true })).toBe(true)
    expect(switched).toEqual(["s-plan:build"])
    expect(synthetic).toEqual([{
      sessionID: "s-plan",
      text: "The plan at /tmp/plan.md has been approved, you can now edit files. Execute the plan",
    }])
    expect(prompted).toEqual([])
    await cleanup()
    expect(hasPlanExecutionKickoff()).toBe(false)
  })

  test("maps Cursor modes onto the native OpenCode 2 plan and build agents", async () => {
    const { ctx } = fakeContext()
    const switched: string[] = []
    ctx.session.switchAgent = async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
      switched.push(`${sessionID}:${agent}`)
    }
    const cleanup = await plugin.setup(ctx)

    expect(queueHostAgentModeSwitch({
      sessionID: "s-mode",
      targetModeID: "spec",
      cursorSessionID: "run-plan",
    })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-mode", {
      cursorSessionID: "run-plan",
      terminal: true,
    })).toBe(true)

    expect(queueHostAgentModeSwitch({
      sessionID: "s-mode",
      targetModeID: "agent",
      cursorSessionID: "run-build",
    })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-mode", {
      cursorSessionID: "run-build",
      terminal: true,
    })).toBe(true)
    expect(switched).toEqual(["s-mode:plan", "s-mode:build"])

    await cleanup()
    expect(queueHostAgentModeSwitch({ sessionID: "s-mode", targetModeID: "plan" })).toBe(false)
  })

  test("falls back to prompt when the host lacks synthetic session input", async () => {
    resetPlanExecutionKickoffForTests()
    const { ctx } = fakeContext()
    delete ctx.session.synthetic
    const prompted: Array<{ sessionID: string; text: string }> = []
    ctx.session.prompt = async (input: { sessionID: string; text: string }) => {
      prompted.push(input)
      return {}
    }
    const cleanup = await plugin.setup(ctx)
    expect(queuePlanExecutionKickoff({ sessionID: "s-plan-old", planPath: "/tmp/old.md" })).toBe(true)
    expect(await flushPlanExecutionKickoff("s-plan-old", { terminal: true })).toBe(true)
    expect(prompted).toHaveLength(1)
    await cleanup()
  })

  test("restores the plan agent when kickoff admission fails", async () => {
    resetPlanExecutionKickoffForTests()
    const { ctx } = fakeContext()
    const switched: string[] = []
    ctx.session.switchAgent = async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
      switched.push(`${sessionID}:${agent}`)
    }
    ctx.session.synthetic = async () => {
      throw new Error("inbox unavailable")
    }
    const cleanup = await plugin.setup(ctx)
    expect(queuePlanExecutionKickoff({ sessionID: "s-plan-fail", planPath: "/tmp/fail.md" })).toBe(true)
    expect(await flushPlanExecutionKickoff("s-plan-fail", { terminal: true })).toBe(false)
    expect(switched).toEqual(["s-plan-fail:build", "s-plan-fail:plan"])
    await cleanup()
  })

  test("shell create.before merges env for a matching pending command", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)
    const executionID = "cursor_shell_env"
    registerCursorShellCall(executionID, {
      background_shell_spawn: true,
      command: "echo hello",
      working_directory: "/tmp",
    })
    const input = { command: "echo hello" }
    await hooks.get("tool.execute.before")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: executionID,
      input,
    })
    const event = { command: "echo hello", cwd: "/tmp", timeout: 0, shell: "/bin/bash", env: {} as Record<string, string | undefined> }
    await hooks.get("shell.create.before")!(event)
    expect(Object.keys(event.env).length).toBeGreaterThan(0)
  })

  test("shell execute.after sanitizes structured output and content blocks", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)
    const executionID = "cursor_shell_blocks"
    registerCursorShellCall(executionID, {
      background_shell_spawn: true,
      command: "sleep 60",
      working_directory: "/tmp",
    })
    const raw = "started\n__CURSOR_BACKGROUND_SHELL__43210:/tmp/cursor-bg.log\n"
    const result: any = {
      output: { output: raw, status: "completed", truncated: false },
      content: [{ type: "text", text: raw }, { type: "file", uri: "file:///tmp/log", mime: "text/plain" }],
      metadata: {},
    }
    await hooks.get("tool.execute.after")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: executionID,
      input: { command: "sleep 60" },
      status: "completed",
      result,
    })
    expect(result.output.output).not.toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(result.content[0].text).not.toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(result.content[1]).toEqual({ type: "file", uri: "file:///tmp/log", mime: "text/plain" })
  })

  test("session.compaction flags the compaction option", async () => {
    clearCompactionSessions()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-c", "/proj")
    await plugin.setup(ctx)
    const event: any = {
      sessionID: "s-c",
      agent: "compaction",
      model: { providerID: "cursor" },
      system: [],
      messages: [],
      tools: {},
    }
    await hooks.get("session.compaction")!(event)
    expect(isCompactionSession("s-c")).toBe(true)
    expect(event.options.opencodeCompaction).toBe(true)
  })

  test("session.generate explicitly clears the request-local compaction option", async () => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-g", "/proj")
    await plugin.setup(ctx)
    const event: any = {
      sessionID: "s-g",
      agent: "build",
      model: { providerID: "cursor" },
      system: [],
      messages: [],
      tools: {},
    }
    await hooks.get("session.generate")!(event)
    expect(event.options.opencodeCompaction).toBe(false)
  })

  test("session.title explicitly clears the request-local compaction option", async () => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-title", "/proj")
    await plugin.setup(ctx)
    const event: any = {
      sessionID: "s-title",
      model: { providerID: "cursor", id: "model" },
      system: [],
      messages: [],
    }
    await hooks.get("session.title")!(event)
    expect(event.options.opencodeCompaction).toBe(false)
  })
})
