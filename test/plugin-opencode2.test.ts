import { describe, expect, test, beforeEach } from "bun:test"
import plugin from "../src/plugin-opencode2.js"
import { applyCursorModels, applyCursorProvider, CURSOR_AISDK_PACKAGE } from "../src/opencode2/catalog.js"
import { applyCursorIntegration, accessTokenFromCredential } from "../src/opencode2/integration.js"
import { clearCompactionSessions, isCompactionSession, markCompactionSession } from "../src/compaction-marker.js"
import { clearSessionDirectories, getSessionDirectory } from "../src/session-directory.js"
import { registerCursorShellCall } from "../src/shell-timeout.js"
import type {
  CatalogDraft,
  IntegrationDraft,
  IntegrationMethodRegistration,
  ModelInfo2,
  ProviderInfo,
} from "../src/opencode2/types.js"
import type { ModelInfo } from "../src/models.js"

// ── Fake catalog draft (mirrors the host's upsert semantics) ──

function fakeCatalogDraft() {
  const providers = new Map<string, ProviderInfo>()
  const models = new Map<string, ModelInfo2>()
  const draft: CatalogDraft = {
    provider: {
      list: () => [],
      get: () => undefined,
      update(id, update) {
        const current =
          providers.get(id) ?? ({ id, name: id, package: "" } as ProviderInfo)
        providers.set(id, current)
        update(current)
      },
      remove(id) {
        providers.delete(id)
      },
    },
    model: {
      get: (pid, mid) => models.get(`${pid}/${mid}`),
      update(pid, mid, update) {
        const key = `${pid}/${mid}`
        const current =
          models.get(key) ??
          ({
            id: mid,
            modelID: mid,
            providerID: pid,
            name: mid,
            capabilities: { tools: false, input: [], output: [] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 0, output: 0 },
          } as ModelInfo2)
        models.set(key, current)
        update(current)
      },
      remove(pid, mid) {
        models.delete(`${pid}/${mid}`)
      },
      default: { get: () => undefined, set: () => {} },
    },
  }
  return { draft, providers, models }
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

describe("opencode2 catalog", () => {
  test("registers the cursor provider on the aisdk path with an integration link", () => {
    const { draft, providers } = fakeCatalogDraft()
    applyCursorProvider(draft)

    const provider = providers.get("cursor")
    expect(provider).toBeDefined()
    expect(provider!.package).toBe(CURSOR_AISDK_PACKAGE)
    // `aisdk:` is what selects the hook-driven path we supply the SDK through.
    expect(provider!.package.startsWith("aisdk:")).toBe(true)
    expect(provider!.integrationID).toBe("cursor")
  })

  test("maps a model into the 2.0 shape", () => {
    const { draft, models } = fakeCatalogDraft()
    applyCursorModels(draft, [baseModel])

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
    const { draft, models } = fakeCatalogDraft()
    applyCursorModels(draft, [
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
    const { draft, models } = fakeCatalogDraft()
    applyCursorModels(draft, [
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

  test("variants become an array carrying their parameters in settings", () => {
    const { draft, models } = fakeCatalogDraft()
    applyCursorModels(draft, [
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
    const { draft, models, providers } = fakeCatalogDraft()
    applyCursorProvider(draft)
    applyCursorModels(draft, [baseModel])
    applyCursorProvider(draft)
    applyCursorModels(draft, [baseModel])

    expect(providers.size).toBe(1)
    expect(models.size).toBe(1)
  })
})

// ── Fake integration draft ──

function fakeIntegrationDraft() {
  const refs = new Map<string, { id: string; name: string }>()
  const methods: IntegrationMethodRegistration[] = []
  const draft: IntegrationDraft = {
    list: () => [],
    get: () => undefined,
    update(id, update) {
      const current = refs.get(id) ?? { id, name: id }
      refs.set(id, current)
      update(current)
    },
    remove(id) {
      refs.delete(id)
    },
    method: {
      list: () => [],
      update(input) {
        methods.push(input)
      },
      remove: () => {},
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
  })
})

// ── setup() against a fake host context ──

function fakeContext() {
  const registered: string[] = []
  const disposed: string[] = []
  const hooks = new Map<string, (input: any) => any>()
  const transforms = new Map<string, (draft: any) => void>()

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
    app: { name: "opencode", version: "2.0.0", channel: "next" },
    options: {},
    aisdk: hookDomain("aisdk"),
    catalog: transformDomain("catalog"),
    event: { subscribe: () => undefined },
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
    },
    tool: { ...hookDomain("tool"), ...transformDomain("tool") },
    websearch: transformDomain("websearch"),
  }
  // `tool` needs both hook and transform; the spreads above would drop `reload`
  // ordering, so rebuild it explicitly.
  ctx.tool = {
    hook: hookDomain("tool").hook,
    transform: transformDomain("tool").transform,
  }

  return { ctx, registered, disposed, hooks, transforms, sessionLocations }
}

describe("opencode2 setup", () => {
  test("registers every domain it needs and returns a cleanup", async () => {
    const { ctx, registered } = fakeContext()
    const cleanup = await plugin.setup(ctx)

    expect(registered).toContain("integration.transform")
    expect(registered).toContain("catalog.transform")
    expect(registered).toContain("aisdk.sdk")
    expect(registered).toContain("aisdk.language")
    expect(registered).toContain("tool.transform")
    expect(registered).toContain("tool.execute.before")
    expect(registered).toContain("tool.execute.after")
    expect(registered).toContain("session.context")
    expect(typeof cleanup).toBe("function")
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
    expect(input.command).not.toBe("echo hello")

    const result = { title: "bash", output: "hello\n", metadata: {} }
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
    expect(result.title).toBe("echo hello")
    expect(result.output).toBe("hello\n")
  })

  test("cleanup disposes every registration", async () => {
    const { ctx, registered, disposed } = fakeContext()
    const cleanup = await plugin.setup(ctx)
    await (cleanup as () => Promise<void>)()

    expect(disposed.sort()).toEqual([...registered].sort())
  })

  test("the catalog transform registers the provider", async () => {
    const { ctx, transforms } = fakeContext()
    await plugin.setup(ctx)

    const { draft, providers } = fakeCatalogDraft()
    transforms.get("catalog")!(draft)
    expect(providers.get("cursor")?.package).toBe(CURSOR_AISDK_PACKAGE)
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

  test("the session hook records the session's real directory, not the daemon cwd", async () => {
    clearSessionDirectories()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s1", "/home/user/projects/my-app")
    await plugin.setup(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s1", agent: "build", model: { providerID: "cursor" } })

    expect(getSessionDirectory("s1")).toBe("/home/user/projects/my-app")
  })

  test("a failed session lookup does not throw and leaves the directory unset", async () => {
    clearSessionDirectories()
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s-unknown", agent: "build", model: { providerID: "cursor" } })

    expect(getSessionDirectory("s-unknown")).toBeUndefined()
  })
})
