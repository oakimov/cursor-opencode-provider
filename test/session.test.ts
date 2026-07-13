import { describe, it, expect } from "bun:test"
import { SessionManager, type CursorSession } from "../src/session.js"

function fakeSession(): CursorSession {
  return {
    stream: { write() {}, end() {}, frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) as any, destroy() {} },
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    allowTools: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

describe("SessionManager", () => {
  it("correlates a pending exec id back to its session with its result field", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(7, s, "read_result")
    expect(mgr.findByExecIds([7])).toBe(s)
    expect(mgr.pendingFor(7)?.resultField).toBe("read_result")
    expect(mgr.findByExecIds([99])).toBeUndefined()
  })

  it("resolves an exec id so it is no longer found", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(7, s, "mcp_result")
    mgr.resolve(7)
    expect(mgr.findByExecIds([7])).toBeUndefined()
    expect(s.pending.has(7)).toBe(false)
  })

  it("supports multiple pending execs on one session", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(1, s, "grep_result")
    mgr.registerPending(2, s, "mcp_result")
    expect(mgr.findByExecIds([2])).toBe(s)
    expect(mgr.pendingFor(2)?.resultField).toBe("mcp_result")
    mgr.resolve(1)
    expect(mgr.findByExecIds([2])).toBe(s)
  })

  it("does not return an expired session", () => {
    const mgr = new SessionManager()
    const s = fakeSession()
    mgr.registerPending(5, s, "read_result")
    s.expiresAt = Date.now() - 1 // registerPending touched it; force-expire
    expect(mgr.findByExecIds([5])).toBeUndefined()
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
    expect(mgr.findByExecIds([0])).toBe(s)
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
    expect(mgr.findByExecIds([0])).toBe(s)
    expect(mgr.pendingFor(0)?.resultField).toBe("grep_result")
    mgr.resolve(0)
    expect(mgr.findByExecIds([0])).toBeUndefined()
    // Now a real close is allowed.
    let destroyed = false
    s.stream.destroy = () => { destroyed = true }
    expect(mgr.closeUnlessPending(s)).toBe(true)
    expect(destroyed).toBe(true)
  })
})
