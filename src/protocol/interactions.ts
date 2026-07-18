import { encodeMessage } from "./messages.js"
import { readAllFields } from "./struct.js"

const HEADLESS_REASON =
  "This Cursor interaction requires UI approval and is not available through the OpenCode provider."

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
}

export type HandledInteraction = {
  id: number
  variantField: number
  variantName: string
  outcome: "rejected" | "acknowledged" | "failed"
  reply: Uint8Array
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
  for (const field of readAllFields(queryBytes)) {
    if (field.fn === 1 && field.wt === 0) id = field.varint
    else if (field.wt === 2 && variantField === undefined) variantField = field.fn
  }
  return {
    id,
    variantField,
    variantName: variantField === undefined ? undefined : variantNames[variantField],
  }
}

/**
 * Build the immediate typed response required by Cursor's Run RPC.
 *
 * OpenCode has no Cursor UI callbacks, so every InteractionQuery is answered
 * here with a conservative headless policy (reject UI-bound prompts; ack a few
 * no-UI cases). See case 7 / F14 for create_plan auto-ack parity with Cursor
 * CLI headless mode.
 */
export function handleInteractionQuery(
  query: Record<string, unknown>,
  agentServerPayload: Uint8Array,
): HandledInteraction {
  const info = inspectInteractionQueryWire(agentServerPayload)
  if (info.id === undefined || info.variantField === undefined || !info.variantName) {
    throw new UnsupportedInteractionQueryError(info)
  }
  if (typeof query.id === "number" && query.id !== info.id) {
    throw new Error(`Cursor interaction query id mismatch: decoded=${query.id} wire=${info.id}`)
  }

  let response: Record<string, unknown>
  let outcome: HandledInteraction["outcome"]

  switch (info.variantField) {
    case 2:
      response = { web_search_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
      break
    case 3:
      response = {
        ask_question_interaction_response: {
          result: { rejected: { reason: "Questions must be asked through OpenCode's question tool." } },
        },
      }
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
