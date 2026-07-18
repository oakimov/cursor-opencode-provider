import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { collectRules, fetchRemoteInstruction } from "../src/context/rules.js"
import { collectSkills } from "../src/context/skills.js"
import { buildRequestContext } from "../src/context/build.js"
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

  it("builds an encodable RequestContext with rules and skills", async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    })
    expect(Array.isArray(ctx.rules)).toBe(true)
    expect((ctx.rules as unknown[]).length).toBeGreaterThan(0)
    expect(ctx.rules_info_complete).toBe(true)
    expect(ctx.env_info_complete).toBe(true)
    // OpenCode owns execution permissions. A global allow boolean cannot be
    // translated into Cursor's allow/block instruction-list messages.
    expect(ctx).not.toHaveProperty("user_permissions_auto_run")
    expect(ctx).not.toHaveProperty("project_permissions_auto_run")
    const bytes = encodeMessage("RequestContext", ctx)
    expect(bytes.length).toBeGreaterThan(50)
    const decoded = decodeMessage("RequestContext", bytes) as Record<string, unknown>
    expect(Array.isArray(decoded.rules)).toBe(true)
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
