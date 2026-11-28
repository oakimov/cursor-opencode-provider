/**
 * Cursor's own conversation summarization: one `summarize_action` Run, as
 * Cursor CLI's `/summarize` sends it. The action is empty; Cursor's harness
 * picks what to summarize from the checkpoint the Run carries, caps its
 * summarizer input itself, and answers with `summary_started`, `summary`
 * (the text), `summary_completed`, a checkpoint holding the summary and its
 * archives, and `turn_ended`.
 *
 * Verified live 2026-11-28 (private run report, issue 203): Cursor asks for the
 * request context with a `request_context_args` exec, the summary text arrives
 * in `SummaryUpdate`, and `turn_ended` carries no usage counters. The same
 * action on a new conversation id with another conversation's checkpoint and
 * blobs summarizes a fork, as Cursor CLI's fork copies blobs and the latest root.
 *
 * This module pumps that Run only. The caller opens the stream (so opening
 * keeps the provider's cancellation and gzip handling) and decides where the
 * resulting checkpoint goes.
 */

import type { BidiStream } from "./transport/connect.js"
import { CursorLocalCancellationError, CursorProviderError } from "./errors.js"
import { decodeFramePayload } from "./protocol/framing.js"
import { decodeMessage } from "./protocol/messages.js"
import { handleKvServerMessage } from "./protocol/kv.js"
import { buildHeartbeat, buildCancelAction } from "./protocol/request.js"
import { buildRequestContextResult } from "./protocol/tools.js"
import { getConversationBlob } from "./protocol/blob-store.js"
import { writeStreamMessage } from "./stream-write.js"
import { trace } from "./debug.js"

export type SummarizeRunInput = {
  /** The conversation id the Run names: the live one, or a fork's new id. */
  conversationId: string
  /**
   * Blob store the Run reads and writes. `conversationId` is where blobs Cursor
   * stores land; `preload` serves blobs another conversation holds (a fork).
   */
  blobs: { conversationId: string; preload?: Map<string, Uint8Array> }
  /** Answer to Cursor's `request_context_args` exec: the conversation's frozen RequestContext. */
  requestContext: Record<string, unknown>
  /** Every checkpoint the Run streams, in order. */
  onCheckpoint?: (bytes: Uint8Array) => void
  heartbeatMs: number
  signal?: AbortSignal
  /**
   * `summary` (default): a `summarize_action` Run, which must yield summary
   * text. `turn`: a user turn whose only purpose is its checkpoint (the import
   * turn before a summary of history Cursor did not hold); its reply is ignored.
   */
  expect?: "summary" | "turn"
}

export type SummarizeRunResult = {
  summary: string
  /** Where the summary text came from: `SummaryUpdate`, or the checkpoint's summary blob. */
  source: "update" | "checkpoint"
  checkpoint?: Uint8Array
  /** Raw `turn_ended` (empty on summarize Runs seen so far). */
  turnEnded?: Record<string, unknown>
}

export type SummarizeRunDeps = {
  /** Decodes a Connect end-stream payload into the provider's error. */
  endStreamError: (payload: string) => CursorProviderError
}

/** A summarize Run that ended without a usable summary. Final: the compaction fails. */
export class CursorSummarizeError extends CursorProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, origin: "server", transient: false, replaySafe: false, retryable: false })
    this.name = "CursorSummarizeError"
  }
}

function bytesOf(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) return Uint8Array.from(raw)
  return undefined
}

/** Summary text from a checkpoint's `summary` blob (#6 → ConversationSummary), if Cursor stored one. */
export function checkpointSummaryText(
  checkpoint: Uint8Array | undefined,
  blob: (id: Uint8Array) => Uint8Array | undefined,
): string | undefined {
  if (!checkpoint?.length) return undefined
  try {
    const state = decodeMessage<{ summary?: Uint8Array }>("ConversationStateStructure", checkpoint)
    const id = bytesOf(state.summary)
    const data = id?.length ? blob(id) : undefined
    if (!data?.length) return undefined
    const text = decodeMessage<{ summary?: string }>("ConversationSummary", data).summary
    return typeof text === "string" && text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Pump one already-opened `summarize_action` Run to `turn_ended`. Any exec other
 * than the request-context probe is unexpected here: the Run is cancelled and
 * the summary fails rather than answering a tool call no host asked for.
 */
export async function pumpSummarizeRun(
  stream: BidiStream,
  input: SummarizeRunInput,
  deps: SummarizeRunDeps,
): Promise<SummarizeRunResult> {
  const kvSession = {
    blobs: input.blobs.preload ?? new Map<string, Uint8Array>(),
    conversationId: input.blobs.conversationId,
  }
  const write = async (message: Uint8Array, operation: string) => {
    await writeStreamMessage(stream, message, operation, () => !stream.isClosed())
  }
  const heartbeat = setInterval(() => {
    if (stream.isClosed()) return
    void writeStreamMessage(stream, buildHeartbeat(), "summarize heartbeat", () => !stream.isClosed())
      .catch(() => {})
  }, input.heartbeatMs)
  heartbeat.unref?.()
  let cancelled = false
  const cancel = () => {
    cancelled = true
    void writeStreamMessage(stream, buildCancelAction("Host stopped the compaction"), "summarize cancel")
      .catch(() => {})
      .finally(() => stream.destroy())
  }
  input.signal?.addEventListener("abort", cancel, { once: true })
  if (input.signal?.aborted) cancel()

  let summary = ""
  let checkpoint: Uint8Array | undefined
  let turnEnded: Record<string, unknown> | undefined
  try {
    for await (const frame of stream.frames()) {
      if (cancelled) break
      if (frame.flags & 0x02) {
        const payload = frame.payload.length > 0 ? new TextDecoder().decode(decodeFramePayload(frame)) : ""
        throw payload ? deps.endStreamError(payload) : new CursorSummarizeError("Cursor ended the summary Run before turn_ended")
      }
      const asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", decodeFramePayload(frame))
      const iu = asm.interaction_update as Record<string, unknown> | undefined
      if (iu) {
        if (iu.summary_started) trace(`summarize: started conversationId=${input.conversationId}`)
        if (iu.summary) {
          const text = (iu.summary as { summary?: unknown }).summary
          if (typeof text === "string") summary = text
        }
        if (iu.summary_completed) {
          const hook = (iu.summary_completed as { hook_message?: unknown }).hook_message
          trace(`summarize: completed conversationId=${input.conversationId} chars=${summary.length}` +
            (typeof hook === "string" && hook ? ` hookMessage=${JSON.stringify(hook.slice(0, 200))}` : ""))
        }
        if (iu.turn_ended) {
          turnEnded = iu.turn_ended as Record<string, unknown>
          break
        }
        continue
      }
      const checkpointRaw = bytesOf(asm.conversation_checkpoint_update)
      if (checkpointRaw?.length) {
        checkpoint = Uint8Array.from(checkpointRaw)
        input.onCheckpoint?.(checkpoint)
        continue
      }
      const kv = asm.kv_server_message as Record<string, unknown> | undefined
      if (kv) {
        const handled = handleKvServerMessage(kv, kvSession)
        if (handled) await write(handled.reply, `summarize kv ${handled.kind} id=${handled.id}`)
        continue
      }
      const exec = asm.exec_server_message as Record<string, unknown> | undefined
      if (exec) {
        const execId = (exec.id as number) ?? 0
        if (exec.request_context_args) {
          await write(buildRequestContextResult(execId, input.requestContext), `summarize request-context id=${execId}`)
          continue
        }
        const kind = Object.keys(exec).find((key) => key.endsWith("_args")) ?? "unknown"
        trace(`summarize: unexpected exec ${kind} id=${execId}; cancelling the summary Run`)
        await write(buildCancelAction("Summarization runs no tools"), "summarize cancel")
        throw new CursorSummarizeError(`Cursor asked for ${kind} during a summary`)
      }
      if (asm.interaction_query) {
        await write(buildCancelAction("Summarization answers no questions"), "summarize cancel")
        throw new CursorSummarizeError("Cursor sent an interaction query during a summary")
      }
      // exec_server_control_message and anything newer carry nothing for a summary.
    }
    if (cancelled || input.signal?.aborted) throw new CursorLocalCancellationError("Cursor summary cancelled")
    if (!turnEnded) throw new CursorSummarizeError("Cursor ended the summary Run before turn_ended")
    if (input.expect === "turn") {
      if (!checkpoint) throw new CursorSummarizeError("Cursor's import turn returned no checkpoint")
      return { summary: "", source: "update", checkpoint, turnEnded }
    }
    const fromCheckpoint = summary.trim() ? undefined : checkpointSummaryText(checkpoint, (id) =>
      kvSession.blobs.get(Buffer.from(id).toString("hex")) ?? getConversationBlob(kvSession.conversationId, id))
    const text = summary.trim() ? summary : fromCheckpoint
    if (!text) throw new CursorSummarizeError("Cursor's summary Run returned no summary")
    return { summary: text, source: summary.trim() ? "update" : "checkpoint", checkpoint, turnEnded }
  } catch (error) {
    if (cancelled || input.signal?.aborted) {
      throw error instanceof CursorLocalCancellationError ? error : new CursorLocalCancellationError("Cursor summary cancelled", error)
    }
    throw error
  } finally {
    clearInterval(heartbeat)
    input.signal?.removeEventListener("abort", cancel)
    stream.destroy()
  }
}
