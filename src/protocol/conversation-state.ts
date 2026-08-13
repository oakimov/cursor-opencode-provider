import { trace } from "../debug.js"
import {
  getFrozenRequestContext,
  setFrozenRequestContext,
} from "../context/frozen.js"
import {
  hasConversationBinding,
  isActiveConversationBinding,
  restoreConversationBinding,
} from "./conversation-bind.js"
import {
  compactConversationBlobs,
  restoreConversationBlobs,
} from "./blob-store.js"
import { getCheckpoint, setCheckpoint } from "./checkpoint.js"
import type { OpencodeToolDef } from "./tools.js"
import {
  deletePersistedConversation,
  loadPersistedConversation,
  persistConversation,
} from "./conversation-persistence.js"

/** Restore one OpenCode session before its conversation binding is resolved. */
export async function hydrateConversationState(
  cacheDir: string,
  sessionKey: string,
): Promise<{
  conversationId: string
  postCompactionRebase: boolean
  toolCatalog: OpencodeToolDef[]
} | undefined> {
  if (hasConversationBinding(sessionKey)) return undefined
  const loaded = await loadPersistedConversation(cacheDir, sessionKey)
  const persisted = loaded.value
  if (!persisted) {
    trace(
      `conversation persistence: hydration skipped sessionKey=${sessionKey} ` +
        `status=${loaded.status}`,
    )
    return undefined
  }

  restoreConversationBinding(sessionKey, persisted.conversationId)
  if (persisted.checkpoint) setCheckpoint(persisted.conversationId, persisted.checkpoint)
  restoreConversationBlobs(persisted.conversationId, persisted.blobs)
  setFrozenRequestContext(persisted.conversationId, persisted.requestContext)
  trace(
    `conversation persistence: restored sessionKey=${sessionKey} ` +
      `conversationId=${persisted.conversationId} checkpoint=${persisted.checkpoint?.length ?? 0}B ` +
      `blobs=${persisted.blobs.length}`,
  )
  return {
    conversationId: persisted.conversationId,
    postCompactionRebase: persisted.postCompactionRebase,
    toolCatalog: structuredClone(persisted.toolCatalog),
  }
}

/** Persist the complete resumable state only after Cursor confirms TurnEnded. */
export async function persistConversationState(
  cacheDir: string,
  input: {
    sessionKey: string
    conversationId: string
    requestContext: Record<string, unknown>
    toolCatalog?: OpencodeToolDef[]
    postCompactionRebase?: boolean
  },
): Promise<void> {
  // A newer Run may have reset/superseded this conversation while its final
  // frame was still in flight. Never let that late TurnEnded resurrect it.
  if (!isActiveConversationBinding(input.sessionKey, input.conversationId)) {
    trace(
      `conversation persistence: skipped superseded TurnEnded ` +
        `sessionKey=${input.sessionKey} conversationId=${input.conversationId}`,
    )
    return
  }
  const checkpoint = getCheckpoint(input.conversationId)
  const blobCompaction = compactConversationBlobs(input.conversationId, checkpoint)
  const blobs = blobCompaction.blobs
  const requestContext = getFrozenRequestContext(input.conversationId) ?? input.requestContext
  await persistConversation(cacheDir, {
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    checkpoint,
    blobs,
    requestContext,
    toolCatalog: structuredClone(input.toolCatalog ?? []),
    postCompactionRebase: input.postCompactionRebase,
  })
  trace(
    `conversation persistence: saved sessionKey=${input.sessionKey} ` +
      `conversationId=${input.conversationId} checkpoint=${checkpoint?.length ?? 0}B ` +
      `blobs=${blobCompaction.beforeCount}->${blobCompaction.afterCount} ` +
      `blobBytes=${blobCompaction.beforeBytes}->${blobCompaction.afterBytes}` +
      (blobCompaction.fallbackReason ? ` compactionFallback=${blobCompaction.fallbackReason}` : ""),
  )
}

export async function clearPersistedConversationState(
  cacheDir: string,
  sessionKey: string,
  expectedConversationId?: string,
): Promise<void> {
  await deletePersistedConversation(cacheDir, sessionKey, expectedConversationId)
}
