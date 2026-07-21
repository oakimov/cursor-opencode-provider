import { describe, expect, it } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  extractPromptHistory,
  pump,
  pumpWithRecovery,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import type { CursorSession, Frame } from "../src/session.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { CursorRetryExhaustedError } from "../src/errors.js"

function fakeSession(id: string, frames: Frame[], writes: Uint8Array[] = []): CursorSession {
  let index = 0
  return {
    sessionId: id,
    conversationId: `conv-${id}`,
    stream: {
      write(data: Uint8Array) { writes.push(data) },
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

function writeVarint(out: number[], value: number): void {
  let remaining = value >>> 0
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  out.push(remaining)
}

function lengthDelimitedField(field: number, bytes = new Uint8Array()): Uint8Array {
  const out: number[] = []
  writeVarint(out, (field << 3) | 2)
  writeVarint(out, bytes.length)
  out.push(...bytes)
  return Uint8Array.from(out)
}

function varintField(field: number, value: number): Uint8Array {
  const out: number[] = []
  writeVarint(out, (field << 3) | 0)
  writeVarint(out, value)
  return Uint8Array.from(out)
}

function fixed32Field(field: number, value = 0): Uint8Array {
  const out: number[] = []
  writeVarint(out, (field << 3) | 5)
  out.push(value & 0xff, 0, 0, 0)
  return Uint8Array.from(out)
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

  it("recovers after idempotent checkpoint and control-plane activity", async () => {
    const writes: Uint8Array[] = []
    const interrupted = fakeSession("control-frames", [
      serverFrame({ conversation_checkpoint_update: Uint8Array.from([1, 2, 3]) }),
      serverFrame({ exec_server_message: { id: 1, request_context_args: {} } }),
      serverFrame({
        exec_server_message: {
          id: 2,
          mcp_state_exec_args: { server_identifiers: ["opencode"] },
        },
      }),
      serverFrame({
        kv_server_message: {
          id: 3,
          set_blob_args: {
            blob_id: Uint8Array.from([4, 5, 6]),
            blob_data: Uint8Array.from([7, 8, 9]),
          },
        },
      }),
      serverFrame({
        interaction_query: {
          id: 4,
          web_search_request_query: new Uint8Array(),
        },
      }),
    ], writes)
    const recovered = fakeSession("control-recovery", [
      serverFrame({ interaction_update: { turn_ended: { input_tokens: 2, output_tokens: 1 } } }),
    ])
    let recoveries = 0

    const finalSession = await pumpWithRecovery({
      initialSession: interrupted,
      controller: controller([]),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        recoveries++
        return recovered
      },
    })

    expect(finalSession).toBe(recovered)
    expect(recoveries).toBe(1)
    expect(writes).toHaveLength(4)
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

  it("replies to decoded KV requests with unknown fields, then suppresses replay", async () => {
    const writes: Uint8Array[] = []
    const getBlob = lengthDelimitedField(1, new TextEncoder().encode("inline blob"))
    const getWithUnknownField = Uint8Array.from([
      ...varintField(1, 15),
      ...lengthDelimitedField(2, getBlob),
      ...fixed32Field(20),
    ])
    const setBlob = Uint8Array.from([
      ...lengthDelimitedField(1, new TextEncoder().encode("stored blob")),
      ...lengthDelimitedField(2, new TextEncoder().encode("stored data")),
    ])
    const setWithUnknownField = Uint8Array.from([
      ...varintField(1, 16),
      ...lengthDelimitedField(3, setBlob),
      ...fixed32Field(20),
    ])
    let recoveries = 0

    await expect(
      pumpWithRecovery({
        initialSession: fakeSession("kv-unknown-field", [
          { flags: 0, payload: lengthDelimitedField(4, getWithUnknownField) },
          { flags: 0, payload: lengthDelimitedField(4, setWithUnknownField) },
        ], writes),
        controller: controller([]),
        retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        recover: async () => {
          recoveries++
          return fakeSession("unused", [])
        },
      }),
    ).rejects.toThrow("automatic retry unsafe")

    expect(recoveries).toBe(0)
    expect(writes).toHaveLength(2)
    const getReply = decodeMessage<any>("AgentClientMessage", writes[0]!).kv_client_message
    expect(getReply.id).toBe(15)
    expect(getReply.get_blob_result.blob_data).toEqual(new TextEncoder().encode("inline blob"))
    const setReply = decodeMessage<any>("AgentClientMessage", writes[1]!).kv_client_message
    expect(setReply.id).toBe(16)
    expect(setReply.set_blob_result).toBeDefined()
  })

  it("answers decoded request-context and MCP probes despite unknown fields", async () => {
    for (const [name, variantField, resultField] of [
      ["request-context", 10, "request_context_result"],
      ["mcp-state", 36, "mcp_state_exec_result"],
    ] as const) {
      const writes: Uint8Array[] = []
      const execWithUnknownField = Uint8Array.from([
        ...varintField(1, 16),
        ...lengthDelimitedField(variantField),
        ...fixed32Field(60),
      ])
      let recoveries = 0
      await expect(
        pumpWithRecovery({
          initialSession: fakeSession(name, [
            { flags: 0, payload: lengthDelimitedField(2, execWithUnknownField) },
          ], writes),
          controller: controller([]),
          retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
          recover: async () => {
            recoveries++
            return fakeSession("unused", [])
          },
        }),
      ).rejects.toThrow("automatic retry unsafe")

      expect(writes).toHaveLength(1)
      expect(recoveries).toBe(0)
      const reply = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
      expect(reply.id).toBe(16)
      expect(reply[resultField].success).toBeDefined()
    }
  })

  it("fails immediately for undecodable or unhandled must-reply frames", async () => {
    const cases: Array<[string, Frame, string]> = [
      [
        "undecodable-kv",
        { flags: 0, payload: Uint8Array.from([0x22, 0x05, 0x08]) },
        "CURSOR_RUN_REQUEST_DECODE_FAILED",
      ],
      [
        "unhandled-kv",
        { flags: 0, payload: lengthDelimitedField(4, varintField(1, 17)) },
        "CURSOR_RUN_REQUEST_UNSUPPORTED",
      ],
    ]

    for (const [id, frame, code] of cases) {
      const session = fakeSession(id, [frame])
      await expect(
        pump(session, controller([]), { textId: "t", reasoningId: "r" }),
      ).rejects.toMatchObject({
        name: "CursorProtocolError",
        origin: "protocol",
        transient: false,
        replaySafe: false,
        code,
      })
      expect(session.closed).toBe(true)
    }
  })

  it("resumes the latest checkpoint after visible output instead of replaying the turn", async () => {
    const firstCheckpoint = Uint8Array.from([0x0a, 0x01, 0x01])
    const latestCheckpoint = Uint8Array.from([0x0a, 0x01, 0x02])
    const interrupted = fakeSession("checkpointed", [
      serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
      serverFrame({ conversation_checkpoint_update: firstCheckpoint }),
      serverFrame({ conversation_checkpoint_update: latestCheckpoint }),
      {
        flags: 0x02,
        payload: new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable" } })),
      },
    ])
    const resumed = fakeSession("resumed", [
      serverFrame({ interaction_update: { text_delta: { text: " continuation" } } }),
      serverFrame({ interaction_update: { turn_ended: { input_tokens: 4, output_tokens: 2 } } }),
    ])
    const parts: any[] = []
    const recoveries: unknown[] = []

    const finalSession = await pumpWithRecovery({
      initialSession: interrupted,
      controller: controller(parts),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      recover: async (recovery) => {
        recoveries.push(recovery)
        return resumed
      },
    })

    expect(finalSession).toBe(resumed)
    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]).toMatchObject({
      kind: "resume",
      conversationId: interrupted.conversationId,
    })
    expect(Buffer.from((recoveries[0] as any).checkpoint)).toEqual(Buffer.from(latestCheckpoint))
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([
      "partial",
      " continuation",
    ])
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(parts.find((part) => part.type === "finish").usage.outputTokens.total).toBe(5)
  })

  it("does not retry a transport close after turn_ended", async () => {
    let recoveries = 0
    const parts: any[] = []
    await pumpWithRecovery({
      initialSession: fakeSession("terminal", [
        serverFrame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
        { flags: 0x02, payload: new Uint8Array() },
      ]),
      controller: controller(parts),
      recover: async () => {
        recoveries++
        return fakeSession("unused", [])
      },
    })

    expect(recoveries).toBe(0)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
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
