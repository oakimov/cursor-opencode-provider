import type { BidiStream } from "./transport/connect.js"
import { trace } from "./transport/connect.js"

export type Frame = { flags: number; payload: Uint8Array }

/**
 * A held-open Run stream. Cursor drives the agentic loop server-side and
 * expects tool results on the SAME bidi stream. opencode, by contrast, owns
 * its tool loop: it calls `doStream`, gets a tool-call, executes it, then calls
 * `doStream` again with the result. We bridge the two by keeping the Run stream
 * (and its single frames iterator) alive in a session across `doStream` calls,
 * keyed by the exec ids we are waiting results for.
 */
export type PendingExec = {
  /** ExecClientMessage result field to reply with (matches the request variant). */
  resultField: string
}

export type CursorSession = {
  stream: BidiStream
  frames: AsyncIterator<Frame>
  pending: Map<number, PendingExec>
  /** KV blob store: blob_id (hex) → data, for Cursor's out-of-band payload channel. */
  blobs: Map<string, Uint8Array>
  /** McpToolDefinition list advertised this turn — echoed into the request_context reply. */
  toolDescriptors: Array<Record<string, unknown>>
  /**
   * False when OpenCode passed no tools (compaction/summary) or toolChoice "none".
   * Cursor may still fire native Grep/etc.; we must refuse those on the Run
   * stream instead of emitting tool-call parts OpenCode will reject.
   */
  allowTools: boolean
  heartbeat: ReturnType<typeof setInterval> | null
  expiresAt: number
}

export class SessionManager {
  private byExecId = new Map<number, CursorSession>()
  private readonly idleTimeoutMs: number

  constructor(idleTimeoutMs = 300_000) {
    this.idleTimeoutMs = idleTimeoutMs
  }

  touch(session: CursorSession): void {
    session.expiresAt = Date.now() + this.idleTimeoutMs
  }

  /** Register that `session` is awaiting a result for `execId`. */
  registerPending(execId: number, session: CursorSession, resultField: string): void {
    session.pending.set(execId, { resultField })
    this.byExecId.set(execId, session)
    this.touch(session)
  }

  /** The pending exec info for an id, if the session is still awaiting it. */
  pendingFor(execId: number): PendingExec | undefined {
    return this.byExecId.get(execId)?.pending.get(execId)
  }

  /** Find the live session awaiting one of the given exec ids. */
  findByExecIds(execIds: number[]): CursorSession | undefined {
    for (const id of execIds) {
      const s = this.byExecId.get(id)
      if (s && Date.now() < s.expiresAt) return s
      if (s) this.close(s)
    }
    return undefined
  }

  /** Mark an exec id as resolved (its result has been delivered). */
  resolve(execId: number): void {
    const s = this.byExecId.get(execId)
    if (s) s.pending.delete(execId)
    this.byExecId.delete(execId)
  }

  close(session: CursorSession): void {
    trace(`sessionManager.close: pending=[${[...session.pending.keys()].join(",")}] blobs=${session.blobs.size}`)
    if (session.heartbeat) clearInterval(session.heartbeat)
    session.heartbeat = null
    session.stream.destroy()
    for (const id of session.pending.keys()) this.byExecId.delete(id)
    session.pending.clear()
  }

  /**
   * Close only if nothing is awaiting a tool result. OpenCode aborts each
   * doStream after finishReason "tool-calls"; that abort must NOT tear down the
   * Cursor Run stream we still need for the continuation write.
   * Returns true if the session was closed.
   */
  closeUnlessPending(session: CursorSession): boolean {
    if (session.pending.size > 0) {
      trace(
        `sessionManager.closeUnlessPending: KEEP open pending=[${[...session.pending.keys()].join(",")}]`,
      )
      return false
    }
    this.close(session)
    return true
  }

  dispose(): void {
    const seen = new Set<CursorSession>()
    for (const s of this.byExecId.values()) {
      if (seen.has(s)) continue
      seen.add(s)
      this.close(s)
    }
    this.byExecId.clear()
  }
}

export const sessionManager = new SessionManager()

function installProcessCleanup(): void {
  const dispose = () => {
    try {
      sessionManager.dispose()
    } catch {
      /* ignore */
    }
  }
  process.once("exit", dispose)
  process.once("beforeExit", dispose)
}

installProcessCleanup()
