import type { CursorSession } from "../src/session.js"

/** Fields `SessionManager.registerSession` initializes on a new Run. */
type ManagedSessionKeys =
  | "closed"
  | "closeError"
  | "pumpOwner"
  | "heartbeatCancel"
  | "hardDeadlineTimer"
  | "semanticDeadlineCancel"
  | "terminalUnsubscribe"
  | "deferredTerminalReason"
  | "policy"
  | "createdAt"
  | "lastInboundAt"
  | "lastHeartbeatWriteAt"
  | "semanticDeadlineAt"

/** A Run as tests build it before registration: everything except the managed fields. */
export type CursorSessionFixture =
  Omit<CursorSession, ManagedSessionKeys | "billing">
    & Partial<Pick<CursorSession, ManagedSessionKeys | "billing">>

/**
 * Type a test Run. The managed fields stay unset until `registerSession`
 * fills them, exactly as for a Run the provider opens. An unpriced Run bills
 * under its own id unless the test supplies `billing`.
 */
export function sessionFixture(init: CursorSessionFixture): CursorSession {
  return { billing: { key: `run:${init.sessionId}`, prefixTokens: 0 }, ...init } as CursorSession
}
