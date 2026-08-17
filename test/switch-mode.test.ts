import { describe, expect, it, beforeEach } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  USER_REJECTED_REASON,
  cursorModeSystemReminder,
  decodeSwitchModeQuery,
  isBridgedCursorPlanModeActive,
  mapSwitchModeTarget,
  resetActiveCursorModesForTests,
  resolveSwitchModeBridge,
  setActiveCursorMode,
  switchModeResultFromQuestionOutput,
  switchModeResultFromToolOutput,
  switchModeToolInput,
  takeActiveCursorModeReminder,
  SWITCH_MODE_EXIT_QUESTION,
} from "../src/protocol/switch-mode.js"
import { parseDisplayToolCall, resolveBridgedOpenCodeToolCall } from "../src/protocol/tool-call-bridge.js"
import { deliverContinuationResults, pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

function switchModeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_mode_id: "plan",
    explanation: "Need a structured plan",
    tool_call_id: "tool_mode_1",
    ...overrides,
  }
}

function switchModePayload(
  args: Record<string, unknown> = switchModeArgs(),
  id = 42,
): Uint8Array {
  const query = encodeMessage("SwitchModeRequestQuery", { args })
  return encodeMessage("AgentServerMessage", {
    interaction_query: { id, switch_mode_request_query: query },
  })
}

describe("mapSwitchModeTarget", () => {
  it("maps plan/spec to plan_enter", () => {
    expect(mapSwitchModeTarget("plan")).toEqual({ ok: true, toolName: "plan_enter" })
    expect(mapSwitchModeTarget("SPEC")).toEqual({ ok: true, toolName: "plan_enter" })
  })

  it("maps every non-plan target to plan_exit", () => {
    for (const id of [
      "agent",
      "build",
      "chat",
      "debug",
      "edit",
      "background",
      "multitask",
      "triage",
      "project",
      "Agent",
      "unknown-mode",
    ]) {
      expect(mapSwitchModeTarget(id)).toEqual({ ok: true, toolName: "plan_exit" })
    }
  })

  it("rejects an empty target", () => {
    const mapped = mapSwitchModeTarget("  ")
    expect(mapped.ok).toBe(false)
  })
})

describe("resolveSwitchModeBridge", () => {
  it("prefers the native host tool when it is advertised", () => {
    expect(
      resolveSwitchModeBridge("plan", { allowTools: true, advertised: ["plan_enter"] }),
    ).toEqual({ kind: "native", toolName: "plan_enter" })
    expect(
      resolveSwitchModeBridge("agent", { allowTools: true, advertised: ["plan_exit"] }),
    ).toEqual({ kind: "native", toolName: "plan_exit" })
  })

  it("approves entering plan mode with no host plan tool at all", () => {
    // The failing live case: neither plan tool advertised. Entering plan mode
    // needs no host tool, so it must no longer reject.
    for (const advertised of [[], ["plan_exit"], ["question", "read", "write"]]) {
      expect(resolveSwitchModeBridge("plan", { allowTools: true, advertised })).toEqual({
        kind: "approve",
      })
    }
    expect(resolveSwitchModeBridge("SPEC", { allowTools: true, advertised: [] })).toEqual({
      kind: "approve",
    })
  })

  it("soft-acks a no-tool lifecycle turn without mutating session mode", () => {
    // OpenCode opens a tools=0 Run (title generation) alongside the real one and
    // Cursor replays the whole turn on it. A hard reject landed in the transcript
    // and the real turn narrated "mode switches are blocked". Soft-ack with
    // approved{} on the wire (no session mutation) — same pattern as CreatePlan.
    for (const target of ["plan", "spec", "agent"]) {
      expect(resolveSwitchModeBridge(target, { allowTools: false, advertised: [] })).toEqual({
        kind: "ack",
      })
    }
  })

  it("auto-approves when the requested mode is already active", () => {
    expect(resolveSwitchModeBridge("plan", {
      allowTools: true,
      advertised: ["plan_enter", "question"],
      activeModeId: "PLAN",
    })).toEqual({ kind: "approve" })
    expect(resolveSwitchModeBridge("agent", {
      allowTools: true,
      advertised: ["plan_exit", "question"],
      activeModeId: "agent",
    })).toEqual({ kind: "approve" })
  })

  it("falls back to the question prompt when leaving plan mode without plan_exit", () => {
    const bridge = resolveSwitchModeBridge("agent", {
      allowTools: true,
      advertised: ["question", "read"],
    })
    expect(bridge.kind).toBe("question")
    if (bridge.kind !== "question") throw new Error("expected question bridge")
    expect(bridge.input.questions).toHaveLength(1)
    expect(bridge.input.questions[0].question).toBe(SWITCH_MODE_EXIT_QUESTION)
    expect(bridge.input.questions[0].header).toBe("Build Agent")
    expect(bridge.input.questions[0].options.map((o) => o.label)).toEqual(["Yes", "No"])
  })

  it("rejects leaving plan mode when neither plan_exit nor question is available", () => {
    const bridge = resolveSwitchModeBridge("agent", {
      allowTools: true,
      advertised: ["read", "write"],
    })
    expect(bridge.kind).toBe("reject")
    if (bridge.kind !== "reject") throw new Error("expected reject")
    expect(bridge.reason).toContain("`plan_exit`")
    expect(bridge.reason).toContain("`question`")
  })

  it("soft-acks even an advertised host tool on a no-tool turn", () => {
    expect(resolveSwitchModeBridge("agent", {
      allowTools: false,
      advertised: ["plan_exit", "question"],
    })).toEqual({ kind: "ack" })
  })

  it("rejects an empty target", () => {
    expect(
      resolveSwitchModeBridge("  ", { allowTools: true, advertised: ["plan_enter"] }).kind,
    ).toBe("reject")
  })
})

describe("switchModeResultFromQuestionOutput", () => {
  const output = (answer: string) =>
    `User has answered your questions: "${SWITCH_MODE_EXIT_QUESTION}"="${answer}". You can now continue.`

  it("approves only on an explicit Yes", () => {
    expect(switchModeResultFromQuestionOutput(output("Yes"), false)).toEqual({ approved: {} })
    expect(switchModeResultFromQuestionOutput(output("yes"), false)).toEqual({ approved: {} })
  })

  it("keeps the model in plan mode on No, unanswered, or unparseable output", () => {
    for (const out of [output("No"), output("Unanswered"), output(""), "nonsense"]) {
      expect(switchModeResultFromQuestionOutput(out, false)).toEqual({
        rejected: { reason: USER_REJECTED_REASON },
      })
    }
  })

  it("maps a dismissed prompt to the CLI user-reject string", () => {
    expect(switchModeResultFromQuestionOutput("Question rejected", true)).toEqual({
      rejected: { reason: USER_REJECTED_REASON },
    })
  })

  it("passes a genuine tool failure through as the reason", () => {
    expect(switchModeResultFromQuestionOutput("question tool crashed", true)).toEqual({
      rejected: { reason: "question tool crashed" },
    })
  })
})

describe("decodeSwitchModeQuery", () => {
  it("decodes target, explanation, and tool call id", () => {
    const query = encodeMessage("SwitchModeRequestQuery", {
      args: switchModeArgs({ target_mode_id: "chat", explanation: "inspect" }),
    })
    const decoded = decodeSwitchModeQuery(query)!
    expect(decoded.args.targetModeId).toBe("chat")
    expect(decoded.args.explanation).toBe("inspect")
    expect(decoded.toolCallId).toBe("tool_mode_1")
  })

  it("returns undefined without a usable target", () => {
    expect(decodeSwitchModeQuery(new Uint8Array())).toBeUndefined()
    expect(
      decodeSwitchModeQuery(
        encodeMessage("SwitchModeRequestQuery", {
          args: { explanation: "x" },
        }),
      ),
    ).toBeUndefined()
  })
})

describe("switchModeResultFromToolOutput", () => {
  it("approves a successful host tool result", () => {
    expect(switchModeResultFromToolOutput("switched", false)).toEqual({ approved: {} })
  })

  it("uses the CLI user-reject string for permission / cancel style failures", () => {
    for (const out of ["", "Permission denied", "Question rejected", "cancelled by user"]) {
      expect(switchModeResultFromToolOutput(out, true)).toEqual({
        rejected: { reason: USER_REJECTED_REASON },
      })
    }
  })

  it("passes through other error text as the reject reason", () => {
    expect(switchModeResultFromToolOutput("disk full", true)).toEqual({
      rejected: { reason: "disk full" },
    })
  })

  it("advertises empty tool input", () => {
    expect(switchModeToolInput()).toEqual({})
  })
})

describe("cursorModeSystemReminder", () => {
  beforeEach(() => {
    resetActiveCursorModesForTests()
  })

  it("wraps mode guidance in a system_reminder", () => {
    const reminder = cursorModeSystemReminder("chat")!
    expect(reminder).toContain("<system_reminder>")
    expect(reminder).toContain("Ask mode is active")
    expect(reminder).toContain("</system_reminder>")
  })

  it("emits mode-specific first-turn guidance", () => {
    expect(cursorModeSystemReminder("plan")!).toContain("Plan mode is active")
    expect(cursorModeSystemReminder("debug")!).toContain("DEBUG MODE")
    expect(cursorModeSystemReminder("multitask")!).toContain("Multitask Mode is active")
    expect(cursorModeSystemReminder("triage")!).toContain("Triage mode is active")
    expect(cursorModeSystemReminder("project")!).toContain("Project Agent Mode")
    expect(cursorModeSystemReminder("background")!).toContain("background mode")
    expect(cursorModeSystemReminder("edit")!).toContain("Agent mode is active")
    expect(cursorModeSystemReminder("agent")!).toContain("Agent mode is active")
  })

  it("arms and consumes the first-turn reminder then still-active text", () => {
    setActiveCursorMode("sess-1", "chat")
    const first = takeActiveCursorModeReminder("sess-1")!
    expect(first).toContain("Ask mode is active")
    const second = takeActiveCursorModeReminder("sess-1")!
    expect(second).toContain("Ask mode is still active")
  })

  it("hands a bridged plan back to Agent mode when plan_enter is restored", () => {
    setActiveCursorMode("sess-plan", "plan", { bridgedPlanEntered: true })

    expect(isBridgedCursorPlanModeActive("sess-plan")).toBe(true)
    const active = takeActiveCursorModeReminder("sess-plan", {
      advertisedTools: ["read", "write", "plan_exit"],
    })!
    expect(active).toContain("Plan mode is active")

    const handoff = takeActiveCursorModeReminder("sess-plan", {
      advertisedTools: ["read", "edit", "plan_enter", "plan_exit"],
    })!
    expect(handoff).toContain("Agent mode is active")
    expect(isBridgedCursorPlanModeActive("sess-plan")).toBe(false)
    expect(takeActiveCursorModeReminder("sess-plan")).toBeUndefined()
  })

  it("does not treat plan_enter present from the start as a bridged-plan exit", () => {
    setActiveCursorMode("sess-native-plan", "spec")

    const first = takeActiveCursorModeReminder("sess-native-plan", {
      advertisedTools: ["read", "write", "plan_enter", "plan_exit"],
    })!
    expect(isBridgedCursorPlanModeActive("sess-native-plan")).toBe(false)
    const second = takeActiveCursorModeReminder("sess-native-plan", {
      advertisedTools: ["read", "write", "plan_enter", "plan_exit"],
    })!

    expect(first).toContain("Plan mode is active")
    expect(second).toContain("Plan mode is still active")
  })
})

describe("handleInteractionQuery switch-mode routing", () => {
  const handle = (
    payload: Uint8Array,
    options: { allowTools?: boolean; advertisedTools?: string[]; activeCursorModeId?: string } = {},
  ) => {
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    return handleInteractionQuery(query, payload, {
      allowTools: options.allowTools ?? true,
      advertisedTools: options.advertisedTools ?? ["plan_enter", "plan_exit"],
      ...(options.activeCursorModeId ? { activeCursorModeId: options.activeCursorModeId } : {}),
    })
  }

  it("bridges and defers the reply when plan_enter is advertised", () => {
    const handled = handle(switchModePayload())
    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.switchMode?.toolName).toBe("plan_enter")
    expect(handled.switchMode?.args.targetModeId).toBe("plan")
  })

  it("bridges chat/debug to plan_exit", () => {
    const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: "debug" })))
    expect(handled.outcome).toBe("bridged")
    expect(handled.switchMode?.toolName).toBe("plan_exit")
  })

  it("bridges formerly-unmapped modes through plan_exit", () => {
    for (const id of ["edit", "background", "multitask", "triage", "project"]) {
      const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: id })))
      expect(handled.outcome).toBe("bridged")
      expect(handled.switchMode?.toolName).toBe("plan_exit")
    }
  })

  it("approves entering plan mode outright when no host plan tool exists", () => {
    // Regression for the live run where both SwitchMode queries were rejected
    // because stock OpenCode advertises neither plan tool.
    const handled = handle(switchModePayload(), {
      allowTools: true,
      advertisedTools: ["question", "read", "write"],
    })
    expect(handled.outcome).toBe("approved")
    expect(handled.switchMode?.bridge.kind).toBe("approve")
    expect(handled.switchMode?.args.targetModeId).toBe("plan")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.switch_mode_request_response.approved).toBeDefined()
  })

  it("auto-approves an already-active target without a host prompt", () => {
    const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: "agent" })), {
      allowTools: true,
      advertisedTools: ["plan_exit", "question"],
      activeCursorModeId: "agent",
    })
    expect(handled.outcome).toBe("approved")
    expect(handled.switchMode?.bridge.kind).toBe("approve")
    expect(handled.switchMode?.toolName).toBeUndefined()
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.switch_mode_request_response.approved).toBeDefined()
  })

  it("bridges leaving plan mode to the question prompt when plan_exit is absent", () => {
    const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: "agent" })), {
      allowTools: true,
      advertisedTools: ["question", "read"],
    })
    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.switchMode?.toolName).toBe("question")
    expect(handled.switchMode?.bridge.kind).toBe("question")
  })

  it("rejects leaving plan mode when nothing can ask the user", () => {
    const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: "agent" })), {
      allowTools: true,
      advertisedTools: ["read", "write"],
    })
    expect(handled.outcome).toBe("rejected")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.switch_mode_request_response.rejected.reason).toContain("`plan_exit`")
  })

  it("soft-acks a lifecycle turn with approved{} and does not attach switchMode", () => {
    // Live bug: tools=0 title Run hard-rejected SwitchMode; the real turn then
    // narrated that mode switches were blocked. Soft-ack on the wire, no mode.
    const handled = handle(switchModePayload(), {
      allowTools: false,
      advertisedTools: ["plan_enter", "question"],
    })
    expect(handled.outcome).toBe("acknowledged")
    expect(handled.switchMode).toBeUndefined()
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.switch_mode_request_response.approved).toBeDefined()
    expect(response.switch_mode_request_response.rejected).toBeUndefined()
  })
})

// ── end-to-end through the held-open Run ─────────────────────────────────────

function switchModeSession(
  payloads: Uint8Array[],
  writes: Uint8Array[],
  advertised: string[],
): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++] } }
      : { done: true, value: undefined },
  }
  return {
    sessionId: "switch-mode-session",
    conversationId: "switch-mode-conversation",
    openCodeSessionId: "switch-mode-opencode-session",
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
    toolDescriptors: advertised.map((name) => ({
      name: `opencode-${name}`,
      tool_name: name,
      provider_identifier: "opencode",
    })),
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    nextBridgedExecId: 900_000,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

const turnEnded = encodeMessage("AgentServerMessage", {
  interaction_update: { turn_ended: { input_tokens: 5, output_tokens: 2 } },
})

async function runSwitchMode(payloads: Uint8Array[], advertised: string[]) {
  const writes: Uint8Array[] = []
  const parts: any[] = []
  const session = switchModeSession(payloads, writes, advertised)
  await pump(
    session,
    { enqueue(part: unknown) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<any>,
    { textId: "text", reasoningId: "reasoning" },
  )
  return { session, writes, parts }
}

describe("SwitchMode over a held-open Run without host plan tools", () => {
  beforeEach(() => resetActiveCursorModesForTests())

  it("approves plan entry inline, emits no tool call, and keeps pumping", async () => {
    // The exact live failure: 65 tools advertised, neither of them a plan tool.
    const { session, writes, parts } = await runSwitchMode(
      [switchModePayload(), turnEnded],
      ["question", "read", "write", "todowrite"],
    )

    expect(writes).toHaveLength(1)
    const response = decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
    expect(response.id).toBe(42)
    expect(response.switch_mode_request_response.approved).toBeDefined()

    // No host tool is involved, so nothing is pending and the turn ran to its end.
    expect(session.pending.size).toBe(0)
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)

    // The mode is recorded, so the next Run carries the plan contract, and it
    // points at the reachable way to ask for execution.
    const reminder = takeActiveCursorModeReminder("switch-mode-opencode-session", {
      advertisedTools: ["question", "read", "write"],
    })!
    expect(reminder).toContain("Plan mode is active")
    // Without a host plan_exit, recording the plan is the gate the model can
    // actually reach — the provider asks for execution approval right after it.
    expect(reminder).toContain("record the finished plan (Cursor CreatePlan)")
    expect(reminder).toContain("asked whether to start implementing")
    expect(reminder).not.toContain("call OpenCode `plan_exit`")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("asks the user before leaving plan mode, then approves on Yes", async () => {
    const { session, writes, parts } = await runSwitchMode(
      [switchModePayload(switchModeArgs({ target_mode_id: "agent" }))],
      ["question", "read", "write"],
    )

    // Cursor is still blocked; the approval left as a question tool call.
    expect(writes).toHaveLength(0)
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall.toolName).toBe("question")
    expect(JSON.parse(toolCall.input).questions[0].question).toBe(SWITCH_MODE_EXIT_QUESTION)
    expect(session.pending.size).toBe(1)

    const delivered = deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output:
        `User has answered your questions: "${SWITCH_MODE_EXIT_QUESTION}"="Yes". You can now continue.`,
    }] as any)

    expect(delivered).toBe(session)
    expect(writes).toHaveLength(1)
    const response = decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
    expect(response.switch_mode_request_response.approved).toBeDefined()
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("keeps the model in plan mode when the user declines execution", async () => {
    const { session, writes, parts } = await runSwitchMode(
      [switchModePayload(switchModeArgs({ target_mode_id: "agent" }))],
      ["question"],
    )
    const toolCall = parts.find((part) => part.type === "tool-call")

    deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output:
        `User has answered your questions: "${SWITCH_MODE_EXIT_QUESTION}"="No". You can now continue.`,
    }] as any)

    const response = decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
    expect(response.switch_mode_request_response.rejected.reason).toBe(USER_REJECTED_REASON)
    sessionManager.close(session, "ordinary-cleanup")
  })
})

describe("display switch_mode_tool_call mapping", () => {
  it("mirrors plan → plan_enter and agent → plan_exit", () => {
    const enter = parseDisplayToolCall("tc_enter", {
      switch_mode_tool_call: { args: { target_mode_id: "spec" } },
    })
    expect(enter?.preferredToolName).toBe("plan_enter")
    expect(enter?.bridgeable).toBe(true)
    // Display completions are not re-executed as host tools.
    expect(resolveBridgedOpenCodeToolCall(enter!, ["plan_enter"])).toBeUndefined()

    const leave = parseDisplayToolCall("tc_leave", {
      switch_mode_tool_call: { args: { target_mode_id: "agent" } },
    })
    expect(leave?.preferredToolName).toBe("plan_exit")
    expect(leave?.bridgeable).toBe(true)
  })

  it("maps former reject targets to plan_exit on the display path", () => {
    const display = parseDisplayToolCall("tc_bg", {
      switch_mode_tool_call: { args: { target_mode_id: "background" } },
    })
    expect(display?.preferredToolName).toBe("plan_exit")
    expect(display?.bridgeable).toBe(true)
    expect(resolveBridgedOpenCodeToolCall(display!, ["plan_enter", "plan_exit"])).toBeUndefined()
  })
})
