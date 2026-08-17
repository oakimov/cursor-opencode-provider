import { beforeEach, describe, it, expect } from "bun:test"
import {
  computeAllowTools,
  MAX_TURN_STATE_SESSIONS,
  resetTurnStateForTests,
  restoreTurnToolCatalog,
  resolveTurnConversationReset,
  resolveTurnToolState,
} from "../src/language-model.js"
import {
  bindConversationId,
  resetConversationBindingsForTests,
} from "../src/protocol/conversation-bind.js"
import { buildExecClientMessages } from "../src/protocol/tools.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("computeAllowTools", () => {
  it("is false when OpenCode advertises no tools (compaction/summary)", () => {
    expect(computeAllowTools(0, undefined)).toBe(false)
    expect(computeAllowTools(0, { type: "auto" })).toBe(false)
  })

  it("is false when toolChoice is none", () => {
    expect(computeAllowTools(3, { type: "none" })).toBe(false)
  })

  it("is true when tools are present and toolChoice allows them", () => {
    expect(computeAllowTools(1, undefined)).toBe(true)
    expect(computeAllowTools(2, { type: "auto" })).toBe(true)
    expect(computeAllowTools(1, { type: "required" })).toBe(true)
  })
})

describe("compaction tool catalog", () => {
  beforeEach(() => {
    resetTurnStateForTests()
    resetConversationBindingsForTests()
  })

  it("advertises the prior catalog during compaction but refuses execution", async () => {
    const tools = [{ name: "bash" }, { name: "grep" }]
    expect(await resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: tools,
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: true })

    expect(await resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("preserves a literal no-tool call when no session key can correlate a sibling", async () => {
    expect(await resolveTurnToolState({
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("keeps the catalog advertised on every lifecycle turn, not just compaction", async () => {
    // Collapsing a title-generation turn to tools=0 changes the RequestContext
    // shape and costs the whole prompt cache; execution stays refused instead.
    const tools = [{ name: "read", inputSchema: { type: "object" } }]
    restoreTurnToolCatalog("ses_restored_catalog", tools)

    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: false })
    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: false })
    expect(await resolveTurnToolState({
      sessionKey: "ses_restored_catalog",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("waits indefinitely for a sibling catalog on cold-start lifecycle turns", async () => {
    // The production race exceeded one second. A timeout merely moves the race
    // threshold, so assert that the lifecycle call remains blocked well beyond
    // the old 100 ms cutoff and resolves only when the real catalog arrives.
    const tools = [{ name: "read" }, { name: "bash" }]
    const sessionKey = "ses_cold_start"
    let settled = false

    const lifecycle = resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: false,
    }).then((state) => {
      settled = true
      return state
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toBe(false)

    await resolveTurnToolState({
      sessionKey,
      incomingTools: tools,
      isCompaction: false,
    })

    expect(await lifecycle).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("cancels a catalog wait instead of sending tools=0", async () => {
    const abort = new AbortController()
    const lifecycle = resolveTurnToolState({
      sessionKey: "ses_cancelled",
      incomingTools: [],
      isCompaction: false,
      abortSignal: abort.signal,
    })

    abort.abort()
    await expect(lifecycle).rejects.toThrow("tool-catalog wait cancelled")
  })

  it("advertises a genuinely restricted catalog verbatim", async () => {
    const full = [{ name: "read" }, { name: "write" }, { name: "bash" }]
    const restricted = [{ name: "read" }]
    await resolveTurnToolState({ sessionKey: "ses_restricted", incomingTools: full, isCompaction: false })

    // A non-empty smaller set is a real restriction, never a lifecycle signal.
    expect(await resolveTurnToolState({
      sessionKey: "ses_restricted",
      incomingTools: restricted,
      isCompaction: false,
    })).toEqual({ advertisedTools: restricted, allowTools: true })
  })

  it("rebases after the summary checkpoint, restores execution, then stays stable", async () => {
    const sessionKey = "ses_transition"
    const tools = [{ name: "bash" }, { name: "grep" }]

    await resolveTurnToolState({ sessionKey, incomingTools: tools, isCompaction: false })
    const beforeCompaction = bindConversationId(sessionKey).conversationId

    const compactionReset = resolveTurnConversationReset({ sessionKey, isCompaction: true })
    const compacted = await resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: true,
    })
    const afterCompaction = bindConversationId(sessionKey, compactionReset).conversationId
    expect(afterCompaction).not.toBe(beforeCompaction)
    expect(compactionReset).toEqual({ reset: true, reason: "compaction" })
    expect(compacted).toEqual({ advertisedTools: tools, allowTools: false })

    const resumedReset = resolveTurnConversationReset({ sessionKey, isCompaction: false })
    const resumed = await resolveTurnToolState({
      sessionKey,
      incomingTools: tools,
      isCompaction: false,
    })
    const afterRebase = bindConversationId(sessionKey, resumedReset).conversationId
    expect(resumedReset).toEqual({ reset: true, reason: "post-compaction-rebase" })
    expect(afterRebase).not.toBe(afterCompaction)
    expect(resumed).toEqual({ advertisedTools: tools, allowTools: true })

    expect(resolveTurnConversationReset({ sessionKey, isCompaction: false }))
      .toEqual({ reset: false })
    expect(bindConversationId(sessionKey).conversationId).toBe(afterRebase)
  })

  it("does not reset ordinary no-tool turns", () => {
    expect(resolveTurnConversationReset({ sessionKey: "ses_no_tools", isCompaction: false }))
      .toEqual({ reset: false })
  })

  it("bounds cached tool catalogs and pending post-compaction rebases", async () => {
    await resolveTurnToolState({
      sessionKey: "oldest",
      incomingTools: [{ name: "read" }],
      isCompaction: false,
    })
    resolveTurnConversationReset({ sessionKey: "oldest", isCompaction: true })

    for (let i = 0; i < MAX_TURN_STATE_SESSIONS; i++) {
      const sessionKey = `new-${i}`
      await resolveTurnToolState({
        sessionKey,
        incomingTools: [{ name: "bash" }],
        isCompaction: false,
      })
      resolveTurnConversationReset({ sessionKey, isCompaction: true })
    }

    // The evicted session has no safe catalog. It must wait rather than emit an
    // empty one; cancellation tears down the wait without changing advertisement.
    const abort = new AbortController()
    const evicted = resolveTurnToolState({
      sessionKey: "oldest",
      incomingTools: [],
      isCompaction: true,
      abortSignal: abort.signal,
    })
    abort.abort()
    await expect(evicted).rejects.toThrow("tool-catalog wait cancelled")
    expect(resolveTurnConversationReset({ sessionKey: "oldest", isCompaction: false }))
      .toEqual({ reset: false })
  })
})

describe("refuse exec while tools disallowed", () => {
  it("builds a typed grep_result error + stream_close (compaction refuse path)", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: "",
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    expect(frames.length).toBe(2)
    const acm = decodeMessage("AgentClientMessage", frames[0]) as Record<string, unknown>
    const ecm = acm.exec_client_message as Record<string, unknown>
    expect(ecm.id).toBe(1)
    const grep = ecm.grep_result as Record<string, unknown>
    expect(grep.error).toEqual({
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    const close = decodeMessage("AgentClientMessage", frames[1]) as Record<string, unknown>
    expect(close.exec_client_control_message).toEqual({ stream_close: { id: 1 } })
  })
})
