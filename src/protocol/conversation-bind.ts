import { createHash } from "node:crypto"
import { clearCheckpoint } from "./checkpoint.js"
import { clearConversationBlobs } from "./blob-store.js"

/**
 * OpenCode session key → active Cursor conversation_id.
 *
 * Normally the binding is the deterministic UUID from the OpenCode session id
 * (CLI-shaped sticky conversation). Compaction/summary turns mint a fresh id
 * and drop the prior checkpoint + blobs so Cursor no longer bills the old
 * cached conversation against OpenCode's newly compacted prompt.
 */
const activeBySession = new Map<string, string>()
export const MAX_ACTIVE_CONVERSATION_BINDINGS = 256

function rememberConversation(sessionKey: string, conversationId: string): void {
  // Map insertion order is the LRU order. Refresh existing sessions on use.
  activeBySession.delete(sessionKey)
  activeBySession.set(sessionKey, conversationId)
  while (activeBySession.size > MAX_ACTIVE_CONVERSATION_BINDINGS) {
    const oldest = activeBySession.entries().next().value as [string, string] | undefined
    if (!oldest) break
    activeBySession.delete(oldest[0])
    clearCheckpoint(oldest[1])
    clearConversationBlobs(oldest[1])
  }
}

export function resetConversationBindingsForTests(): void {
  activeBySession.clear()
}

/** Deterministic UUID (version-4 shape) from an arbitrary session key. */
export function sessionIdToUuid(sessionId: string): string {
  const hash = createHash("sha256").update(`cursor-opencode-provider:conv:${sessionId}`).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Current Cursor conversation_id for an OpenCode session key, creating the default binding if needed. */
export function peekConversationId(sessionKey: string): string {
  let id = activeBySession.get(sessionKey)
  if (!id) {
    id = sessionIdToUuid(sessionKey)
  }
  rememberConversation(sessionKey, id)
  return id
}

/**
 * Resolve the Cursor conversation_id for this OpenCode session.
 * When `reset` is true (compaction/summary), discard prior Cursor state and
 * mint a new id so TurnEnded cache_read cannot keep overflowing OpenCode.
 */
export function bindConversationId(
  sessionKey: string | undefined,
  opts?: { reset?: boolean },
): { conversationId: string; reset: boolean; previousId?: string } {
  if (!sessionKey) {
    return { conversationId: crypto.randomUUID(), reset: !!opts?.reset }
  }

  if (opts?.reset) {
    const previousId = activeBySession.get(sessionKey) ?? sessionIdToUuid(sessionKey)
    clearCheckpoint(previousId)
    clearConversationBlobs(previousId)
    const conversationId = crypto.randomUUID()
    rememberConversation(sessionKey, conversationId)
    return { conversationId, reset: true, previousId }
  }

  return { conversationId: peekConversationId(sessionKey), reset: false }
}
