/**
 * Session-scoped workspace directory for the OpenCode 2.0 plugin.
 *
 * The classic plugin learns the project directory from `input.directory`,
 * supplied once per invocation by the 1.x host. OpenCode 2.0 runs a single
 * daemon across many projects, so `process.cwd()` captured at sdk-creation
 * time is wrong for any session but the one open when the daemon started.
 * The only place the 2.0 runtime names a session's actual directory is
 * `SessionInfo.location.directory`, reachable from `session.hook("context")`'s
 * `sessionID` via `ctx.session.get()`. Record it there and let the provider
 * read it back by session id, same mechanism as `compaction-marker.ts`.
 *
 * Bounded so a long-lived server cannot accumulate ids for dead sessions.
 */

const MAX_TRACKED_SESSIONS = 256

const sessionDirectories = new Map<string, string>()

export function markSessionDirectory(sessionID: string, directory: string | undefined): void {
  if (!sessionID || !directory) return
  // Re-insert to keep insertion order meaningful for the eviction below.
  sessionDirectories.delete(sessionID)
  sessionDirectories.set(sessionID, directory)
  while (sessionDirectories.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionDirectories.keys().next().value
    if (oldest === undefined) break
    sessionDirectories.delete(oldest)
  }
}

export function getSessionDirectory(sessionID: string | undefined): string | undefined {
  return typeof sessionID === "string" ? sessionDirectories.get(sessionID) : undefined
}

export function clearSessionDirectories(): void {
  sessionDirectories.clear()
}
