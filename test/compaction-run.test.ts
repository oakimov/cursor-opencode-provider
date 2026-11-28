import { afterEach, describe, expect, it } from "bun:test"
import protobuf from "protobufjs"
import { checkpointSummaryText, CursorSummarizeError, pumpSummarizeRun } from "../src/compaction-run.js"
import { CursorLocalCancellationError, CursorProviderError } from "../src/errors.js"
import { buildRunRequest, MAX_PREPENDED_HISTORY_PARTS, seedHistoryParts } from "../src/protocol/request.js"
import { getConversationBlob, resetConversationBlobsForTests, setConversationBlob } from "../src/protocol/blob-store.js"
import type { BidiStream } from "../src/transport/connect.js"

// Wire bytes are written by hand from Cursor CLI's agent.proto field numbers,
// not with the provider's encoder: AgentServerMessage{interaction_update=1,
// exec_server_message=2, conversation_checkpoint_update=3, kv_server_message=4};
// InteractionUpdate{summary=9{summary=1}, summary_started=10,
// summary_completed=11{hook_message=1}, turn_ended=14}; KvServerMessage{id=1,
// get_blob_args=2{blob_id=1}, set_blob_args=3{blob_id=1, blob_data=2}};
// ExecServerMessage{id=1, request_context_args=10};
// ConversationStateStructure{summary=6 (blob id)}; ConversationSummary{summary=1}.

type Field = { no: number; value: Uint8Array | string | number }
function message(fields: Field[]): Uint8Array {
  const writer = protobuf.Writer.create()
  for (const field of fields) {
    if (typeof field.value === "number") writer.uint32((field.no << 3) | 0).uint32(field.value)
    else if (typeof field.value === "string") writer.uint32((field.no << 3) | 2).string(field.value)
    else writer.uint32((field.no << 3) | 2).bytes(field.value)
  }
  return writer.finish()
}
const empty = new Uint8Array(0)
const update = (no: number, value: Uint8Array = empty) => message([{ no: 1, value: message([{ no, value }]) }])
const frame = (payload: Uint8Array) => ({ flags: 0, payload })

/** Reads top-level fields of a protobuf message: field number → list of raw values. */
function read(bytes: Uint8Array): Map<number, Array<Uint8Array | number>> {
  const reader = protobuf.Reader.create(bytes)
  const out = new Map<number, Array<Uint8Array | number>>()
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const no = tag >>> 3
    const value = (tag & 7) === 2 ? reader.bytes() : reader.uint32()
    out.set(no, [...(out.get(no) ?? []), value])
  }
  return out
}
const sub = (bytes: Uint8Array, ...path: number[]) =>
  path.reduce<Uint8Array | undefined>((at, no) => at && (read(at).get(no)?.[0] as Uint8Array | undefined), bytes)

function fakeStream(frames: Array<{ flags: number; payload: Uint8Array }>) {
  const writes: Uint8Array[] = []
  let destroyed = false
  const stream = {
    write(message: Uint8Array) { writes.push(message); return true },
    end() {},
    destroy() { destroyed = true },
    isClosed: () => destroyed,
    onTerminal: () => () => {},
    frames: () => ({ async *[Symbol.asyncIterator]() { for (const f of frames) yield f } }),
  } as unknown as BidiStream
  return { stream, writes, destroyed: () => destroyed }
}

const deps = {
  endStreamError: (payload: string) => new CursorProviderError(`end-stream ${payload}`, {
    origin: "server", transient: false, replaySafe: false,
  }),
}

afterEach(() => resetConversationBlobsForTests())

describe("summarize_action Run", () => {
  it("returns the SummaryUpdate text, stores the checkpoint and answers request_context_args", async () => {
    const blobId = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    const checkpoint = message([{ no: 6, value: blobId }])
    const { stream, writes, destroyed } = fakeStream([
      frame(message([{ no: 2, value: message([{ no: 1, value: 7 }, { no: 10, value: empty }]) }])),
      frame(update(10)),
      frame(message([{ no: 4, value: message([{ no: 1, value: 3 }, { no: 3, value: message([
        { no: 1, value: blobId }, { no: 2, value: message([{ no: 1, value: "Summary:\n1. Primary Request" }]) },
      ]) }]) }])),
      frame(update(11)),
      frame(update(9, message([{ no: 1, value: "Summary:\n1. Primary Request" }]))),
      frame(message([{ no: 3, value: checkpoint }])),
      frame(update(14)),
    ])
    const seen: Uint8Array[] = []
    const result = await pumpSummarizeRun(stream, {
      conversationId: "conv-live",
      blobs: { conversationId: "conv-live" },
      requestContext: { rules: [] },
      onCheckpoint: (bytes) => seen.push(bytes),
      heartbeatMs: 60_000,
    }, deps)

    expect(result.summary).toBe("Summary:\n1. Primary Request")
    expect(result.source).toBe("update")
    expect(seen).toEqual([checkpoint])
    expect(getConversationBlob("conv-live", blobId)).toBeDefined()
    // exec_client_message(2){id=1: 7, request_context_result=10{success=1}}
    const execReply = writes.map((w) => read(w).get(2)?.[0] as Uint8Array | undefined).find(Boolean)!
    expect(read(execReply).get(1)?.[0]).toBe(7)
    expect(sub(execReply, 10, 1)).toBeDefined()
    // kv_client_message(3){id=1: 3, set_blob_result=3}
    const kvReply = writes.map((w) => read(w).get(3)?.[0] as Uint8Array | undefined).find(Boolean)!
    expect(read(kvReply).get(1)?.[0]).toBe(3)
    expect(read(kvReply).has(3)).toBe(true)
    expect(destroyed()).toBe(true)
  })

  it("reads the summary from the checkpoint's summary blob when no SummaryUpdate arrives", async () => {
    const blobId = Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
    setConversationBlob("conv-live", blobId, message([{ no: 1, value: "From the checkpoint" }]))
    const checkpoint = message([{ no: 6, value: blobId }])
    const { stream } = fakeStream([frame(message([{ no: 3, value: checkpoint }])), frame(update(14))])
    const result = await pumpSummarizeRun(stream, {
      conversationId: "conv-live", blobs: { conversationId: "conv-live" }, requestContext: {}, heartbeatMs: 60_000,
    }, deps)
    expect(result).toMatchObject({ summary: "From the checkpoint", source: "checkpoint" })
    expect(checkpointSummaryText(checkpoint, (id) => getConversationBlob("conv-live", id))).toBe("From the checkpoint")
  })

  it("fails without a summary, before turn_ended, and on a Connect end-stream", async () => {
    const run = (frames: Array<{ flags: number; payload: Uint8Array }>) => pumpSummarizeRun(fakeStream(frames).stream, {
      conversationId: "c", blobs: { conversationId: "c" }, requestContext: {}, heartbeatMs: 60_000,
    }, deps)
    await expect(run([frame(update(14))])).rejects.toBeInstanceOf(CursorSummarizeError)
    await expect(run([frame(update(9, message([{ no: 1, value: "partial" }])))])).rejects.toBeInstanceOf(CursorSummarizeError)
    const endStream = { flags: 0x02, payload: new TextEncoder().encode(JSON.stringify({ error: { code: "resource_exhausted" } })) }
    await expect(run([endStream])).rejects.toThrow("end-stream")
  })

  it("cancels the Run instead of answering a tool exec", async () => {
    // exec_server_message{id=1: 4, read_args=7{path=1}}
    const { stream, writes } = fakeStream([
      frame(message([{ no: 2, value: message([{ no: 1, value: 4 }, { no: 7, value: message([{ no: 1, value: "a.txt" }]) }]) }])),
    ])
    await expect(pumpSummarizeRun(stream, {
      conversationId: "c", blobs: { conversationId: "c" }, requestContext: {}, heartbeatMs: 60_000,
    }, deps)).rejects.toThrow("read_args")
    // conversation_action(4){cancel_action=3}
    expect(writes.some((w) => sub(w, 4, 3) !== undefined)).toBe(true)
    expect(writes.some((w) => read(w).has(2))).toBe(false)
  })

  it("serves a fork's blobs from the preloaded copy and keeps new ones under the fork id", async () => {
    const liveBlob = Uint8Array.from({ length: 32 }, () => 9)
    const preload = new Map([[Buffer.from(liveBlob).toString("hex"), Uint8Array.of(1, 2, 3)]])
    const { stream, writes } = fakeStream([
      frame(message([{ no: 4, value: message([{ no: 1, value: 5 }, { no: 2, value: message([{ no: 1, value: liveBlob }]) }]) }])),
      frame(update(9, message([{ no: 1, value: "fork summary" }]))),
      frame(update(14)),
    ])
    const result = await pumpSummarizeRun(stream, {
      conversationId: "conv-fork", blobs: { conversationId: "conv-fork", preload }, requestContext: {}, heartbeatMs: 60_000,
    }, deps)
    expect(result.summary).toBe("fork summary")
    // kv_client_message(3){get_blob_result=2{blob_data=1}}
    const kvReply = writes.map((w) => read(w).get(3)?.[0] as Uint8Array | undefined).find(Boolean)!
    expect(sub(kvReply, 2, 1)).toEqual(Uint8Array.of(1, 2, 3))
    expect(getConversationBlob("conv-live", liveBlob)).toBeUndefined()
  })

  it("a host stop sends cancel_action and ends as a local cancellation", async () => {
    const abort = new AbortController()
    abort.abort()
    const { stream, writes } = fakeStream([frame(update(10))])
    await expect(pumpSummarizeRun(stream, {
      conversationId: "c", blobs: { conversationId: "c" }, requestContext: {}, heartbeatMs: 60_000, signal: abort.signal,
    }, deps)).rejects.toBeInstanceOf(CursorLocalCancellationError)
    await Bun.sleep(0)
    expect(writes.some((w) => sub(w, 4, 3) !== undefined)).toBe(true)
  })
})

describe("summarize and history placement on the wire", () => {
  it("summarize Runs carry an empty summarize_action, the checkpoint and no request context", () => {
    const state = message([{ no: 5, value: message([{ no: 1, value: 10 }]) }])
    const bytes = buildRunRequest({
      text: ".", modelId: "default", conversationId: "conv-1", conversationState: state, action: "summarize",
      requestContext: { rules: [] },
    })
    const runRequest = sub(bytes, 1)!
    const action = sub(runRequest, 2)!
    expect([...read(action).keys()]).toEqual([4])
    expect(sub(action, 4)).toEqual(empty)
    expect(sub(runRequest, 1)).toEqual(state)
    expect(new TextDecoder().decode(sub(runRequest, 5))).toBe("conv-1")
  })

  it("a seed goes in at most 5 prepended user turns, split at message boundaries; the live text is only the request", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `message ${i} ${"x".repeat(100 * (i + 1))}`,
    }))
    const bytes = buildRunRequest({ text: "the request", modelId: "default", conversationId: "c", history })
    const userMessageAction = sub(bytes, 1, 2, 1)!
    const live = sub(userMessageAction, 1)!
    expect(new TextDecoder().decode(sub(live, 1))).toBe("the request")
    const prepended = (read(userMessageAction).get(4) ?? []) as Uint8Array[]
    expect(prepended).toHaveLength(MAX_PREPENDED_HISTORY_PARTS)
    const texts = prepended.map((part) => new TextDecoder().decode(sub(part, 1)))
    const ids = prepended.map((part) => new TextDecoder().decode(sub(part, 2)))
    expect(new Set(ids).size).toBe(ids.length)
    texts.forEach((text, i) => expect(text.startsWith(`[Earlier conversation, part ${i + 1} of 5]\n<conversation_history>\n`)).toBe(true))
    const all = texts.join("\n")
    history.forEach((entry) => expect(all.split(entry.content).length - 1).toBe(1))
  })

  it("fewer messages than parts give one part per message, and system entries are dropped", () => {
    expect(seedHistoryParts([{ role: "system", content: "sys" }])).toEqual([])
    const parts = seedHistoryParts([{ role: "user", content: "a" }, { role: "assistant", content: "b </assistant> c" }])
    expect(parts).toEqual([
      "[Earlier conversation, part 1 of 2]\n<conversation_history>\n<user>\na\n</user>\n</conversation_history>",
      "[Earlier conversation, part 2 of 2]\n<conversation_history>\n<assistant>\nb <\\/assistant> c\n</assistant>\n</conversation_history>",
    ])
  })

  it("a checkpointed Run prepends nothing", () => {
    const bytes = buildRunRequest({
      text: "next", modelId: "default", conversationId: "c", conversationState: Uint8Array.of(0x2a, 0),
      history: [{ role: "user", content: "old" }],
    })
    expect(read(sub(bytes, 1, 2, 1)!).has(4)).toBe(false)
  })
})
