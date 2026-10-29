import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createManagedTerminal } from "../src/terminal-runner.js"
import os from "node:os"
import path from "node:path"
import { CursorPlugin } from "../src/plugin.js"
import { modelInfoToConfig, thinkingSuffixBaseNames } from "../src/model-config.js"
import { isExpiringSoon } from "../src/auth.js"
import { resetAuthRenewalState } from "../src/auth-renewal.js"
import { CursorAuthError } from "../src/errors.js"
import { CURSOR_VARIANT_PARAMETERS_KEY, readCache, writeCache, type ModelInfo } from "../src/models.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { resetAgentUrlCache } from "../src/agent-url.js"
import {
  CURSOR_COMPACTION_OPTION,
  CURSOR_HOST_AGENT_OPTION,
  CURSOR_SESSION_EDITS_DENIED_OPTION,
  MODEL_CACHE_SCHEMA_VERSION,
} from "../src/shared.js"
import {
  CURSOR_TIMEOUT_BACKGROUND,
  buildBackgroundShellCommand,
  consumeCursorShellResult,
  registerCursorShellCall,
  resetCursorShellCalls,
} from "../src/shell-timeout.js"
import { sessionActivity } from "../src/activity.js"
import * as rootExports from "../src/index.js"
import { hostPlanFileFor, isHostPlanFileResolved, resetHostPlanFilesForTests, setHostPlanFile } from "../src/host-plan-file.js"
import { HOST_PATH_BRIDGE } from "../src/context/paths.js"
import {
  flushHostAgentModeSwitch,
  hostAgentSwitchPromptText,
  isHostPlanEntryPending,
  queueHostAgentModeSwitch,
  resetHostAgentModeSwitchForTests,
} from "../src/host-agent-mode.js"
import { reapBackgroundSpawn } from "./background-spawn.js"
import { withTempHostCache } from "./host-cache.js"

// Characters safeLabel must remove from emitted names/keys (issue #2).
const INVALID = new RegExp("[()<>&\"'`]")
const variantParams = (params: Array<{ id: string; value: string }>) => ({
  [CURSOR_VARIANT_PARAMETERS_KEY]: params,
})

describe("package root exports", () => {
  it("selects the host plan agent through session.promptAsync after the Run ends", async () => {
    resetHostAgentModeSwitchForTests()
    await CursorPlugin({} as any)
    expect(queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "plan", hostAgent: "build" })).toBe(false)

    const calls: unknown[] = []
    let agentReads = 0
    const hooks = await CursorPlugin({
      client: {
        session: { promptAsync: async (args: unknown) => { calls.push(args) } },
        app: {
          agents: async () => {
            agentReads++
            await Bun.sleep(5)
            return {
              data: [
                { name: "build", mode: "primary" },
                { name: "plan", mode: "primary" },
                { name: "explore", mode: "subagent" },
                { name: "summary", mode: "primary", hidden: true },
              ],
            }
          },
        },
      },
    } as any)
    // The agent list is read on the first Cursor request, not during plugin load.
    expect(agentReads).toBe(0)
    expect(queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "plan", hostAgent: "build" })).toBe(false)
    const params = { options: {} as Record<string, unknown> }
    // The first request waits for the list, so a SwitchMode in its Run is accepted.
    await hooks["chat.params"]!({ model: { providerID: "cursor" }, agent: "build" } as any, params as any)
    expect(agentReads).toBe(1)
    await hooks["chat.params"]!({ model: { providerID: "cursor" }, agent: "build" } as any, params as any)
    expect(agentReads).toBe(1)

    // Background/internal sessions are not switched.
    expect(queueHostAgentModeSwitch({ sessionID: "bg", targetModeID: "plan", hostAgent: "summary" }))
      .toBe(false)
    expect(queueHostAgentModeSwitch({
      sessionID: "s",
      targetModeID: "plan",
      cursorSessionID: "c",
      hostAgent: "build",
    })).toBe(true)
    // The prompt switch continues the work itself, so the plan waits for it.
    expect(isHostPlanEntryPending("s")).toBe(true)
    expect(await flushHostAgentModeSwitch("s", { cursorSessionID: "c", terminal: true })).toBe(true)
    expect(calls).toEqual([{
      path: { id: "s" },
      body: {
        agent: "plan",
        parts: [{ type: "text", text: hostAgentSwitchPromptText("plan"), synthetic: true }],
      },
    }])
    resetHostAgentModeSwitchForTests()
  })

  it("resolves the session's own plan file once per session", async () => {
    resetHostPlanFilesForTests()
    const previous = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
    const seen: unknown[] = []
    ;(globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = {
      projectConfigDirs: () => [],
      globalConfigDirs: () => [],
      planFile: (input: { worktree: string; vcs: boolean; created: number; slug: string }) => {
        seen.push(input)
        return `${input.worktree}/.host/plans/${input.created}-${input.slug}.md`
      },
    }
    try {
      const hooks = await CursorPlugin({
        worktree: "/repo",
        project: { worktree: "/repo", vcs: "git" },
        client: {
          session: {
            promptAsync: async () => {},
            get: async (args: { path: { id: string } }) => ({
              data: { id: args.path.id, slug: "calm-wizard", time: { created: 17 } },
            }),
          },
        },
      } as any)
      const params = { options: {} as Record<string, unknown> }
      // Compaction turns never resolve it.
      await hooks["chat.params"]!({ sessionID: "s", model: { providerID: "cursor" }, agent: "compaction" } as any, params as any)
      expect(hostPlanFileFor("s")).toBeUndefined()
      await hooks["chat.params"]!({ sessionID: "s", model: { providerID: "cursor" }, agent: "build" } as any, params as any)
      await hooks["chat.params"]!({ sessionID: "s", model: { providerID: "cursor" }, agent: "plan" } as any, params as any)
      expect(seen).toEqual([{ worktree: "/repo", vcs: true, created: 17, slug: "calm-wizard" }])
      expect(hostPlanFileFor("s")).toBe("/repo/.host/plans/17-calm-wizard.md")
    } finally {
      if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
      else (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = previous
      resetHostPlanFilesForTests()
      resetHostAgentModeSwitchForTests()
      }
  })

  it("looks a session's plan file up once when it has none, but retries a failed lookup", async () => {
    resetHostPlanFilesForTests()
    const previous = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
    ;(globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = {
      projectConfigDirs: () => [],
      globalConfigDirs: () => [],
    }
    const reads: string[] = []
    try {
      const hooks = await CursorPlugin({
        worktree: "/repo",
        project: { worktree: "/repo", vcs: "git" },
        client: {
          session: {
            promptAsync: async () => {},
            get: async (args: { path: { id: string } }) => {
              reads.push(args.path.id)
              if (args.path.id === "flaky" && reads.length === 1) throw new Error("not ready")
              return { data: { id: args.path.id, slug: "calm-wizard", time: { created: 17 } } }
            },
          },
        },
      } as any)
      const params = { options: {} as Record<string, unknown> }
      const call = (sessionID: string) => hooks["chat.params"]!(
        { sessionID, model: { providerID: "cursor" }, agent: "build" } as any,
        params as any,
      )
      // The first read fails. Plan-file resolution retries it in the same request
      // and remembers that this host defines none. Later requests still read the
      // session, for its edit rule, and do not look the plan file up again.
      await call("flaky")
      expect(reads).toEqual(["flaky", "flaky"])
      await call("flaky")
      await call("flaky")
      expect(reads).toEqual(["flaky", "flaky", "flaky", "flaky"])
      expect(hostPlanFileFor("flaky")).toBeUndefined()
    } finally {
      if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
      else (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = previous
      resetHostPlanFilesForTests()
      resetHostAgentModeSwitchForTests()
      }
  })

  it("loads classic tools from a Windows absolute host path", async () => {
    const { loadClassicTools } = await import("../src/classic-tools.js")
    const seen: string[] = []
    const schema = {
      string: () => ({ describe() { return this }, optional() { return this } }),
      number: () => ({ int() { return this }, min() { return this }, max() { return this }, positive() { return this }, optional() { return this } }),
      enum: () => ({ optional() { return this } }),
    }
    const identityTool = Object.assign((input: Record<string, unknown>) => input, { schema })
    const tools = await loadClassicTools({
      configDirs: ["C:\\host-config"],
      importModule: async (specifier) => {
        seen.push(specifier)
        return { tool: identityTool }
      },
    })
    expect(seen[0]).toMatch(/^file:\/\/\/C:/)
    expect(tools.webSearch).toBeDefined()
    expect(tools.imageSave).toBeDefined()
  })

  it("falls back to plain classic definitions when no helper can be imported", async () => {
    const { loadClassicTools } = await import("../src/classic-tools.js")
    const tools = await loadClassicTools({
      configDirs: ["/missing"],
      importModule: async () => { throw new Error("missing") },
    })
    expect((tools.webSearch as any).args.query.type).toBe("string")
    expect((tools.imageSave as any).args.image_id.type).toBe("string")
  })

  it("keeps runtime root exports safe for OpenCode's legacy plugin loader", () => {
    expect(Object.keys(rootExports).sort()).toEqual(["CursorPlugin", "createCursor", "default"])
  })

  it("exports only CursorPlugin from the classic plugin module", async () => {
    // OpenCode 1.x calls every export of a `file://…/dist/plugin.js` module as a
    // plugin (`getLegacyPlugins`); a helper export there fails plugin load.
    const pluginModule = await import("../src/plugin.js")
    expect(Object.keys(pluginModule)).toEqual(["CursorPlugin"])
  })

  it("registers web search under a non-reserved OpenCode tool id", async () => {
    const hooks = await CursorPlugin({} as any)
    expect(hooks.tool?.custom_websearch).toBeDefined()
    expect(hooks.tool?.websearch).toBeUndefined()
  })
})

describe("session activity hooks", () => {
  it("propagates child message activity to a parent continuation lease", async () => {
    const hooks = await CursorPlugin({} as any)
    sessionActivity.clear()
    try {
      await hooks.event?.({
        event: {
          type: "session.updated",
          properties: { info: { id: "child", parentID: "parent" } },
        } as any,
      })
      expect(sessionActivity.lastActivityAt("parent")).toBeUndefined()

      await hooks.event?.({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "child" } },
        } as any,
      })
      expect(sessionActivity.lastActivityAt("parent")).toBeNumber()
    } finally {
      sessionActivity.clear()
    }
  })

  it("keeps a parent lease active while a child permission or question prompt is open", async () => {
    const hooks = await CursorPlugin({} as any)
    sessionActivity.clear()
    const start = Date.now()
    try {
      await hooks.event?.({ event: { type: "session.updated", properties: { info: { id: "child", parentID: "parent" } } } as any })
      await hooks.event?.({ event: { type: "permission.asked", properties: { id: "per_1", sessionID: "child" } } as any })
      await hooks.event?.({ event: { type: "question.asked", properties: { id: "que_1", sessionID: "child" } } as any })
      setSystemTime(new Date(start + 3_600_000))
      expect(sessionActivity.lastActivityAt("parent")).toBe(start + 3_600_000)

      await hooks.event?.({ event: { type: "permission.replied", properties: { sessionID: "child", requestID: "per_1", reply: "once" } } as any })
      await hooks.event?.({ event: { type: "question.rejected", properties: { sessionID: "child", requestID: "que_1" } } as any })
      setSystemTime(new Date(start + 7_200_000))
      expect(sessionActivity.lastActivityAt("parent")).toBe(start + 3_600_000)
    } finally {
      setSystemTime()
      sessionActivity.clear()
    }
  })
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

  it("distinguishes a parameterless default variant from its model name", () => {
    const config = modelInfoToConfig({
      id: "plain-model",
      displayName: "Plain",
      variants: [{
        key: "plain-model",
        displayName: "Plain",
        isDefaultNonMax: true,
        isDefaultMax: false,
        parameterValues: [],
      }],
    })
    expect(config.variants).toEqual({ "Plain default": variantParams([]) })
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
    expect(compaction.options[CURSOR_HOST_AGENT_OPTION]).toBe("compaction")

    const normal = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]?.({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "cursor" },
    } as never, normal as never)
    expect(normal.options[CURSOR_COMPACTION_OPTION]).toBeUndefined()
    expect(normal.options[CURSOR_HOST_AGENT_OPTION]).toBe("build")
  })

  it("sets the session edit deny option from the classic session payload", async () => {
    resetHostPlanFilesForTests()
    const sessions = new Map<string, unknown>([
      ["ses_deny", { data: { permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "/plans/*", effect: "allow" },
      ] } }],
      ["ses_allow", { data: { permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "allow" },
      ] } }],
      ["ses_plain", { data: { slug: "quiet-owl" } }],
    ])
    const plugin = await CursorPlugin({
      directory: process.cwd(),
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => sessions.get(path.id),
        },
      },
    } as never)
    const denied = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]?.({
      sessionID: "ses_deny",
      agent: "plan",
      model: { providerID: "cursor" },
    } as never, denied as never)
    expect(denied.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBe(true)
    expect(denied.options[CURSOR_HOST_AGENT_OPTION]).toBe("plan")

    const allowed = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]?.({
      sessionID: "ses_allow",
      agent: "build",
      model: { providerID: "cursor" },
    } as never, allowed as never)
    expect(allowed.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBe(false)

    const plain = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]?.({
      sessionID: "ses_plain",
      agent: "build",
      model: { providerID: "cursor" },
    } as never, plain as never)
    expect(plain.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBe(false)
    expect(plain.options[CURSOR_HOST_AGENT_OPTION]).toBe("build")
    resetHostPlanFilesForTests()
  })

  it("retries the session read before checking permissions even with a cached plan path", async () => {
    for (const cached of [false, true]) {
      resetHostPlanFilesForTests()
      if (cached) setHostPlanFile("ses_retry", null)
      let reads = 0
      const plugin = await CursorPlugin({
        directory: process.cwd(),
        client: { session: { get: async () => {
          if (++reads === 1) throw new Error("not ready")
          return { data: { permissions: [{ action: "edit", resource: "*", effect: "deny" }] } }
        } } },
      } as never)
      const params = { options: {} as Record<string, unknown> }
      await plugin["chat.params"]!({ sessionID: "ses_retry", agent: "plan", model: { providerID: "cursor" } } as never, params as never)
      expect(params.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBe(true)
      expect(reads).toBe(2)
    }
    resetHostPlanFilesForTests()
  })

  it("clears the edit-deny marker when native 1.x session permissions are lifted", async () => {
    resetHostPlanFilesForTests()
    const permission = [{ permission: "edit", pattern: "*", action: "deny" }]
    const plugin = await CursorPlugin({
      directory: process.cwd(),
      client: { session: { get: async () => ({ data: { permission } }) } },
    } as never)
    const params = { options: {} as Record<string, unknown> }
    const input = { sessionID: "ses_native", agent: "plan", model: { providerID: "cursor" } }
    await plugin["chat.params"]!(input as never, params as never)
    expect(params.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBe(true)
    permission.push({ permission: "edit", pattern: "*", action: "allow" })
    await plugin["chat.params"]!(input as never, params as never)
    expect(params.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBe(false)
    resetHostPlanFilesForTests()
  })

  it("keeps ordinary requests usable with unreadable permissions without caching an absent plan", async () => {
    for (const get of [
      async () => { throw new Error("session unavailable") },
      async () => ({ error: { message: "session unavailable" } }),
    ]) {
      resetHostPlanFilesForTests()
      const plugin = await CursorPlugin({ directory: process.cwd(), client: { session: { get } } } as never)
      for (const agent of ["build", "plan"]) {
        const params = { options: {} as Record<string, unknown> }
        await plugin["chat.params"]!({
          sessionID: "ses_failed", agent, model: { providerID: "cursor" },
        } as never, params as never)
        expect(params.options.opencodeSessionPermissionsUnavailable).toBe(true)
        expect(params.options[CURSOR_SESSION_EDITS_DENIED_OPTION]).toBeUndefined()
      }
      expect(isHostPlanFileResolved("ses_failed")).toBe(false)
    }
  })
})

describe("CursorPlugin shell result hooks", () => {
  it("normalizes interrupted model input in the original array without changing stored parts", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const original = { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "cursor_projection_1", state: { status: "completed", input: {}, output: "partial\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>", metadata: { exit: null }, time: { start: 0, end: 1 } } }] }
    const messages = [original]
    const output = { messages }
    await plugin["experimental.chat.messages.transform"]?.({} as never, output as never)
    expect(output.messages).toBe(messages)
    expect(messages[0]!.parts[0]!.state.status).toBe("error")
    expect(original.parts[0]!.state.status).toBe("completed")
  })

  it("releases an unstarted reservation on persisted error state without an after hook or continuation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cursor-classic-rejected-"))
    try {
      const plugin = await CursorPlugin({ directory: root } as never)
      const terminal = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
      const callID = "cursor_classic_rejected_1"
      registerCursorShellCall(callID, { background_shell_spawn: true, command: "true", working_directory: root, managed_command: terminal.command, managed_job_directory: terminal.directory })
      const part = { id: "part", messageID: "message", sessionID: "session", type: "tool", tool: "bash", callID, state: { status: "error", input: { command: "true" }, error: "Rejected", time: { start: 0, end: 1 } } }
      await plugin.event?.({ event: { type: "message.part.updated", properties: { part } } } as never)
      expect(existsSync(terminal.file)).toBe(false)
      expect(existsSync(terminal.directory)).toBe(false)
      expect(existsSync(path.join(root, "terminals", ".jobs", `${terminal.shellId}.json`))).toBe(false)
    } finally { resetCursorShellCalls(); rmSync(root, { recursive: true, force: true }) }
  })

  it("removes OpenCode timeout metadata before rendering and records a typed timeout", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const callID = "cursor_hook_1"
    registerCursorShellCall(callID, {
      shell_stream: true,
      command: "bun test",
      working_directory: process.cwd(),
      timeout_ms: 30_000,
      timeout_behavior: 1,
    })
    const output = {
      title: "wrapped command",
      output:
        "partial\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. Retry.\n</shell_metadata>",
      metadata: { exit: null },
    }
    await plugin["tool.execute.after"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID,
      args: {},
    } as never, output as never)

    expect(output.title).toBe("bun test")
    expect(output.output).toBe("partial\nTimed out after 30000ms.\n")
    expect(consumeCursorShellResult(callID, output.output).outcome).toEqual({
      kind: "timeout",
      timeoutMs: 30_000,
    })
  })

  it("replays a timed-out shell as a timeout once its saved outcome is gone", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const callID = "cursor_hook_timeout_replay"
    registerCursorShellCall(callID, { shell_stream: true, command: "bun test", working_directory: process.cwd(), timeout_ms: 30_000, timeout_behavior: 1 })
    const output = {
      title: "bun test",
      output: "partial\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. Retry.\n</shell_metadata>",
      metadata: { exit: null } as Record<string, unknown>,
    }
    await plugin["tool.execute.after"]?.({ tool: "bash", sessionID: "ses_1", callID, args: {} } as never, output as never)
    expect(output.metadata.cursorShellTimeoutMs).toBe(30_000)
    const stored = { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID, state: { status: "completed", input: {}, output: output.output, metadata: output.metadata, time: { start: 0, end: 1 } } }] }
    const projected = async () => {
      const messages = [stored]
      await plugin["experimental.chat.messages.transform"]?.({} as never, { messages } as never)
      return (messages[0] as typeof stored).parts[0]!.state.output
    }
    const timedOut = { output: "partial\nTimed out after 30000ms.\n", outcome: { kind: "timeout" as const, timeoutMs: 30_000 } }
    // Live: the saved outcome wins and the restored block is not sent as output.
    expect(consumeCursorShellResult(callID, await projected())).toEqual(timedOut)
    // Replay after that outcome was consumed, as after a restart.
    expect(consumeCursorShellResult(callID, await projected())).toEqual(timedOut)
    expect(stored.parts[0]!.state.output).toBe("partial\nTimed out after 30000ms.\n")
  })

  it("keeps soft-background Bash command original and injects wrap via shell.env", () => withTempHostCache(async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    await plugin.config?.({ shell: "/bin/bash" } as never)
    const callID = "cursor_hook_2"
    registerCursorShellCall(callID, {
      shell_stream: true,
      command: "sleep 60",
      working_directory: process.cwd(),
      timeout_ms: 5_000,
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
    })
    const output = { args: { command: "sleep 60", timeout: 5_000 } }
    await plugin["tool.execute.before"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID,
    } as never, output as never)
    // UI/storage must keep the original command; wrap comes from shell.env.
    expect(output.args.command).toBe("sleep 60")
    expect(output.args.timeout).toBe(20_000)

    const envOut = { env: {} as Record<string, string> }
    await plugin["shell.env"]?.({
      cwd: process.cwd(),
      sessionID: "ses_1",
      callID,
    } as never, envOut as never)
    expect(envOut.env.BASH_ENV).toBeString()
    expect(envOut.env.ZDOTDIR).toBeString()

    const ordinary = { args: { command: "pwd" } }
    await plugin["tool.execute.before"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID: "ordinary-call",
    } as never, ordinary as never)
    expect(ordinary.args.command).toBe("pwd")
    const ordinaryEnv = { env: {} as Record<string, string> }
    await plugin["shell.env"]?.({
      cwd: process.cwd(),
      sessionID: "ses_1",
      callID: "ordinary-call",
    } as never, ordinaryEnv as never)
    expect(ordinaryEnv.env).toEqual({})
  }))

  it("wraps background_shell_spawn via shell.env without rewriting args.command", () => withTempHostCache(async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    await plugin.config?.({ shell: "/bin/bash" } as never)
    const callID = "cursor_hook_bg_spawn"
    registerCursorShellCall(callID, {
      background_shell_spawn: true,
      command: "sleep 10",
      working_directory: process.cwd(),
    })
    const output = { args: { command: buildBackgroundShellCommand("sleep 10") } }
    await plugin["tool.execute.before"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID,
    } as never, output as never)
    // The protocol fallback is replaced with the original display/permission command.
    expect(output.args.command).toBe("sleep 10")

    const envOut = { env: {} as Record<string, string> }
    await plugin["shell.env"]?.({
      cwd: process.cwd(),
      sessionID: "ses_1",
      callID,
    } as never, envOut as never)
    expect(envOut.env.BASH_ENV).toBeString()
    const injector = await Bun.file(envOut.env.BASH_ENV).text()
    expect(injector).toContain("exec /bin/sh")
  }))

  it("replaces background fallback with a short wrapper command for sh", () => withTempHostCache(async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    await plugin.config?.({ shell: "/bin/sh" } as never)
    const callID = "cursor_hook_bg_spawn_sh"
    registerCursorShellCall(callID, {
      background_shell_spawn: true,
      command: "sleep 10",
      working_directory: process.cwd(),
    })
    const output = { args: { command: buildBackgroundShellCommand("sleep 10") } }
    await plugin["tool.execute.before"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID,
    } as never, output as never)
    expect(output.args.command).toStartWith("exec /bin/sh '")
    expect(output.args.command).not.toContain("__CURSOR_BACKGROUND_SHELL__")

    const envOut = { env: {} as Record<string, string> }
    await plugin["shell.env"]?.({
      cwd: process.cwd(),
      sessionID: "ses_1",
      callID,
    } as never, envOut as never)
    const result = Bun.spawnSync(["/bin/sh", "-c", output.args.command], {
      env: { ...process.env, ...envOut.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stdout.toString()).toContain("__CURSOR_BACKGROUND_SHELL__")
    await reapBackgroundSpawn(result.stdout.toString())
  }))

  it("keeps timeout-shaped successful stdout in output and metadata.output", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const raw = "feature/cp16\r\n\r\n<shell_metadata>\nshell tool terminated command after exceeding timeout 60000 ms.\n</shell_metadata>"
    const output = { title: "command", output: raw, metadata: { exit: 0, output: raw } }
    await plugin["tool.execute.after"]?.({ tool: "bash", sessionID: "ses_1", callID: "cursor_timeout_text", args: {} } as never, output as never)
    expect(output.output).toBe(raw)
    expect(output.metadata.output).toBe(raw)
  })

  it("sanitizes both output and metadata.output after soft-background completion", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const callID = "cursor_hook_meta_sanitize"
    registerCursorShellCall(callID, {
      shell_stream: true,
      command: "sleep 60",
      working_directory: process.cwd(),
      timeout_ms: 5_000,
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
    })
    const marker = "__CURSOR_SHELL_BACKGROUND__43210:/tmp/cursor-opencode-shell.XYZ\n"
    const output = {
      title: "wrapped",
      output: `started\n\n${marker}`,
      metadata: { exit: 0, output: `started\n\n${marker}` },
    }
    await plugin["tool.execute.after"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID,
      args: {},
    } as never, output as never)
    expect(output.title).toBe("sleep 60")
    expect(output.output).toBe("started\nStill running in the background (pid 43210) after 5000ms.\n")
    expect(output.metadata.output).toBe("started\nStill running in the background (pid 43210) after 5000ms.\n")
  })

  it("sanitizes exit markers when host-shell Terminated noise trails them", async () => {
    const plugin = await CursorPlugin({ directory: process.cwd() } as never)
    const callID = "cursor_hook_exit_trailing"
    registerCursorShellCall(callID, {
      shell_stream: true,
      command: "echo hello",
      working_directory: process.cwd(),
      timeout_ms: 5_000,
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
    })
    const noise =
      "/bin/bash: line 31:  4676 Terminated: 15          nohup sh -c 'cursor-shell-watchdog'\n"
    const output = {
      title: "wrapped",
      output: `hello\n\n__CURSOR_SHELL_EXIT__0\n${noise}`,
      metadata: { exit: 0, output: `hello\n\n__CURSOR_SHELL_EXIT__0\n${noise}` },
    }
    await plugin["tool.execute.after"]?.({
      tool: "bash",
      sessionID: "ses_1",
      callID,
      args: {},
    } as never, output as never)
    expect(output.title).toBe("echo hello")
    expect(output.output).toBe("hello\n")
    expect(output.metadata.output).toBe("hello\n")
  })
})

const originalHome = process.env.HOME
const originalXdgCache = process.env.XDG_CACHE_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const originalTelemetry = process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY

afterEach(() => {
  resetCursorShellCalls()
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
  it("publishes derived and supplied families from the cached model inventory", async () => {
    const fakeHome = path.join(os.tmpdir(), `cursor-plugin-family-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_CACHE_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    const cacheDir = path.join(fakeHome, ".cache", "opencode")
    try {
      await writeCache(cacheDir, {
        fetchedAt: Date.now(),
        models: [
          { id: "default", variants: [] },
          { id: "gemini-3.8-flash", variants: [] },
          { id: "gpt-5.4-nano", variants: [] },
          { id: "claude-haiku-4-5", family: "   ", variants: [] },
          { id: "gpt-5.6-sol-1m", variants: [] },
          { id: "grok-4.7-fast", variants: [] },
          { id: "kimi-k2.7-code", variants: [] },
          { id: "explicit", family: "  custom-family  ", variants: [] },
        ],
      })
      const plugin = await CursorPlugin({ directory: fakeHome } as never)
      const config: { provider?: Record<string, { models?: Record<string, Record<string, unknown>> }> } = {}
      await plugin.config?.(config as never)
      const models = config.provider?.cursor?.models
      expect(models?.default).not.toHaveProperty("family")
      expect(models?.["gemini-3.8-flash"]?.family).toBe("gemini-flash")
      expect(models?.["gpt-5.4-nano"]?.family).toBe("gpt-nano")
      expect(models?.["claude-haiku-4-5"]?.family).toBe("claude-haiku")
      expect(models?.["gpt-5.6-sol-1m"]?.family).toBe("gpt-sol")
      expect(models?.["grok-4.7-fast"]?.family).toBe("grok")
      expect(models?.["kimi-k2.7-code"]?.family).toBe("kimi-k2")
      expect(models?.explicit?.family).toBe("custom-family")
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

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
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec, n: Math.random() }),
  ).toString("base64")
  return `${header}.${payload}.sig`
}

/** Cursor browser-login session JWT: 60-day life, issue time in `time`. */
function sessionJwt(issuedAgoSec: number): string {
  const issued = Math.floor(Date.now() / 1000) - issuedAgoSec
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    type: "session",
    time: String(issued),
    exp: issued + 60 * 86_400,
    randomness: Math.random().toString(36),
  })).toString("base64url")
  return `${header}.${payload}.sig`
}

const DAY_S = 86_400

const INSTALLER_FIXTURE = `
DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.07.09-a3815c0/\${OS}/\${ARCH}/agent-cli-package.tar.gz"
`

type LoaderOptions = Record<string, unknown> & {
  accessToken?: string
  apiKey?: string
  getAccessToken?: (request?: { forceRefresh?: boolean }) => Promise<string>
}

describe("loadModels on cache miss", () => {
  let fakeHome: string
  let projectDir: string
  let cacheDir: string
  let dataDir: string
  let realFetch: typeof globalThis.fetch
  let availableModelsCalls: number
  let serverConfigCalls: number
  let serverConfigBodies: string[]
  /** `POST /oauth/token` session renewals. */
  let refreshCalls: number
  /** Calls to the removed `/auth/token` route; must stay 0. */
  let legacyRefreshCalls: number
  let exchangeKeys: string[]
  let sessionResponse: () => Response | Promise<Response>
  let exchangeResponse: () => Response
  let persisted: unknown[]
  let persistAttempts: number

  async function writeAuth(cursor: unknown): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, "auth.json"), JSON.stringify({ cursor }))
  }

  /** Plugin input whose `auth.set` also updates auth.json, as OpenCode does. */
  function pluginInput(options: { failPersist?: boolean } = {}) {
    return {
      directory: projectDir,
      client: {
        auth: {
          set: async (opts: { body: unknown }) => {
            persistAttempts += 1
            if (options.failPersist) throw new Error("auth.set failed")
            persisted.push(opts.body)
            await writeAuth(opts.body)
            return { data: true }
          },
        },
      },
    } as never
  }

  async function runLoader(
    plugin: Awaited<ReturnType<typeof CursorPlugin>>,
    getAuth: () => Promise<unknown>,
  ): Promise<LoaderOptions> {
    const auth = plugin.auth
    if (!auth || !("loader" in auth) || !auth.loader) throw new Error("missing loader")
    return await auth.loader(getAuth as never, {} as never) as LoaderOptions
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
    legacyRefreshCalls = 0
    exchangeKeys = []
    sessionResponse = () => Response.json({ access_token: sessionJwt(0), id_token: "id", shouldLogout: false })
    exchangeResponse = () => Response.json({ accessToken: fakeJwt(3600), refreshToken: "example-refresh-token" })
    persisted = []
    persistAttempts = 0
    realFetch = globalThis.fetch
    resetClientVersionCache()
    resetAgentUrlCache()
    resetAuthRenewalState()

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/oauth/token")) {
        refreshCalls += 1
        return sessionResponse()
      }
      if (url.includes("/auth/token")) {
        legacyRefreshCalls += 1
        return new Response("Route POST:/auth/token not found", { status: 404 })
      }
      if (url.includes("/auth/exchange_user_api_key")) {
        const authorization = new Headers(init?.headers).get("authorization") ?? ""
        exchangeKeys.push(authorization.replace(/^Bearer /, ""))
        return exchangeResponse()
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
    }) as unknown as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    resetClientVersionCache()
    resetAgentUrlCache()
    resetAuthRenewalState()
    expect(legacyRefreshCalls).toBe(0)
    await rm(fakeHome, { recursive: true, force: true })
  })

  it("fetches and caches models when oauth auth exists and cache is empty", async () => {
    await writeAuth({
      type: "oauth",
      access: sessionJwt(DAY_S),
      refresh: "refresh-tok",
      expires: Date.now() + 59 * DAY_S * 1000,
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
      schemaVersion: MODEL_CACHE_SCHEMA_VERSION - 1,
      models: [{ id: "stale-model", displayName: "Stale", variants: [] }],
    })
    await writeAuth({
      type: "oauth",
      access: sessionJwt(DAY_S),
      refresh: "refresh-tok",
      expires: Date.now() + 59 * DAY_S * 1000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(config.provider?.cursor?.models).not.toHaveProperty("stale-model")
    expect(availableModelsCalls).toBe(1)
    expect(await readCache(cacheDir)).toMatchObject({
      schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      models: [{ id: "fetched-model" }],
    })
  })

  it("renews a due session at startup through /oauth/token, preserving extras", async () => {
    const old = sessionJwt(16 * DAY_S)
    await writeAuth({
      type: "oauth",
      access: old,
      refresh: old,
      expires: Date.now() + 44 * DAY_S * 1000,
      accountId: "acct-1",
      enterpriseUrl: "https://enterprise.example",
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(refreshCalls).toBe(1)
    expect(persisted).toHaveLength(1)
    const saved = persisted[0] as { access: string; refresh: string; expires: number }
    expect(saved).toMatchObject({ type: "oauth", accountId: "acct-1", enterpriseUrl: "https://enterprise.example" })
    expect(saved.access).not.toBe(old)
    // Cursor's IDE stores the renewed session token as both.
    expect(saved.refresh).toBe(saved.access)
    expect(saved.expires).toBeGreaterThan(Date.now() + 59 * DAY_S * 1000)
  })

  it("returns empty models when auth.json is absent", async () => {
    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toEqual({})
    expect(availableModelsCalls).toBe(0)
  })

  it("returns empty models when Cursor ended the session, without persisting", async () => {
    sessionResponse = () => Response.json({ access_token: "", id_token: "", shouldLogout: true })
    await writeAuth({
      type: "oauth",
      access: sessionJwt(61 * DAY_S),
      refresh: "",
      expires: Date.now() - 60_000,
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toEqual({})
    expect(refreshCalls).toBe(1)
    expect(availableModelsCalls).toBe(0)
    expect(persisted).toHaveLength(0)
  })

  it("returns empty models when an expired session cannot be renewed and does not persist", async () => {
    sessionResponse = () => new Response("nope", { status: 500 })
    await writeAuth({
      type: "oauth",
      access: sessionJwt(61 * DAY_S),
      refresh: "bad-refresh",
      expires: Date.now() - 60_000,
      enterpriseUrl: "https://enterprise.example",
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toEqual({})
    expect(refreshCalls).toBe(1)
    expect(availableModelsCalls).toBe(0)
    expect(persisted).toHaveLength(0)
  })

  it("keeps using a valid session through a transient renewal failure", async () => {
    sessionResponse = () => new Response("down", { status: 503 })
    const old = sessionJwt(16 * DAY_S)
    await writeAuth({ type: "oauth", access: old, refresh: old, expires: Date.now() + 44 * DAY_S * 1000 })

    const plugin = await CursorPlugin(pluginInput())
    const opts = await runLoader(plugin, async () => ({ type: "oauth", access: old, refresh: old, expires: 0 }))

    expect(await opts.getAccessToken!()).toBe(old)
    expect(refreshCalls).toBe(1) // the second call is inside the backoff
    expect(persisted).toHaveLength(0)
  })

  it("still uses the renewed session when persisting fails", async () => {
    const old = sessionJwt(16 * DAY_S)
    await writeAuth({ type: "oauth", access: old, refresh: old, expires: Date.now() + 44 * DAY_S * 1000 })

    const plugin = await CursorPlugin(pluginInput({ failPersist: true }))
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)
    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")

    // getAuth still returns the old credential: the renewal is not repeated,
    // and the failed write is not retried on every Run.
    const opts = await runLoader(plugin, async () => ({ type: "oauth", access: old, refresh: old, expires: 0 }))
    expect(await opts.getAccessToken!()).not.toBe(old)
    await opts.getAccessToken!()
    expect(refreshCalls).toBe(1)
    expect(persistAttempts).toBe(1)
  })

  it("does not overwrite a credential that changed during renewal", async () => {
    const old = sessionJwt(16 * DAY_S)
    const relogin = sessionJwt(0)
    await writeAuth({ type: "oauth", access: old, refresh: old, expires: 0 })
    sessionResponse = async () => {
      // A re-login lands while the renewal request is in flight.
      await writeAuth({ type: "oauth", access: relogin, refresh: relogin, expires: 0 })
      return Response.json({ access_token: sessionJwt(0), shouldLogout: false })
    }

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(refreshCalls).toBe(1)
    expect(persisted).toHaveLength(0)
  })

  it("never uses an API key for a browser login, or a session renewal for an API key", async () => {
    const old = sessionJwt(16 * DAY_S)
    await writeAuth({ type: "oauth", access: old, refresh: old, expires: 0 })
    const plugin = await CursorPlugin(pluginInput())
    const oauthOpts = await runLoader(plugin, async () => ({ type: "oauth", access: old, refresh: old, expires: 0 }))
    expect(oauthOpts.apiKey).toBeUndefined()
    expect(exchangeKeys).toEqual([])

    resetAuthRenewalState()
    refreshCalls = 0
    const apiAuth = { type: "api", key: fakeJwt(-60), metadata: { apiKey: "crsr_k" } }
    await writeAuth(apiAuth)
    const apiOpts = await runLoader(plugin, async () => apiAuth)
    expect(apiOpts.apiKey).toBeUndefined()
    expect(refreshCalls).toBe(0)
    expect(exchangeKeys).toEqual(["crsr_k"])
  })

  it("fetches and caches models when api auth exists and cache is empty", async () => {
    await writeAuth({
      type: "api",
      key: fakeJwt(3600),
      metadata: { apiKey: "crsr_l" },
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(availableModelsCalls).toBe(1)
    expect(exchangeKeys).toEqual([])
    expect((await readCache(cacheDir))?.models[0]?.id).toBe("fetched-model")
  })

  it("re-exchanges the stored api key for an expired JWT and drops the unused refresh token", async () => {
    await writeAuth({
      type: "api",
      key: fakeJwt(-60),
      metadata: { apiKey: "crsr_s", refreshToken: "example-refresh-token", note: "keep-me" },
    })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(exchangeKeys).toEqual(["crsr_s"])
    expect(persisted).toHaveLength(1)
    const saved = persisted[0] as { type: string; key: string; metadata: Record<string, string> }
    expect(saved.type).toBe("api")
    expect(isExpiringSoon(saved.key)).toBe(false)
    expect(saved.metadata).toEqual({ apiKey: "crsr_s", note: "keep-me" })
  })

  it("exchanges a raw api key the host stored as `key`", async () => {
    await writeAuth({ type: "api", key: "crsr_i" })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    expect(config.provider?.cursor?.models).toHaveProperty("fetched-model")
    expect(exchangeKeys).toEqual(["crsr_i"])
    expect(persisted).toHaveLength(1)
    const saved = persisted[0] as { key: string; metadata: Record<string, string> }
    expect(saved.key.startsWith("crsr_")).toBe(false)
    expect(saved.metadata).toEqual({ apiKey: "crsr_i" })
  })

  it("explains that an expired API-key login saved without the key needs a new sign-in", async () => {
    const expired = fakeJwt(-60)
    const stored = { type: "api", key: expired, metadata: { refreshToken: "example-refresh-token" } }
    await writeAuth(stored)

    const plugin = await CursorPlugin(pluginInput())
    const opts = await runLoader(plugin, async () => stored)

    const error = await opts.getAccessToken!().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CursorAuthError)
    expect((error as Error).message).toMatch(/saved without the key/)
    expect(exchangeKeys).toEqual([])
    expect(persisted).toHaveLength(0)
  })

  it("loader hands the provider a token function and no credential in options", async () => {
    const live = fakeJwt(3600)
    const stored = { type: "api" as const, key: live, metadata: { apiKey: "crsr_s" } }
    await writeAuth(stored)
    const session = sessionJwt(DAY_S)
    const oauth = { type: "oauth" as const, access: session, refresh: session, expires: 0 }

    const plugin = await CursorPlugin(pluginInput())
    for (const [credential, token] of [[stored, live], [oauth, session]] as const) {
      const opts = await runLoader(plugin, async () => credential)
      expect(Object.keys(opts).sort()).toEqual(["cacheDir", "getAccessToken", "workspaceRoot"])
      expect(await opts.getAccessToken!()).toBe(token)
      // OpenCode serves provider options through JSON (`toPublicInfo`), as it
      // does for its own OAuth providers' `fetch`: functions drop out.
      const serialized = JSON.stringify(opts)
      expect(serialized).not.toContain("crsr_")
      expect(serialized).not.toContain(token)
      expect(serialized).not.toContain("getAccessToken")
    }
  })

  it("getAccessToken follows a re-login without a restart", async () => {
    const first = sessionJwt(DAY_S)
    let current: unknown = { type: "oauth", access: first, refresh: first, expires: 0 }
    await writeAuth(current)
    const plugin = await CursorPlugin(pluginInput())
    const opts = await runLoader(plugin, async () => current)
    expect(await opts.getAccessToken!()).toBe(first)

    const second = sessionJwt(0)
    current = { type: "oauth", access: second, refresh: second, expires: 0 }
    expect(await opts.getAccessToken!()).toBe(second)
  })

  it("getAccessToken force-renews a session Cursor rejected", async () => {
    const live = sessionJwt(DAY_S)
    const stored = { type: "oauth", access: live, refresh: live, expires: 0 }
    await writeAuth(stored)
    const plugin = await CursorPlugin(pluginInput())
    const opts = await runLoader(plugin, async () => stored)
    expect(refreshCalls).toBe(0)

    const renewed = await opts.getAccessToken!({ forceRefresh: true })
    expect(renewed).not.toBe(live)
    expect(refreshCalls).toBe(1)
  })

  it("renews a session on demand once it becomes due, with no timer", async () => {
    const live = sessionJwt(DAY_S)
    let current: unknown = { type: "oauth", access: live, refresh: live, expires: 0 }
    await writeAuth(current)
    const plugin = await CursorPlugin(pluginInput())

    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0)
      return realSetTimeout(callback, delay)
    }) as typeof setTimeout
    let opts: LoaderOptions
    try {
      opts = await runLoader(plugin, async () => current)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    // Like OpenCode's own OAuth providers: nothing is scheduled ahead.
    expect(delays.filter((delay) => delay > 60_000)).toEqual([])
    expect(refreshCalls).toBe(0)

    // A re-login lands, then a week passes: the next Run's token request
    // renews the credential it reads now, not the one seen at load time.
    const relogin = sessionJwt(0)
    current = { type: "oauth", access: relogin, refresh: relogin, expires: 0 }
    await writeAuth(current)
    setSystemTime(new Date(Date.now() + 8 * DAY_S * 1000))
    try {
      const token = await opts.getAccessToken!()
      expect(refreshCalls).toBe(1)
      expect(token).not.toBe(relogin)
      expect(persisted).toHaveLength(1)
      const saved = persisted[0] as { access: string; refresh: string }
      expect(saved.access).toBe(token)
      expect(saved.refresh).toBe(token)
    } finally {
      setSystemTime()
    }
  })

  it("api key login stores only the raw key next to the exchanged JWT", async () => {
    const plugin = await CursorPlugin(pluginInput())
    const method = plugin.auth?.methods.find((m) => m.type === "api")
    if (!method || method.type !== "api" || !method.authorize) throw new Error("missing api method")

    const result = await method.authorize({ apiKey: "crsr_g" })

    expect(result.type).toBe("success")
    if (result.type !== "success") return
    expect(isExpiringSoon(result.key)).toBe(false)
    expect(result.metadata).toEqual({ apiKey: "crsr_g" })
  })

  it("loader skips discoverModels when config already wrote a fresh cache", async () => {
    const live = sessionJwt(DAY_S)
    await writeAuth({ type: "oauth", access: live, refresh: "refresh-tok", expires: 0 })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)
    expect(availableModelsCalls).toBe(1)

    await runLoader(plugin, async () => ({ type: "oauth", access: live, refresh: "refresh-tok", expires: 0 }))

    // Fresh cache from config — no second AvailableModels (and no background kick).
    expect(availableModelsCalls).toBe(1)
    expect(serverConfigCalls).toBe(1)
    expect(JSON.parse(serverConfigBodies[0])).toEqual({ telem_enabled: false })
  })

  it("loader honors CURSOR_GET_SERVER_CONFIG_TELEMETRY for agent-url warmup", async () => {
    process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY = "1"
    const live = sessionJwt(DAY_S)
    await writeAuth({ type: "oauth", access: live, refresh: "refresh-tok", expires: 0 })

    const plugin = await CursorPlugin(pluginInput())
    const config: { provider?: Record<string, { models?: Record<string, unknown> }> } = {}
    await plugin.config?.(config as never)

    await runLoader(plugin, async () => ({ type: "oauth", access: live, refresh: "refresh-tok", expires: 0 }))

    expect(serverConfigCalls).toBe(1)
    expect(JSON.parse(serverConfigBodies[0])).toEqual({ telem_enabled: true })
  })
})
