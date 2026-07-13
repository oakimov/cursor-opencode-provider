import { encodeMessage } from "./messages.js"
import type { CursorSession } from "../session.js"
import {
  getConversationBlob,
  isBlobIdHash,
  setConversationBlob,
} from "./blob-store.js"

function hex(b: Uint8Array): string {
  let s = ""
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0")
  return s
}

/**
 * Handle a server `KvServerMessage` (AgentServerMessage #4). Cursor moves large
 * payloads out-of-band via this blob channel:
 *  - `set_blob_args{blob_id, blob_data}` → server stores a blob on the client.
 *    We persist it (per-session + durable per conversation_id) and ACK.
 *  - `get_blob_args{blob_id}` → server asks the client for a blob it stored.
 *    We return `get_blob_result{blob_data}` (empty if unknown hash).
 * The reply MUST be sent as `AgentClientMessage.kv_client_message` (field #3) on
 * the same Run stream, echoing `id`. If we don't reply, the server hangs the
 * turn (endless heartbeats, never any interaction_update) — the "no response"
 * root cause.
 *
 * Returns the AgentClientMessage bytes to write back, or null if the message
 * carried no get/set blob request.
 */
export function handleKvServerMessage(
  ksm: Record<string, unknown>,
  session: CursorSession,
): { reply: Uint8Array; kind: "set" | "get"; id: number; blobIdHex: string; found: boolean; echoed?: boolean } | null {
  const id = (ksm.id as number) ?? 0
  const setArgs = ksm.set_blob_args as { blob_id?: Uint8Array; blob_data?: Uint8Array } | undefined
  const getArgs = ksm.get_blob_args as { blob_id?: Uint8Array } | undefined

  if (setArgs && setArgs.blob_id) {
    const data = setArgs.blob_data ?? new Uint8Array(0)
    const key = hex(setArgs.blob_id)
    session.blobs.set(key, data)
    // Survive across Run streams — required for checkpoint echo on turn 2+.
    if (session.conversationId) {
      setConversationBlob(session.conversationId, setArgs.blob_id, data)
    }
    return {
      kind: "set",
      id,
      blobIdHex: key,
      found: true,
      reply: encodeMessage("AgentClientMessage", {
        kv_client_message: { id, set_blob_result: {} },
      }),
    }
  }

  if (getArgs && getArgs.blob_id) {
    const key = hex(getArgs.blob_id)
    const stored =
      session.blobs.get(key) ??
      (session.conversationId
        ? getConversationBlob(session.conversationId, getArgs.blob_id)
        : undefined)

    let blobData: Uint8Array
    let echoed = false
    let found = false
    if (stored) {
      blobData = stored
      found = true
    } else if (!isBlobIdHash(getArgs.blob_id)) {
      // Content-as-id: server sometimes sends blob_id as the literal payload
      // (e.g. inline JSON). Echo it. Never do this for 32-byte hashes — that
      // made the server JSON.parse binary and return "Unexpected token".
      blobData = getArgs.blob_id
      echoed = true
    } else {
      blobData = new Uint8Array(0)
    }

    return {
      kind: "get",
      id,
      blobIdHex: key,
      found,
      echoed,
      reply: encodeMessage("AgentClientMessage", {
        kv_client_message: { id, get_blob_result: { blob_data: blobData } },
      }),
    }
  }

  return null
}
