import type { BidiStream } from "./transport/connect.js"
import { trace } from "./debug.js"

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
  /**
   * Resolved opencode tool name (read/write/grep/…). Used on continuation so
   * mcp_result can unwrap read envelopes even if the prompt omits toolName.
   */
  toolName?: string
}

export type CursorSession = {
  /**
   * Stable per-Run-stream id (distinct from Cursor's own conversation_id).
   * Tags toolCallIds so two concurrent Run streams with overlapping exec ids
   * (Cursor resets them per stream) can't cross-deliver results.
   */
  sessionId: string
  /**
   * Cursor conversation_id for this Run — used to store/echo
   * conversation_checkpoint_update (CLI parity).
   */
  conversationId: string
  stream: BidiStream
  frames: AsyncIterator<Frame>
  pending: Map<number, PendingExec>
  /** KV blob store: blob_id (hex) → data, for Cursor's out-of-band payload channel. */
  blobs: Map<string, Uint8Array>
  /** McpToolDefinition list advertised this turn — echoed into the request_context reply. */
  toolDescriptors: Array<Record<string, unknown>>
  /** Full RequestContext for exec #10 replies. */
  requestContext: Record<string, unknown>
  /**
   * False when OpenCode passed no tools (compaction/summary) or toolChoice "none".
   * Cursor may still fire native Grep/etc.; we must refuse those on the Run
   * stream instead of emitting tool-call parts OpenCode will reject.
   */
  allowTools: boolean
  /**
   * True while a doStream pull() is actively reading this session's frames.
   * Prevents a late cancel/abort from a prior ReadableStream from destroying
   * the Run connection after tool results were delivered (pending cleared) but
   * Cursor is still generating.
   */
  pumpActive: boolean
  heartbeat: ReturnType<typeof setInterval> | null
  expiresAt: number
}

export class SessionManager {
  // Composite key `${sessionId}:${execId}` → owning session. Composite keying
  // means two Run streams that both register an execId of 1 (Cursor resets
  // counters per stream) coexist instead of overwriting each other.
  private byExecId = new Map<string, CursorSession>()
  private readonly idleTimeoutMs: number

  constructor(idleTimeoutMs = 300_000) {
    this.idleTimeoutMs = idleTimeoutMs
  }

  touch(session: CursorSession): void {
    session.expiresAt = Date.now() + this.idleTimeoutMs
  }

  /** Register that `session` is awaiting a result for `execId`. */
  registerPending(
    execId: number,
    session: CursorSession,
    resultField: string,
    toolName?: string,
  ): void {
    session.pending.set(execId, { resultField, toolName })
    this.byExecId.set(this.key(session.sessionId, execId), session)
    this.touch(session)
  }

  /** The pending exec info for an id on a specific session, if still awaiting it. */
  pendingFor(sessionId: string, execId: number): PendingExec | undefined {
    return this.byExecId.get(this.key(sessionId, execId))?.pending.get(execId)
  }

  /** Find the live session awaiting one of the given exec ids. */
  findByExecIds(sessionId: string, execIds: number[]): CursorSession | undefined {
    for (const id of execIds) {
      const s = this.byExecId.get(this.key(sessionId, id))
      if (s && Date.now() < s.expiresAt) return s
      if (s) this.close(s)
    }
    return undefined
  }

  /** Mark an exec id as resolved (its result has been delivered). */
  resolve(sessionId: string, execId: number): void {
    const k = this.key(sessionId, execId)
    const s = this.byExecId.get(k)
    if (s) s.pending.delete(execId)
    this.byExecId.delete(k)
  }

  private key(sessionId: string, execId: number): string {
    return `${sessionId}:${execId}`
  }

  close(session: CursorSession): void {
    trace(`sessionManager.close: pending=[${[...session.pending.keys()].join(",")}] blobs=${session.blobs.size}`)
    if (session.heartbeat) clearInterval(session.heartbeat)
    session.heartbeat = null
    session.stream.destroy()
    for (const id of session.pending.keys()) this.byExecId.delete(this.key(session.sessionId, id))
    session.pending.clear()
  }

  /**
   * Close only if nothing is awaiting a tool result AND no pull() is actively
   * pumping this session. OpenCode aborts each doStream after finishReason
   * "tool-calls"; that abort must NOT tear down the Cursor Run stream.
   * Equally, a late cancel from the previous ReadableStream must not destroy
   * the session once the continuation has cleared pending and resumed pumping.
   * Returns true if the session was closed.
   */
  closeUnlessPending(session: CursorSession): boolean {
    if (session.pending.size > 0 || session.pumpActive) {
      trace(
        `sessionManager.closeUnlessPending: KEEP open pending=[${[...session.pending.keys()].join(",")}] pumpActive=${session.pumpActive}`,
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