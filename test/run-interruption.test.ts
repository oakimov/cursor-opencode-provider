import { describe, expect, it } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  checkpointBlobGraphConcern,
  checkpointBlobGraphRequiresRebase,
  extractPromptHistory,
  MAX_CHECKPOINT_BLOB_GRAPH_BYTES,
  pump,
  pumpWithRecovery,
  rememberMirroredTodos,
  type CursorRunRecovery,
  snapshotMirroredTodosBySession,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { CursorAuthError, CursorRetryExhaustedError, CursorServerError, CursorTransportError, hostFacingError } from "../src/errors.js"
import { setOfflineClockForTests } from "../src/offline.js"
import { writeStreamMessage } from "../src/stream-write.js"
import { sessionFixture } from "./session-fixture.js"

function fakeSession(id: string, frames: Frame[], writes: Uint8Array[] = []): CursorSession {
  let index = 0
  return sessionFixture({
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
      onTerminal: () => () => {},
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
  })
}

function controller(parts: unknown[]) {
  return {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
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

function lengthDelimitedField(field: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
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
  it("closes a cancelled consumer's Run after the active pump stops", async () => {
    const session = fakeSession("cancelled-consumer", [
      serverFrame({ interaction_update: { thinking_delta: { text: "in flight" } } }),
    ])
    let destroyed = 0
    session.stream.destroy = () => { destroyed++ }
    const cancelledController = controller([])
    cancelledController.enqueue = () => { throw new TypeError("Controller is already closed") }

    await pumpWithRecovery({
      initialSession: session,
      controller: cancelledController,
      recover: async () => { throw new Error("Cancellation must not retry") },
    })

    expect(session.pumpActive).toBe(false)
    expect(session.closed).toBe(true)
    expect(destroyed).toBe(1)
  })

  it("closes an aborted Run without pending tools after releasing pump ownership", async () => {
    const session = fakeSession("aborted-consumer", [])
    let destroyed = 0
    session.stream.destroy = () => { destroyed++ }

    await pumpWithRecovery({
      initialSession: session,
      controller: controller([]),
      abortSignal: AbortSignal.abort(),
      recover: async () => { throw new Error("Cancellation must not retry") },
    })

    expect(session.closed).toBe(true)
    expect(destroyed).toBe(1)
  })

  it("keeps pending tool results deliverable when the consumer aborts", async () => {
    const session = fakeSession("aborted-tool-turn", [])
    sessionManager.registerPending(0, session, "read_result", "read")
    try {
      await pumpWithRecovery({
        initialSession: session,
        controller: controller([]),
        abortSignal: AbortSignal.abort(),
        recover: async () => { throw new Error("Cancellation must not retry") },
      })

      expect(session.closed).toBe(false)
      expect(session.pumpActive).toBe(false)
      expect(sessionManager.findByExecIds(session.sessionId, [0])).toBe(session)
    } finally {
      sessionManager.close(session)
    }
  })

  it("ignores a prior consumer's late cancellation while the continuation pumps", async () => {
    const session = fakeSession("late-prior-cancel", [
      serverFrame({ interaction_update: { text_delta: { text: "continued" } } }),
      serverFrame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
    ])
    const next = session.frames.next.bind(session.frames)
    session.frames.next = async () => {
      expect(sessionManager.closeUnlessPending(session)).toBe(false)
      expect(session.closed).toBe(false)
      return next()
    }
    const parts: any[] = []
    await pumpWithRecovery({
      initialSession: session,
      controller: controller(parts),
      recover: async () => { throw new Error("Late cancellation must not retry") },
    })

    expect(parts.some((part) => part.type === "text-delta" && part.delta === "continued")).toBe(true)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("awaits KV reply backpressure before consuming the next server frame", async () => {
    const blobId = new Uint8Array([1, 2, 3, 4])
    const session = fakeSession("kv-backpressure", [
      serverFrame({ kv_server_message: { id: 7, get_blob_args: { blob_id: blobId } } }),
      serverFrame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
    ])
    session.blobs.set("01020304", new TextEncoder().encode("large-enough-for-test"))
    let releaseDrain!: () => void
    let drainStarted!: () => void
    const started = new Promise<void>((resolve) => { drainStarted = resolve })
    const released = new Promise<void>((resolve) => { releaseDrain = resolve })
    let writes = 0
    session.stream.write = () => {
      writes++
      return false
    }
    session.stream.waitForDrain = async () => {
      drainStarted()
      await released
    }

    let completed = false
    const pumping = pump(
      session,
      controller([]),
      { textId: "t", reasoningId: "r" },
    ).then(() => { completed = true })
    await started
    expect(writes).toBe(1)
    expect(completed).toBe(false)
    releaseDrain()
    await pumping
    expect(completed).toBe(true)
  })

  it("never remints for oversized or incomplete checkpoint graphs (CLI soft-reuse)", () => {
    expect(checkpointBlobGraphRequiresRebase({
      count: 1,
      bytes: MAX_CHECKPOINT_BLOB_GRAPH_BYTES,
      complete: true,
    })).toBe(false)
    expect(checkpointBlobGraphRequiresRebase({
      count: 1,
      bytes: MAX_CHECKPOINT_BLOB_GRAPH_BYTES + 1,
      complete: true,
    })).toBe(false)
    expect(checkpointBlobGraphRequiresRebase({
      count: 0,
      bytes: 0,
      complete: false,
      fallbackReason: "missing referenced blob",
    })).toBe(false)
  })

  it("reports warn-only concerns for oversized or incomplete graphs", () => {
    expect(checkpointBlobGraphConcern({
      count: 1,
      bytes: MAX_CHECKPOINT_BLOB_GRAPH_BYTES + 1,
      complete: true,
    })).toBe("oversized-checkpoint-graph")
    expect(checkpointBlobGraphConcern({
      count: 0,
      bytes: 0,
      complete: false,
      fallbackReason: "missing referenced blob",
    })).toBe("incomplete-checkpoint-graph")
    expect(checkpointBlobGraphConcern({
      count: 1,
      bytes: 10,
      complete: true,
    })).toBeUndefined()
  })

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

  for (const afterRow of ["eof", "read-idle", "semantic-idle", "unknown", "started", "exec"] as const) {
    it(`retries an unfinished display row only without stateful activity (${afterRow})`, async () => {
      const session = fakeSession(`unfinished-row-${afterRow}`, [
        serverFrame({ interaction_update: { thinking_delta: { text: "Preparing an edit" } } }),
        serverFrame({ interaction_update: { partial_tool_call: { call_id: "unfinished-edit",
          tool_call: { edit_tool_call: { args: { path: "unfinished.txt" } } } } } }),
        ...(afterRow === "unknown" ? [{ flags: 0, payload: Uint8Array.of(0xa2, 0x06, 0) }] : []),
        ...(afterRow === "started" ? [serverFrame({ interaction_update: { tool_call_started: { call_id: "unfinished-edit" } } })] : []),
        ...(afterRow === "exec" ? [serverFrame({ exec_server_message: { id: 4, list_mcp_resources_exec_args: {} } })] : []),
      ])
      session.toolCatalog = [{ name: "write", description: "Write a file" }]
      session.permittedToolNames = new Set(["write"])
      session.requestContext.env = { workspace_paths: [process.cwd()] }
      const next = session.frames.next.bind(session.frames)
      session.frames.next = async () => {
        const frame = await next()
        if (frame.done && (afterRow === "read-idle" || afterRow === "semantic-idle")) {
          throw new CursorTransportError("Cursor Run stalled", { transient: true, replaySafe: true,
            code: afterRow === "read-idle" ? "CURSOR_READ_IDLE_TIMEOUT" : "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
        }
        return frame
      }
      const parts: Array<{ type: string; providerExecuted?: boolean; result?: string }> = []
      try {
        const failure = await pumpWithRecovery({
          initialSession: session,
          controller: controller(parts),
          recover: async () => { throw new Error("Already displayed output must be retried by the host") },
        }).catch((error: unknown) => error)
        const outputOnly = ["eof", "read-idle", "semantic-idle"].includes(afterRow)
        expect(hostFacingError(failure)).toMatchObject({ isRetryable: outputOnly,
          responseHeaders: { "x-should-retry": String(outputOnly) } })
        expect(parts.filter(part => part.type === "tool-input-start")).toHaveLength(1)
        expect(parts.filter(part => part.type === "tool-input-end")).toHaveLength(1)
        const calls = parts.filter(part => part.type === "tool-call")
        expect(calls).toHaveLength(1)
        expect(calls[0]!.providerExecuted).toBe(true)
        expect(parts.find(part => part.type === "tool-result")?.result).toBe("Cursor did not finish this tool call.")
        expect(session.pending.size).toBe(0)
      } finally {
        sessionManager.close(session)
      }
    })
  }

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

  it("stops early EOF after ten transport retries, like Cursor CLI", async () => {
    let recoveries = 0
    await expect(
      pumpWithRecovery({
        initialSession: fakeSession("first-eof", []),
        controller: controller([]),
        retryPolicy: { baseDelayMs: 0, maxDelayMs: 0 },
        recover: async () => {
          recoveries++
          return fakeSession("second-eof", [])
        },
      }),
    ).rejects.toBeInstanceOf(CursorRetryExhaustedError)
    expect(recoveries).toBe(10)
  })

  it("does not leak OpenCode SessionRetry triggers after unavailable retries finish", async () => {
    let recoveries = 0
    let failure: unknown
    try {
      await pumpWithRecovery({
        initialSession: fakeSession("busy", [
          {
            flags: 0x02,
            payload: new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable" } })),
          },
        ]),
        controller: controller([]),
        retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        recover: async () => {
          recoveries++
          return fakeSession("busy-retry", [
            {
              flags: 0x02,
              payload: new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable" } })),
            },
          ])
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      name: "CursorRetryExhaustedError",
      code: "unavailable",
      transient: false,
    })
    expect(recoveries).toBe(1)
    expect(String((failure as Error).message).toLowerCase()).not.toMatch(/unavailable|exhausted/)
  })

  function endStreamError(code: string): Frame {
    return { flags: 0x02, payload: new TextEncoder().encode(JSON.stringify({ error: { code } })) }
  }

  const turnEnded = () => serverFrame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })

  it("waits out a network outage without spending the attempt budget", async () => {
    const offline = () => new CursorTransportError("Cursor HTTP/2 connection failed", {
      transient: true,
      replaySafe: true,
      code: "ENOTFOUND",
    })
    const dropped = fakeSession("dropped", [])
    dropped.frames = { next: async () => { throw offline() } }
    let opens = 0
    setOfflineClockForTests({
      now: () => 5_000,
      windowMs: 60_000,
      sleep: async () => {},
      reachable: async () => true,
    })
    try {
      const finalSession = await pumpWithRecovery({
        initialSession: dropped,
        controller: controller([]),
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        recover: async () => {
          opens++
          if (opens <= 5) throw offline()
          return fakeSession("back-online", [turnEnded()])
        },
      })
      expect(finalSession.sessionId).toBe("back-online")
      expect(opens).toBe(6)
    } finally {
      setOfflineClockForTests(undefined)
    }
  })

  it("renews a rejected credential once and reopens before any output, outside the retry budget", async () => {
    let renewals = 0
    const recoveries: unknown[] = []
    const finalSession = await pumpWithRecovery({
      initialSession: fakeSession("expired-token", [endStreamError("unauthenticated")]),
      controller: controller([]),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("renewed-token", [turnEnded()])
      },
      renewRejectedCredential: () => { renewals++ },
    })
    expect(finalSession.sessionId).toBe("renewed-token")
    expect(renewals).toBe(1)
    expect(recoveries).toEqual([{ kind: "rebase" }])
  })

  it("renews a rejected credential only once per turn", async () => {
    let renewals = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("expired-1", [endStreamError("unauthenticated")]),
      controller: controller([]),
      recover: async () => fakeSession("expired-2", [endStreamError("unauthenticated")]),
      renewRejectedCredential: () => { renewals++ },
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(CursorAuthError)
    expect(renewals).toBe(1)
  })

  it("honors a final Cursor verdict before treating unauthenticated as a renewable login", async () => {
    let renewals = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("final-auth-code", [{
        flags: 0x02,
        payload: new TextEncoder().encode(JSON.stringify({ error: {
          code: "unauthenticated",
          // aiserver.v1.ErrorDetails{error:RATE_LIMITED_CHANGEABLE (51)}.
          details: [{ type: "aiserver.v1.ErrorDetails", value: "CDM=" }],
        } })),
      }]),
      controller: controller([]),
      recover: async () => { throw new Error("A final verdict must not reopen the Run") },
      renewRejectedCredential: () => { renewals++ },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CursorServerError)
    expect(failure).toMatchObject({ code: "unauthenticated", transient: false, retryable: false })
    expect(renewals).toBe(0)
  })

  it("retains a checkpoint across credential renewal and a later output-only failure", async () => {
    const checkpoint = Uint8Array.from([0x0a, 0x01, 0x09])
    const recoveries: CursorRunRecovery[] = []
    const finalSession = await pumpWithRecovery({
      initialSession: fakeSession("checkpoint-before-renewal", [
        serverFrame({ conversation_checkpoint_update: checkpoint }),
        endStreamError("unauthenticated"),
      ]),
      controller: controller([]),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      renewRejectedCredential: () => {},
      recover: async (recovery) => {
        recoveries.push(recovery)
        return recoveries.length === 1
          ? fakeSession("renewed-without-checkpoint", [
              serverFrame({ interaction_update: { thinking_delta: { text: "continuing" } } }),
            ])
          : fakeSession("renewed-recovered", [turnEnded()])
      },
    })
    expect(finalSession.sessionId).toBe("renewed-recovered")
    expect(recoveries).toHaveLength(2)
    for (const recovery of recoveries) {
      expect(recovery).toMatchObject({ kind: "resume", checkpoint })
    }
  })

  it.each([false, true])("renews an untouched checkpoint resume after an earlier tool barrier (new checkpoint: %s)", async newCheckpoint => {
    const checkpoint = Uint8Array.of(10, 1, 11)
    const replacementCheckpoint = Uint8Array.of(10, 1, 12)
    const initial = fakeSession("tool-before-renewal", [
      serverFrame({ conversation_checkpoint_update: checkpoint }),
      endStreamError("unavailable"),
    ])
    initial.replaySafety = { statefulBarrier: "non-control-exec" }
    const rejected = fakeSession("untouched-resume", [
      ...(newCheckpoint ? [serverFrame({ conversation_checkpoint_update: replacementCheckpoint })] : []),
      endStreamError("unauthenticated"),
    ])
    const renewed = fakeSession("renewed-resume", [turnEnded()])
    rejected.conversationId = renewed.conversationId = initial.conversationId
    const recoveries: CursorRunRecovery[] = []
    let renewals = 0
    const final = await pumpWithRecovery({
      initialSession: initial,
      controller: controller([]),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      renewRejectedCredential: () => { renewals++ },
      recover: async recovery => {
        recoveries.push(recovery)
        return recoveries.length === 1 ? rejected : renewed
      },
    })
    expect(final).toBe(renewed)
    expect(renewals).toBe(1)
    expect(recoveries).toEqual([
      { kind: "resume", conversationId: initial.conversationId, checkpoint },
      { kind: "resume", conversationId: initial.conversationId, checkpoint: newCheckpoint ? replacementCheckpoint : checkpoint },
    ])
    expect(renewed.replaySafety).toEqual(initial.replaySafety)
  })

  it.each(["output", "tool display", "revoked checkpoint"])("does not renew a resumed credential after %s", async activity => {
    const initial = fakeSession("before-resume-activity", [
      serverFrame({ conversation_checkpoint_update: Uint8Array.of(10, 1, 13) }),
    ])
    initial.replaySafety = { statefulBarrier: "non-control-exec" }
    const rejected = fakeSession("resume-activity", [
      ...(activity === "output" ? [serverFrame({ interaction_update: { text_delta: { text: "Visible progress" } } })] : []),
      ...(activity === "tool display" ? [serverFrame({ interaction_update: { tool_call_started: { call_id: "new-tool" } } })] : []),
      endStreamError("unauthenticated"),
    ])
    rejected.checkpointRevoked = activity === "revoked checkpoint"
    let renewals = 0
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: initial,
      controller: controller([]),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      renewRejectedCredential: () => { renewals++ },
      recover: async () => { recoveries++; return rejected },
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorAuthError)
    expect(recoveries).toBe(1)
    expect(renewals).toBe(0)
  })

  it("never renews twice after a checkpointed tool result", async () => {
    const initial = fakeSession("tool-before-two-rejections", [
      serverFrame({ conversation_checkpoint_update: Uint8Array.of(10, 1, 14) }),
    ])
    initial.replaySafety = { statefulBarrier: "non-control-exec" }
    let renewals = 0
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: initial,
      controller: controller([]),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      renewRejectedCredential: () => { renewals++ },
      recover: async () => { recoveries++; return fakeSession(`rejection-${recoveries}`, [endStreamError("unauthenticated")]) },
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorAuthError)
    expect(recoveries).toBe(2)
    expect(renewals).toBe(1)
  })

  it("does not renew when the source cannot, after visible output, or on permission_denied", async () => {
    const cases = [
      { session: fakeSession("static", [endStreamError("unauthenticated")]), renew: false },
      {
        session: fakeSession("after-output", [
          serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
          endStreamError("unauthenticated"),
        ]),
        renew: true,
      },
      // Cursor CLI treats a bare permission_denied as a final error, not a login prompt.
      { session: fakeSession("denied", [endStreamError("permission_denied")]), renew: true, error: CursorServerError },
    ]
    for (const { session, renew, error = CursorAuthError } of cases) {
      let renewals = 0
      let recoveries = 0
      const failure = await pumpWithRecovery({
        initialSession: session,
        controller: controller([]),
        recover: async () => {
          recoveries++
          return fakeSession("unexpected", [turnEnded()])
        },
        ...(renew ? { renewRejectedCredential: () => { renewals++ } } : {}),
      }).catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(error)
      expect(renewals).toBe(0)
      expect(recoveries).toBe(0)
    }
  })

  it.each([false, true])("keeps transport counts across replacement checkpoints (endless=%s)", async endless => {
    const saved = process.env.CURSOR_ENDLESS_RETRIES
    if (endless) process.env.CURSOR_ENDLESS_RETRIES = "1"
    else delete process.env.CURSOR_ENDLESS_RETRIES
    let attempts = 0
    const checkpointedFailure = () => {
      attempts++
      const session = fakeSession(`transport-budget-${attempts}`, [
        serverFrame({ conversation_checkpoint_update: Uint8Array.of(10, 1, attempts) }),
        ...(endless && attempts === 15 ? [turnEnded()] : []),
      ])
      const next = session.frames.next.bind(session.frames)
      session.frames.next = async () => {
        const frame = await next()
        if (frame.done) throw new CursorTransportError("reset", { transient: true, replaySafe: true, code: "ECONNRESET" })
        return frame
      }
      return session
    }
    try {
      const pumping = pumpWithRecovery({
        initialSession: checkpointedFailure(), controller: controller([]),
        retryPolicy: { baseDelayMs: 0, maxDelayMs: 0 },
        recover: async () => checkpointedFailure(),
      })
      if (endless) await pumping
      else await expect(pumping).rejects.toBeInstanceOf(CursorRetryExhaustedError)
      expect(attempts).toBe(endless ? 15 : 11)
    } finally {
      if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
      else process.env.CURSOR_ENDLESS_RETRIES = saved
    }
  })

  it("budgets replacement connection failures in the same loop", async () => {
    let openings = 0
    await expect(pumpWithRecovery({
      initialSession: fakeSession("before-replacement-connect-failures", []),
      controller: controller([]), retryPolicy: { baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        openings++
        throw new CursorTransportError("connect reset", { transient: true, replaySafe: true, code: "ECONNRESET" })
      },
    })).rejects.toBeInstanceOf(CursorRetryExhaustedError)
    // The initial EOF and failed replacement opens share ten transport retries.
    expect(openings).toBe(10)
  })

  for (const endless of [false, true]) {
    for (const renewal of [false, true]) {
      for (const upload of ["throw", "drain"] as const) {
        it(`ends an unsafe replacement ${upload} with an older checkpoint (renewal=${renewal}, endless=${endless})`, async () => {
          const saved = process.env.CURSOR_ENDLESS_RETRIES
          if (endless) process.env.CURSOR_ENDLESS_RETRIES = "true"
          else delete process.env.CURSOR_ENDLESS_RETRIES
          const checkpoint = Uint8Array.of(10, 1, 21)
          let openings = 0
          let renewals = 0
          let uploadFailure: unknown
          try {
            const failure = await pumpWithRecovery({
              initialSession: fakeSession("before-unsafe-replacement", [
                serverFrame({ conversation_checkpoint_update: checkpoint }),
                ...(renewal ? [endStreamError("unauthenticated")] : []),
              ]),
              controller: controller([]), retryPolicy: { baseDelayMs: 0, maxDelayMs: 0 },
              renewRejectedCredential: () => { renewals++ },
              recover: async recovery => {
                openings++
                expect(recovery).toMatchObject({ kind: "resume", checkpoint })
                // A second opening makes the buggy path finish instead of looping.
                if (openings > 1) return fakeSession("unexpected-replay", [turnEnded()])
                const stream = fakeSession("ambiguous-upload", []).stream
                const reset = Object.assign(new Error("upload connection reset"), { code: "ECONNRESET" })
                stream.write = () => { if (upload === "throw") throw reset; return false }
                stream.waitForDrain = async () => { throw reset }
                try { await writeStreamMessage(stream, Uint8Array.of(1), "replacement Run request") }
                catch (error) { uploadFailure = error; throw error }
                throw new Error("The replacement upload must fail")
              },
            }).catch((error: unknown) => error)

            expect(hostFacingError(failure)).toMatchObject({
              statusCode: 400, isRetryable: false, responseHeaders: { "x-should-retry": "false" },
            })
            expect(failure).toMatchObject({ retryable: false, replaySafe: false, cause: uploadFailure })
            expect(openings).toBe(1)
            expect(renewals).toBe(renewal ? 1 : 0)
          } finally {
            if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
            else process.env.CURSOR_ENDLESS_RETRIES = saved
          }
        })
      }
    }
  }

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

  it("leaves the retry to the host after output only, before any checkpoint", async () => {
    let recoveries = 0
    const parts: any[] = []
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("partial", [
        serverFrame({ interaction_update: { thinking_delta: { text: "thinking" } } }),
        serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
      ]),
      controller: controller(parts),
      recover: async () => {
        recoveries++
        return fakeSession("unused", [])
      },
    }).catch((error: unknown) => error)

    // Replaying here would show the text twice; Cursor CLI sends the action again.
    expect(failure).toMatchObject({ hostRetryable: true, transient: false, replaySafe: false })
    expect((failure as Error).message).not.toContain("automatic retry unsafe")
    expect(recoveries).toBe(0)
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "partial")).toBe(true)
  })

  it("keeps a failure final when the attempt did more than show output", async () => {
    const getBlob = lengthDelimitedField(1, new TextEncoder().encode("inline blob"))
    const getWithUnknownField = Uint8Array.from([
      ...varintField(1, 15),
      ...lengthDelimitedField(2, getBlob),
      ...fixed32Field(20),
    ])
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("output-then-state", [
        // Text first: the later stateful frame must still decide the verdict.
        serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
        { flags: 0, payload: lengthDelimitedField(4, getWithUnknownField) },
      ]),
      controller: controller([]),
      recover: async () => {
        recoveries++
        return fakeSession("unused", [])
      },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ retryable: false, replaySafe: false })
    expect((failure as { hostRetryable?: boolean }).hostRetryable).toBeUndefined()
    expect((failure as Error).message).toContain("automatic retry unsafe")
    expect(recoveries).toBe(0)
  })

  for (const withOutput of [false, true]) {
    it(`keeps an appended user message stateful without echoing it (prior output: ${withOutput})`, async () => {
      // Shipped CLI: InteractionUpdate #6 wraps UserMessageAppendedUpdate #1.
      const userMessage = lengthDelimitedField(1, new TextEncoder().encode("injected instructions"))
      const appended = lengthDelimitedField(1, lengthDelimitedField(6, lengthDelimitedField(1, userMessage)))
      const writes: Uint8Array[] = []
      const session = fakeSession(`appended-user-${withOutput}`, [
        ...(withOutput ? [serverFrame({ interaction_update: { text_delta: { text: "partial" } } })] : []),
        { flags: 0, payload: appended },
      ], writes)
      const parts: Array<{ type: string; delta?: string }> = []
      let recoveries = 0
      try {
        const failure = await pumpWithRecovery({
          initialSession: session,
          controller: controller(parts),
          recover: async () => { recoveries++; return fakeSession("unused", []) },
        }).catch((error: unknown) => error)

        expect(failure).toMatchObject({ retryable: false, replaySafe: false })
        expect((failure as { hostRetryable?: boolean }).hostRetryable).toBeUndefined()
        expect(hostFacingError(failure)).toMatchObject({
          isRetryable: false, responseHeaders: { "x-should-retry": "false" },
        })
        expect(session.replaySafety).toMatchObject({
          statefulBarrier: "stateful-interaction", historyRebaseUnsafe: true,
        })
        expect(recoveries).toBe(0)
        expect(writes).toHaveLength(0)
        expect(parts.filter(part => part.type === "text-delta").map(part => part.delta))
          .toEqual(withOutput ? ["partial"] : [])
      } finally {
        sessionManager.close(session)
      }
    })
  }

  it("resumes the turn's latest checkpoint when a resumed attempt saved none, like Cursor CLI", async () => {
    const checkpoint = Uint8Array.from([0x0a, 0x01, 0x05])
    const sessions = [
      fakeSession("resume-no-output", []),
      fakeSession("resume-output", [serverFrame({ interaction_update: { text_delta: { text: " more" } } })]),
      fakeSession("resume-done", [
        serverFrame({ interaction_update: { text_delta: { text: " done" } } }),
        serverFrame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
      ]),
    ]
    const recoveries: CursorRunRecovery[] = []
    const parts: any[] = []
    const finalSession = await pumpWithRecovery({
      initialSession: fakeSession("checkpointed-first", [
        serverFrame({ interaction_update: { text_delta: { text: "partial" } } }),
        serverFrame({ conversation_checkpoint_update: checkpoint }),
      ]),
      controller: controller(parts),
      retryPolicy: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async (recovery) => {
        recoveries.push(recovery)
        return sessions[recoveries.length - 1]!
      },
    })

    expect(finalSession).toBe(sessions[2])
    expect(recoveries.map((recovery) => recovery.kind)).toEqual(["resume", "resume", "resume"])
    for (const recovery of recoveries) {
      expect(Buffer.from((recovery as { checkpoint: Uint8Array }).checkpoint)).toEqual(Buffer.from(checkpoint))
    }
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("does not count a prior tool-step barrier as streaming from a silent resumed attempt", async () => {
    const checkpoint = Uint8Array.from([0x0a, 0x01, 0x08])
    const initial = fakeSession("prior-tool-checkpoint", [
      serverFrame({ conversation_checkpoint_update: checkpoint }),
    ])
    initial.replaySafety = { statefulBarrier: "non-control-exec" }
    let recoveries = 0
    const finalSession = await pumpWithRecovery({
      initialSession: initial,
      controller: controller([]),
      retryPolicy: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        recoveries++
        return fakeSession(`silent-resume-${recoveries}`, recoveries === 3 ? [turnEnded()] : [])
      },
    })
    expect(finalSession.sessionId).toBe("silent-resume-3")
    expect(recoveries).toBe(3)
  })

  it.each([false, true])("stops after two resumed attempts stream without saving a checkpoint (endless=%s)", async endless => {
    const saved = process.env.CURSOR_ENDLESS_RETRIES
    if (endless) process.env.CURSOR_ENDLESS_RETRIES = "true"
    else delete process.env.CURSOR_ENDLESS_RETRIES
    const checkpoint = Uint8Array.from([0x0a, 0x01, 0x06])
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("checkpointed-then-stuck", [
        serverFrame({ conversation_checkpoint_update: checkpoint }),
      ]),
      controller: controller([]),
      retryPolicy: { maxAttempts: 6, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        recoveries++
        return fakeSession(`stuck-${recoveries}`, [
          serverFrame({ interaction_update: { thinking_delta: { text: "again" } } }),
        ])
      },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ retryable: false, transient: false })
    expect((failure as Error).message).toContain("2 resume attempts made no progress")
    expect(recoveries).toBe(2)
    if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
    else process.env.CURSOR_ENDLESS_RETRIES = saved
  })

  it("does not resume an earlier checkpoint once the Run sent a newer user message", async () => {
    let recoveries = 0
    const revoked = fakeSession("revoked", [
      serverFrame({ interaction_update: { text_delta: { text: "after steer" } } }),
    ])
    revoked.checkpointRevoked = true
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("checkpointed-before-steer", [
        serverFrame({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x01, 0x07]) }),
      ]),
      controller: controller([]),
      retryPolicy: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        recoveries++
        if (recoveries > 1) throw new Error("A revoked checkpoint must not be resumed")
        return revoked
      },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ retryable: false })
    expect((failure as { hostRetryable?: boolean }).hostRetryable).toBeUndefined()
    expect(recoveries).toBe(1)
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
    const finish = parts.find((part) => part.type === "finish")
    expect(finish.usage.outputTokens.total).toBe(0)
    expect(finish.providerMetadata.cursor).toMatchObject({
      inputTokensRaw: 4,
      outputTokensRaw: 2,
    })
    expect(finish.providerMetadata.cursor.context).toBeUndefined()
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

  it("leaves context unavailable without hiding malformed raw Cursor counters", async () => {
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
      { textId: "t", reasoningId: "r" },
    )
    const finish = parts.find((part) => part.type === "finish")
    expect(finish.usage.inputTokens).toEqual({
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(finish.usage.outputTokens).toEqual({
      total: 0,
      text: 0,
      reasoning: 0,
    })
    expect(finish.providerMetadata.cursor).toMatchObject({
      usageVersion: 3,
      inputTokensRaw: 120_000,
      outputTokensRaw: 73_483,
      cacheReadRaw: 5_810_572,
    })
    expect(finish.providerMetadata.cursor.context).toBeUndefined()
  })

  it("maps total and subset TurnEnded counters without double counting", async () => {
    const parts: any[] = []
    const session = fakeSession("small-usage", [
        serverFrame({
          interaction_update: {
            turn_ended: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read: 10,
              cache_write: 5,
              reasoning_tokens: 7,
            },
          },
        }),
      ])
    session.tokenDetails = { usedTokens: 150, maxTokens: 256_000 }
    session.tokenDetailsFresh = false
    await pump(
      session,
      controller(parts),
      { textId: "t", reasoningId: "r" },
    )

    const finish = parts.find((part) => part.type === "finish")
    expect(finish.usage.inputTokens.total + finish.usage.outputTokens.total).toBe(150)
    expect(finish.usage.outputTokens).toEqual({
      total: 1,
      text: 1,
      reasoning: 0,
    })
    expect(finish.providerMetadata.cursor).toMatchObject({
      inputTokensRaw: 100,
      outputTokensRaw: 50,
      cacheReadRaw: 10,
      cacheWriteRaw: 5,
      reasoningTokensRaw: 7,
      context: {
        source: "checkpoint-previous-turn",
        stale: true,
        usedTokens: 150,
      },
    })
  })

  it("uses checkpoint context occupancy for totals and retains raw TurnEnded usage", async () => {
    const parts: any[] = []
    const checkpoint = encodeMessage("ConversationStateStructure", {
      token_details: {
        used_tokens: 30_450,
        max_tokens: 256_000,
        breakdown: {
          total_used_tokens: 30_450,
          max_tokens: 256_000,
          categories: [
            { id: "system_prompt", label: "System prompt", estimated_tokens: 14_976 },
            { id: "conversation", label: "Conversation", estimated_tokens: 15_474 },
          ],
        },
      },
    })
    await pump(
      fakeSession("context-usage", [
        serverFrame({ conversation_checkpoint_update: checkpoint }),
        serverFrame({
          interaction_update: {
            turn_ended: {
              input_tokens: 330_222,
              output_tokens: 3_206,
              cache_read: 230_400,
              cache_write: 0,
              reasoning_tokens: 480,
            },
          },
        }),
      ]),
      controller(parts),
      { textId: "t", reasoningId: "r" },
    )

    const finish = parts.find((part) => part.type === "finish")
    expect(finish.usage.inputTokens.total + finish.usage.outputTokens.total).toBe(30_450)
    expect(
      finish.usage.inputTokens.noCache
        + finish.usage.inputTokens.cacheRead
        + finish.usage.inputTokens.cacheWrite,
    ).toBe(finish.usage.inputTokens.total)
    // Held-Run TurnEnded counters are cumulative; this finish only covers the
    // last generation slice. Display usage is checkpoint occupancy (output=1)
    // so host tok/s stays sane. Exact request counters stay under *Raw.
    expect(finish.usage.outputTokens).toEqual({
      total: 1,
      text: 1,
      reasoning: 0,
    })
    expect(finish.providerMetadata.copilot).toEqual({ totalNanoAiu: 0 })
    expect(finish.providerMetadata.cursor).toMatchObject({
      inputTokensRaw: 330_222,
      outputTokensRaw: 3_206,
      cacheReadRaw: 230_400,
      reasoningTokensRaw: 480,
    })
    expect(finish.providerMetadata.cursor.context).toEqual({
      contextUsageVersion: 2,
      source: "checkpoint-current-run",
      stale: false,
      usedTokens: 30_450,
      maxTokens: 256_000,
      remainingTokens: 225_550,
      usedPercent: 11.9,
      breakdown: {
        totalUsedTokens: 30_450,
        maxTokens: 256_000,
        categories: [
          { id: "system_prompt", label: "System prompt", estimatedTokens: 14_976 },
          { id: "conversation", label: "Conversation", estimatedTokens: 15_474 },
        ],
      },
    })
  })

  it("settles the final request-local counters once after a multi-step held Run", async () => {
    const parts: any[] = []
    const session = fakeSession("multi-step-usage", [
      serverFrame({ interaction_update: { text_delta: { text: "answer" } } }),
      serverFrame({
        interaction_update: {
          turn_ended: {
            input_tokens: 101_753,
            output_tokens: 1_391,
            cache_read: 79_872,
            cache_write: 0,
            reasoning_tokens: 525,
          },
        },
      }),
    ])
    session.usageEstimate = {
      inputTokens: 30_000,
      outputTokens: 500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
    }
    session.tokenDetails = { usedTokens: 103_144, maxTokens: 256_000 }
    session.tokenDetailsFresh = false

    await pump(
      session,
      controller(parts),
      { textId: "t", reasoningId: "r" },
    )

    const finish = parts.find((part) => part.type === "finish")
    expect(finish.usage.inputTokens.total + finish.usage.outputTokens.total).toBe(103_144)
    expect(finish.usage.outputTokens).toEqual({
      total: 1,
      text: 1,
      reasoning: 0,
    })
    expect(finish.providerMetadata.copilot).toEqual({ totalNanoAiu: 0 })
    expect(finish.providerMetadata.cursor).toMatchObject({
      inputTokensRaw: 101_753,
      outputTokensRaw: 1_391,
      cacheReadRaw: 79_872,
      reasoningTokensRaw: 525,
      context: {
        source: "checkpoint-previous-turn",
        stale: true,
        usedTokens: 103_144,
      },
    })
  })

  it("carries the mirrored todo snapshot across Runs of one OpenCode session", () => {
    // Turn_ended closes the Run session (wiping Run-local state), but merges
    // in later turns still need a base. The per-session copy survives across
    // Runs, resumes, and rebases; it never enters the prompt, so the cache
    // prefix is untouched.
    const key = `mirror-todos-${Date.now()}`
    expect(snapshotMirroredTodosBySession(key)).toBeUndefined()
    expect(snapshotMirroredTodosBySession(undefined)).toBeUndefined()
    rememberMirroredTodos(undefined, [
      { id: "1", content: "noop", status: "pending", priority: "medium" },
    ])
    expect(snapshotMirroredTodosBySession(key)).toBeUndefined()
    const first = [
      { id: "1", content: "kept", status: "in_progress", priority: "medium" },
    ]
    rememberMirroredTodos(key, first)
    const snap = snapshotMirroredTodosBySession(key)
    expect(snap).toEqual(first)
    // Copies, not aliases: mutating a snapshot must not corrupt the store.
    expect(snap).not.toBe(first)
    snap![0]!.status = "completed"
    expect(snapshotMirroredTodosBySession(key)).toEqual(first)
    // Wholesale replace on every store — tracks host truth, never merges.
    rememberMirroredTodos(key, [])
    expect(snapshotMirroredTodosBySession(key)).toEqual([])
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
