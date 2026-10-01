import { describe, expect, it } from "bun:test"
import { pump, pumpWithRecovery, type CursorRunRecovery } from "../src/language-model.js"
import { encodeMessage } from "../src/protocol/messages.js"
import type { CursorSession, Frame } from "../src/session.js"
import { CursorProviderError } from "../src/errors.js"

function fakeSession(id: string, frames: Frame[], eligible = true): CursorSession {
  let index = 0
  return {
    sessionId: id,
    conversationId: `conv-${id}`,
    checkpointRebaseEligible: eligible,
    stream: {
      write() {},
      end() {},
      frames: () => ({ async *[Symbol.asyncIterator]() { yield* frames } }),
      destroy() {},
      isClosed: () => false,
    },
    frames: {
      next: async () => index < frames.length
        ? { done: false, value: frames[index++]! }
        : { done: true, value: undefined },
    },
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    allowTools: true,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

function controller(parts: unknown[]) {
  return {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
}

function serverFrame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

/** A get_blob for a hash this client never stored. */
function missingBlobRequest(id: number): Frame {
  return serverFrame({
    kv_server_message: { id, get_blob_args: { blob_id: Uint8Array.from({ length: 32 }, (_, i) => 200 + (i % 50)) } },
  })
}

function internalEndStream(): Frame {
  return {
    flags: 0x2,
    payload: new TextEncoder().encode(JSON.stringify({ error: { code: "internal" } })),
  }
}

async function pumpError(session: CursorSession, parts: unknown[] = []): Promise<CursorProviderError> {
  try {
    await pump(session, controller(parts), { textId: "t", reasoningId: "r" })
  } catch (error) {
    return error as CursorProviderError
  }
  throw new Error("pump did not fail")
}

describe("checkpoint-unusable recovery", () => {
  it("marks a resumed Run that fails after a blob miss with no output as reseedable", async () => {
    const error = await pumpError(fakeSession("miss", [
      serverFrame({ interaction_update: { heartbeat: {} } }),
      missingBlobRequest(0),
      internalEndStream(),
    ]))
    expect(error.message).toContain("code=internal")
    expect(error.checkpointUnusable).toBe(true)
    expect(error.replaySafe).toBe(true)
  })

  it("does not reseed once visible output was produced", async () => {
    const error = await pumpError(fakeSession("visible", [
      missingBlobRequest(0),
      serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
      internalEndStream(),
    ]))
    expect(error.checkpointUnusable).toBeUndefined()
    expect(error.replaySafe).toBe(false)
  })

  it("does not reseed without a blob miss or outside a resumed fresh turn", async () => {
    const noMiss = await pumpError(fakeSession("no-miss", [internalEndStream()]))
    expect(noMiss.checkpointUnusable).toBeUndefined()
    const notEligible = await pumpError(fakeSession("not-eligible", [missingBlobRequest(0), internalEndStream()], false))
    expect(notEligible.checkpointUnusable).toBeUndefined()
  })

  it("recovers by reseeding instead of surfacing retry-unsafe", async () => {
    const recoveries: CursorRunRecovery[] = []
    const parts: any[] = []
    const reseeded = fakeSession("reseeded", [
      serverFrame({ interaction_update: { text_delta: { text: "fresh answer" } } }),
      serverFrame({ interaction_update: { turn_ended: { input_tokens: 4, output_tokens: 2 } } }),
    ], false)
    const finalSession = await pumpWithRecovery({
      initialSession: fakeSession("broken", [missingBlobRequest(0), missingBlobRequest(1), internalEndStream()]),
      controller: controller(parts),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } as any,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return reseeded
      },
    })
    expect(finalSession).toBe(reseeded)
    expect(recoveries).toEqual([{ kind: "rebase", reason: "checkpoint-unusable" }])
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "fresh answer")).toBe(true)
  })
})
