import { describe, it, expect, beforeEach } from "bun:test"
import {
  bindConversationId,
  peekConversationId,
  resetConversationBindingsForTests,
  sessionIdToUuid,
} from "../src/protocol/conversation-bind.js"
import { setCheckpoint, getCheckpoint, resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import {
  setConversationBlob,
  getConversationBlob,
  clearConversationBlobs,
  resetConversationBlobsForTests,
} from "../src/protocol/blob-store.js"

describe("conversation bind / compaction reset", () => {
  beforeEach(() => {
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
  })

  it("defaults to the deterministic session UUID", () => {
    expect(peekConversationId("ses_abc")).toBe(sessionIdToUuid("ses_abc"))
    expect(bindConversationId("ses_abc").conversationId).toBe(sessionIdToUuid("ses_abc"))
  })

  it("reset mints a new id and clears prior checkpoint + blobs", () => {
    const first = bindConversationId("ses_abc").conversationId
    setCheckpoint(first, Uint8Array.from([1, 2, 3]))
    setConversationBlob(first, Uint8Array.from([9, 9, 9]), Uint8Array.from([7]))
    expect(getCheckpoint(first)).toBeDefined()
    expect(getConversationBlob(first, Uint8Array.from([9, 9, 9]))).toBeDefined()

    const reset = bindConversationId("ses_abc", { reset: true })
    expect(reset.reset).toBe(true)
    expect(reset.previousId).toBe(first)
    expect(reset.conversationId).not.toBe(first)
    expect(getCheckpoint(first)).toBeUndefined()
    expect(getConversationBlob(first, Uint8Array.from([9, 9, 9]))).toBeUndefined()
    expect(peekConversationId("ses_abc")).toBe(reset.conversationId)
  })

  it("clearConversationBlobs is a no-op for unknown ids", () => {
    clearConversationBlobs("missing")
  })
})
