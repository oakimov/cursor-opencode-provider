import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { collectRules, fetchRemoteInstruction } from "../src/context/rules.js"
import { collectSkills } from "../src/context/skills.js"
import { buildRequestContext } from "../src/context/build.js"
import { workspaceRootFromRequestContext } from "../src/context/env.js"
import { opencodeProjectDir } from "../src/context/paths.js"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"

describe("collectRules / buildRequestContext", () => {
  let root: string

  beforeAll(async () => {
    root = path.join(os.tmpdir(), `cursor-ctx-${process.pid}-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "AGENTS.md"), "# Project rules\nUse bun.\n")
    await mkdir(path.join(root, ".opencode", "skills", "demo"), { recursive: true })
    await writeFile(
      path.join(root, ".opencode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n\nDo the demo.\n",
    )
    await mkdir(path.join(root, ".opencode", "agents"), { recursive: true })
    await writeFile(
      path.join(root, ".opencode", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review local changes\n---\n\nReview carefully.\n",
    )
    await mkdir(path.join(root, ".cursor", "rules"), { recursive: true })
    await writeFile(path.join(root, ".cursor", "rules", "extra.md"), "cursor instruction via opencode.json")
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({
        instructions: [".cursor/rules/*.md"],
        permission: "allow",
        mcp: {
          github: { type: "remote", url: "https://example.test/github" },
          "my server": { type: "remote", url: "https://example.test/custom" },
        },
      }),
    )
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("loads AGENTS.md and honors .cursor paths listed in instructions", async () => {
    const { rules } = await collectRules(root)
    expect(rules.some((r) => r.fullPath.endsWith("AGENTS.md"))).toBe(true)
    expect(rules.some((r) => r.fullPath.replace(/\\/g, "/").includes("/.cursor/rules/extra.md"))).toBe(true)
  })

  it("discovers .opencode skills", async () => {
    const skills = await collectSkills(root, root)
    expect(skills.some((s) => s.name === "demo")).toBe(true)
  })

  it("marks augmented custom subagents complete when the host exposes only string subagent_type", async () => {
    const prevCache = process.env.XDG_CACHE_HOME
    const cacheRoot = path.join(os.tmpdir(), `cursor-ctx-agents-string-${process.pid}-${Date.now()}`)
    process.env.XDG_CACHE_HOME = cacheRoot
    try {
      const ctx = await buildRequestContext({
        workspaceRoot: root,
        tools: [{
          name: "task",
          description: "Launch a subagent with subagent_type.",
          inputSchema: {
            type: "object",
            properties: {
              description: { type: "string" },
              prompt: { type: "string" },
              subagent_type: { type: "string" },
            },
          },
        }],
      })
      const subagents = ctx.custom_subagents as Array<Record<string, unknown>>
      expect(subagents.map((agent) => agent.name)).toEqual(["general", "explore", "reviewer"])
      expect(String(subagents.find((agent) => agent.name === "reviewer")?.prompt).trim())
        .toBe("Review carefully.")
      // The raw host task schema is incomplete (subagent_type is a string, not an
      // enum), but the provider augments it with defaults plus discovered agents.
      // This flag describes the final advertised catalog, not the raw host parse.
      expect(ctx.custom_subagents_info_complete).toBe(true)
    } finally {
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = prevCache
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it("advertises the host's complete spawnable-agent catalog to Cursor", async () => {
    const prevCache = process.env.XDG_CACHE_HOME
    const cacheRoot = path.join(os.tmpdir(), `cursor-ctx-agents-${process.pid}-${Date.now()}`)
    process.env.XDG_CACHE_HOME = cacheRoot
    try {
      const ctx = await buildRequestContext({
        workspaceRoot: root,
        tools: [{
          name: "task",
          description: [
            "Delegate work.",
            "Available agent types and the tools they have access to:",
            "- general: General-purpose work.",
            "- explore: Local codebase search.",
            "- scout: External dependency research.",
            "- reviewer: Review local changes.",
          ].join("\n"),
        }],
      })
      const subagents = ctx.custom_subagents as Array<Record<string, unknown>>
      expect(subagents.map((agent) => agent.name)).toEqual([
        "general", "explore", "scout", "reviewer",
      ])
      expect(String(subagents.find((agent) => agent.name === "reviewer")?.prompt).trim())
        .toBe("Review carefully.")
      expect(subagents.find((agent) => agent.name === "scout")?.description)
        .toBe("External dependency research.")
      expect(ctx.custom_subagents_info_complete).toBe(true)

      const decoded = decodeMessage<Record<string, unknown>>(
        "RequestContext",
        encodeMessage("RequestContext", ctx),
      )
      expect((decoded.custom_subagents as unknown[]).length).toBe(4)
    } finally {
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = prevCache
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it("builds an encodable RequestContext with rules and skills", async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    })
    expect(Array.isArray(ctx.rules)).toBe(true)
    expect((ctx.rules as unknown[]).length).toBeGreaterThan(0)
    expect(ctx.rules_info_complete).toBe(true)
    expect(ctx.env_info_complete).toBe(true)
    expect(ctx.web_search_enabled).toBe(false)
    expect(ctx.web_fetch_enabled).toBe(false)
    // OpenCode owns execution permissions. A global allow boolean cannot be
    // translated into Cursor's allow/block instruction-list messages.
    expect(ctx).not.toHaveProperty("user_permissions_auto_run")
    expect(ctx).not.toHaveProperty("project_permissions_auto_run")
    const bytes = encodeMessage("RequestContext", ctx)
    expect(bytes.length).toBeGreaterThan(50)
    const decoded = decodeMessage("RequestContext", bytes) as Record<string, unknown>
    expect(Array.isArray(decoded.rules)).toBe(true)
  })

  it("advertises Cursor metadata under ~/.cache/opencode/projects, not the workspace", async () => {
    const prevCache = process.env.XDG_CACHE_HOME
    const cacheRoot = path.join(os.tmpdir(), `cursor-ctx-cache-${process.pid}-${Date.now()}`)
    process.env.XDG_CACHE_HOME = cacheRoot
    try {
      const expectedProject = opencodeProjectDir(root)
      const ctx = await buildRequestContext({
        workspaceRoot: root,
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      })
      const env = ctx.env as Record<string, unknown>
      expect(env.workspace_paths).toEqual([path.resolve(root)])
      expect(env.project_folder).toBe(expectedProject)
      expect(env.project_folder).not.toBe(path.resolve(root))
      expect(env.terminals_folder).toBe(path.join(expectedProject, "terminals"))
      expect(env.agent_transcripts_folder).toBe(path.join(expectedProject, "agent-transcripts"))
      const fsOpts = ctx.mcp_file_system_options as Record<string, unknown>
      expect(fsOpts.workspace_project_dir).toBe(expectedProject)
      expect(workspaceRootFromRequestContext(ctx)).toBe(path.resolve(root))
    } finally {
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = prevCache
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it("splits only config-backed MCP tools and preserves custom underscore names", async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [
        { name: "github_create_pull_request" },
        { name: "my_server_lookup" },
        { name: "custom_helper" },
      ],
    })
    const tools = ctx.tools as Array<Record<string, unknown>>
    expect(tools.map((tool) => [tool.provider_identifier, tool.tool_name])).toEqual([
      ["github", "create_pull_request"],
      ["my_server", "lookup"],
      ["opencode", "custom_helper"],
    ])
  })
})

describe("collectRules remote instructions (F1 HTTPS-only)", () => {
  let root: string
  let realFetch: typeof globalThis.fetch
  let fetchedUrls: string[]

  beforeAll(async () => {
    root = path.join(os.tmpdir(), `cursor-ctx-remote-${process.pid}-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "AGENTS.md"), "# Project\n")
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    realFetch = globalThis.fetch
    fetchedUrls = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      fetchedUrls.push(url)
      return new Response("# remote instruction\n", { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("fetches https:// instructions and includes content", async () => {
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({ instructions: ["https://example.com/rules.md"] }),
    )
    const { rules } = await collectRules(root)
    expect(fetchedUrls).toEqual(["https://example.com/rules.md"])
    expect(rules.some((r) => r.fullPath === "https://example.com/rules.md" && r.content.includes("remote instruction"))).toBe(
      true,
    )
  })

  it("skips http:// instructions without fetching", async () => {
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({ instructions: ["http://example.com/rules.md", "https://example.com/ok.md"] }),
    )
    const { rules } = await collectRules(root)
    expect(fetchedUrls).toEqual(["https://example.com/ok.md"])
    expect(rules.some((r) => r.fullPath.startsWith("http://"))).toBe(false)
    expect(rules.some((r) => r.fullPath === "https://example.com/ok.md")).toBe(true)
  })

  it("keeps the timeout active while consuming the response body", async () => {
    let aborted = false
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      text: () => new Promise<string>((_resolve, reject) => {
        const signal = init?.signal
        const onAbort = () => {
          aborted = true
          reject(new DOMException("Aborted", "AbortError"))
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener("abort", onAbort, { once: true })
      }),
    })) as typeof fetch

    expect(await fetchRemoteInstruction("https://example.com/stalled.md", 5)).toBeUndefined()
    expect(aborted).toBe(true)
  })
})

describe("collectRules OPENCODE_DISABLE_PROJECT_CONFIG (F2)", () => {
  let root: string
  let prev: string | undefined

  beforeAll(async () => {
    root = path.join(os.tmpdir(), `cursor-ctx-disable-project-${process.pid}-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "AGENTS.md"), "# Should be skipped when project config disabled\n")
    await mkdir(path.join(root, ".cursor", "rules"), { recursive: true })
    await writeFile(path.join(root, ".cursor", "rules", "extra.md"), "project instruction")
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({ instructions: [".cursor/rules/*.md", "~/.ssh/id_rsa"] }),
    )
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    prev = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = prev
  })

  it("skips project AGENTS.md and project instructions", async () => {
    const { rules, config } = await collectRules(root)
    expect(config.instructions ?? []).not.toContain(".cursor/rules/*.md")
    expect(rules.some((r) => r.fullPath.replace(/\\/g, "/").includes("/.cursor/rules/extra.md"))).toBe(false)
    expect(rules.some((r) => r.fullPath === path.resolve(root, "AGENTS.md"))).toBe(false)
  })
})
