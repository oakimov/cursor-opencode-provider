import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { buildRequestContextResult } from "../src/protocol/tools.js"
import {
  clearFrozenRequestContext,
  getFrozenRequestContext,
  getOrBuildRequestContext,
  MAX_FROZEN_REQUEST_CONTEXTS,
  resetFrozenRequestContextsForTests,
  setFrozenRequestContext,
} from "../src/context/frozen.js"
import {
  bindConversationId,
  MAX_ACTIVE_CONVERSATION_BINDINGS,
  resetConversationBindingsForTests,
} from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Wire-encode RequestContext the way exec #10 does, for byte-identity asserts. */
function encodeRequestContext(context: Record<string, unknown>): Uint8Array {
  return buildRequestContextResult(1, context)
}

describe("frozen request_context", () => {
  let root: string
  let cacheRoot: string

  beforeAll(async () => {
    root = path.join(os.tmpdir(), `cursor-frozen-ctx-${process.pid}-${Date.now()}`)
    cacheRoot = path.join(os.tmpdir(), `cursor-frozen-cache-${process.pid}-${Date.now()}`)
    setHostCacheDirOverride(cacheRoot)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "AGENTS.md"), "# freeze test\n")
    // Init a tiny git repo so collectGit has porcelain status to freeze.
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileAsync = promisify(execFile)
    await execFileAsync("git", ["init"], { cwd: root })
    await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root })
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: root })
    await execFileAsync("git", ["add", "AGENTS.md"], { cwd: root })
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root })
  })

  afterAll(async () => {
    setHostCacheDirOverride(undefined)
    await rm(root, { recursive: true, force: true })
    await rm(cacheRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetFrozenRequestContextsForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
  })

  it("builds once then reuses the same object across calls", async () => {
    const conversationId = "conv-freeze-1"
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(first.reused).toBe(false)

    const second = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(second.reused).toBe(true)
    expect(second.context).toBe(first.context)
    expect(Object.isFrozen(first.context)).toBe(true)
    expect(Object.isFrozen(first.context.tools)).toBe(true)
  })

  it("deduplicates overlapping builds for one conversation", async () => {
    const conversationId = "conv-freeze-concurrent"
    const [first, second] = await Promise.all([
      getOrBuildRequestContext(conversationId, { workspaceRoot: root }),
      getOrBuildRequestContext(conversationId, { workspaceRoot: root }),
    ])

    expect(first.context).toBe(second.context)
    expect([first.reused, second.reused].sort()).toEqual([false, true])
  })

  it("prevents callers from mutating the retained snapshot", async () => {
    const first = await getOrBuildRequestContext("conv-freeze-immutable", {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    const tools = first.context.tools as Array<Record<string, unknown>>

    expect(() => tools.push({ name: "write" })).toThrow()
    expect(() => { tools[0]!.name = "write" }).toThrow()

    const reused = await getOrBuildRequestContext("conv-freeze-immutable", {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    expect((reused.context.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "opencode-read",
      tool_name: "read",
    })
  })

  it("keeps encoded request_context bytes identical after workspace changes", async () => {
    const conversationId = "conv-freeze-bytes"
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    const bytes1 = encodeRequestContext(first.context)

    // Mutate the workspace so a fresh build would embed different git status /
    // layout — the frozen snapshot must ignore that.
    await writeFile(path.join(root, "volatile.txt"), `changed-${Date.now()}\n`)

    const second = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(second.reused).toBe(true)
    const bytes2 = encodeRequestContext(second.context)
    expect(sha(bytes2)).toBe(sha(bytes1))
  })

  it("refresh forces a rebuild", async () => {
    const conversationId = "conv-freeze-refresh"
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    const refreshed = await getOrBuildRequestContext(
      conversationId,
      { workspaceRoot: root },
      { refresh: true },
    )
    expect(refreshed.reused).toBe(false)
    expect(refreshed.context).not.toBe(first.context)
  })

  it("updates live tools and then reuses byte-identical capabilities", async () => {
    const conversationId = "conv-freeze-tools"
    const empty = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(empty.context.tools).toEqual([])

    const upgraded = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    expect(upgraded.reused).toBe(false)
    expect(upgraded.context.tools).toHaveLength(1)

    const stable = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    expect(stable.reused).toBe(true)
    expect(stable.context).toBe(upgraded.context)
    expect(stable.context.tools).toHaveLength(1)

    const changed = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{
        name: "read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    })
    expect(changed.reused).toBe(false)
    expect(changed.context).not.toBe(stable.context)
    expect((changed.context.tools as Array<Record<string, unknown>>)[0]?.tool_name)
      .toBe("read")
  })

  it("removes tools on an ordinary restricted/no-tool turn", async () => {
    const conversationId = "conv-freeze-no-downgrade"
    const populated = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    const empty = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })

    expect(empty.reused).toBe(false)
    expect(empty.context).not.toBe(populated.context)
    expect(empty.context.tools).toEqual([])
  })

  it("discovers skill additions and removals during a conversation", async () => {
    const conversationId = "conv-live-skills"
    const skillDir = path.join(root, ".opencode", "skills", "live-skill")
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect((first.context.agent_skills as Array<Record<string, unknown>>)
      .some((skill) => skill.full_path === path.join(skillDir, "SKILL.md"))).toBe(false)

    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: live-skill\ndescription: Added during chat\n---\nUse this live skill.\n",
    )
    const added = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(added.reused).toBe(false)
    expect((added.context.agent_skills as Array<Record<string, unknown>>)
      .some((skill) => skill.description === "Added during chat")).toBe(true)

    const unchanged = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(unchanged.reused).toBe(true)
    expect(unchanged.context).toBe(added.context)

    await rm(skillDir, { recursive: true, force: true })
    const removed = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(removed.reused).toBe(false)
    expect((removed.context.agent_skills as Array<Record<string, unknown>>)
      .some((skill) => skill.description === "Added during chat")).toBe(false)
  })

  it("refreshes MCP server identity when configuration changes", async () => {
    const conversationId = "conv-live-mcp"
    const configPath = path.join(root, "opencode.json")
    const tools = [{ name: "github_create_issue", description: "Create issue" }]
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect((first.context.tools as Array<Record<string, unknown>>)[0]?.provider_identifier)
      .toBe("opencode")

    await writeFile(configPath, JSON.stringify({ mcp: { github: { type: "remote" } } }))
    const enabled = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(enabled.reused).toBe(false)
    expect((enabled.context.tools as Array<Record<string, unknown>>)[0]?.provider_identifier)
      .toBe("github")

    const unchanged = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(unchanged.reused).toBe(true)
    expect(unchanged.context).toBe(enabled.context)

    await rm(configPath, { force: true })
    const disabled = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(disabled.reused).toBe(false)
    expect((disabled.context.tools as Array<Record<string, unknown>>)[0]?.provider_identifier)
      .toBe("opencode")
  })

  it("conversation reset transfers the stable base and refreshes live overlays", async () => {
    const firstId = bindConversationId("ses_freeze").conversationId
    const tools = [{ name: "read" }]
    const first = await getOrBuildRequestContext(firstId, { workspaceRoot: root, tools })
    const firstBytes = encodeRequestContext(first.context)

    // A volatile base change after the first build must not shift the reset
    // prefix; the reset belongs to the same OpenCode workspace/session.
    await writeFile(path.join(root, "after-freeze.txt"), "must stay outside the frozen base\n")
    const reset = bindConversationId("ses_freeze", { reset: true })
    expect(getFrozenRequestContext(firstId)).toBeUndefined()
    expect(getFrozenRequestContext(reset.conversationId)).toBeDefined()

    const transferred = await getOrBuildRequestContext(reset.conversationId, {
      workspaceRoot: root,
      tools,
    })
    expect(transferred.reused).toBe(true)
    expect(sha(encodeRequestContext(transferred.context))).toBe(sha(firstBytes))

    const rebased = bindConversationId("ses_freeze", { reset: true })
    const retransferred = await getOrBuildRequestContext(rebased.conversationId, {
      workspaceRoot: root,
      tools,
    })
    expect(retransferred.reused).toBe(true)
    expect(sha(encodeRequestContext(retransferred.context))).toBe(sha(firstBytes))

    // Live capabilities are still rediscovered rather than frozen across the
    // id boundary.
    const changed = await getOrBuildRequestContext(rebased.conversationId, {
      workspaceRoot: root,
      tools: [...tools, { name: "write" }],
    })
    expect(changed.reused).toBe(false)
    expect(changed.context.tools).toHaveLength(2)
  })

  it("binding LRU eviction clears frozen context with other opaque state", () => {
    const first = bindConversationId("oldest-freeze").conversationId
    setFrozenRequestContext(first, { tools: [] })
    expect(getFrozenRequestContext(first)).toBeDefined()

    for (let i = 0; i < MAX_ACTIVE_CONVERSATION_BINDINGS; i++) {
      bindConversationId(`new-freeze-${i}`)
    }

    expect(getFrozenRequestContext(first)).toBeUndefined()
  })

  it("clearFrozenRequestContext is a no-op for unknown ids", () => {
    clearFrozenRequestContext("missing")
  })

  it("caps the freeze store", () => {
    for (let i = 0; i < MAX_FROZEN_REQUEST_CONTEXTS + 5; i++) {
      setFrozenRequestContext(`cap-${i}`, { i })
    }
    expect(getFrozenRequestContext("cap-0")).toBeUndefined()
    expect(getFrozenRequestContext(`cap-${MAX_FROZEN_REQUEST_CONTEXTS + 4}`)).toBeDefined()
  })
})
