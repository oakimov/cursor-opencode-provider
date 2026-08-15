import { encodeMessage } from "./messages.js"
import { readAllFields } from "./struct.js"
import {
  type AskQuestionResultMessage,
  type DecodedAskQuestionQuery,
  decodeAskQuestionQuery,
  MISSING_ARGS_REASON,
  MISSING_QUERY_REASON,
} from "./ask-question.js"

const HEADLESS_REASON =
  "This Cursor interaction requires UI approval and is not available through the OpenCode provider."

/**
 * Rejection used when AskQuestion cannot be bridged because the current
 * OpenCode agent does not advertise `question` (subagents deny it by default,
 * and compaction turns advertise no tools at all). Naming the actual reason
 * keeps the model from concluding that asking is impossible in general.
 */
const ASK_QUESTION_UNAVAILABLE_REASON =
  "The OpenCode `question` tool is not available to the current agent, so questions "
  + "cannot be shown to the user this turn. State the question in your reply instead."

const variantNames: Record<number, string> = {
  2: "web_search_request_query",
  3: "ask_question_interaction_query",
  4: "switch_mode_request_query",
  7: "create_plan_request_query",
  8: "setup_vm_environment_args",
  9: "web_fetch_request_query",
  10: "pr_management_request_query",
  11: "mcp_auth_request_query",
  12: "generate_image_request_query",
  13: "replace_env_args",
  14: "connect_scm_request_query",
}

export type InteractionQueryWireInfo = {
  id?: number
  variantField?: number
  variantName?: string
  /** Raw bytes of the selected variant sub-message, when it is length-delimited. */
  variantBytes?: Uint8Array
}

export type HandledInteraction = {
  id: number
  variantField: number
  variantName: string
  outcome: "rejected" | "acknowledged" | "failed" | "bridged"
  /**
   * Immediate reply for this query. Absent only for a bridged *synchronous*
   * AskQuestion: Cursor blocks on the real answer, exactly as its own CLI does
   * while the user is choosing, so the reply is written on continuation once
   * the OpenCode `question` tool returns.
   */
  reply?: Uint8Array
  /** Present when `outcome === "bridged"`: the question set to hand OpenCode. */
  askQuestion?: DecodedAskQuestionQuery
}

export type HandleInteractionQueryOptions = {
  /**
   * True when the host advertises `question` on this turn and tool calls are
   * allowed, i.e. the provider can actually surface the prompt to the user.
   */
  canBridgeAskQuestion?: boolean
}

export class UnsupportedInteractionQueryError extends Error {
  constructor(info: InteractionQueryWireInfo) {
    const variant = info.variantField === undefined
      ? "missing variant"
      : `unsupported variant field #${info.variantField}`
    const id = info.id === undefined ? "missing id" : `id=${info.id}`
    super(`Cursor interaction query cannot be handled (${id}, ${variant})`)
    this.name = "UnsupportedInteractionQueryError"
  }
}

/**
 * Inspect the raw wrapper as well as the decoded object. protobufjs drops
 * fields introduced by newer Cursor schemas; raw inspection lets us fail fast
 * instead of accidentally restoring the heartbeat-only deadlock.
 */
export function inspectInteractionQueryWire(
  agentServerPayload: Uint8Array,
): InteractionQueryWireInfo {
  const queryBytes = readAllFields(agentServerPayload)
    .find((field) => field.fn === 7 && field.wt === 2)?.bytes
  if (!queryBytes) return {}

  // InteractionQuery.id is a proto3 uint32. Cursor commonly uses id=0, whose
  // default scalar value is omitted from the wire; absence therefore means
  // zero, not a malformed/missing correlation id.
  let id = 0
  let variantField: number | undefined
  let variantBytes: Uint8Array | undefined
  for (const field of readAllFields(queryBytes)) {
    if (field.fn === 1 && field.wt === 0) id = field.varint
    else if (field.wt === 2 && variantField === undefined) {
      variantField = field.fn
      variantBytes = field.bytes
    }
  }
  return {
    id,
    variantField,
    variantName: variantField === undefined ? undefined : variantNames[variantField],
    variantBytes,
  }
}

/**
 * Build the typed response required by Cursor's Run RPC.
 *
 * OpenCode has no Cursor UI callbacks, so UI-bound queries get a conservative
 * headless policy (reject; ack a few no-UI cases). See case 7 / F14 for
 * create_plan auto-ack parity with Cursor CLI headless mode.
 *
 * AskQuestion (#3) is the exception: OpenCode's `question` tool is a real
 * equivalent, so it returns `outcome: "bridged"` and the caller surfaces the
 * prompt as a host tool call. Only genuinely unbridgeable cases are rejected.
 */
export function handleInteractionQuery(
  query: Record<string, unknown>,
  agentServerPayload: Uint8Array,
  options: HandleInteractionQueryOptions = {},
): HandledInteraction {
  const info = inspectInteractionQueryWire(agentServerPayload)
  if (info.id === undefined || info.variantField === undefined || !info.variantName) {
    throw new UnsupportedInteractionQueryError(info)
  }
  if (typeof query.id === "number" && query.id !== info.id) {
    throw new Error(`Cursor interaction query id mismatch: decoded=${query.id} wire=${info.id}`)
  }

  if (info.variantField === 3) {
    return handleAskQuestionQuery(info.id, info.variantBytes, options)
  }

  let response: Record<string, unknown>
  let outcome: HandledInteraction["outcome"]

  switch (info.variantField) {
    case 2:
      response = { web_search_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 4:
      response = { switch_mode_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 7:
      // F14: create_plan_request_query auto-ack (Cursor CLI headless parity).
      // Cursor CLI's headless fallback acknowledges plan creation without a
      // client-side URI (`success` + empty `plan_uri`); the plan remains in
      // conversation state / checkpoints. This provider mirrors that reply so
      // the Run RPC does not deadlock waiting for UI approval. Impact: Cursor
      // may treat the plan as accepted without an OpenCode UI confirm; local
      // tool execution is still gated by OpenCode permissions. Do not change
      // this to reject/prompt without CLI parity evidence.
      response = { create_plan_request_response: { result: { success: {}, plan_uri: "" } } }
      outcome = "acknowledged"
      break
    case 8:
      // OpenCode owns the local environment; there is no Cursor VM to create.
      response = { setup_vm_environment_result: { success: {} } }
      outcome = "acknowledged"
      break
    case 9:
      response = { web_fetch_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 10:
      response = { pr_management_result: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 11:
      response = { mcp_auth_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 12:
      response = { generate_image_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 13:
      response = {
        replace_env_result: {
          failure: {
            error_message: "Environment replacement is not supported by the OpenCode provider.",
            setup_logs: "",
          },
        },
      }
      outcome = "failed"
      break
    case 14:
      response = { connect_scm_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    default:
      throw new UnsupportedInteractionQueryError(info)
  }

  return {
    id: info.id,
    variantField: info.variantField,
    variantName: info.variantName,
    outcome,
    reply: encodeMessage("AgentClientMessage", {
      interaction_response: { id: info.id, ...response },
    }),
  }
}

/**
 * AskQuestion is the one interaction OpenCode can genuinely satisfy, so it is
 * translated instead of refused. Cursor CLI's own handler is mirrored: reject
 * a malformed query, answer `async` immediately when the server asked for a
 * non-blocking prompt, and otherwise hold the query open until the user picks.
 */
function handleAskQuestionQuery(
  id: number,
  variantBytes: Uint8Array | undefined,
  options: HandleInteractionQueryOptions,
): HandledInteraction {
  const base = { id, variantField: 3, variantName: "ask_question_interaction_query" } as const
  const reject = (reason: string): HandledInteraction => ({
    ...base,
    outcome: "rejected",
    reply: buildAskQuestionInteractionReply(id, { rejected: { reason } }),
  })

  if (!variantBytes) return reject(MISSING_QUERY_REASON)
  const decoded = decodeAskQuestionQuery(variantBytes)
  if (!decoded) return reject(MISSING_ARGS_REASON)
  if (!options.canBridgeAskQuestion) return reject(ASK_QUESTION_UNAVAILABLE_REASON)

  return {
    ...base,
    outcome: "bridged",
    askQuestion: decoded,
    // Async queries are unblocked now and answered later through a
    // ConversationAction; synchronous ones keep Cursor waiting, which is what
    // its CLI does while the user is still choosing.
    reply: decoded.args.runAsync
      ? buildAskQuestionInteractionReply(id, { async: {} })
      : undefined,
  }
}

/** `AgentClientMessage{interaction_response{ask_question_interaction_response}}`. */
export function buildAskQuestionInteractionReply(
  id: number,
  result: AskQuestionResultMessage,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    interaction_response: {
      id,
      ask_question_interaction_response: { result },
    },
  })
}

/**
 * Deferred answers for a query already acknowledged with `async`.
 * `originalArgs` must be the server's own `AskQuestionArgs` bytes so Cursor can
 * correlate the completion with the tool call it raised.
 */
export function buildAsyncAskQuestionCompletion(
  originalToolCallId: string,
  originalArgs: Uint8Array,
  result: AskQuestionResultMessage,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    conversation_action: {
      async_ask_question_completion_action: {
        original_tool_call_id: originalToolCallId,
        original_args: originalArgs,
        result,
      },
    },
  })
}
