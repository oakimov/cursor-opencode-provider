import { beforeEach, describe, it, expect } from "bun:test"
import {
  computeAllowTools,
  resetTurnStateForTests,
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

  it("advertises the prior catalog during compaction but refuses execution", () => {
    const tools = [{ name: "bash" }, { name: "grep" }]
    expect(resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: tools,
      isCompaction: false,
    })).toEqual({ advertisedTools: tools, allowTools: true })

    expect(resolveTurnToolState({
      sessionKey: "ses_1",
      incomingTools: [],
      isCompaction: true,
    })).toEqual({ advertisedTools: tools, allowTools: false })
  })

  it("does not reinterpret an ordinary no-tool call as compaction", () => {
    expect(resolveTurnToolState({
      sessionKey: "ses_2",
      incomingTools: [],
      toolChoice: { type: "none" },
      isCompaction: false,
    })).toEqual({ advertisedTools: [], allowTools: false })
  })

  it("rebases after the summary checkpoint, restores execution, then stays stable", () => {
    const sessionKey = "ses_transition"
    const tools = [{ name: "bash" }, { name: "grep" }]

    resolveTurnToolState({ sessionKey, incomingTools: tools, isCompaction: false })
    const beforeCompaction = bindConversationId(sessionKey).conversationId

    const compactionReset = resolveTurnConversationReset({ sessionKey, isCompaction: true })
    const compacted = resolveTurnToolState({
      sessionKey,
      incomingTools: [],
      isCompaction: true,
    })
    const afterCompaction = bindConversationId(sessionKey, compactionReset).conversationId
    expect(afterCompaction).not.toBe(beforeCompaction)
    expect(compactionReset).toEqual({ reset: true, reason: "compaction" })
    expect(compacted).toEqual({ advertisedTools: tools, allowTools: false })

    const resumedReset = resolveTurnConversationReset({ sessionKey, isCompaction: false })
    const resumed = resolveTurnToolState({
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
