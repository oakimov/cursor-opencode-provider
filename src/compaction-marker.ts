/**
 * Session-scoped compaction marker for the OpenCode 2.0 plugin.
 *
 * The classic plugin learns that a turn belongs to OpenCode's compaction agent
 * via the `chat.params` hook and forwards it as a provider option. OpenCode 2.0
 * removed `chat.params`; the only place the runtime names the owning agent is
 * `session.hook("context")`, which fires before dispatch. We record the fact
 * there and let the provider read it back by session id.
 *
 * Bounded so a long-lived server cannot accumulate ids for dead sessions.
 */

const MAX_TRACKED_SESSIONS = 256

const compactionSessions = new Set<string>()

export function markCompactionSession(sessionID: string, isCompaction: boolean): void {
  if (!sessionID) return
  if (!isCompaction) {
    compactionSessions.delete(sessionID)
    return
  }
  // Re-insert to keep insertion order meaningful for the eviction below.
  compactionSessions.delete(sessionID)
  compactionSessions.add(sessionID)
  while (compactionSessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = compactionSessions.values().next().value
    if (oldest === undefined) break
    compactionSessions.delete(oldest)
  }
}

export function isCompactionSession(sessionID: string | undefined): boolean {
  return typeof sessionID === "string" && compactionSessions.has(sessionID)
}

export function clearCompactionSessions(): void {
  compactionSessions.clear()
}
