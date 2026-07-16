import { describe, it, expect, beforeEach } from "bun:test"
import { handleKvServerMessage } from "../src/protocol/kv.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  getConversationBlob,
  resetConversationBlobsForTests,
} from "../src/protocol/blob-store.js"
import type { CursorSession } from "../src/session.js"

function fakeSession(conversationId = "conv-kv-test"): CursorSession {
  return {
    sessionId: "sess-kv",
    conversationId,
    stream: { write() {} } as any,
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    allowTools: false,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

describe("handleKvServerMessage", () => {
  beforeEach(() => resetConversationBlobsForTests())

  it("stores a set_blob_args blob and replies with set_blob_result echoing id", () => {
    const s = fakeSession()
    const blobId = new Uint8Array([1, 2, 3, 4])
    const blobData = new TextEncoder().encode("hello blob")
    const res = handleKvServerMessage(
      { id: 42, set_blob_args: { blob_id: blobId, blob_data: blobData } },
      s,
    )
    expect(res).not.toBeNull()
    expect(res!.kind).toBe("set")
    expect(res!.id).toBe(42)
    // Blob persisted under hex key.
    expect(s.blobs.get("01020304")).toEqual(blobData)
    // Reply is an AgentClientMessage.kv_client_message with matching id.
    const dec = decodeMessage<any>("AgentClientMessage", res!.reply).kv_client_message
    expect(dec.id).toBe(42)
    expect(dec.set_blob_result).toBeDefined()
  })

  it("persists blobs by conversation_id so a later Run can serve get_blob", () => {
    const turn1 = fakeSession("conv-durable")
    const blobId = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i))
    const blobData = new TextEncoder().encode('{"role":"assistant","content":"hi"}')
    handleKvServerMessage(
      { id: 1, set_blob_args: { blob_id: blobId, blob_data: blobData } },
      turn1,
    )
    expect(getConversationBlob("conv-durable", blobId)).toEqual(blobData)

    // New Run stream — empty session.blobs, same conversation_id.
    const turn2 = fakeSession("conv-durable")
    expect(turn2.blobs.size).toBe(0)
    const res = handleKvServerMessage({ id: 2, get_blob_args: { blob_id: blobId } }, turn2)
    expect(res!.found).toBe(true)
    expect(res!.echoed).toBeFalsy()
    const dec = decodeMessage<any>("AgentClientMessage", res!.reply).kv_client_message
    expect(dec.get_blob_result?.blob_data).toEqual(blobData)
  })

  it("answers get_blob_args with the previously stored blob", () => {
    const s = fakeSession()
    const blobId = new Uint8Array([9, 9])
    const blobData = new TextEncoder().encode("payload")
    s.blobs.set("0909", blobData)
    const res = handleKvServerMessage({ id: 7, get_blob_args: { blob_id: blobId } }, s)
    expect(res!.kind).toBe("get")
    const dec = decodeMessage<any>("AgentClientMessage", res!.reply).kv_client_message
    expect(dec.id).toBe(7)
    expect(dec.get_blob_result?.blob_data).toEqual(blobData)
  })

  it("echoes the blob_id back as blob_data for an unknown (content-as-id) get", () => {
    // Cursor sends get_blob_args{ blob_id: <literal content> }; for content we
    // haven't stored we must return that content, not empty (empty → "Blob not found").
    const s = fakeSession()
    const blobId = new TextEncoder().encode('{"role":"system","content":"hi"}')
    const res = handleKvServerMessage({ id: 1, get_blob_args: { blob_id: blobId } }, s)
    expect(res!.echoed).toBe(true)
    const dec = decodeMessage<any>("AgentClientMessage", res!.reply).kv_client_message
    expect(dec.get_blob_result?.blob_data).toEqual(blobId)
  })

  it("does NOT echo unknown 32-byte hashes (avoids JSON.parse of binary)", () => {
    const s = fakeSession()
    const hash = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 0xaa + (i % 16)))
    const res = handleKvServerMessage({ id: 3, get_blob_args: { blob_id: hash } }, s)
    expect(res!.found).toBe(false)
    expect(res!.echoed).toBeFalsy()
    const dec = decodeMessage<any>("AgentClientMessage", res!.reply).kv_client_message
    expect(dec.get_blob_result?.blob_data?.length ?? 0).toBe(0)
  })

  it("round-trips a set→get through real encode/decode of KvServerMessage", () => {
    const s = fakeSession()
    const blobId = new Uint8Array([10, 20, 30])
    const blobData = new TextEncoder().encode("round trip")
    const ksmBytes = encodeMessage("AgentServerMessage", {
      kv_server_message: { id: 99, set_blob_args: { blob_id: blobId, blob_data: blobData } },
    })
    const ksm = decodeMessage<any>("AgentServerMessage", ksmBytes).kv_server_message
    const setRes = handleKvServerMessage(ksm, s)
    expect(setRes!.kind).toBe("set")
    expect(s.blobs.size).toBe(1)

    const getKsm = decodeMessage<any>(
      "AgentServerMessage",
      encodeMessage("AgentServerMessage", {
        kv_server_message: { id: 100, get_blob_args: { blob_id: blobId } },
      }),
    ).kv_server_message
    const getRes = handleKvServerMessage(getKsm, s)
    expect(getRes!.kind).toBe("get")
    expect(getRes!.found).toBe(true)
    const dec = decodeMessage<any>("AgentClientMessage", getRes!.reply).kv_client_message
    expect(dec.get_blob_result?.blob_data).toEqual(blobData)
  })

  it("returns null for a kv message with neither get nor set", () => {
    expect(handleKvServerMessage({ id: 1 }, fakeSession())).toBeNull()
  })
})
