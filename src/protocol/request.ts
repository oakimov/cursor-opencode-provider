import { encodeMessage, getMessageTypes } from "./messages.js"
import { toolsToDescriptors, type OpencodeToolDef } from "./tools.js"
import type { ModelInfo } from "../models.js"

export type RunRequestInput = {
  text: string
  modelId: string
  conversationId: string
  systemPrompt?: string
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
  availableModels?: ModelInfo[]
  tools?: OpencodeToolDef[]
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
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
function buildSeedConversationState(systemPrompt?: string): Uint8Array {
  const root = getMessageTypes()
  const type = root.lookupType("ConversationStateStructure")
  const obj: Record<string, unknown> = {}
  if (systemPrompt && systemPrompt.length > 0) {
    obj.root_prompt_messages_json = [
      JSON.stringify({ role: "system", content: systemPrompt }),
    ]
  }
  return type.encode(type.fromObject(obj)).finish()
}

function buildAvailableModels(models: ModelInfo[]): Array<Record<string, unknown>> {
  return models.map((m) => ({
    model_id: m.id,
    parameters: (m.variants ?? []).flatMap((v) =>
      (v.parameterValues ?? []).map((p) => p),
    ),
  }))
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
  const mcpTools = tools.length > 0 ? toolsToDescriptors(tools) : []
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
      : buildSeedConversationState(input.systemPrompt)

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
    available_models: input.availableModels ? buildAvailableModels(input.availableModels) : [],
    conversation_id_dup: input.conversationId,
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
