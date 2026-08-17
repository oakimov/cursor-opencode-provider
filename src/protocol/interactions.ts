import { encodeMessage } from "./messages.js"
import { readAllFields } from "./struct.js"
import {
  type AskQuestionResultMessage,
  type DecodedAskQuestionQuery,
  decodeAskQuestionQuery,
  MISSING_ARGS_REASON,
  MISSING_QUERY_REASON,
} from "./ask-question.js"
import {
  type DecodedGenerateImageQuery,
  decodeGenerateImageQuery,
} from "./generate-image.js"
import {
  CURSOR_PLAN_STAGE_TOOL,
  type CreatePlanBridge,
  type DecodedCreatePlanQuery,
  createPlanApprovalQuestionInput,
  decodeCreatePlanQuery,
  renderPlanReviewMessage,
  resolveCreatePlanBridge,
  writeOpencodePlanFile,
} from "./create-plan.js"
import {
  type DecodedSwitchModeQuery,
  type SwitchModeBridge,
  type SwitchModeHostTool,
  decodeSwitchModeQuery,
  MISSING_ARGS_REASON as SWITCH_MODE_MISSING_ARGS_REASON,
  MISSING_QUERY_REASON as SWITCH_MODE_MISSING_QUERY_REASON,
  resolveSwitchModeBridge,
  switchModeApprovedResult,
} from "./switch-mode.js"

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
  outcome: "rejected" | "acknowledged" | "failed" | "bridged" | "approved"
  /**
   * Immediate reply for this query. Absent for bridged *synchronous* AskQuestion
   * or SwitchMode: Cursor blocks until the host tool returns, exactly as its own
   * CLI does while the user is choosing / approving the mode switch.
   */
  reply?: Uint8Array
  /** Present when `outcome === "bridged"`: the question set to hand OpenCode. */
  askQuestion?: DecodedAskQuestionQuery
  /**
   * Present when SwitchMode should mutate session mode — bridged to a host
   * tool, or approved outright when entering plan mode needs none. Absent on
   * lifecycle soft-acks (`ack`): those reply `approved{}` without recording
   * a mode. The caller reads `bridge` to decide whether a tool call is emitted,
   * and `args.targetModeId` to record the active Cursor mode when present.
   */
  switchMode?: DecodedSwitchModeQuery & {
    bridge: SwitchModeBridge
    toolName?: SwitchModeHostTool | "question"
  }
  /**
   * Present when CreatePlan needs a host tool: either a native plan stage that
   * owns the write *and* the approval, or the emulated `question` prompt the
   * provider raises after writing the plan itself. `planUri` is set only for
   * the emulated path, where the provider already knows the file it wrote.
   */
  createPlan?: DecodedCreatePlanQuery & {
    bridge: CreatePlanBridge
    toolName: typeof CURSOR_PLAN_STAGE_TOOL | "question"
    planUri?: string
    /** Filesystem path of the plan the provider just wrote (emulated path). */
    planPath?: string
    questionInput?: ReturnType<typeof createPlanApprovalQuestionInput>
    /** The plan to show the user before they approve it (emulated path only). */
    planReview?: string
  }
  /** Present when an image generation was approved: the target to expect. */
  generateImage?: DecodedGenerateImageQuery
}

export type HandleInteractionQueryOptions = {
  /**
   * True when the host advertises `question` on this turn and tool calls are
   * allowed, i.e. the provider can actually surface the prompt to the user.
   */
  canBridgeAskQuestion?: boolean
  /**
   * True when tool calls are allowed this turn (needed before advertising can
   * be checked for plan_enter / plan_exit).
   */
  allowTools?: boolean
  /**
   * Host tool names advertised this turn. Used to resolve SwitchMode →
   * plan_enter / plan_exit only when the matching tool is present.
   */
  advertisedTools?: ReadonlySet<string> | Iterable<string>
  /**
   * True when `cursor_image_save` is advertised, i.e. a generated image can be
   * committed to disk under OpenCode's permission. Approving generation the
   * provider cannot then save would spend the user's Cursor quota for nothing.
   */
  canSaveGeneratedImage?: boolean
  /**
   * Session workspace root used to place CreatePlan files via {@link hostPlansDir}
   * (host project-config `plans/` in a git worktree, else host global data/plans).
   */
  workspaceRoot?: string
  /** True when the advertised host plan-stage tool is available. */
  canBridgeCreatePlan?: boolean
  /**
   * True when the provider has recorded an approved Cursor plan/spec mode for
   * this session. A written plan then ends with an execution-approval prompt,
   * which is the transition out of planning; outside plan mode there is none.
   */
  planModeActive?: boolean
  /**
   * Cursor unified mode currently recorded for this session. A SwitchMode to
   * the mode already in effect needs no approval, matching Cursor's own IDE
   * handler and keeping the plan-approval prompt from firing twice.
   */
  activeCursorModeId?: string
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
 * headless policy (reject; ack a few no-UI cases).
 *
 * Bridged / persisted exceptions:
 * - AskQuestion (#3) → OpenCode `question` tool
 * - SwitchMode (#4) → OpenCode `plan_enter` / `plan_exit` when advertised
 * - CreatePlan (#7) → host-calculated plan file via hostPlansDir (project-config
 *   `plans/` in a git worktree, else host global data/plans); empty args still
 *   get the CLI empty-`plan_uri` success ack
 * - GenerateImage (#12) → approve when `cursor_image_save` is advertised
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
  if (info.variantField === 4) {
    return handleSwitchModeQuery(info.id, info.variantBytes, options)
  }
  if (info.variantField === 7) {
    return handleCreatePlanQuery(info.id, info.variantBytes, options)
  }
  if (info.variantField === 12) {
    return handleGenerateImageQuery(info.id, info.variantBytes, options)
  }

  let response: Record<string, unknown>
  let outcome: HandledInteraction["outcome"]

  switch (info.variantField) {
    case 2:
      response = { web_search_request_response: { rejected: { reason: HEADLESS_REASON } } }
      outcome = "rejected"
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
 * SwitchMode is bridged to OpenCode `plan_enter` / `plan_exit` when advertised.
 * Cursor CLI blocks until the user approves or rejects; we hold the query open
 * until the host tool returns, then reply approved{} or rejected{reason}.
 */
function handleSwitchModeQuery(
  id: number,
  variantBytes: Uint8Array | undefined,
  options: HandleInteractionQueryOptions,
): HandledInteraction {
  const base = { id, variantField: 4, variantName: "switch_mode_request_query" } as const
  const reject = (reason: string): HandledInteraction => ({
    ...base,
    outcome: "rejected",
    reply: buildSwitchModeInteractionReply(id, { rejected: { reason } }),
  })

  if (!variantBytes) return reject(SWITCH_MODE_MISSING_QUERY_REASON)
  const decoded = decodeSwitchModeQuery(variantBytes)
  if (!decoded) return reject(SWITCH_MODE_MISSING_ARGS_REASON)

  const bridge = resolveSwitchModeBridge(decoded.args.targetModeId, {
    allowTools: options.allowTools === true,
    advertised: options.advertisedTools ?? [],
    ...(options.activeCursorModeId ? { activeModeId: options.activeCursorModeId } : {}),
  })
  if (bridge.kind === "reject") return reject(bridge.reason)

  // Lifecycle turn: approve on the wire so the model never sees a rejection, but
  // do not attach switchMode — the real turn owns session mode.
  if (bridge.kind === "ack") {
    return {
      ...base,
      outcome: "acknowledged",
      reply: buildSwitchModeInteractionReply(id, switchModeApprovedResult()),
    }
  }

  if (bridge.kind === "approve") {
    // Entering plan mode needs no host tool, so Cursor is released at once and
    // the caller records the mode for the reminder injected on later Runs.
    return {
      ...base,
      outcome: "approved",
      switchMode: { ...decoded, bridge },
      reply: buildSwitchModeInteractionReply(id, switchModeApprovedResult()),
    }
  }

  return {
    ...base,
    outcome: "bridged",
    switchMode: {
      ...decoded,
      bridge,
      toolName: bridge.kind === "native" ? bridge.toolName : "question",
    },
    // Keep Cursor waiting until the host tool returns, matching CLI blocking on
    // the mode-switch approval prompt.
    reply: undefined,
  }
}

/** `AgentClientMessage{interaction_response{switch_mode_request_response}}`. */
export function buildSwitchModeInteractionReply(
  id: number,
  result: Record<string, unknown>,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    interaction_response: {
      id,
      switch_mode_request_response: result,
    },
  })
}

/** `AgentClientMessage{interaction_response{create_plan_request_response}}`. */
export function buildCreatePlanInteractionReply(
  id: number,
  result: Record<string, unknown>,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    interaction_response: {
      id,
      create_plan_request_response: { result },
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

/**
 * CreatePlan persistence and execution approval. Cursor CLI writes
 * `~/.cursor/plans/*.plan.md` with YAML frontmatter; this provider writes plain
 * markdown under the host's calculated plans dir (`hostPlansDir` / path bridge)
 * so switching models and hosts stays coherent. Empty / missing args keep the
 * CLI empty-`plan_uri` success ack (nothing to write).
 *
 * Writing the plan never asks; executing it always does. Which channel raises
 * that prompt is resolved from the advertised catalog by
 * {@link resolveCreatePlanBridge}, and every channel reports the same outcome:
 * `success` means the user approved execution, `error` means the plan was
 * written but not accepted, so the model keeps planning.
 */
function handleCreatePlanQuery(
  id: number,
  variantBytes: Uint8Array | undefined,
  options: HandleInteractionQueryOptions,
): HandledInteraction {
  const base = { id, variantField: 7, variantName: "create_plan_request_query" } as const
  const reply = (result: Record<string, unknown>): HandledInteraction => ({
    ...base,
    outcome: result.error ? "failed" : "acknowledged",
    reply: encodeMessage("AgentClientMessage", {
      interaction_response: {
        id,
        create_plan_request_response: { result },
      },
    }),
  })

  // Missing / empty args: CLI headless fallback — success with empty plan_uri.
  if (!variantBytes) return reply({ success: {}, plan_uri: "" })
  const decoded = decodeCreatePlanQuery(variantBytes)
  if (!decoded) return reply({ success: {}, plan_uri: "" })

  const bridge = resolveCreatePlanBridge({
    allowTools: options.allowTools === true,
    canStage: options.canBridgeCreatePlan === true,
    planModeActive: options.planModeActive === true,
    advertised: options.advertisedTools ?? [],
  })

  // The host plan-stage tool owns the write and the approval prompt together.
  if (bridge.kind === "stage") {
    return {
      ...base,
      outcome: "bridged",
      createPlan: { ...decoded, bridge, toolName: CURSOR_PLAN_STAGE_TOOL },
      reply: undefined,
    }
  }

  // A lifecycle turn (title generation, compaction) runs alongside the real one
  // and would otherwise write a second, throwaway plan file for the same
  // request. Ack it the CLI way instead of persisting anything.
  if (options.allowTools !== true) return reply({ success: {}, plan_uri: "" })

  const workspaceRoot = options.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return reply({
      error: { error: "CreatePlan requires a workspace root to write the plan file" },
      plan_uri: "",
    })
  }

  const written = writeOpencodePlanFile(decoded.args, workspaceRoot)
  if (!written.ok) {
    return reply({ error: { error: written.error }, plan_uri: "" })
  }

  // The plan is on disk either way; only execution needs the user. Hold Cursor's
  // query open while the host asks, exactly as the CLI blocks on its own prompt.
  if (bridge.kind === "approve") {
    return {
      ...base,
      outcome: "bridged",
      createPlan: {
        ...decoded,
        bridge,
        toolName: "question",
        planUri: written.planUri,
        planPath: written.planPath,
        questionInput: createPlanApprovalQuestionInput(written.planPath),
        planReview: renderPlanReviewMessage(written.markdown, written.planPath),
      },
      reply: undefined,
    }
  }

  return reply({ success: {}, plan_uri: written.planUri })
}

/**
 * GenerateImage approval. Cursor renders its own confirmation in the CLI; here
 * the meaningful gate is OpenCode's `edit` permission raised by
 * `cursor_image_save` when the finished bytes are written, so generation itself
 * is approved whenever the provider can actually commit the result. Approving
 * without a commit path would spend Cursor quota on an image that then has
 * nowhere to go.
 */
function handleGenerateImageQuery(
  id: number,
  variantBytes: Uint8Array | undefined,
  options: HandleInteractionQueryOptions,
): HandledInteraction {
  const base = { id, variantField: 12, variantName: "generate_image_request_query" } as const
  const reject = (reason: string): HandledInteraction => ({
    ...base,
    outcome: "rejected",
    reply: encodeMessage("AgentClientMessage", {
      interaction_response: { id, generate_image_request_response: { rejected: { reason } } },
    }),
  })

  if (!variantBytes) return reject("Missing generate image query")
  const decoded = decodeGenerateImageQuery(variantBytes)
  if (!decoded) return reject("Missing generate image arguments")
  if (!options.canSaveGeneratedImage) {
    return reject(
      "This OpenCode agent cannot save a generated image, so generating one would "
      + "produce nothing. Describe the image in your reply instead.",
    )
  }

  return {
    ...base,
    outcome: "acknowledged",
    generateImage: decoded,
    reply: encodeMessage("AgentClientMessage", {
      interaction_response: {
        id,
        // Cursor's CLI returns the description the user may have edited at the
        // prompt. There is no text field on OpenCode's permission, so the
        // model's own description is passed through unchanged.
        generate_image_request_response: { approved: { description: decoded.description } },
      },
    }),
  }
}
