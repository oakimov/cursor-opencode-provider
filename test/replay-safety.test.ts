import { describe, expect, it } from "bun:test"
import { CursorTransportError } from "../src/errors.js"
import {
  analyzeReplayFrame,
  announcedCallsClaimed,
  AttemptReplaySafety,
  describeFrameLayout,
  type ReplaySafetyState,
} from "../src/replay-safety.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"

function varint(value: number): number[] {
  const out: number[] = []
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  out.push(value)
  return out
}

function lengthDelimited(field: number, bytes: Uint8Array = new Uint8Array()): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]
}

function kvFrame(...fields: number[][]): Uint8Array {
  return Uint8Array.from(lengthDelimited(4, Uint8Array.from(fields.flat())))
}

const id = [...varint(1 << 3), 7]
const getBlob = lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("blob"))))
// `KvServerMessage.span_context` (#4): Cursor sends it on live KV requests.
const span = lengthDelimited(4, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("trace"))))
const kv = { id: 7, get_blob_args: { blob_id: new TextEncoder().encode("blob") } }

describe("replay frame analysis", () => {
  it("treats a KV request with its span context as a control frame", () => {
    expect(analyzeReplayFrame(kvFrame(id, getBlob, span), { kv })).toEqual({ barrier: undefined })
    expect(analyzeReplayFrame(kvFrame(id, getBlob), { kv }).barrier).toBeUndefined()
  })

  it("keeps the barrier for unknown or repeated KV fields", () => {
    const unknown = [...varint((20 << 3) | 0), 1]
    expect(analyzeReplayFrame(kvFrame(id, getBlob, unknown), { kv }).barrier).toBe("unknown-or-malformed-frame")
    expect(analyzeReplayFrame(kvFrame(id, getBlob, span, span), { kv }).barrier).toBe("unknown-or-malformed-frame")
  })
})

function updateFrame(field: number, body: number[]): Uint8Array {
  return Uint8Array.from(lengthDelimited(1, Uint8Array.from(lengthDelimited(field, Uint8Array.from(body)))))
}

describe("interaction update analysis", () => {
  const text = lengthDelimited(1, new TextEncoder().encode("hm"))

  it("accepts Cursor's informational updates and styled thinking", () => {
    // thinking_completed{thinking_duration_ms} #5, token_delta{tokens} #8.
    expect(analyzeReplayFrame(updateFrame(5, [...varint(1 << 3), 42]), { interactionUpdate: {} }).barrier).toBeUndefined()
    expect(analyzeReplayFrame(updateFrame(8, [...varint(1 << 3), 3]), { interactionUpdate: {} }).barrier).toBeUndefined()
    // thinking_delta{text, thinking_style} #4.
    const styled = updateFrame(4, [...text, ...varint(2 << 3), 1])
    expect(analyzeReplayFrame(styled, { interactionUpdate: { thinking_delta: { text: "hm" } } }))
      .toEqual({ barrier: undefined })
  })

  it("keeps the barrier for undeclared updates and unknown delta fields", () => {
    // shell_output_delta #12 is not a member this client declares.
    expect(analyzeReplayFrame(updateFrame(12, text), { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
    const textWithUnknown = updateFrame(1, [...text, ...varint(3 << 3), 1])
    expect(analyzeReplayFrame(textWithUnknown, { interactionUpdate: { text_delta: { text: "hm" } } }).barrier)
      .toBe("unknown-or-malformed-frame")
    // A second top-level oneof member, or a repeated timing field, is not a frame this client knows.
    const twoMembers = Uint8Array.from([...updateFrame(13, []), ...lengthDelimited(4, Uint8Array.from(id))])
    expect(analyzeReplayFrame(twoMembers, { interactionUpdate: { heartbeat: {} } }).barrier).toBe("unknown-or-malformed-frame")
  })
})

describe("user-message-appended updates", () => {
  // Independent bytes from the shipped CLI descriptors: InteractionUpdate #6,
  // UserMessageAppendedUpdate.user_message #1, UserMessage text #1 / id #2 / mode #4.
  const userMessage = Uint8Array.of(0x0a, 0x02, 0x68, 0x69, 0x12, 0x02, 0x6d, 0x31, 0x20, 0x03)
  const appended = lengthDelimited(1, userMessage)
  const frame = updateFrame(6, appended)
  const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)

  it("decodes the appended user message using the vendor field numbers", () => {
    expect(decoded).toMatchObject({ interaction_update: {
      user_message_appended: { user_message: { text: "hi", message_id: "m1", mode: 3 } },
    } })
  })

  it("recognizes a stateful update, including the timing field seen after injection", () => {
    expect(analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update }).barrier)
      .toBe("stateful-interaction")
    const timed = Uint8Array.from(lengthDelimited(1, Uint8Array.from([
      ...lengthDelimited(6, Uint8Array.from(appended)), 0xc8, 0x01, 0x01,
    ])))
    expect(describeFrameLayout(timed)).toBe("1:2{6:2{1:2},25:0}")
    expect(analyzeReplayFrame(timed, { interactionUpdate: decoded.interaction_update }).barrier)
      .toBe("stateful-interaction")
  })

  it("keeps missing, repeated, unknown, or mistyped appended-message fields unknown", () => {
    for (const body of [[], [...appended, ...appended], lengthDelimited(2, userMessage), [0x08, 0x01]]) {
      expect(analyzeReplayFrame(updateFrame(6, body), { interactionUpdate: decoded.interaction_update }).barrier)
        .toBe("unknown-or-malformed-frame")
    }
    expect(analyzeReplayFrame(frame, { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
  })

  it("keeps mixed update members unknown", () => {
    const mixed = Uint8Array.from(lengthDelimited(1, Uint8Array.from([
      ...lengthDelimited(6, Uint8Array.from(appended)), ...lengthDelimited(13),
    ])))
    expect(analyzeReplayFrame(mixed, { interactionUpdate: decoded.interaction_update }).barrier)
      .toBe("unknown-or-malformed-frame")
  })
})

describe("display tool lifecycle", () => {
  // Independent bytes from the shipped CLI descriptors: InteractionUpdate
  // tool_call_started #2 / tool_call_completed #3; both updates carry call_id #1.
  const lifecycleFrame = (field: 2 | 3, callId?: string) =>
    updateFrame(field, callId === undefined ? [] : lengthDelimited(1, new TextEncoder().encode(callId)))
  const analyze = (field: 2 | 3, callId?: string) => {
    const frame = lifecycleFrame(field, callId)
    const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
    return analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update })
  }
  const failure = () => new CursorTransportError("Cursor Run transport interrupted", { transient: true, replaySafe: true })

  it("correlates started and completed frames by call id", () => {
    expect(analyze(2, "call-1")).toEqual({
      barrier: "display-tool-lifecycle", toolLifecycle: { kind: "started", callId: "call-1" },
    })
    expect(analyze(3, "call-1")).toEqual({
      barrier: "display-tool-lifecycle", toolLifecycle: { kind: "completed", callId: "call-1" },
    })
  })

  it("does not correlate a frame without a call id or with another member", () => {
    expect(analyze(2)).toEqual({ barrier: "display-tool-lifecycle" })
    const frame = lifecycleFrame(2, "call-1")
    const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
    const mixed = Uint8Array.from(lengthDelimited(1, Uint8Array.from([
      ...lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("call-1")))),
      ...lengthDelimited(13),
    ])))
    expect(analyzeReplayFrame(mixed, { interactionUpdate: decoded.interaction_update }))
      .toEqual({ barrier: "display-tool-lifecycle" })
  })

  it("lets history represent a call its host exec claimed", () => {
    const state: ReplaySafetyState = {}
    const toolStep = new AttemptReplaySafety("run-1", state)
    toolStep.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
    expect(announcedCallsClaimed(state)).toBe(false)
    toolStep.markBarrier("non-control-exec")
    toolStep.recordExec(1, "call-1")
    expect(toolStep.applyTo(failure())).toMatchObject({ replaySafe: false, replayBarrier: "stateful" })
    expect(state.historyRebaseUnsafe).toBeUndefined()
    expect(announcedCallsClaimed(state)).toBe(true)

    // The completion Cursor sends after the delivered result marks nothing.
    const continuation = new AttemptReplaySafety("run-1", state)
    continuation.recordToolLifecycle(analyze(3, "call-1").toolLifecycle)
    const continued = continuation.applyTo(failure())
    expect(continued.replayBarrier).toBeUndefined()
    expect(continued.replaySafe).toBe(false)
    expect(state.historyRebaseUnsafe).toBeUndefined()
  })

  it("retains a preceding Run's display claim across resume", () => {
    const state: ReplaySafetyState = {}
    const previous = new AttemptReplaySafety("run-1", state)
    previous.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
    previous.markBarrier("non-control-exec")
    previous.recordExec(1, "call-1")
    previous.recordToolLifecycle(analyze(3, "call-1").toolLifecycle)

    const resumed = new AttemptReplaySafety("run-2", state)
    resumed.recordToolLifecycle(analyze(3, "call-1").toolLifecycle)
    expect(state.historyRebaseUnsafe).toBeUndefined()
    expect(announcedCallsClaimed(state)).toBe(true)
    expect(resumed.applyTo(failure()).replayBarrier).toBeUndefined()
  })

  it("keeps malformed nested lifecycle fields from claiming completed work", () => {
    const callId = lengthDelimited(1, new TextEncoder().encode("call-1"))
    for (const body of [
      [...callId, ...callId],
      [...callId, ...lengthDelimited(99)],
      [...callId, ...varint(3 << 3), 0],
    ]) {
      const frame = updateFrame(3, body)
      const decoded = decodeMessage<{ interaction_update: Record<string, unknown> }>("AgentServerMessage", frame)
      expect(analyzeReplayFrame(frame, { interactionUpdate: decoded.interaction_update }))
        .toEqual({ barrier: "display-tool-lifecycle" })
    }
  })

  it("keeps blocking calls no host exec claimed and unknown lifecycle frames", () => {
    const cursorRun: ReplaySafetyState = {}
    const run = new AttemptReplaySafety("run-1", cursorRun)
    run.recordToolLifecycle(analyze(2, "web-1").toolLifecycle)
    expect(announcedCallsClaimed(cursorRun)).toBe(false)
    run.recordToolLifecycle(analyze(3, "web-1").toolLifecycle)
    expect(cursorRun.historyRebaseUnsafe).toBe(true)

    for (const record of [
      (safety: AttemptReplaySafety) => safety.recordToolLifecycle(analyze(3, "never-started").toolLifecycle),
      (safety: AttemptReplaySafety) => safety.recordToolLifecycle(analyze(2).toolLifecycle),
      (safety: AttemptReplaySafety) => {
        safety.recordExec(1, "call-1")
        safety.recordToolLifecycle(analyze(2, "call-1").toolLifecycle)
      },
    ]) {
      const state: ReplaySafetyState = {}
      const safety = new AttemptReplaySafety("run-1", state)
      record(safety)
      expect(state.historyRebaseUnsafe).toBe(true)
      expect(safety.applyTo(failure()).replayBarrier).toBe("stateful")
    }
  })
})

describe("frame layout", () => {
  it("names field numbers and wire types without payload bytes", () => {
    const frame = updateFrame(16, [...varint(1 << 3), 5])
    expect(describeFrameLayout(frame)).toBe("1:2{16:2{1:0}}")
    expect(describeFrameLayout(kvFrame(id, getBlob))).toBe("4:2{1:0,2:2{1:2}}")
  })
})

function fixed64(field: number): number[] {
  return [...varint((field << 3) | 1), 1, 0, 0, 0, 0, 0, 0, 0]
}

describe("Cursor CLI 2026.09.28 frame shapes", () => {
  const text = lengthDelimited(1, new TextEncoder().encode("hm"))
  const startedAt = [...varint(25 << 3), ...varint(1_791_275_000)]
  const update = (field: number, body: number[], extra: number[] = startedAt): number[] =>
    lengthDelimited(1, Uint8Array.from([...lengthDelimited(field, Uint8Array.from(body)), ...extra]))
  const ttft = lengthDelimited(8, Uint8Array.from([...fixed64(1), ...fixed64(2), ...fixed64(3), ...fixed64(4)]))
  const callId = lengthDelimited(1, new TextEncoder().encode("call-1"))
  const nested = lengthDelimited(2, Uint8Array.from(lengthDelimited(1, new TextEncoder().encode("x"))))

  // Layouts logged live by `replay frame unknown: layout=…`.
  const cases: Array<[string, number[], Record<string, unknown>]> = [
    ["1:2{4:2{1:2,2:0},25:0},8:2{1:1,2:1,3:1,4:1}", [...update(4, [...text, ...varint(2 << 3), 1]), ...ttft], { thinking_delta: { text: "hm" } }],
    ["1:2{4:2{1:2,2:0},25:0}", update(4, [...text, ...varint(2 << 3), 1]), { thinking_delta: { text: "hm" } }],
    ["1:2{5:2{1:0},25:0}", update(5, [...varint(1 << 3), 42]), {}],
    ["1:2{1:2{1:2},25:0}", update(1, text), { text_delta: { text: "hm" } }],
    ["1:2{27:2{1:0}}", update(27, [...varint(1 << 3), 2], []), {}],
    ["1:2{7:2{1:2,2:2,4:2},25:0}", update(7, [...callId, ...nested, ...lengthDelimited(4, new TextEncoder().encode("m"))]), { partial_tool_call: {} }],
    ["1:2{15:2{1:2,2:2,3:2},25:0}", update(15, [...callId, ...nested, ...lengthDelimited(3, new TextEncoder().encode("m"))]), {}],
    // context_injection_state{injection_id, state} after an inject_context_action.
    ["1:2{23:2{1:2,2:2}}", update(23, [...callId, ...lengthDelimited(2, Uint8Array.from(lengthDelimited(3)))], []), {}],
  ]

  for (const [layout, bytes, interactionUpdate] of cases) {
    it(`accepts ${layout}`, () => {
      const frame = Uint8Array.from(bytes)
      expect(describeFrameLayout(frame)).toBe(layout)
      expect(analyzeReplayFrame(frame, { interactionUpdate }).barrier).toBeUndefined()
    })
  }

  it("decodes an injection state update as status without a barrier", () => {
    const frame = encodeMessage("AgentServerMessage", {
      interaction_update: {
        context_injection_state: { injection_id: "inj-1", state: { rejected: { reason: "run ended" } } },
      },
    })
    const decoded = decodeMessage<any>("AgentServerMessage", frame).interaction_update
    expect(decoded.context_injection_state.injection_id).toBe("inj-1")
    expect(decoded.context_injection_state.state.rejected.reason).toBe("run ended")
    expect(analyzeReplayFrame(frame, { interactionUpdate: decoded })).toEqual({ barrier: undefined })
  })

  it("keeps the barrier for an undeclared member or a repeated timing field", () => {
    // `grok_bot_nudge` #26 is not one this client accepts.
    expect(analyzeReplayFrame(Uint8Array.from(update(26, text)), { interactionUpdate: {} }).barrier).toBe("unknown-or-malformed-frame")
    expect(analyzeReplayFrame(Uint8Array.from([...update(1, text), ...ttft, ...ttft]), { interactionUpdate: { text_delta: { text: "hm" } } }).barrier)
      .toBe("unknown-or-malformed-frame")
  })
})
