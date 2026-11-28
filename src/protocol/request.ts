import { encodeMessage, getMessageTypes } from "./messages.js"
import type { OpencodeToolDef } from "./tools.js"
import type { CursorImageInput } from "../image-input.js"

export type SeedHistoryMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type RunRequestInput = {
  text: string
  images?: CursorImageInput[]
  modelId: string
  conversationId: string
  /** Stable parent group; unlike conversationId, this survives compaction/rebase. */
  conversationGroupId?: string
  /**
   * Prior chat turns for a Run without a checkpoint, carried as earlier user
   * turns (see {@link seedHistoryParts}). Tool outputs, when required for
   * recovery, are represented as user-role OpenCode host observations rather
   * than assistant-authored prose.
   */
  history?: SeedHistoryMessage[]
  /**
   * Opaque ConversationStateStructure bytes from the last
   * conversation_checkpoint_update for this conversation_id. When set, echoed
   * as AgentRunRequest.conversation_state (CLI parity). When absent, an empty
   * seed state is sent and `history` travels as prepended earlier user turns.
   */
  conversationState?: Uint8Array
  parameterValues?: Array<{ id: string; value: string }>
  maxMode?: boolean
  messageId?: string
  tools?: OpencodeToolDef[]
  /** Pre-resolved descriptors (including config-backed MCP server identity). */
  toolDescriptors?: Array<Record<string, unknown>>
  /** Prebuilt RequestContext (OpenCode-sourced). */
  requestContext?: Record<string, unknown>
  /**
   * `resume` resumes the supplied checkpoint instead of submitting another user
   * turn; `summarize` asks Cursor to summarize the conversation in place
   * (`summarize_action`, Cursor CLI `/summarize`).
   */
  action?: "user" | "resume" | "summarize"
  /**
   * Cursor mode of this user turn (`UserMessage.mode`, an `agent.v1.AgentMode`
   * value). Cursor CLI sends its current mode on every user message.
   */
  mode?: number
}

/**
 * Empty ConversationStateStructure for a Run without a checkpoint (turn 1,
 * import, rebase, reseed). After the first checkpoint arrives we stop
 * inventing state and echo the server's opaque structure instead (CLI behavior).
 *
 * Nothing goes in `root_prompt_messages_json` (#1). Neither Cursor client
 * writes it: Cursor checkpoints fill it with references to the conversation's
 * own rendered root prompt. A client-written entry stands in for that prompt,
 * so Cursor stops rendering RequestContext rules, skills and subagents — the
 * host system-instructions rule included. Verified live 2026-10-09
 * (claude-sonnet-5-5): two seeded history messages there gave checkpoint
 * categories `rules:0, subagents:0` and a reply that ignored the rule; the same
 * history in user messages kept both. History therefore travels as prepended
 * earlier user turns ({@link seedHistoryParts}).
 * `UserMessageAction.conversation_history` (#7), Cursor CLI's own import, is
 * ignored by Cursor's cloud for this client (live 2026-11-28).
 *
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
export function buildSeedConversationState(): Uint8Array {
  const type = getMessageTypes().lookupType("ConversationStateStructure")
  return type.encode(type.fromObject({})).finish()
}

const SEED_HISTORY_TAGS = /<\/(conversation_history|user|assistant)>/gi

/**
 * Cursor keeps only the last 5 `prepend_user_messages` and drops older ones
 * without notice (agent harness `maxPrependedUserMessages ?? 5`; live
 * 2026-11-28: of 7 prepended notes only 3–7 reached the model).
 */
export const MAX_PREPENDED_HISTORY_PARTS = 5

/**
 * Prior turns of a Run without a checkpoint, as at most
 * {@link MAX_PREPENDED_HISTORY_PARTS} earlier user turns
 * (`UserMessageAction.prepend_user_messages`). The live user message then
 * holds only the request. History in the live message is summarized together
 * with the request when it overflows the window, so the model loses the
 * request (#203); earlier turns are summarized while the request is kept
 * (live A/B 2026-11-28). `system` entries are dropped: host system context
 * travels as the system-instructions rule in RequestContext. Closing tags
 * inside a message are escaped so a message cannot end its own block early.
 * Parts split at message boundaries and are balanced by size.
 */
export function seedHistoryParts(history: readonly SeedHistoryMessage[] | undefined): string[] {
  const entries = (history ?? [])
    .filter((entry) => entry.content && entry.role !== "system")
    .map((entry) => `<${entry.role}>\n${entry.content.replace(SEED_HISTORY_TAGS, "<\\/$1>")}\n</${entry.role}>`)
  if (entries.length === 0) return []
  const count = Math.min(MAX_PREPENDED_HISTORY_PARTS, entries.length)
  const total = entries.reduce((sum, entry) => sum + entry.length, 0)
  const parts: string[][] = []
  let current: string[] = []
  let size = 0
  entries.forEach((entry, index) => {
    const partsAfterCurrent = count - parts.length - 1
    const remaining = entries.length - index
    if (current.length > 0 && partsAfterCurrent > 0
      && (size >= (total * (parts.length + 1)) / count || remaining <= partsAfterCurrent)) {
      parts.push(current)
      current = []
    }
    current.push(entry)
    size += entry.length
  })
  parts.push(current)
  return parts.map((part, index) =>
    `[Earlier conversation, part ${index + 1} of ${parts.length}]\n` +
      `<conversation_history>\n${part.join("\n\n")}\n</conversation_history>`)
}

/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export function buildRunRequest(input: RunRequestInput): Uint8Array {
  const msgId = input.messageId ?? crypto.randomUUID()

  // Advertise host tools on UserMessageAction.request_context (#2) via slim
  // mcp_meta_tool_options. AgentRunRequest.mcp_tools (#4) stays empty on real
  // turns (CLI prewarm-only). Full defs are session.toolDescriptors + exec #36.
  const requestContext = input.requestContext

  const seeded = !(input.conversationState && input.conversationState.length > 0)
  const userMessage: Record<string, unknown> = {
    text: input.text,
    message_id: msgId,
  }
  if (input.mode !== undefined) userMessage.mode = input.mode
  if (input.images?.length) {
    userMessage.selected_context = {
      selected_images: input.images.map((image) => ({
        data: image.data,
        uuid: crypto.randomUUID(),
        path: image.filename,
        mime_type: image.mimeType,
      })),
    }
  }
  const userMessageAction: Record<string, unknown> = { user_message: userMessage }
  if (requestContext) userMessageAction.request_context = requestContext
  const prepended = seeded ? seedHistoryParts(input.history) : []
  if (prepended.length > 0) {
    userMessageAction.prepend_user_messages = prepended.map((text) => ({ text, message_id: crypto.randomUUID() }))
  }
  // Cursor CLI `/summarize` sends an empty SummarizeAction and no request
  // context; Cursor asks for it with a `request_context_args` exec.
  const action = input.action === "resume"
    ? { resume_action: {} }
    : input.action === "summarize"
      ? { summarize_action: {} }
      : { user_message_action: userMessageAction }

  const conversationState = seeded
    ? buildSeedConversationState()
    : input.conversationState!

  const runRequest: Record<string, unknown> = {
    conversation_id: input.conversationId,
    conversation_group_id: input.conversationGroupId ?? input.conversationId,
    run_id: msgId,
    action,
    requested_model: {
      // The provider always selects a concrete model. Cursor's "default"
      // pseudo-model (Auto) is never used here — we send the real id plus the
      // chosen variant's parameter values.
      model_id: input.modelId,
      max_mode: input.maxMode ?? false,
      parameters: input.parameterValues ?? [],
    },
    conversation_state: conversationState,
    mcp_tools: { mcp_tools: [] },
  }

  return encodeMessage("AgentClientMessage", {
    run_request: runRequest,
  })
}

/**
 * Build a heartbeat message.
 */
export function buildHeartbeat(): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    client_heartbeat: {},
  })
}

/**
 * ACM #5 `exec_client_control_message.heartbeat{id}`: Cursor CLI sends it every
 * 3 s for each exec it is still running, keyed by the exec message id. The CLI
 * leaves a zero id out, as proto3 does for a default scalar; protobufjs would
 * write it explicitly, so it is omitted here to send the CLI's exact bytes.
 */
export function buildExecHeartbeat(execId: number): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_control_message: { heartbeat: execId === 0 ? {} : { id: execId } },
  })
}

/** Stops the live Run, as Cursor CLI does on a user Stop before it closes the stream. */
export function buildCancelAction(reason: string): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    conversation_action: { cancel_action: { reason } },
  })
}
