import { describe, expect, it } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  cancelPendingExecsForFreshTurn,
  drainSessionUntilTurnEnded,
  FRESH_TURN_PENDING_CANCEL_REASON,
  isProperCatalogSubset,
  preparePriorSessionForFreshTurn,
  shouldIsolateInSessionHelper,
} from "../src/language-model.js"
import { sessionManager, type CursorSession } from "../src/session.js"
import { billingLedger } from "../src/billing.js"
import { sessionFixture } from "./session-fixture.js"

function turnEndedPayload(inputTokens: number, cacheRead: number): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      turn_ended: {
        input_tokens: inputTokens,
        output_tokens: 3,
        cache_read: cacheRead,
        cache_write: 0,
        reasoning_tokens: 0,
      },
    },
  })
}

function fakeSessionWithPayloads(payloads: Uint8Array[]): CursorSession {
  let index = 0
  const written: Uint8Array[] = []
  const conversationId = `conv_drain_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const session = sessionFixture({
    sessionId: `sess_drain_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    conversationId,
    openCodeSessionId: `opencode-fresh-turn-${Math.random().toString(16).slice(2)}`,
    stream: {
      write(frame: Uint8Array) { written.push(frame); return true },
      end() {},
      frames: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true as const, value: undefined }),
        }),
      }),
      destroy() {},
      isClosed: () => false,
    } as never,
    frames: {
      next: async () => {
        if (index >= payloads.length) return { done: true as const, value: undefined }
        const payload = payloads[index++]!
        return {
          done: false as const,
          value: { flags: 0, payload },
        }
      },
    } as never,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    cacheDiagnostics: {
      sessionKey: "opencode-fresh-turn",
      conversationId,
      startedWithCheckpoint: true,
      requestContextReused: true,
      requestContextHash: "abc",
      checkpointUpdates: 0,
      tokenDetailUpdates: 0,
      pumpPasses: 1,
      stepStarts: 0,
      stepCompletes: 0,
      displayToolCalls: 0,
      execRequests: 0,
      priorTokenDetails: { usedTokens: 1000, maxTokens: 256_000 },
    },
  })
  ;(session as CursorSession & { _written: Uint8Array[] })._written = written
  sessionManager.registerSession(session)
  return session
}

describe("fresh-turn prior drain", () => {
  it("settles bridged pending and drains turn_ended before a fresh turn", async () => {
    const session = fakeSessionWithPayloads([turnEndedPayload(5000, 4000)])
    sessionManager.registerPending(900_000, session, "bridged", "todowrite", true)
    expect(session.pending.size).toBe(1)

    const outcome = await preparePriorSessionForFreshTurn(session.openCodeSessionId, {
      timeoutMs: 1_000,
    })
    expect(outcome).toBe("drained")
    expect(session.closed).toBe(true)
    expect(session.pending.size).toBe(0)
  })

  it("records what a drained prior Run cost for the next billed step to settle", async () => {
    const session = fakeSessionWithPayloads([turnEndedPayload(5000, 4000)])
    session.billing = { key: session.openCodeSessionId!, cost: { input: 2, output: 6, cache_read: 0.5 }, prefixTokens: 0 }
    sessionManager.registerPending(900_000, session, "bridged", "todowrite", true)
    try {
      expect(await preparePriorSessionForFreshTurn(session.openCodeSessionId, { timeoutMs: 1_000 })).toBe("drained")
      expect(billingLedger.outstanding(session.openCodeSessionId!)).toBeCloseTo((1_000 * 2 + 4_000 * 0.5 + 3 * 6) / 1e6, 12)
    } finally {
      billingLedger.clear()
    }
  })

  it("cancels a real pending exec then drains turn_ended instead of superseding mid-tool", async () => {
    const session = fakeSessionWithPayloads([turnEndedPayload(100, 80)])
    sessionManager.registerPending(1, session, "read_result", "read", false)
    expect(session.pending.size).toBe(1)

    const outcome = await preparePriorSessionForFreshTurn(session.openCodeSessionId, {
      timeoutMs: 1_000,
    })
    expect(outcome).toBe("drained")
    expect(session.closed).toBe(true)
    expect(session.pending.size).toBe(0)
    const written = (session as CursorSession & { _written: Uint8Array[] })._written
    expect(written.length).toBeGreaterThan(0)
  })

  it("keeps a child session separate while draining a new turn on the busy parent", async () => {
    const parent = fakeSessionWithPayloads([turnEndedPayload(100, 80)])
    parent.toolCatalog = Array.from({ length: 76 }, (_, index) => ({ name: `tool-${index}` })) as never
    sessionManager.registerPending(1, parent, "read_result", "read", false)

    // OpenCode child agents carry their own session id. Their reduced catalog
    // cannot identify a child call when a new user turn can have the same set.
    expect(await preparePriorSessionForFreshTurn("ses_child", { timeoutMs: 1_000 })).toBe("none")
    expect(parent.pending.size).toBe(1)
    expect(parent.closed).toBe(false)

    expect(await preparePriorSessionForFreshTurn(parent.openCodeSessionId, {
      timeoutMs: 1_000,
    })).toBe("drained")
    expect(parent.pending.size).toBe(0)
    expect(parent.closed).toBe(true)
  })

  it("cancelPendingExecsForFreshTurn writes an error result for each open exec", async () => {
    const session = fakeSessionWithPayloads([])
    sessionManager.registerPending(0, session, "grep_result", "grep", false)
    sessionManager.registerPending(1, session, "read_result", "read", false)
    expect(await cancelPendingExecsForFreshTurn(session)).toBe(2)
    expect(session.pending.size).toBe(0)
    expect(session.closed).toBe(false)
    const written = (session as CursorSession & { _written: Uint8Array[] })._written
    expect(written.length).toBeGreaterThanOrEqual(2)
    const blob = Buffer.concat(written.map((f) => Buffer.from(f))).toString("utf8")
    expect(blob).toContain(FRESH_TURN_PENDING_CANCEL_REASON)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("refuses an abandoned CreatePlan review with the cancel reason, never an approval", async () => {
    const session = fakeSessionWithPayloads([])
    sessionManager.registerPending(900_000, session, "create_plan_request_response", "question", false, {
      interactionId: 1,
      createPlanBridgeKind: "approve",
      planUri: "file:///tmp/plan.md",
    })
    sessionManager.registerPending(0, session, "grep_result", "grep", false)
    expect(await cancelPendingExecsForFreshTurn(session)).toBe(2)
    expect(session.pending.size).toBe(0)
    const replies = (session as CursorSession & { _written: Uint8Array[] })._written
      .map((frame) => decodeMessage<any>("AgentClientMessage", frame))
    const plan = replies.find((reply) => reply.interaction_response?.create_plan_request_response)
      ?.interaction_response.create_plan_request_response.result
    expect(plan.success).toBeUndefined()
    expect(plan.error.error).toBe(FRESH_TURN_PENDING_CANCEL_REASON)
    expect(plan.plan_uri).toBe("")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("delivers the host's own answer before cancelling, so it is never replaced", async () => {
    const session = fakeSessionWithPayloads([turnEndedPayload(100, 80)])
    sessionManager.registerPending(900_000, session, "create_plan_request_response", "question", false, {
      interactionId: 3,
      createPlanBridgeKind: "approve",
      planUri: "file:///tmp/plan.md",
      createPlanQuestion: "Approve?",
    })
    expect(await preparePriorSessionForFreshTurn(session.openCodeSessionId, {
      timeoutMs: 1_000,
      toolResults: [{
        toolCallId: "q",
        sessionId: session.sessionId,
        execId: 900_000,
        toolName: "question",
        output: "User has answered your questions: \"Approve?\"=\"No\". You can now continue with the user's answers in mind.",
      }],
    })).toBe("drained")
    const writes = (session as CursorSession & { _written: Uint8Array[] })._written
    expect(writes).toHaveLength(1)
    const plan = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(plan.error.error).not.toBe(FRESH_TURN_PENDING_CANCEL_REASON)
  })

  it("drainSessionUntilTurnEnded times out when Cursor stays silent", async () => {
    const session = fakeSessionWithPayloads([])
    let resolveNext: ((value: IteratorResult<{ flags: number; payload: Uint8Array }>) => void) | undefined
    session.frames = {
      next: () => new Promise((resolve) => {
        resolveNext = resolve
      }),
    } as never
    const outcome = await drainSessionUntilTurnEnded(session, { timeoutMs: 40 })
    expect(outcome).toBe("timeout")
    expect(session.closed).toBe(false)
    resolveNext?.({ done: true, value: undefined })
    sessionManager.close(session, "ordinary-cleanup")
  })
})

describe("in-session helper catalog isolation", () => {
  it("reconciles a pending plan review before classifying a reduced catalog as a helper", async () => {
    const parent = fakeSessionWithPayloads([turnEndedPayload(100, 80)])
    parent.toolCatalog = ["read", "write", "plan_exit"].map(name => ({ name })) as never
    sessionManager.registerPending(900_000, parent, "create_plan_request_response", "plan_exit", false, {
      interactionId: 7,
      createPlanBridgeKind: "exit",
      planUri: "file:///plans/review.md",
    })
    const incoming = [{ name: "read" }, { name: "write" }]
    const results = [{
      toolCallId: "plan-review",
      sessionId: parent.sessionId,
      execId: 900_000,
      toolName: "plan_exit",
      output: "Plan review complete",
    }]
    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, incoming)).toBe(true)
    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, incoming, [
      { ...results[0]!, sessionId: "another-run" },
    ])).toBe(true)
    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, incoming, results)).toBe(false)

    expect(await preparePriorSessionForFreshTurn(parent.openCodeSessionId, {
      timeoutMs: 1_000,
      toolResults: results,
      hostAgent: "build",
    })).toBe("drained")
    const writes = (parent as CursorSession & { _written: Uint8Array[] })._written
    const reply = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(reply.success).toBeDefined()
    expect(reply.plan_uri).toBe("file:///plans/review.md")
    expect(parent.pending.size).toBe(0)
    expect(parent.closed).toBe(true)
  })

  it("drains past the display close of the delivered call to keep the turn's checkpoint", async () => {
    // Live order after a delivered host result: display close of the same
    // call, checkpoint, turn_ended. Stopping at the close lost the turn.
    const closeDisplay = encodeMessage("AgentServerMessage", {
      interaction_update: {
        tool_call_completed: {
          call_id: "call-plan-review",
          tool_call: { create_plan_tool_call: { args: { name: "Review", plan: "1. A" } } },
        },
      },
    })
    const parent = fakeSessionWithPayloads([closeDisplay, turnEndedPayload(100, 80)])
    sessionManager.registerPending(900_000, parent, "create_plan_request_response", "plan_exit", false, {
      interactionId: 7,
      createPlanBridgeKind: "exit",
      planUri: "file:///plans/review.md",
    })
    expect(await preparePriorSessionForFreshTurn(parent.openCodeSessionId, {
      timeoutMs: 1_000,
      toolResults: [{
        toolCallId: "plan-review",
        sessionId: parent.sessionId,
        execId: 900_000,
        toolName: "plan_exit",
        output: "Plan review complete",
      }],
      hostAgent: "build",
    })).toBe("drained")
    expect(parent.closed).toBe(true)
  })

  it("stops draining as soon as the model answers in the abandoned Run", async () => {
    // Live: a delivered helper result made Cursor write its whole answer in
    // the old Run for ~8 s before the drain gave up; nobody could see it.
    let reads = 0
    const answer = encodeMessage("AgentServerMessage", {
      interaction_update: { text_delta: { text: "Reply continue to run steps 8–10." } },
    })
    const session = fakeSessionWithPayloads([answer, answer, turnEndedPayload(100, 80)])
    const next = session.frames.next.bind(session.frames)
    session.frames = { next: async () => { reads++; return next() } } as never
    expect(await drainSessionUntilTurnEnded(session, { timeoutMs: 1_000 })).toBe("busy")
    expect(reads).toBe(1)
    expect(session.closed).toBe(false)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("stops draining when Cursor starts a new tool", async () => {
    const startDisplay = encodeMessage("AgentServerMessage", {
      interaction_update: {
        tool_call_started: {
          call_id: "call-next",
          tool_call: { create_plan_tool_call: { args: { name: "Next", plan: "1. B" } } },
        },
      },
    })
    const session = fakeSessionWithPayloads([startDisplay, turnEndedPayload(100, 80)])
    expect(await drainSessionUntilTurnEnded(session, { timeoutMs: 1_000 })).toBe("busy")
    expect(session.closed).toBe(false)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("detects a proper catalog subset (67 of 70, missing task/question/plan_exit)", () => {
    const parent = ["bash", "edit", "grep", "plan_exit", "question", "read", "task", "write"].map(
      (name) => ({ name }),
    )
    const helper = parent.filter((tool) => !["plan_exit", "question", "task"].includes(tool.name))
    expect(isProperCatalogSubset(helper, parent)).toBe(true)
    expect(isProperCatalogSubset(parent, parent)).toBe(false)
    expect(isProperCatalogSubset(parent, helper)).toBe(false)
    expect(isProperCatalogSubset([{ name: "other" }], parent)).toBe(false)
    expect(isProperCatalogSubset([], parent)).toBe(false)
  })

  it("isolates when a busy parent Run is open with a larger catalog", () => {
    const parent = fakeSessionWithPayloads([])
    parent.toolCatalog = [
      { name: "bash" },
      { name: "read" },
      { name: "task" },
      { name: "question" },
      { name: "plan_exit" },
      { name: "write" },
    ] as never
    sessionManager.registerPending(37, parent, "mcp_result", "task", false)

    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, [
      { name: "bash" },
      { name: "read" },
      { name: "write" },
    ])).toBe(true)

    // Same-sized catalog is a real fresh turn, not a helper.
    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, parent.toolCatalog!)).toBe(false)
    // Different OpenCode session id is a real child agent, not this path.
    expect(shouldIsolateInSessionHelper("ses_other_child", [
      { name: "bash" },
      { name: "read" },
    ])).toBe(false)

    sessionManager.close(parent, "ordinary-cleanup")
    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, [
      { name: "bash" },
      { name: "read" },
    ])).toBe(false)
  })

  it("does not cancel the parent pending when the helper should be isolated", async () => {
    const parent = fakeSessionWithPayloads([turnEndedPayload(100, 80)])
    parent.toolCatalog = Array.from({ length: 70 }, (_, index) => ({
      name: index === 37 ? "task" : `tool-${index}`,
    })) as NonNullable<CursorSession["toolCatalog"]>
    sessionManager.registerPending(37, parent, "mcp_result", "task", false)

    const helperTools = (parent.toolCatalog ?? []).filter((tool) => tool.name !== "task")
    expect(shouldIsolateInSessionHelper(parent.openCodeSessionId, helperTools)).toBe(true)
    // Isolation skips preparePriorSessionForFreshTurn entirely — parent pending stays.
    expect(parent.pending.size).toBe(1)
    expect(parent.closed).toBe(false)

    // A non-isolated fresh turn still cancels + drains as before.
    expect(await preparePriorSessionForFreshTurn(parent.openCodeSessionId, {
      timeoutMs: 1_000,
    })).toBe("drained")
    expect(parent.pending.size).toBe(0)
    expect(parent.closed).toBe(true)
  })
})
