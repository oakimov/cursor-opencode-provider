import { encodeMessage, getMessageTypes } from "./messages.js"
import { toolsToDescriptors, type OpencodeToolDef } from "./tools.js"

export type SeedHistoryMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type RunRequestInput = {
  text: string
  modelId: string
  conversationId: string
  systemPrompt?: string
  /**
   * Prior chat turns for a seed ConversationStateStructure (no checkpoint).
   * Tool outputs, when required for compaction/recovery, are represented as
   * user-role OpenCode host observations rather than assistant-authored prose.
   */
  history?: SeedHistoryMessage[]
  /**
   * Opaque ConversationStateStructure bytes from the last
   * conversation_checkpoint_update for this conversation_id. When set, echoed
   * as AgentRunRequest.conversation_state (CLI parity). When absent, a seed
   * state with the system prompt (or empty) is built for turn 1.
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
}

/**
 * Seed ConversationStateStructure for the first turn (no checkpoint yet).
 *
 * OpenCode needs a system prompt channel; we put it in root_prompt_messages_json
 * as a JSON chat message. After the first checkpoint arrives we stop inventing
 * state and echo the server's opaque structure instead (CLI behavior).
 *
 * Compaction resets also use this seed, with `history` carrying OpenCode's
 * compacted prompt turns so Cursor can summarize without the old checkpoint.
 *
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
export function buildSeedConversationState(input?: {
  systemPrompt?: string
  history?: SeedHistoryMessage[]
}): Uint8Array {
  const root = getMessageTypes()
  const type = root.lookupType("ConversationStateStructure")
  const messages: string[] = []
  if (input?.systemPrompt && input.systemPrompt.length > 0) {
    messages.push(JSON.stringify({ role: "system", content: input.systemPrompt }))
  }
  for (const entry of input?.history ?? []) {
    if (!entry.content) continue
    // Avoid duplicating the system prompt when history also carries one.
    if (entry.role === "system" && input?.systemPrompt) continue
    messages.push(JSON.stringify({ role: entry.role, content: entry.content }))
  }
  const obj: Record<string, unknown> = {}
  if (messages.length > 0) obj.root_prompt_messages_json = messages
  return type.encode(type.fromObject(obj)).finish()
}

/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export function buildRunRequest(input: RunRequestInput): Uint8Array {
  const msgId = input.messageId ?? crypto.randomUUID()

  // Advertise opencode's tools on the LIVE path: UserMessageAction.request_context
  // (#2). AgentRunRequest.mcp_tools (#4) is prewarm-only / empty on real turns —
  // putting tools only there is why the model fell back to native Grep/Read.
  const tools = input.tools ?? []
  const mcpTools = input.toolDescriptors ?? (tools.length > 0 ? toolsToDescriptors(tools) : [])
  const requestContext = input.requestContext

  const userMessageAction: Record<string, unknown> = {
    user_message: {
      text: input.text,
      message_id: msgId,
    },
  }
  if (requestContext) {
    userMessageAction.request_context = requestContext
  }

  const conversationState =
    input.conversationState && input.conversationState.length > 0
      ? input.conversationState
      : buildSeedConversationState({
          systemPrompt: input.systemPrompt,
          history: input.history,
        })

  const runRequest: Record<string, unknown> = {
    conversation_id: input.conversationId,
    action: {
      user_message_action: userMessageAction,
    },
    requested_model: {
      // The provider always selects a concrete model. Cursor's "default"
      // pseudo-model (Auto) is never used here — we send the real id plus the
      // chosen variant's parameter values.
      model_id: input.modelId,
      max_mode: input.maxMode ?? false,
      parameters: input.parameterValues ?? [],
    },
    conversation_state: conversationState,
    // Keep #4 populated too (harmless on real turns; useful for prewarm /
    // older server builds that still read it).
    mcp_tools: { mcp_tools: mcpTools },
    unknown_flag: 0,
    field_12: 0,
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
