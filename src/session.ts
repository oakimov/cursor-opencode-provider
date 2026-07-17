import type { BidiStream, BidiTerminalEvent } from "./transport/connect.js"
import { trace } from "./debug.js"
import { CursorProtocolError, type CursorProviderError } from "./errors.js"
import { sessionActivity, type SessionActivitySource } from "./activity.js"

export type Frame = { flags: number; payload: Uint8Array }

export type CursorContinuationOptions = {
  semanticIdleMs?: number
  /** @deprecated Use semanticIdleMs. Kept as a strict alias for compatibility. */
  softHealthMs?: number
  /** Pending-tool inactivity window, renewed by OpenCode session progress. */
  hardCapMs?: number
  heartbeatMs?: number
}

export type CursorContinuationPolicy = {
  semanticIdleMs: number
  hardCapMs: number
  heartbeatMs: number
}

export const DEFAULT_CONTINUATION_POLICY: Readonly<CursorContinuationPolicy> = {
  semanticIdleMs: 120_000,
  hardCapMs: 600_000,
  heartbeatMs: 5_000,
}

const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_TOMBSTONE_TTL_MS = 15 * 60_000
const DEFAULT_TOMBSTONE_LIMIT = 1_024

function positiveInteger(name: string, value: unknown, fallback: number): number {
  const resolved = value === undefined ? fallback : value
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > MAX_TIMER_MS
  ) {
    throw new CursorProtocolError(
      `Cursor continuation ${name} must be a positive integer no greater than ${MAX_TIMER_MS}`,
    )
  }
  return resolved
}

export function resolveContinuationPolicy(
  options: CursorContinuationOptions | undefined,
): CursorContinuationPolicy {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new CursorProtocolError("Cursor continuation options must be an object")
  }
  for (const key of Object.keys(options ?? {})) {
    if (!["heartbeatMs", "semanticIdleMs", "softHealthMs", "hardCapMs"].includes(key)) {
      throw new CursorProtocolError(`Unknown Cursor continuation option: ${key}`)
    }
  }
  if (
    options?.semanticIdleMs !== undefined &&
    options.softHealthMs !== undefined &&
    options.semanticIdleMs !== options.softHealthMs
  ) {
    throw new CursorProtocolError(
      "Cursor continuation semanticIdleMs and deprecated softHealthMs must match when both are set",
    )
  }
  const heartbeatMs = positiveInteger(
    "heartbeatMs",
    options?.heartbeatMs,
    DEFAULT_CONTINUATION_POLICY.heartbeatMs,
  )
  const semanticIdleMs = positiveInteger(
    "semanticIdleMs",
    options?.semanticIdleMs ?? options?.softHealthMs,
    DEFAULT_CONTINUATION_POLICY.semanticIdleMs,
  )
  const hardCapMs = positiveInteger(
    "hardCapMs",
    options?.hardCapMs,
    DEFAULT_CONTINUATION_POLICY.hardCapMs,
  )
  if (heartbeatMs >= semanticIdleMs) {
    throw new CursorProtocolError("Cursor continuation heartbeatMs must be less than semanticIdleMs")
  }
  if (semanticIdleMs > hardCapMs) {
    throw new CursorProtocolError("Cursor continuation semanticIdleMs must be no greater than hardCapMs")
  }
  return { heartbeatMs, semanticIdleMs, hardCapMs }
}

export type PendingExecState = "pending" | "claimed" | "delivered"

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
  state: PendingExecState
  registeredAt: number
  hardDeadlineAt: number
  /**
   * Resolved opencode tool name (read/write/grep/…). Used on continuation so
   * mcp_result can unwrap read envelopes even if the prompt omits toolName.
   */
  toolName?: string
  /** Original request fields required by a typed result message. */
  resultMetadata?: Record<string, unknown>
  /**
   * True when this pending entry was synthesized from a Cursor display-only
   * tool_call_* frame (no ExecServerMessage). Continuation must not write an
   * exec result back to Cursor — just clear pending and keep pumping.
   */
  bridged?: boolean
}

export type ContinuationTerminalReason =
  | "hard-cap-expired"
  | "remote-clean-close"
  | "remote-error"
  | "result-write-failed"
  | "ambiguous-partial-write"
  | "heartbeat-write-failed"
  | "reply-write-failed"
  | "process-disposed"

export type SessionCloseReason =
  | ContinuationTerminalReason
  | "ordinary-cleanup"
  | "turn-ended"
  | "initial-write-failed"

export type ContinuationClaim = {
  session: CursorSession
  execId: number
  pending: PendingExec
}

export type ContinuationClassification =
  | { kind: "deliverable"; session: CursorSession; pending: PendingExec }
  | { kind: "duplicate"; reason: "in-flight" | "delivered" }
  | { kind: "terminal"; reason: ContinuationTerminalReason }
  | { kind: "missing"; reason: "missing-process-local-state" }

export type DeliveryOutcome =
  | { kind: "delivered"; framesWritten: number }
  | { kind: "duplicate"; reason: "in-flight" | "delivered"; framesWritten: 0 }
  | { kind: "terminal"; reason: ContinuationTerminalReason; framesWritten: number }
  | { kind: "missing"; reason: "missing-process-local-state"; framesWritten: 0 }

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
  /** OpenCode session whose own or descendant activity renews tool leases. */
  openCodeSessionId?: string
  stream: BidiStream
  frames: AsyncIterator<Frame>
  pending: Map<number, PendingExec>
  /**
   * Cursor display tool calls (tool_call_started) awaiting either an exec or a
   * tool_call_completed. Keyed by call_id. Cleared when exec handles the call
   * or when we bridge the completed display call into an OpenCode tool-call.
   */
  displayToolCalls: Map<string, Record<string, unknown>>
  /** Monotonic synthetic exec ids for bridged (display-only) OpenCode tool calls. */
  nextBridgedExecId: number
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
   * Best-effort token usage for this held-open Run. Updated from text/tool
   * activity and replaced by TurnEnded when the turn completes. Emitted on
   * tool-calls finishes so OpenCode does not store all-zero usage mid-loop.
   */
  usageEstimate: {
    inputTokens: number
    outputTokens: number
    cacheRead: number
    cacheWrite: number
  }
  /**
   * True while a doStream pull() is actively reading this session's frames.
   * Prevents a late cancel/abort from a prior ReadableStream from destroying
   * the Run connection after tool results were delivered (pending cleared) but
   * Cursor is still generating.
  */
  pumpActive: boolean
  /** The active pull owner; stale cancel callbacks cannot affect a newer pump. */
  pumpOwner: symbol | null
  heartbeat: ReturnType<typeof setInterval> | null
  heartbeatCancel: (() => void) | null
  hardDeadlineTimer: ReturnType<typeof setTimeout> | null
  semanticDeadlineCancel: (() => void) | null
  terminalUnsubscribe: (() => void) | null
  deferredTerminalReason: "remote-clean-close" | "remote-error" | null
  policy: CursorContinuationPolicy
  createdAt: number
  lastInboundAt: number
  lastHeartbeatWriteAt: number
  semanticDeadlineAt: number
  closeError: CursorProviderError | null
  closed: boolean
}

type Tombstone = {
  reason: ContinuationTerminalReason | "delivered"
  expiresAt: number
}

type SessionManagerOptions = {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  activitySource?: SessionActivitySource
  tombstoneTtlMs?: number
  tombstoneLimit?: number
}

export class SessionManager {
  // Composite key `${sessionId}:${execId}` → owning session. Composite keying
  // means two Run streams that both register an execId of 1 (Cursor resets
  // counters per stream) coexist instead of overwriting each other.
  private byExecId = new Map<string, CursorSession>()
  private sessions = new Set<CursorSession>()
  private tombstones = new Map<string, Tombstone>()
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly activitySource: SessionActivitySource
  private readonly tombstoneTtlMs: number
  private readonly tombstoneLimit: number

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.activitySource = options.activitySource ?? sessionActivity
    this.tombstoneTtlMs = positiveInteger(
      "tombstoneTtlMs",
      options.tombstoneTtlMs,
      DEFAULT_TOMBSTONE_TTL_MS,
    )
    this.tombstoneLimit = positiveInteger(
      "tombstoneLimit",
      options.tombstoneLimit,
      DEFAULT_TOMBSTONE_LIMIT,
    )
  }

  registerSession(session: CursorSession): void {
    if (session.closed) throw new CursorProtocolError("Cannot register a closed Cursor session")
    if (this.sessions.has(session)) return
    session.closed ??= false
    session.closeError ??= null
    session.pumpOwner ??= null
    session.heartbeatCancel ??= null
    session.hardDeadlineTimer ??= null
    session.semanticDeadlineCancel ??= null
    session.terminalUnsubscribe ??= null
    session.deferredTerminalReason ??= null
    session.policy ??= { ...DEFAULT_CONTINUATION_POLICY }
    session.createdAt ??= this.now()
    session.lastInboundAt ??= this.now()
    session.lastHeartbeatWriteAt ??= this.now()
    session.semanticDeadlineAt ??= this.now() + session.policy.semanticIdleMs
    this.sessions.add(session)
    const unsubscribe = session.stream.onTerminal?.(
      (event) => this.onStreamTerminal(session, event),
    ) ?? (() => {})
    if (session.closed) unsubscribe()
    else session.terminalUnsubscribe = unsubscribe
  }

  recordSemanticProgress(session: CursorSession, at?: number): void {
    if (session.closed) return
    const now = at ?? this.now()
    session.lastInboundAt = now
    session.semanticDeadlineAt = now + session.policy.semanticIdleMs
  }

  recordHeartbeatWrite(session: CursorSession): void {
    if (!session.closed) session.lastHeartbeatWriteAt = this.now()
  }

  /** Register that `session` is awaiting a result for `execId`. */
  registerPending(
    execId: number,
    session: CursorSession,
    resultField: string,
    toolName?: string,
    bridged = false,
    resultMetadata?: Record<string, unknown>,
  ): void {
    this.registerSession(session)
    if (session.closed) throw new CursorProtocolError("Cannot register a pending exec on a closed Cursor session")
    const now = this.now()
    const key = this.key(session.sessionId, execId)
    this.tombstones.delete(key)
    session.pending.set(execId, {
      resultField,
      toolName,
      bridged,
      resultMetadata,
      state: "pending",
      registeredAt: now,
      hardDeadlineAt: now + session.policy.hardCapMs,
    })
    this.byExecId.set(key, session)
    this.scheduleHardDeadline(session)
  }

  /** The pending exec info for an id on a specific session, if still awaiting it. */
  pendingFor(sessionId: string, execId: number): PendingExec | undefined {
    return this.byExecId.get(this.key(sessionId, execId))?.pending.get(execId)
  }

  classify(sessionId: string, execId: number): ContinuationClassification {
    const key = this.key(sessionId, execId)
    const session = this.byExecId.get(key)
    if (session) {
      const pending = session.pending.get(execId)
      const legacyExpiresAt = (session as CursorSession & { expiresAt?: number }).expiresAt
      if (
        !pending ||
        session.closed ||
        session.stream.isClosed() ||
        (typeof legacyExpiresAt === "number" && this.now() >= legacyExpiresAt)
      ) {
        this.byExecId.delete(key)
        if (!session.closed) this.close(session, "remote-clean-close")
      } else if (this.hardDeadlineExpired(session, pending)) {
        this.close(session, "hard-cap-expired")
      } else if (pending.state === "pending") {
        return { kind: "deliverable", session, pending }
      } else if (pending.state === "claimed") {
        return { kind: "duplicate", reason: "in-flight" }
      } else {
        return { kind: "duplicate", reason: "delivered" }
      }
    }

    const tombstone = this.getTombstone(key)
    if (!tombstone) return { kind: "missing", reason: "missing-process-local-state" }
    if (tombstone.reason === "delivered") return { kind: "duplicate", reason: "delivered" }
    return { kind: "terminal", reason: tombstone.reason }
  }

  claim(sessionId: string, execId: number): ContinuationClaim | ContinuationClassification {
    const classification = this.classify(sessionId, execId)
    if (classification.kind !== "deliverable") return classification
    classification.pending.state = "claimed"
    return {
      session: classification.session,
      execId,
      pending: classification.pending,
    }
  }

  deliverClaim(claim: ContinuationClaim, frames: readonly Uint8Array[]): DeliveryOutcome {
    const { session, execId, pending } = claim
    const key = this.key(session.sessionId, execId)
    if (
      session.closed ||
      this.byExecId.get(key) !== session ||
      session.pending.get(execId) !== pending
    ) {
      const current = this.classify(session.sessionId, execId)
      if (current.kind === "duplicate") return { ...current, framesWritten: 0 }
      if (current.kind === "terminal") return { ...current, framesWritten: 0 }
      return { kind: "missing", reason: "missing-process-local-state", framesWritten: 0 }
    }
    if (pending.state !== "claimed") {
      return {
        kind: "duplicate",
        reason: pending.state === "delivered" ? "delivered" : "in-flight",
        framesWritten: 0,
      }
    }
    if (this.hardDeadlineExpired(session, pending)) {
      this.close(session, "hard-cap-expired")
      return { kind: "terminal", reason: "hard-cap-expired", framesWritten: 0 }
    }

    let framesWritten = 0
    try {
      if (!pending.bridged && frames.length === 0) {
        throw new CursorProtocolError("No result frames were produced")
      }
      for (const frame of frames) {
        session.stream.write(frame)
        framesWritten++
      }
    } catch {
      const reason: ContinuationTerminalReason =
        framesWritten === 0 ? "result-write-failed" : "ambiguous-partial-write"
      this.close(session, reason)
      return { kind: "terminal", reason, framesWritten }
    }

    pending.state = "delivered"
    this.putTombstone(key, "delivered")
    session.pending.delete(execId)
    this.byExecId.delete(key)
    if (session.pending.size === 0) this.recordSemanticProgress(session)
    this.scheduleHardDeadline(session)
    return { kind: "delivered", framesWritten }
  }

  /** Find the live session awaiting one of the given exec ids. */
  findByExecIds(sessionId: string, execIds: number[]): CursorSession | undefined {
    for (const id of execIds) {
      const classification = this.classify(sessionId, id)
      if (classification.kind === "deliverable") return classification.session
    }
    return undefined
  }

  /** Mark an exec id as resolved (its result has been delivered). */
  resolve(sessionId: string, execId: number): void {
    const k = this.key(sessionId, execId)
    const s = this.byExecId.get(k)
    if (s) {
      s.pending.delete(execId)
      this.putTombstone(k, "delivered")
      this.scheduleHardDeadline(s)
    }
    this.byExecId.delete(k)
  }

  beginPump(session: CursorSession, owner: symbol): void {
    this.registerSession(session)
    if (session.pumpOwner && session.pumpOwner !== owner) {
      throw new CursorProtocolError("Cursor session already has an active pump")
    }
    session.pumpOwner = owner
    session.pumpActive = true
  }

  isPumpOwner(session: CursorSession, owner: symbol): boolean {
    return !session.closed && session.pumpOwner === owner
  }

  endPump(session: CursorSession, owner: symbol): boolean {
    if (session.pumpOwner !== owner) return false
    session.pumpOwner = null
    session.pumpActive = false
    const deferred = session.deferredTerminalReason
    session.deferredTerminalReason = null
    if (deferred) this.close(session, deferred)
    return true
  }

  private key(sessionId: string, execId: number): string {
    return `${sessionId}:${execId}`
  }

  close(
    session: CursorSession,
    reason: SessionCloseReason = "ordinary-cleanup",
    error?: CursorProviderError,
  ): void {
    if (session.closed) return
    session.closed = true
    session.closeError = error ?? session.closeError ?? null
    trace(`sessionManager.close: reason=${reason} pendingCount=${session.pending.size} blobs=${session.blobs.size}`)
    if (session.heartbeatCancel) session.heartbeatCancel()
    else if (session.heartbeat) clearInterval(session.heartbeat)
    session.heartbeat = null
    session.heartbeatCancel = null
    if (session.hardDeadlineTimer) this.clearTimer(session.hardDeadlineTimer)
    session.hardDeadlineTimer = null
    session.semanticDeadlineCancel?.()
    session.semanticDeadlineCancel = null
    session.terminalUnsubscribe?.()
    session.terminalUnsubscribe = null
    session.deferredTerminalReason = null
    for (const id of session.pending.keys()) {
      const key = this.key(session.sessionId, id)
      this.byExecId.delete(key)
      if (this.isTerminalReason(reason)) this.putTombstone(key, reason)
    }
    session.pending.clear()
    session.pumpOwner = null
    session.pumpActive = false
    session.displayToolCalls?.clear()
    session.blobs?.clear()
    this.sessions.delete(session)
    try { session.stream.destroy() } catch { /* already closed */ }
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
    if (session.closed) return true
    const pumpActive = session.pumpOwner != null || session.pumpActive
    if (session.pending.size > 0 || pumpActive) {
      trace(
        `sessionManager.closeUnlessPending: KEEP open pendingCount=${session.pending.size} pumpActive=${pumpActive}`,
      )
      return false
    }
    this.close(session, "ordinary-cleanup")
    return true
  }

  dispose(): void {
    for (const session of [...this.sessions]) this.close(session, "process-disposed")
    this.byExecId.clear()
  }

  sweepHardDeadlines(): void {
    for (const session of [...this.sessions]) {
      if (
        !session.closed &&
        [...session.pending.values()].some((pending) => this.hardDeadlineExpired(session, pending))
      ) {
        this.close(session, "hard-cap-expired")
      }
    }
  }

  private onStreamTerminal(session: CursorSession, event: BidiTerminalEvent): void {
    if (event.kind === "local-close" || session.closed) return
    const reason = event.kind === "remote-error" ? "remote-error" : "remote-clean-close"
    if (event.kind === "remote-error") session.closeError = event.error
    if (session.pumpOwner !== null) {
      session.deferredTerminalReason = reason
      return
    }
    this.close(session, reason, event.kind === "remote-error" ? event.error : undefined)
  }

  private refreshHardDeadline(session: CursorSession, pending: PendingExec): number {
    if (!session.openCodeSessionId) return pending.hardDeadlineAt
    const activityAt = this.activitySource.lastActivityAt(session.openCodeSessionId)
    if (activityAt === undefined || activityAt <= pending.registeredAt) return pending.hardDeadlineAt
    const renewedDeadline = activityAt + session.policy.hardCapMs
    if (renewedDeadline > pending.hardDeadlineAt) {
      pending.hardDeadlineAt = renewedDeadline
      trace("continuation lease renewed from OpenCode session activity")
    }
    return pending.hardDeadlineAt
  }

  private hardDeadlineExpired(session: CursorSession, pending: PendingExec): boolean {
    return this.now() >= this.refreshHardDeadline(session, pending)
  }

  private scheduleHardDeadline(session: CursorSession): void {
    if (session.hardDeadlineTimer) this.clearTimer(session.hardDeadlineTimer)
    session.hardDeadlineTimer = null
    if (session.closed || session.pending.size === 0) return
    const earliest = Math.min(
      ...[...session.pending.values()].map((pending) => this.refreshHardDeadline(session, pending)),
    )
    const delayMs = Math.max(0, earliest - this.now())
    const timer = this.setTimer(() => {
      session.hardDeadlineTimer = null
      if (session.closed) return
      if (
        [...session.pending.values()].some((pending) => this.hardDeadlineExpired(session, pending))
      ) {
        this.close(session, "hard-cap-expired")
      } else {
        this.scheduleHardDeadline(session)
      }
    }, delayMs)
    session.hardDeadlineTimer = timer
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === "function") unref.call(timer)
  }

  private getTombstone(key: string): Tombstone | undefined {
    const tombstone = this.tombstones.get(key)
    if (!tombstone) return undefined
    if (this.now() >= tombstone.expiresAt) {
      this.tombstones.delete(key)
      return undefined
    }
    return tombstone
  }

  private putTombstone(
    key: string,
    reason: ContinuationTerminalReason | "delivered",
  ): void {
    this.tombstones.delete(key)
    this.tombstones.set(key, {
      reason,
      expiresAt: this.now() + this.tombstoneTtlMs,
    })
    while (this.tombstones.size > this.tombstoneLimit) {
      const oldest = this.tombstones.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  private isTerminalReason(reason: SessionCloseReason): reason is ContinuationTerminalReason {
    return !["ordinary-cleanup", "turn-ended", "initial-write-failed"].includes(reason)
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
