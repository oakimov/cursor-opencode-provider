import { describe, it, expect, beforeEach } from "bun:test"
import {
  bindConversationId,
  MAX_ACTIVE_CONVERSATION_BINDINGS,
  peekConversationId,
  resetConversationBindingsForTests,
  restoreConversationBinding,
  resolveConversationGroupId,
  sessionIdToUuid,
} from "../src/protocol/conversation-bind.js"
import { setCheckpoint, getCheckpoint, resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import {
  setConversationBlob,
  getConversationBlob,
  clearConversationBlobs,
  resetConversationBlobsForTests,
} from "../src/protocol/blob-store.js"
import {
  getFrozenRequestContext,
  resetFrozenRequestContextsForTests,
  setFrozenRequestContext,
} from "../src/context/frozen.js"

describe("conversation bind / compaction reset", () => {
  beforeEach(() => {
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetFrozenRequestContextsForTests()
  })

  it("defaults to the deterministic session UUID", () => {
    expect(peekConversationId("ses_abc")).toBe(sessionIdToUuid("ses_abc"))
    expect(bindConversationId("ses_abc").conversationId).toBe(sessionIdToUuid("ses_abc"))
  })

  it("ephemeral binds do not replace the sticky conversation", () => {
    const sticky = bindConversationId("ses_live").conversationId
    const ephemeral = bindConversationId("ses_live", { ephemeral: true })
    expect(ephemeral.reset).toBe(false)
    expect(ephemeral.conversationId).not.toBe(sticky)
    expect(bindConversationId("ses_live").conversationId).toBe(sticky)
  })

  it("restores a reminted durable binding", () => {
    restoreConversationBinding("ses_restored", "persisted-conversation")
    expect(bindConversationId("ses_restored").conversationId).toBe("persisted-conversation")
  })

  it("keeps the session group stable across reminted conversations", () => {
    const sessionKey = "ses_group"
    const first = bindConversationId(sessionKey).conversationId
    const group = resolveConversationGroupId(sessionKey, first)
    const compaction = bindConversationId(sessionKey, { reset: true }).conversationId
    const postCompaction = bindConversationId(sessionKey, { reset: true }).conversationId

    expect(compaction).not.toBe(first)
    expect(postCompaction).not.toBe(compaction)
    expect(group).toBe(sessionIdToUuid(sessionKey))
    expect(resolveConversationGroupId(sessionKey, compaction)).toBe(group)
    expect(resolveConversationGroupId(sessionKey, postCompaction)).toBe(group)
  })

  it("uses the conversation as the group without a host session key", () => {
    expect(resolveConversationGroupId(undefined, "standalone-conversation"))
      .toBe("standalone-conversation")
  })

  it("reset mints a new id, clears opaque state, and transfers context", () => {
    const first = bindConversationId("ses_abc").conversationId
    setCheckpoint(first, Uint8Array.from([1, 2, 3]))
    setConversationBlob(first, Uint8Array.from([9, 9, 9]), Uint8Array.from([7]))
    setFrozenRequestContext(first, { tools: [{ name: "read" }] })
    expect(getCheckpoint(first)).toBeDefined()
    expect(getConversationBlob(first, Uint8Array.from([9, 9, 9]))).toBeDefined()
    expect(getFrozenRequestContext(first)).toBeDefined()

    const reset = bindConversationId("ses_abc", { reset: true })
    expect(reset.reset).toBe(true)
    expect(reset.previousId).toBe(first)
    expect(reset.conversationId).not.toBe(first)
    expect(getCheckpoint(first)).toBeUndefined()
    expect(getConversationBlob(first, Uint8Array.from([9, 9, 9]))).toBeUndefined()
    expect(getFrozenRequestContext(first)).toBeUndefined()
    expect(getFrozenRequestContext(reset.conversationId)).toBeDefined()
    expect(peekConversationId("ses_abc")).toBe(reset.conversationId)
  })

  it("clearConversationBlobs is a no-op for unknown ids", () => {
    clearConversationBlobs("missing")
  })

  it("evicts the least-recently-used binding and its opaque state", () => {
    const first = bindConversationId("oldest").conversationId
    setCheckpoint(first, Uint8Array.from([1]))
    setConversationBlob(first, Uint8Array.from([2]), Uint8Array.from([3]))
    setFrozenRequestContext(first, { tools: [] })

    for (let i = 0; i < MAX_ACTIVE_CONVERSATION_BINDINGS; i++) {
      bindConversationId(`new-${i}`)
    }

    expect(getCheckpoint(first)).toBeUndefined()
    expect(getConversationBlob(first, Uint8Array.from([2]))).toBeUndefined()
    expect(getFrozenRequestContext(first)).toBeUndefined()
  })
})
