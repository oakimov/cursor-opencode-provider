/**
 * Session-scoped workspace directory for the OpenCode 2.0 plugin.
 *
 * The classic plugin learns the project directory from `input.directory`,
 * supplied once per invocation by the 1.x host. OpenCode 2.0 runs a single
 * daemon across many projects, so `process.cwd()` captured at sdk-creation
 * time is wrong for any session but the one open when the daemon started.
 *
 * The 2.0 runtime names a session directory in two places:
 * - request header `x-opencode-directory` (per-request; preferred in the LM)
 * - `ctx.session.get()` → flat `info.directory`, or legacy
 *   `info.location.directory`, reachable from `session.hook("context")`
 *
 * This module records the session-get value by id so the language model can
 * fall back when the header is absent, same mechanism as `compaction-marker.ts`.
 *
 * Bounded so a long-lived server cannot accumulate ids for dead sessions.
 */

import path from "node:path"

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

/**
 * Active session workspace directory from OpenCode 2.0 request headers.
 * Values may be URI-encoded.
 */
export function opencodeDirectoryHeader(
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!headers) return undefined
  const raw = headers["x-opencode-directory"] ?? headers["X-Opencode-Directory"]
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined
  const trimmed = raw.trim()
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

/**
 * Resolve the workspace root for a model turn.
 * Prefer the per-request header, then the session mark, then static options/cwd.
 */
export function resolveSessionWorkspaceRoot(input: {
  sessionKey?: string
  headers?: Record<string, string | undefined>
  workspaceRoot?: string
  cwd?: string
}): string {
  return path.resolve(
    opencodeDirectoryHeader(input.headers) ??
      getSessionDirectory(input.sessionKey) ??
      (input.workspaceRoot || input.cwd || process.cwd()),
  )
}
