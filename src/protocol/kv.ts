import { encodeMessage } from "./messages.js"
import type { CursorSession } from "../session.js"

function hex(b: Uint8Array): string {
  let s = ""
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0")
  return s
}

/**
 * Handle a server `KvServerMessage` (AgentServerMessage #4). Cursor moves large
 * payloads out-of-band via this blob channel:
 *  - `set_blob_args{blob_id, blob_data}` → server stores a blob on the client.
 *    We persist it and ACK with `set_blob_result` (empty = success).
 *  - `get_blob_args{blob_id}` → server asks the client for a blob it stored.
 *    We return `get_blob_result{blob_data}` (empty if unknown).
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
    const key = hex(setArgs.blob_id)
    session.blobs.set(key, setArgs.blob_data ?? new Uint8Array(0))
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
    const stored = session.blobs.get(key)
    // Cursor's blob store is content-addressed with the CLIENT as source of
    // truth: the server sends get_blob_args{ blob_id: <the literal content> }
    // for conversation content it received inline (e.g. our system-prompt
    // message). The client must return that content. If we stored it via an
    // earlier set_blob_args, return the stored bytes; otherwise echo the
    // blob_id back as blob_data (returning empty → server "Blob not found").
    const blobData = stored ?? getArgs.blob_id
    return {
      kind: "get",
      id,
      blobIdHex: key,
      found: !!stored,
      echoed: !stored,
      reply: encodeMessage("AgentClientMessage", {
        kv_client_message: { id, get_blob_result: { blob_data: blobData } },
      }),
    }
  }

  return null
}

