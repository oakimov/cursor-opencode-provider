import { encodeMessage, getMessageTypes } from "./messages.js"
import { toolsToDescriptors, buildLiveRequestContext, type OpencodeToolDef } from "./tools.js"
import type { ModelInfo } from "../models.js"

export type RunRequestInput = {
  text: string
  modelId: string
  conversationId: string
  systemPrompt?: string
  /** Prior user/assistant turns (oldest first), excluding the current user message. */
  history?: Array<{ role: "user" | "assistant"; text: string }>
  parameterValues?: Array<{ id: string; value: string }>
  maxMode?: boolean
  messageId?: string
  availableModels?: ModelInfo[]
  tools?: OpencodeToolDef[]
}

/**
 * Build ConversationStateStructure. The system prompt is delivered here, in
 * `root_prompt_messages_json` (#1) as a JSON-encoded `{"role":"system",...}`
 * message — this is the verified Cursor mechanism (see capture_reference_run
 * + AGENT_RUN_PROTOCOL.md §ConversationState). We deliberately do NOT use
 * `AgentRunRequest.custom_system_prompt` (#8): that field is the internal
 * `--system-prompt` CLI override, gated to Anysphere/OpenAI teams, and the
 * server rejects it for normal accounts with
 * `invalid_argument: unknown option '--system-prompt'`.
 *
 * Prior chat turns go in `turns` (#8) as AgentConversationTurn messages so
 * multi-turn OpenCode sessions keep context on Cursor's side.
 */
function buildConversationState(
  systemPrompt?: string,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Uint8Array {
  const root = getMessageTypes()
  const type = root.lookupType("ConversationStateStructure")
  const obj: Record<string, unknown> = {}
  if (systemPrompt && systemPrompt.length > 0) {
    obj.root_prompt_messages_json = [
      JSON.stringify({ role: "system", content: systemPrompt }),
    ]
  }
  const turns = packHistoryTurns(history)
  if (turns.length > 0) obj.turns = turns
  return type.encode(type.fromObject(obj)).finish()
}

/**
 * Pack AI SDK prompt history into ConversationTurn / AgentConversationTurn.
 * Each completed user→assistant exchange becomes one turn; a trailing user
 * message without an assistant reply is omitted here (it is sent as the live
 * `action.user_message_action` instead).
 */
function packHistoryTurns(
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Array<Record<string, unknown>> {
  if (!history || history.length === 0) return []
  const turns: Array<Record<string, unknown>> = []
  let i = 0
  while (i < history.length) {
    const msg = history[i]
    if (msg.role !== "user") {
      i++
      continue
    }
    const userText = msg.text
    i++
    const steps: Array<Record<string, unknown>> = []
    while (i < history.length && history[i].role === "assistant") {
      steps.push({
        assistant_message: { text: history[i].text },
      })
      i++
    }
    // Only include completed turns (user + at least one assistant step). A
    // trailing user-only message is the current action, not history.
    if (steps.length === 0) continue
    turns.push({
      agent_conversation_turn: {
        user_message: { text: userText, message_id: crypto.randomUUID() },
        steps,
      },
    })
  }
  return turns
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
 */
export function buildRunRequest(input: RunRequestInput): Uint8Array {
  const msgId = input.messageId ?? crypto.randomUUID()

  // Advertise opencode's tools on the LIVE path: UserMessageAction.request_context
  // (#2). AgentRunRequest.mcp_tools (#4) is prewarm-only / empty on real turns —
  // putting tools only there is why the model fell back to native Grep/Read.
  const tools = input.tools ?? []
  const mcpTools = tools.length > 0 ? toolsToDescriptors(tools) : []
  const requestContext = tools.length > 0 ? buildLiveRequestContext(tools) : undefined

  const userMessageAction: Record<string, unknown> = {
    user_message: {
      text: input.text,
      message_id: msgId,
    },
  }
  if (requestContext) {
    userMessageAction.request_context = requestContext
  }

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
    conversation_state: buildConversationState(input.systemPrompt, input.history),
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
