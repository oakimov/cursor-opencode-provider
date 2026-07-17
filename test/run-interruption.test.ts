import { describe, expect, it } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  extractPromptHistory,
  pump,
  pumpWithRecovery,
} from "../src/language-model.js"
import { encodeMessage } from "../src/protocol/messages.js"
import type { CursorSession, Frame } from "../src/session.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"

function fakeSession(id: string, frames: Frame[]): CursorSession {
  let index = 0
  return {
    sessionId: id,
    conversationId: `conv-${id}`,
    stream: {
      write() {},
      end() {},
      frames: () => ({
        async *[Symbol.asyncIterator]() {
          yield* frames
        },
      }),
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
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

function controller(parts: unknown[]) {
  return {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as ReadableStreamDefaultController<any>
}

function serverFrame(message: Record<string, unknown>, flags = 0): Frame {
  return {
    flags,
    payload: encodeMessage("AgentServerMessage", message),
  }
}

describe("interrupted Cursor Run handling", () => {
  it("rejects iterator EOF without turn_ended instead of emitting a normal stop", async () => {
    const parts: unknown[] = []
    await expect(
      pump(fakeSession("eof", []), controller(parts), { textId: "t", reasoningId: "r" }),
    ).rejects.toBeInstanceOf(CursorRunInterruptedError)
    expect(parts.some((part: any) => part.type === "finish")).toBe(false)
  })

  it("rejects a clean Connect end-stream envelope without turn_ended", async () => {
    const parts: unknown[] = []
    await expect(
      pump(
        fakeSession("end", [{ flags: 0x02, payload: new Uint8Array() }]),
        controller(parts),
        { textId: "t", reasoningId: "r" },
      ),
    ).rejects.toBeInstanceOf(CursorRunInterruptedError)
    expect(parts.some((part: any) => part.type === "finish")).toBe(false)
  })

  it("recovers once on a fresh session and completes only after turn_ended", async () => {
    const interrupted = fakeSession("first", [])
    const recovered = fakeSession("second", [
      serverFrame({ interaction_update: { text_delta: { text: "continued" } } }),
      serverFrame({ interaction_update: { turn_ended: { input_tokens: 4, output_tokens: 2 } } }),
    ])
    const parts: any[] = []
    const seen: string[] = []

    const finalSession = await pumpWithRecovery({
      initialSession: interrupted,
      controller: controller(parts),
      abortSignal: undefined,
      recover: async () => recovered,
      onSession: (session) => seen.push(session.sessionId),
    })

    expect(finalSession).toBe(recovered)
    expect(seen).toEqual(["first", "second"])
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "continued")).toBe(true)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("surfaces a second interruption instead of retrying forever", async () => {
    let recoveries = 0
    await expect(
      pumpWithRecovery({
        initialSession: fakeSession("first-eof", []),
        controller: controller([]),
        recover: async () => {
          recoveries++
          return fakeSession("second-eof", [])
        },
      }),
    ).rejects.toBeInstanceOf(CursorRunInterruptedError)
    expect(recoveries).toBe(1)
  })

  it("preserves the live user request when rebasing recovery history", () => {
    const prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "finish the migration" }] },
    ] as LanguageModelV3CallOptions["prompt"]

    expect(extractPromptHistory(prompt)).toEqual([{ role: "system", content: "system" }])
    expect(extractPromptHistory(prompt, { preserveTrailingUser: true })).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "finish the migration" },
    ])
  })
})
