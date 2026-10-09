import { afterEach, describe, expect, it } from "bun:test"
import { attachSessionHeartbeat } from "../src/language-model.js"
import { sessionManager, type CursorSession } from "../src/session.js"

function heartbeatSession(overrides: Partial<CursorSession> = {}): CursorSession {
  return {
    sessionId: `heartbeat-${Math.random().toString(16).slice(2)}`,
    conversationId: "heartbeat-conversation",
    billing: { key: "run:heartbeat", prefixTokens: 0 },
    stream: {
      write() { return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      onTerminal() { return () => {} },
    } as CursorSession["stream"],
    frames: { next: async () => ({ done: true, value: undefined }) } as CursorSession["frames"],
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    pumpOwner: null,
    heartbeat: null,
    heartbeatCancel: null,
    hardDeadlineTimer: null,
    semanticDeadlineCancel: null,
    terminalUnsubscribe: null,
    deferredTerminalReason: null,
    policy: { heartbeatMs: 20, semanticIdleMs: 1_000, hardCapMs: 2_000 },
    createdAt: Date.now(),
    lastInboundAt: Date.now(),
    lastHeartbeatWriteAt: Date.now(),
    semanticDeadlineAt: Date.now() + 1_000,
    closeError: null,
    closed: false,
    ...overrides,
  }
}

const live: CursorSession[] = []

afterEach(() => {
  for (const session of live.splice(0)) {
    session.heartbeatCancel?.()
    if (!session.closed) sessionManager.close(session, "ordinary-cleanup")
  }
})

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for heartbeat condition")
    await Bun.sleep(10)
  }
}

describe("attachSessionHeartbeat generation guard", () => {
  it("does not close the session when a superseded in-flight heartbeat write fails", async () => {
    let drainReject: ((error: Error) => void) | undefined
    const session = heartbeatSession({
      stream: {
        write() { return false },
        waitForDrain: () => new Promise((_, reject) => {
          drainReject = reject
        }),
        end() {},
        destroy() {},
        isClosed: () => false,
        frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
        onTerminal() { return () => {} },
      } as CursorSession["stream"],
    })
    live.push(session)
    sessionManager.registerSession(session)
    attachSessionHeartbeat(session)

    await waitUntil(() => drainReject !== undefined)
    attachSessionHeartbeat(session)
    drainReject?.(new Error("old stream destroyed"))
    await Bun.sleep(20)

    expect(session.closed).toBe(false)
  })

  it("still closes the session when the current generation's heartbeat write fails", async () => {
    const session = heartbeatSession({
      stream: {
        write() { throw new Error("current heartbeat failed") },
        end() {},
        destroy() {},
        isClosed: () => false,
        frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
        onTerminal() { return () => {} },
      } as CursorSession["stream"],
    })
    live.push(session)
    sessionManager.registerSession(session)
    attachSessionHeartbeat(session)

    await waitUntil(() => session.closed)
  })
})
