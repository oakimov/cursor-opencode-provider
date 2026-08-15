import { describe, expect, it } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  answerForQuestion,
  askQuestionResultFromToolOutput,
  askQuestionToolInput,
  decodeAskQuestionQuery,
  displayOptions,
  isCatchAllOptionLabel,
  parseAnswerSegments,
  type CursorAskQuestionItem,
} from "../src/protocol/ask-question.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import { deliverContinuationResults, pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

// ── fixtures ─────────────────────────────────────────────────────────────────

const QUESTION: CursorAskQuestionItem = {
  id: "q1",
  prompt: "Which cache should we use?",
  options: [
    { id: "opt_redis", label: "Redis" },
    { id: "opt_memory", label: "In-memory" },
  ],
  allowMultiple: false,
}

function askQuestionArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Cache strategy",
    questions: [
      {
        id: "q1",
        prompt: "Which cache should we use?",
        options: [
          { id: "opt_redis", label: "Redis" },
          { id: "opt_memory", label: "In-memory" },
        ],
        allow_multiple: false,
      },
    ],
    ...overrides,
  }
}

function askQuestionPayload(
  args: Record<string, unknown> = askQuestionArgs(),
  toolCallId = "tool_abc",
  id = 42,
): Uint8Array {
  const query = encodeMessage("AskQuestionInteractionQuery", { args, tool_call_id: toolCallId })
  return encodeMessage("AgentServerMessage", {
    interaction_query: { id, ask_question_interaction_query: query },
  })
}

/** OpenCode's `question` tool output format (tool/question.ts). */
function questionToolOutput(pairs: Array<[string, string]>): string {
  const formatted = pairs.map(([q, a]) => `"${q}"="${a}"`).join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

// ── translation parity with Cursor CLI interaction-utils ─────────────────────

describe("ask-question display options (CLI Q7 parity)", () => {
  it("recognises the CLI's catch-all label forms", () => {
    for (const label of [
      "Other",
      " other ",
      "SOMETHING ELSE",
      "Other: explain",
      "Other - explain",
      "Other (explain)",
      "Something else: explain",
    ]) {
      expect(isCatchAllOptionLabel(label)).toBe(true)
    }
    for (const label of ["Otherwise", "Another option", "Redis"]) {
      expect(isCatchAllOptionLabel(label)).toBe(false)
    }
  })

  it("drops only a trailing catch-all, because OpenCode adds its own", () => {
    const withOther: CursorAskQuestionItem = {
      ...QUESTION,
      options: [...QUESTION.options, { id: "opt_other", label: "Other" }],
    }
    expect(displayOptions(withOther).map((o) => o.id)).toEqual(["opt_redis", "opt_memory"])
    expect(displayOptions(QUESTION).map((o) => o.id)).toEqual(["opt_redis", "opt_memory"])
  })

  it("keeps a catch-all that is not last", () => {
    const leading: CursorAskQuestionItem = {
      ...QUESTION,
      options: [{ id: "opt_other", label: "Other" }, ...QUESTION.options],
    }
    expect(displayOptions(leading)).toHaveLength(3)
  })
})

describe("ask-question → OpenCode question tool input", () => {
  it("maps title, prompt, options and multi-select", () => {
    const input = askQuestionToolInput({
      title: "Cache strategy",
      questions: [{ ...QUESTION, allowMultiple: true }],
      runAsync: false,
    })
    expect(input).toEqual({
      questions: [{
        question: "Which cache should we use?",
        header: "Cache strategy",
        options: [
          { label: "Redis", description: "" },
          { label: "In-memory", description: "" },
        ],
        multiple: true,
      }],
    })
  })

  it("omits `multiple` for single-select and falls back to a generic header", () => {
    const input = askQuestionToolInput({ title: "  ", questions: [QUESTION], runAsync: false })
    expect(input.questions[0]!.header).toBe("Question")
    expect("multiple" in input.questions[0]!).toBe(false)
  })

  it("truncates a header beyond OpenCode's 30-char limit", () => {
    const input = askQuestionToolInput({
      title: "An extremely long clarifying question title",
      questions: [QUESTION],
      runAsync: false,
    })
    expect(input.questions[0]!.header.length).toBeLessThanOrEqual(30)
  })
})

describe("OpenCode answers → Cursor AskQuestionResult (CLI iX parity)", () => {
  it("maps a chosen label back to its Cursor option id", () => {
    const result = askQuestionResultFromToolOutput(
      { title: "t", questions: [QUESTION], runAsync: false },
      questionToolOutput([[QUESTION.prompt, "Redis"]]),
      false,
    )
    expect(result).toEqual({
      success: { answers: [{ question_id: "q1", selected_option_ids: ["opt_redis"] }] },
    })
  })

  it("splits a multi-select answer into several option ids", () => {
    expect(
      answerForQuestion({ ...QUESTION, allowMultiple: true }, "Redis, In-memory"),
    ).toEqual({ question_id: "q1", selected_option_ids: ["opt_redis", "opt_memory"] })
  })

  it("treats an unrecognised label as the user's freeform answer", () => {
    expect(answerForQuestion(QUESTION, "Postgres with a TTL")).toEqual({
      question_id: "q1",
      freeform_text: "Postgres with a TTL",
    })
  })

  it("substitutes the literal Other for an empty freeform choice, like the CLI", () => {
    expect(answerForQuestion(QUESTION, "   ")).toEqual({ question_id: "q1" })
    expect(answerForQuestion(QUESTION, "Redis, Something bespoke")).toEqual({
      question_id: "q1",
      selected_option_ids: ["opt_redis"],
      freeform_text: "Something bespoke",
    })
  })

  it("leaves an Unanswered question empty rather than guessing", () => {
    expect(answerForQuestion(QUESTION, "Unanswered")).toEqual({ question_id: "q1" })
  })

  it("rejects when the host dismissed the prompt", () => {
    const result = askQuestionResultFromToolOutput(
      { title: "t", questions: [QUESTION], runAsync: false },
      "The user dismissed this question",
      true,
    )
    expect(result).toEqual({ rejected: { reason: "The user dismissed this question" } })
  })

  it("locates each answer positionally, tolerating quotes and commas", () => {
    const second: CursorAskQuestionItem = { ...QUESTION, id: "q2", prompt: 'Use "strict" mode?' }
    const output = questionToolOutput([
      [QUESTION.prompt, "Redis, In-memory"],
      [second.prompt, 'Yes, but only for "new" files'],
    ])
    expect(parseAnswerSegments([QUESTION, second], output)).toEqual([
      "Redis, In-memory",
      'Yes, but only for "new" files',
    ])
  })
})

describe("ask-question query decoding", () => {
  it("decodes questions, run_async and the originating tool call id", () => {
    const payload = askQuestionPayload(askQuestionArgs({ run_async: true }))
    const queryBytes = decodeMessage<any>("AgentServerMessage", payload)
      .interaction_query.ask_question_interaction_query
    const decoded = decodeAskQuestionQuery(queryBytes)!
    expect(decoded.args.title).toBe("Cache strategy")
    expect(decoded.args.runAsync).toBe(true)
    expect(decoded.args.questions[0]!.options.map((o) => o.label)).toEqual(["Redis", "In-memory"])
    expect(decoded.toolCallId).toBe("tool_abc")
  })

  it("preserves the exact args bytes for the async completion echo", () => {
    const args = askQuestionArgs({ run_async: true })
    const payload = askQuestionPayload(args)
    const queryBytes = decodeMessage<any>("AgentServerMessage", payload)
      .interaction_query.ask_question_interaction_query
    const decoded = decodeAskQuestionQuery(queryBytes)!
    expect(decoded.rawArgs).toEqual(encodeMessage("AskQuestionArgs", args))
  })

  it("returns nothing for a body with no answerable questions", () => {
    expect(decodeAskQuestionQuery(new Uint8Array())).toBeUndefined()
    expect(decodeAskQuestionQuery(encodeMessage("AskQuestionInteractionQuery", {
      args: { title: "t", questions: [] },
    }))).toBeUndefined()
  })
})

describe("handleInteractionQuery ask-question routing", () => {
  const handle = (payload: Uint8Array, canBridge: boolean) => {
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    return handleInteractionQuery(query, payload, { canBridgeAskQuestion: canBridge })
  }

  it("bridges and defers the reply when Cursor is blocking on the answer", () => {
    const handled = handle(askQuestionPayload(), true)
    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.askQuestion?.args.questions).toHaveLength(1)
  })

  it("replies async immediately for a run_async query", () => {
    const handled = handle(askQuestionPayload(askQuestionArgs({ run_async: true })), true)
    expect(handled.outcome).toBe("bridged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.ask_question_interaction_response.result.async).toBeDefined()
  })

  it("rejects with a reason naming the host tool when question is unavailable", () => {
    const handled = handle(askQuestionPayload(), false)
    expect(handled.outcome).toBe("rejected")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.ask_question_interaction_response.result.rejected.reason)
      .toContain("`question` tool")
  })
})

// ── end-to-end through the held-open Run ─────────────────────────────────────

function bridgingSession(payloads: Uint8Array[], writes: Uint8Array[]): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++] } }
      : { done: true, value: undefined },
  }
  return {
    sessionId: "ask-question-session",
    conversationId: "ask-question-conversation",
    openCodeSessionId: "ask-question-opencode-session",
    stream: {
      write(data: Uint8Array) { writes.push(data); return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    blobs: new Map(),
    displayToolCalls: new Map(),
    toolDescriptors: [{ name: "opencode-question", tool_name: "question", provider_identifier: "opencode" }],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    nextBridgedExecId: 900_000,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

async function runBridge(payload: Uint8Array) {
  const writes: Uint8Array[] = []
  const parts: any[] = []
  const session = bridgingSession([payload], writes)
  await pump(
    session,
    { enqueue(part: unknown) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<any>,
    { textId: "text", reasoningId: "reasoning" },
  )
  return { session, writes, parts }
}

describe("bridged ask-question over a held-open Run", () => {
  it("emits a question tool call and holds the interaction open", async () => {
    const { session, writes, parts } = await runBridge(askQuestionPayload())

    expect(writes).toHaveLength(0)
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall.toolName).toBe("question")
    expect(JSON.parse(toolCall.input).questions[0].question).toBe("Which cache should we use?")
    expect(session.pending.size).toBe(1)

    const delivered = deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: questionToolOutput([["Which cache should we use?", "Redis"]]),
    }] as any)

    expect(delivered).toBe(session)
    expect(writes).toHaveLength(1)
    const response = decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
    expect(response.id).toBe(42)
    expect(response.ask_question_interaction_response.result.success.answers).toEqual([
      { question_id: "q1", selected_option_ids: ["opt_redis"], freeform_text: "" },
    ])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("delivers a run_async answer as a ConversationAction echoing the original args", async () => {
    const args = askQuestionArgs({ run_async: true })
    const { session, writes, parts } = await runBridge(askQuestionPayload(args))

    // The async acknowledgement goes out immediately; the answer follows later.
    expect(writes).toHaveLength(1)
    const toolCall = parts.find((part) => part.type === "tool-call")

    deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: questionToolOutput([["Which cache should we use?", "Something bespoke"]]),
    }] as any)

    expect(writes).toHaveLength(2)
    const action = decodeMessage<any>("AgentClientMessage", writes[1]!)
      .conversation_action.async_ask_question_completion_action
    expect(action.original_tool_call_id).toBe("tool_abc")
    expect(action.original_args).toEqual(encodeMessage("AskQuestionArgs", args))
    expect(action.result.success.answers[0].freeform_text).toBe("Something bespoke")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("rejects instead of bridging when the agent does not advertise question", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = bridgingSession([
      askQuestionPayload(),
      encodeMessage("AgentServerMessage", {
        interaction_update: { turn_ended: { input_tokens: 5, output_tokens: 2 } },
      }),
    ], writes)
    session.toolDescriptors = []

    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )

    expect(session.pending.size).toBe(0)
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    const response = decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
    expect(response.ask_question_interaction_response.result.rejected).toBeDefined()
    sessionManager.close(session, "ordinary-cleanup")
  })
})
