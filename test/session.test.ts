import { describe, it, expect } from "bun:test"
import { SessionManager, type CursorSession } from "../src/session.js"

let _seq = 0
function fakeSession(): CursorSession {
  return {
    sessionId: `sess_test_${++_seq}`,
    conversationId: `conv_test_${_seq}`,
    stream: { write() {}, end() {}, frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) as any, destroy() {}, isClosed: () => false },
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: false,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

describe("SessionManager", () => {
  it("correlates a pending exec id back to its session with its result field", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(7, s, "read_result")
    expect(mgr.findByExecIds(s.sessionId, [7])).toBe(s)
    expect(mgr.pendingFor(s.sessionId, 7)?.resultField).toBe("read_result")
    expect(mgr.findByExecIds(s.sessionId, [99])).toBeUndefined()
  })

  it("stores optional toolName on pending for continuation unwrap gating", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(3, s, "mcp_result", "read")
    expect(mgr.pendingFor(s.sessionId, 3)).toMatchObject({
      resultField: "mcp_result",
      toolName: "read",
      bridged: false,
      state: "pending",
    })
  })

  it("marks bridged pending entries so continuation skips Cursor exec writes", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(900_001, s, "bridged", "todowrite", true)
    expect(mgr.pendingFor(s.sessionId, 900_001)).toMatchObject({
      resultField: "bridged",
      toolName: "todowrite",
      bridged: true,
      state: "pending",
    })
    expect(mgr.findByExecIds(s.sessionId, [900_001])).toBe(s)
  })

  it("resolves an exec id so it is no longer found", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(7, s, "mcp_result")
    mgr.resolve(s.sessionId, 7)
    expect(mgr.findByExecIds(s.sessionId, [7])).toBeUndefined()
    expect(s.pending.has(7)).toBe(false)
  })

  it("supports multiple pending execs on one session", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(1, s, "grep_result")
    mgr.registerPending(2, s, "mcp_result")
    expect(mgr.findByExecIds(s.sessionId, [2])).toBe(s)
    expect(mgr.pendingFor(s.sessionId, 2)?.resultField).toBe("mcp_result")
    mgr.resolve(s.sessionId, 1)
    expect(mgr.findByExecIds(s.sessionId, [2])).toBe(s)
  })

  it("claims and delivers each continuation result at most once", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    const writes: Uint8Array[] = []
    s.stream.write = (frame) => { writes.push(frame) }
    mgr.registerPending(7, s, "read_result")

    const claim = mgr.claim(s.sessionId, 7)
    expect("kind" in claim).toBe(false)
    expect(mgr.claim(s.sessionId, 7)).toMatchObject({ kind: "duplicate", reason: "in-flight" })
    if ("kind" in claim) throw new Error("expected continuation claim")
    expect(mgr.deliverClaim(claim, [Uint8Array.of(1)])).toEqual({
      kind: "delivered",
      framesWritten: 1,
    })
    expect(writes).toHaveLength(1)
    expect(mgr.classify(s.sessionId, 7)).toMatchObject({ kind: "duplicate", reason: "delivered" })
  })

  it("marks a partially written result terminal instead of replaying it", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    let writes = 0
    s.stream.write = () => {
      writes++
      if (writes === 2) throw new Error("closed")
    }
    mgr.registerPending(8, s, "mcp_result")
    const claim = mgr.claim(s.sessionId, 8)
    if ("kind" in claim) throw new Error("expected continuation claim")

    expect(mgr.deliverClaim(claim, [Uint8Array.of(1), Uint8Array.of(2)])).toEqual({
      kind: "terminal",
      reason: "ambiguous-partial-write",
      framesWritten: 1,
    })
    expect(mgr.classify(s.sessionId, 8)).toMatchObject({
      kind: "terminal",
      reason: "ambiguous-partial-write",
    })
  })

  it("renews a pending-tool inactivity lease from descendant session activity", () => {
    let now = 0
    let activityAt: number | undefined
    const mgr = new SessionManager({
      now: () => now,
      activitySource: { lastActivityAt: () => activityAt },
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })
    const s = fakeSession()
    s.openCodeSessionId = "parent"
    s.policy = { heartbeatMs: 10, semanticIdleMs: 50, hardCapMs: 100 }
    mgr.registerPending(9, s, "read_result")

    activityAt = 80
    now = 110
    mgr.sweepHardDeadlines()
    expect(s.closed).toBe(false)

    now = 181
    mgr.sweepHardDeadlines()
    expect(s.closed).toBe(true)
    expect(mgr.classify(s.sessionId, 9)).toMatchObject({
      kind: "terminal",
      reason: "hard-cap-expired",
    })
  })

  it("does not return an expired session", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(5, s, "read_result")
    s.expiresAt = Date.now() - 1 // registerPending touched it; force-expire
    expect(mgr.findByExecIds(s.sessionId, [5])).toBeUndefined()
  })

  it("does not return a remotely closed session", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(5, s, "read_result")
    s.stream.isClosed = () => true
    expect(mgr.findByExecIds(s.sessionId, [5])).toBeUndefined()
    expect(s.pending.size).toBe(0)
  })

  it("two sessions with the same execId are not conflated", () => {
    // Regression: Cursor resets exec ids per Run stream; concurrent
    // conversations must not overwrite each other in the byExecId map.
    const mgr = new SessionManager()
    const sA = fakeSession()
    const sB = fakeSession()
    mgr.registerPending(1, sA, "read_result")
    mgr.registerPending(1, sB, "mcp_result")
    expect(mgr.findByExecIds(sA.sessionId, [1])).toBe(sA)
    expect(mgr.findByExecIds(sB.sessionId, [1])).toBe(sB)
    expect(mgr.pendingFor(sA.sessionId, 1)?.resultField).toBe("read_result")
    expect(mgr.pendingFor(sB.sessionId, 1)?.resultField).toBe("mcp_result")
  })

  it("closes sessions and clears heartbeat on dispose", () => {
    const mgr = new SessionManager()
    let destroyed = false
    const s = fakeSession()
    s.stream.destroy = () => { destroyed = true }
    mgr.registerPending(1, s, "read_result")
    mgr.dispose()
    expect(destroyed).toBe(true)
  })

  it("closeUnlessPending keeps the session when execs are awaiting results", () => {
    // Live failure: OpenCode aborts doStream after tool-calls; closing then
    // caused "TOOL LOOP BROKEN" because findByExecIds could not find the session.
    const mgr = new SessionManager()
    let destroyed = false
    const s = fakeSession()
    s.stream.destroy = () => { destroyed = true }
    mgr.registerPending(0, s, "grep_result")
    expect(mgr.closeUnlessPending(s)).toBe(false)
    expect(destroyed).toBe(false)
    expect(mgr.findByExecIds(s.sessionId, [0])).toBe(s)
  })

  it("closeUnlessPending keeps the session while pumpActive even with empty pending", () => {
    // Regression: after tool results are written, pending is empty but Cursor is
    // still generating. A late cancel from the prior ReadableStream must not
    // destroy the Run stream the continuation is pumping.
    const mgr = new SessionManager()
    const s = fakeSession()
    let destroyed = false
    s.stream.destroy = () => { destroyed = true }
    s.pumpActive = true
    expect(mgr.closeUnlessPending(s)).toBe(false)
    expect(destroyed).toBe(false)
    s.pumpActive = false
    expect(mgr.closeUnlessPending(s)).toBe(true)
    expect(destroyed).toBe(true)
  })

  it("closeUnlessPending destroys when nothing is pending", () => {
    const mgr = new SessionManager()
    let destroyed = false
    const s = fakeSession()
    s.stream.destroy = () => { destroyed = true }
    expect(mgr.closeUnlessPending(s)).toBe(true)
    expect(destroyed).toBe(true)
  })

  it("after abort-style closeUnlessPending, resolve still works on continuation", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(0, s, "grep_result")
    mgr.closeUnlessPending(s) // simulate OpenCode abort after tool-calls
    expect(mgr.findByExecIds(s.sessionId, [0])).toBe(s)
    expect(mgr.pendingFor(s.sessionId, 0)?.resultField).toBe("grep_result")
    mgr.resolve(s.sessionId, 0)
    expect(mgr.findByExecIds(s.sessionId, [0])).toBeUndefined()
    // Now a real close is allowed.
    let destroyed = false
    s.stream.destroy = () => { destroyed = true }
    expect(mgr.closeUnlessPending(s)).toBe(true)
    expect(destroyed).toBe(true)
  })

  it("supersedes a stale open session when a new Run registers for the same OpenCode session", () => {
    // A caller that abandons a Run and retries with a fresh one (instead of
    // delivering a continuation to the held-open Run) must not leak the old
    // Run's stream indefinitely.
    const mgr = new SessionManager()
    const a = fakeSession()
    a.openCodeSessionId = "opencode-session-1"
    let destroyed = false
    a.stream.destroy = () => { destroyed = true }
    mgr.registerPending(0, a, "grep_result")

    const b = fakeSession()
    b.openCodeSessionId = "opencode-session-1"
    mgr.registerSession(b)

    expect(a.closed).toBe(true)
    expect(destroyed).toBe(true)
    expect(mgr.classify(a.sessionId, 0)).toMatchObject({
      kind: "terminal",
      reason: "superseded-by-new-run",
    })
    expect(b.closed).toBe(false)
  })

  it("does not interrupt a still-pumping prior session on supersede", () => {
    // Regression: forcing close() on a session with a live pull() mid-await
    // (nextFrameWithSemanticDeadline) rejects that await and propagates a
    // real error to whatever still holds the ReadableStream — the opposite
    // of what superseding a truly stale session is supposed to do.
    const mgr = new SessionManager()
    const a = fakeSession()
    a.openCodeSessionId = "opencode-session-1"
    let destroyed = false
    a.stream.destroy = () => { destroyed = true }
    mgr.registerPending(0, a, "grep_result")
    a.pumpActive = true

    const b = fakeSession()
    b.openCodeSessionId = "opencode-session-1"
    mgr.registerSession(b)

    expect(a.closed).toBe(false)
    expect(destroyed).toBe(false)
    expect(mgr.findByExecIds(a.sessionId, [0])).toBe(a)
    expect(b.closed).toBe(false)
  })

  it("does not double-close an already-closed prior session on re-registration", () => {
    const mgr = new SessionManager()
    const a = fakeSession()
    a.openCodeSessionId = "opencode-session-1"
    mgr.registerSession(a)
    mgr.close(a, "ordinary-cleanup")

    const b = fakeSession()
    b.openCodeSessionId = "opencode-session-1"
    expect(() => mgr.registerSession(b)).not.toThrow()
    expect(b.closed).toBe(false)
  })

  it("does not supersede sessions across different OpenCode sessions", () => {
    const mgr = new SessionManager()
    const a = fakeSession()
    a.openCodeSessionId = "opencode-session-1"
    const b = fakeSession()
    b.openCodeSessionId = "opencode-session-2"
    mgr.registerSession(a)
    mgr.registerSession(b)
    expect(a.closed).toBe(false)
    expect(b.closed).toBe(false)
  })

  it("does not supersede sessions without an openCodeSessionId", () => {
    const mgr = new SessionManager()
    const a = fakeSession()
    const b = fakeSession()
    mgr.registerSession(a)
    mgr.registerSession(b)
    expect(a.closed).toBe(false)
    expect(b.closed).toBe(false)
  })

  it("force-closes the oldest session once the open-session cap is exceeded", () => {
    let now = 0
    const mgr = new SessionManager({ now: () => now, maxOpenSessions: 2 })
    const a = fakeSession()
    a.openCodeSessionId = "s1"
    now = 10
    mgr.registerPending(0, a, "read_result")

    const b = fakeSession()
    b.openCodeSessionId = "s2"
    now = 20
    mgr.registerSession(b)

    const c = fakeSession()
    c.openCodeSessionId = "s3"
    now = 30
    mgr.registerSession(c)

    expect(a.closed).toBe(true)
    expect(mgr.classify(a.sessionId, 0)).toMatchObject({
      kind: "terminal",
      reason: "open-session-cap-exceeded",
    })
    expect(b.closed).toBe(false)
    expect(c.closed).toBe(false)
  })

  it("skips a still-pumping session when choosing which one the cap evicts", () => {
    let now = 0
    const mgr = new SessionManager({ now: () => now, maxOpenSessions: 2 })
    const a = fakeSession()
    a.openCodeSessionId = "s1"
    now = 10
    mgr.registerPending(0, a, "read_result")
    a.pumpActive = true // oldest, but actively pumping — must not be evicted

    const b = fakeSession()
    b.openCodeSessionId = "s2"
    now = 20
    mgr.registerPending(0, b, "read_result")

    const c = fakeSession()
    c.openCodeSessionId = "s3"
    now = 30
    mgr.registerSession(c)

    expect(a.closed).toBe(false)
    expect(b.closed).toBe(true)
    expect(mgr.classify(b.sessionId, 0)).toMatchObject({
      kind: "terminal",
      reason: "open-session-cap-exceeded",
    })
    expect(c.closed).toBe(false)
  })
})