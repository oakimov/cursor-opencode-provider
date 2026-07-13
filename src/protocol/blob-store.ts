/**
 * Cursor CLI keeps conversation blobs in a durable client store (SQLite) across
 * Runs. ConversationStateStructure only holds blob IDs; the server re-fetches
 * them via get_blob on the next turn. Our per-Run session.blobs Map was wiped
 * on stream close, so follow-up gets echoed 32-byte hashes → server JSON.parse
 * fails ("Unexpected token ... is not valid JSON").
 *
 * This store is keyed by conversation_id and survives across Run streams.
 */

function hex(b: Uint8Array): string {
  let s = ""
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0")
  return s
}

const byConversation = new Map<string, Map<string, Uint8Array>>()

function bucket(conversationId: string): Map<string, Uint8Array> {
  let m = byConversation.get(conversationId)
  if (!m) {
    m = new Map()
    byConversation.set(conversationId, m)
  }
  return m
}

export function setConversationBlob(
  conversationId: string,
  blobId: Uint8Array,
  blobData: Uint8Array,
): string {
  const key = hex(blobId)
  // Copy so decode buffers can't mutate the store later.
  bucket(conversationId).set(key, Uint8Array.from(blobData))
  return key
}

export function getConversationBlob(
  conversationId: string,
  blobId: Uint8Array,
): Uint8Array | undefined {
  return bucket(conversationId).get(hex(blobId))
}

export function conversationBlobCount(conversationId: string): number {
  return byConversation.get(conversationId)?.size ?? 0
}

/** SHA-256 content hashes are 32 non-text bytes — never echo those as content. */
export function isBlobIdHash(blobId: Uint8Array): boolean {
  if (blobId.length !== 32) return false
  // Content-as-id payloads can also be 32 bytes (short JSON). Real hashes are
  // binary; if every byte is printable ASCII/UTF-8 text, treat as content.
  for (let i = 0; i < blobId.length; i++) {
    const b = blobId[i]!
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b > 0x7e) return true
  }
  return false
}

export function resetConversationBlobsForTests(): void {
  byConversation.clear()
}
