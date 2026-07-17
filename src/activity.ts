export type SessionActivitySource = {
  lastActivityAt(sessionId: string): number | undefined
}

const MAX_ANCESTRY_DEPTH = 64

/** Tracks OpenCode message progress and propagates it through subagent ancestry. */
export class SessionActivityTracker implements SessionActivitySource {
  private readonly parentBySession = new Map<string, string>()
  private readonly lastActivityBySession = new Map<string, number>()

  linkSession(sessionId: string, parentId?: string): void {
    if (!sessionId) return
    if (parentId && parentId !== sessionId) this.parentBySession.set(sessionId, parentId)
    else this.parentBySession.delete(sessionId)

    const existing = this.lastActivityBySession.get(sessionId)
    if (existing !== undefined) this.recordActivity(sessionId, existing)
  }

  recordActivity(sessionId: string, at = Date.now()): void {
    if (!sessionId || !Number.isFinite(at)) return
    const visited = new Set<string>()
    let current: string | undefined = sessionId
    for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (visited.has(current)) return
      visited.add(current)
      const previous = this.lastActivityBySession.get(current)
      if (previous === undefined || at > previous) this.lastActivityBySession.set(current, at)
      current = this.parentBySession.get(current)
    }
  }

  lastActivityAt(sessionId: string): number | undefined {
    return this.lastActivityBySession.get(sessionId)
  }

  removeSession(sessionId: string): void {
    this.parentBySession.delete(sessionId)
    this.lastActivityBySession.delete(sessionId)
  }

  clear(): void {
    this.parentBySession.clear()
    this.lastActivityBySession.clear()
  }
}

export const sessionActivity = new SessionActivityTracker()
