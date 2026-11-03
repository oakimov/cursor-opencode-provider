import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { isProjectConfigDisabled, loadMergedConfig } from "../src/context/rules.js"
import { buildRequestContext, resetWorkspaceFactsForTests } from "../src/context/build.js"
import * as gitDiscovery from "../src/context/git.js"
import { buildEnv, workspaceRootFromRequestContext } from "../src/context/env.js"
import { opencodeProjectDir } from "../src/context/paths.js"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"
import { withTempHostCache } from "./host-cache.js"

describe("buildRequestContext", () => {
  let root: string
  let isolatedHome: string
  let prevHome: string | undefined
  let prevXdgConfig: string | undefined
  let prevTranscriptsFolder: string | undefined
  let restoreGit: (() => void) | undefined

  beforeAll(async () => {
    // These catalog/config tests use a non-repository fixture. Native Git's
    // five-second fallback can race Bun's five-second test deadline; actual
    // Git discovery and failure handling are covered in workspace-facts.test.ts.
    const git = spyOn(gitDiscovery, "collectGit").mockResolvedValue({ repositoryInfo: [], gitRepos: [], statusComplete: true })
    restoreGit = () => git.mockRestore()
    resetWorkspaceFactsForTests()
    prevTranscriptsFolder = process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
    delete process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
    prevHome = process.env.HOME
    prevXdgConfig = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    isolatedHome = path.join(os.tmpdir(), `cursor-ctx-home-${process.pid}-${Date.now()}`)
    await mkdir(isolatedHome, { recursive: true })
    process.env.HOME = isolatedHome
    root = path.join(os.tmpdir(), `cursor-ctx-${process.pid}-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({
        permission: "allow",
        mcp: {
          github: { type: "remote", url: "https://example.test/github" },
          my_server: { type: "local", command: ["true"] },
        },
      }),
    )
  })

  afterAll(async () => {
    restoreGit?.()
    resetWorkspaceFactsForTests()
    if (prevTranscriptsFolder === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER
    else process.env.CURSOR_AGENT_TRANSCRIPTS_FOLDER = prevTranscriptsFolder
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    await rm(root, { recursive: true, force: true })
    await rm(isolatedHome, { recursive: true, force: true })
  })

  it("does not invent custom subagents when the host schema has no catalog", async () => {
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
      expect(ctx.custom_subagents).toBeUndefined()
      expect(ctx.custom_subagents_info_complete).toBe(false)
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
      expect(String(subagents.find((agent) => agent.name === "reviewer")?.prompt))
        .toContain("host-configured reviewer")
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

  it("builds an encodable RequestContext without duplicating host rules or skills", () => withTempHostCache(async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    })
    expect(ctx.rules).toBeUndefined()
    expect(ctx.agent_skills).toBeUndefined()
    expect(ctx.agent_skills_info_complete).toBeUndefined()
    expect(ctx.rules_info_complete).toBe(true)
    expect(ctx.env_info_complete).toBe(true)
    expect(ctx.web_search_enabled).toBe(false)
    expect(ctx.web_fetch_enabled).toBe(false)
    expect(ctx).not.toHaveProperty("user_permissions_auto_run")
    expect(ctx).not.toHaveProperty("project_permissions_auto_run")
    const bytes = encodeMessage("RequestContext", ctx)
    expect(bytes.length).toBeGreaterThan(50)
    const decoded = decodeMessage("RequestContext", bytes) as Record<string, unknown>
    const decodedRules = decoded.rules
    expect(decodedRules === undefined || (Array.isArray(decodedRules) && decodedRules.length === 0)).toBe(true)
  }))

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
      expect(env.process_working_directory).toBe(path.resolve(root))
      expect(env.is_working_dir_home_dir).toBe(false)
      expect(env.project_folder).toBe(expectedProject)
      expect(env.project_folder).not.toBe(path.resolve(root))
      expect(env.terminals_folder).toBe(path.join(expectedProject, "terminals"))
      const holder = path.join(path.dirname(expectedProject), "not-a-directory")
      writeFileSync(holder, "")
      const replaced = path.join(expectedProject, "terminals")
      await rm(replaced, { recursive: true, force: true })
      symlinkSync(holder, replaced)
      const blocked = buildEnv(root)
      expect(blocked.terminals_folder).toBeUndefined()
      await rm(replaced, { force: true })
      expect(env).not.toHaveProperty("agent_transcripts_folder")
      const fsOpts = ctx.mcp_file_system_options as Record<string, unknown>
      expect(fsOpts.workspace_project_dir).toBe(expectedProject)
      expect(workspaceRootFromRequestContext(ctx)).toBe(path.resolve(root))
    } finally {
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = prevCache
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it("splits only config-backed MCP tools and preserves custom underscore names", () => withTempHostCache(async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [
        { name: "github_create_pull_request" },
        { name: "my_server_lookup" },
        { name: "custom_helper" },
      ],
    })
    const tools = ctx.mcp_meta_tool_options as {
      mcp_descriptors: Array<{ server_identifier: string; tools: Array<{ tool_name: string }> }>
    }
    expect(tools.mcp_descriptors.flatMap((descriptor) =>
      descriptor.tools.map((tool) => [descriptor.server_identifier, tool.tool_name]),
    )).toEqual([
      ["github", "create_pull_request"],
      ["my_server", "lookup"],
      ["opencode", "custom_helper"],
    ])
    expect(ctx.tools).toBeUndefined()
  }))
})

describe("loadMergedConfig OPENCODE_DISABLE_PROJECT_CONFIG", () => {
  let root: string
  let isolatedHome: string
  let prev: string | undefined
  let prevHome: string | undefined
  let prevXdgConfig: string | undefined

  beforeAll(async () => {
    prevHome = process.env.HOME
    prevXdgConfig = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    isolatedHome = path.join(os.tmpdir(), `cursor-cfg-home-${process.pid}-${Date.now()}`)
    await mkdir(isolatedHome, { recursive: true })
    process.env.HOME = isolatedHome
    root = path.join(os.tmpdir(), `cursor-cfg-disable-project-${process.pid}-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({ mcp: { github: { type: "remote" } } }),
    )
  })

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdgConfig
    await rm(root, { recursive: true, force: true })
    await rm(isolatedHome, { recursive: true, force: true })
  })

  beforeEach(() => {
    prev = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = prev
  })

  it("skips project opencode.json when project config is disabled", async () => {
    expect(isProjectConfigDisabled()).toBe(true)
    const config = await loadMergedConfig(root)
    expect(config.mcp?.github).toBeUndefined()
  })

  it("reads JSONC trailing commas without stripping comment markers from strings", async () => {
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "0"
    const workspace = path.join(root, "jsonc")
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, "opencode.jsonc"), `{
      // Config comments are allowed alongside strings containing comment tokens.
      "mcp": {
        "docs": { "type": "remote", "url": "https://example.test/docs/*literal*/", },
      }, /* trailing comma before a comment */
      "plugin": ["fixture/*literal*/",],
    }`)
    const config = await loadMergedConfig(workspace)
    expect(config.mcp?.docs).toEqual({ type: "remote", url: "https://example.test/docs/*literal*/" })
    expect(config.plugin).toContain("fixture/*literal*/")
  })
})
