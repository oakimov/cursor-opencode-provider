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
import { CursorRetryExhaustedError } from "../src/errors.js"

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
    ).rejects.toBeInstanceOf(CursorRetryExhaustedError)
    expect(recoveries).toBe(1)
  })

  it("uses retry.maxAttempts as the total Run attempt budget", async () => {
    let recoveries = 0
    await expect(
      pumpWithRecovery({
        initialSession: fakeSession("first-eof", []),
        controller: controller([]),
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        recover: async () => {
          recoveries++
          return fakeSession(`recovery-${recoveries}`, [])
        },
      }),
    ).rejects.toBeInstanceOf(CursorRetryExhaustedError)
    // One initial Run plus two replacements, never three replacements.
    expect(recoveries).toBe(2)
  })

  it("does not recover after visible output because replay could duplicate text", async () => {
    let recoveries = 0
    const parts: any[] = []
    await expect(
      pumpWithRecovery({
        initialSession: fakeSession("partial", [
          serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
        ]),
        controller: controller(parts),
        recover: async () => {
          recoveries++
          return fakeSession("unused", [])
        },
      }),
    ).rejects.toThrow("automatic retry unsafe")
    expect(recoveries).toBe(0)
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "partial")).toBe(true)
  })

  it("reports per-request usage while preserving cumulative Cursor counters as metadata", async () => {
    const parts: any[] = []
    await pump(
      fakeSession("usage", [
        serverFrame({ interaction_update: { thinking_delta: { text: "think" } } }),
        serverFrame({ interaction_update: { text_delta: { text: "answer" } } }),
        serverFrame({
          interaction_update: {
            turn_ended: {
              input_tokens: 120_000,
              output_tokens: 73_483,
              cache_read: 5_810_572,
              cache_write: 24_000,
            },
          },
        }),
      ]),
      controller(parts),
      { textId: "t", reasoningId: "r", promptTokens: 25 },
    )
    const finish = parts.find((part) => part.type === "finish")
    expect(finish.usage.inputTokens).toMatchObject({ total: 25, cacheRead: 0, cacheWrite: 0 })
    expect(finish.usage.outputTokens.total).toBe(3)
    expect(finish.providerMetadata.cursor).toMatchObject({
      usageVersion: 2,
      inputTokensRaw: 120_000,
      outputTokensRaw: 73_483,
      cacheReadRaw: 5_810_572,
    })
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
