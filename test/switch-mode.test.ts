import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  USER_REJECTED_REASON,
  cursorModeSystemReminder,
  decodeSwitchModeQuery,
  cursorAgentModeWireValue,
  followHostPlanAgent,
  getActiveCursorMode,
  isBridgedCursorPlanModeActive,
  mapSwitchModeTarget,
  resetActiveCursorModesForTests,
  resolveSwitchModeBridge,
  setActiveCursorMode,
  switchModeResultFromToolOutput,
  switchModeToolInput,
  takeActiveCursorModeReminder,
  takeHostPlanAgentNote,
  PLAN_EXIT_BY_USER_REASON,
  PLAN_EXIT_VIA_CREATE_PLAN_REASON,
} from "../src/protocol/switch-mode.js"
import { parseDisplayToolCall, resolveBridgedOpenCodeToolCall } from "../src/protocol/tool-call-bridge.js"
import { pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  createPromptHostAgentModeSwitch,
  flushHostAgentModeSwitch,
  hostAgentSwitchPromptText,
  isHostPlanEntryPending,
  queueHostAgentModeSwitch,
  resetHostAgentModeSwitchForTests,
  setHostAgentModeSwitch,
} from "../src/host-agent-mode.js"

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

  it("routes leaving the host plan agent without plan_exit through CreatePlan's approval", () => {
    // With `question`, CreatePlan asks whether to implement; SwitchMode points there.
    expect(resolveSwitchModeBridge("agent", {
      allowTools: true,
      advertised: ["question", "read"],
      hostAgent: "plan",
    })).toEqual({ kind: "reject", reason: PLAN_EXIT_VIA_CREATE_PLAN_REASON })
    // Nothing can ask: the user leaves plan mode by switching agents.
    expect(resolveSwitchModeBridge("agent", {
      allowTools: true,
      advertised: ["read"],
      hostAgent: "plan",
    })).toEqual({ kind: "reject", reason: PLAN_EXIT_BY_USER_REASON })
    // A Cursor-only plan mode has nothing on the host to leave.
    for (const hostAgent of [undefined, "build"]) {
      expect(resolveSwitchModeBridge("agent", {
        allowTools: true,
        advertised: ["question", "read"],
        ...(hostAgent ? { hostAgent } : {}),
      })).toEqual({ kind: "approve" })
    }
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
    expect(cursorModeSystemReminder("agent")!).toContain("write")
    expect(cursorModeSystemReminder("agent")!).toContain("edit")
    expect(cursorModeSystemReminder("agent", { firstTurn: false })!).toContain("write")
  })

  it("arms and consumes the first-turn reminder then still-active text", () => {
    setActiveCursorMode("sess-1", "chat")
    const first = takeActiveCursorModeReminder("sess-1")!
    expect(first).toContain("Ask mode is active")
    const second = takeActiveCursorModeReminder("sess-1")!
    expect(second).toContain("Ask mode is still active")
  })

  it("points a staged plan at the host follow-up instead of plan_exit", () => {
    const reminder = cursorModeSystemReminder("plan", {
      planExitAdvertised: true,
      planStageAdvertised: true,
    })!
    expect(reminder).toContain("waits for the host plan review")
    expect(reminder).toContain("Do not call `plan_exit` to submit or skip")
    expect(reminder).not.toContain("call OpenCode `plan_exit` so the user can approve")
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

  it("keeps bridged plan mode while the host agent is still plan, even with plan_enter advertised", () => {
    setActiveCursorMode("sess-host-plan", "plan", { bridgedPlanEntered: true })
    const reminder = takeActiveCursorModeReminder("sess-host-plan", {
      advertisedTools: ["read", "plan_enter", "plan_exit", "cursor_plan_stage"],
      hostAgent: "plan",
    })!
    expect(reminder).toContain("Plan mode is active")
    expect(isBridgedCursorPlanModeActive("sess-host-plan")).toBe(true)
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
    options: { allowTools?: boolean; advertisedTools?: string[]; activeCursorModeId?: string; hostAgent?: string } = {},
  ) => {
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    return handleInteractionQuery(query, payload, {
      allowTools: options.allowTools ?? true,
      advertisedTools: options.advertisedTools ?? ["plan_enter", "plan_exit"],
      ...(options.activeCursorModeId ? { activeCursorModeId: options.activeCursorModeId } : {}),
      ...(options.hostAgent ? { hostAgent: options.hostAgent } : {}),
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

  it("sends a plan-agent exit without plan_exit to CreatePlan's approval", () => {
    const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: "agent" })), {
      allowTools: true,
      advertisedTools: ["question", "read"],
      hostAgent: "plan",
    })
    expect(handled.outcome).toBe("rejected")
    expect(handled.switchMode).toBeUndefined()
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.switch_mode_request_response.rejected.reason).toBe(PLAN_EXIT_VIA_CREATE_PLAN_REASON)
  })

  it("approves leaving a Cursor-only plan mode outright", () => {
    const handled = handle(switchModePayload(switchModeArgs({ target_mode_id: "agent" })), {
      allowTools: true,
      advertisedTools: ["question", "read"],
      hostAgent: "build",
    })
    expect(handled.outcome).toBe("approved")
    expect(handled.switchMode?.bridge.kind).toBe("approve")
    expect(handled.switchMode?.toolName).toBeUndefined()
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
  payloads: Array<Uint8Array | Frame>,
  writes: Uint8Array[],
  advertised: string[],
): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => {
      const payload = payloads[index++]
      return payload === undefined ? { done: true, value: undefined }
        : { done: false, value: payload instanceof Uint8Array ? { flags: 0, payload } : payload }
    },
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
    billing: { key: "run:test", prefixTokens: 0 },
  } as unknown as CursorSession
}

const turnEnded = encodeMessage("AgentServerMessage", {
  interaction_update: { turn_ended: { input_tokens: 5, output_tokens: 2 } },
})

async function runSwitchMode(payloads: Array<Uint8Array | Frame>, advertised: string[]) {
  const writes: Uint8Array[] = []
  const parts: any[] = []
  const session = switchModeSession(payloads, writes, advertised)
  await pump(
    session,
    { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
    { textId: "text", reasoningId: "reasoning" },
  )
  return { session, writes, parts }
}

describe("SwitchMode over a held-open Run without host plan tools", () => {
  beforeEach(() => {
    resetActiveCursorModesForTests()
    resetHostAgentModeSwitchForTests()
  })
  afterEach(() => resetHostAgentModeSwitchForTests())

  it("accepts the server's explicit cancellation only for its own plan handoff", async () => {
    setHostAgentModeSwitch(() => {}, { resumesTurn: true })
    const terminal = { flags: 2, payload: new TextEncoder().encode('{"error":{"code":"canceled"}}') }
    const { session, parts } = await runSwitchMode([switchModePayload(), terminal], ["read"])
    expect(session.closed).toBe(true)
    expect(parts.at(-1)?.finishReason.unified).toBe("stop")
    expect(parts.at(-1)?.providerMetadata.cursor.occupancyOnly).toBe(true)
    expect(parts.at(-1)?.usage.inputTokens.total).toBe(0)
    resetHostAgentModeSwitchForTests()
    await expect(runSwitchMode([terminal], ["read"])).rejects.toMatchObject({ code: "canceled" })
    setHostAgentModeSwitch(() => {}, { resumesTurn: true })
    await expect(runSwitchMode([switchModePayload(), {
      flags: 2, payload: new TextEncoder().encode('{"error":{"code":"internal"}}'),
    }], ["read"])).rejects.toMatchObject({ code: "internal" })
  })

  it("stops the old Run before the resuming host starts its plan agent", async () => {
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) }, { resumesTurn: true })
    const { session, writes, parts } = await runSwitchMode(
      [switchModePayload(), turnEnded], ["question", "read", "write"],
    )
    expect(writes).toHaveLength(2)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
      .switch_mode_request_response.approved).toBeDefined()
    expect(decodeMessage<any>("AgentClientMessage", writes[1]!).conversation_action
      .cancel_action.reason).toBe("host_plan_agent_handoff")
    expect(session.closed).toBe(true)
    expect(session.pending.size).toBe(0)
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(parts.at(-1)?.finishReason.unified).toBe("stop")
    expect(switched).toEqual([])
    expect(await flushHostAgentModeSwitch(session.openCodeSessionId, {
      cursorSessionID: session.sessionId, terminal: session.closed,
    })).toBe(true)
    expect(switched).toEqual(["plan"])
  })

  it("does not cancel a mode the host declines to own", async () => {
    setHostAgentModeSwitch(() => {}, { resumesTurn: true, accepts: () => false })
    const { writes } = await runSwitchMode([switchModePayload(), turnEnded], ["read"])
    expect(writes).toHaveLength(1)
    expect(isHostPlanEntryPending("switch-mode-opencode-session")).toBe(false)
  })

  it("approves plan entry inline, emits no tool call, and keeps pumping", async () => {
    const switched: string[] = []
    setHostAgentModeSwitch(({ sessionID, targetModeID }) => {
      switched.push(`${sessionID}:${targetModeID}`)
    })
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
    // Without a host plan_exit, CreatePlan asks through `question` whether to implement.
    expect(reminder).toContain("record the finished plan with Cursor CreatePlan")
    expect(reminder).toContain("asked whether to switch to the build agent")
    expect(reminder).not.toContain("call OpenCode `plan_exit`")
    expect(cursorModeSystemReminder("plan", { planExitAdvertised: false, questionAdvertised: false }))
      .toContain("they switch to the build agent")
    expect(await flushHostAgentModeSwitch(session.openCodeSessionId, {
      cursorSessionID: session.sessionId,
      terminal: true,
    })).toBe(true)
    expect(switched).toEqual(["switch-mode-opencode-session:plan"])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("discards a queued native-agent switch when its owning Run was superseded", async () => {
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    expect(queueHostAgentModeSwitch({
      sessionID: "oc-session",
      cursorSessionID: "cursor-old",
      targetModeID: "plan",
    })).toBe(true)

    expect(await flushHostAgentModeSwitch("oc-session", {
      cursorSessionID: "cursor-new",
      terminal: true,
    })).toBe(false)
    expect(await flushHostAgentModeSwitch("oc-session", {
      cursorSessionID: "cursor-old",
      terminal: true,
    })).toBe(false)
    expect(switched).toEqual([])
  })
})

describe("native-agent switch concurrency", () => {
  beforeEach(() => resetHostAgentModeSwitchForTests())
  afterEach(() => resetHostAgentModeSwitchForTests())

  it("runs only one callback per session and preserves a replacement queued during it", async () => {
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    setHostAgentModeSwitch(async ({ targetModeID }) => {
      seen.push(targetModeID)
      if (targetModeID === "plan") await gate
    })
    queueHostAgentModeSwitch({ sessionID: "serial", targetModeID: "plan" })
    const first = flushHostAgentModeSwitch("serial", { terminal: true })
    expect(await flushHostAgentModeSwitch("serial", { terminal: true })).toBe(false)
    queueHostAgentModeSwitch({ sessionID: "serial", targetModeID: "agent" })
    expect(await flushHostAgentModeSwitch("serial", { terminal: true })).toBe(false)
    expect(seen).toEqual(["plan"])
    release()
    expect(await first).toBe(true)
    expect(await flushHostAgentModeSwitch("serial", { terminal: true })).toBe(true)
    expect(seen).toEqual(["plan", "agent"])
    expect(await flushHostAgentModeSwitch("serial", { terminal: true })).toBe(false)
  })

  it("releases the callback lock after failure and retries the owning request", async () => {
    let attempts = 0
    setHostAgentModeSwitch(() => {
      if (++attempts === 1) throw new Error("host unavailable")
    })
    queueHostAgentModeSwitch({ sessionID: "retry", targetModeID: "plan", cursorSessionID: "old" })
    expect(await flushHostAgentModeSwitch("retry", { terminal: true, cursorSessionID: "old" })).toBe(false)
    expect(await flushHostAgentModeSwitch("retry", { terminal: true, cursorSessionID: "new" })).toBe(true)
    expect(attempts).toBe(2)
  })

  it("does not clear a replacement's Run ownership when the older callback fails", async () => {
    let reject!: (error: Error) => void
    const gate = new Promise<void>((_, rejectGate) => { reject = rejectGate })
    setHostAgentModeSwitch(async () => { await gate })
    queueHostAgentModeSwitch({ sessionID: "replacement", targetModeID: "plan", cursorSessionID: "old" })
    const first = flushHostAgentModeSwitch("replacement", { terminal: true, cursorSessionID: "old" })
    queueHostAgentModeSwitch({ sessionID: "replacement", targetModeID: "agent", cursorSessionID: "new" })
    reject(new Error("old request failed"))
    expect(await first).toBe(false)
    expect(await flushHostAgentModeSwitch("replacement", { terminal: true, cursorSessionID: "old" })).toBe(false)
    expect(await flushHostAgentModeSwitch("replacement", { terminal: true, cursorSessionID: "new" })).toBe(false)
  })
})

describe("followHostPlanAgent", () => {
  beforeEach(() => resetActiveCursorModesForTests())

  it("ends Cursor plan mode when the host leaves its plan agent", () => {
    setActiveCursorMode("s", "plan")
    expect(followHostPlanAgent("s", "plan", "build")).toBe("left")
    expect(getActiveCursorMode("s")).toBe("agent")
    expect(takeActiveCursorModeReminder("s")).toContain("You have left plan mode")
  })

  it("enters Cursor plan mode under the host plan agent, however the host got there", () => {
    // Host agent picker before the first Cursor turn: no previous agent known.
    expect(followHostPlanAgent("s", undefined, "plan")).toBe("entered")
    expect(getActiveCursorMode("s")).toBe("plan")
    // The host runs its plan agent, so the host enforces this plan mode.
    expect(isBridgedCursorPlanModeActive("s")).toBe(true)
    // Already in plan mode: nothing changes.
    expect(followHostPlanAgent("s", "plan", "plan")).toBeUndefined()

    // A Cursor-only mode under the ordinary agent yields to the host plan agent.
    setActiveCursorMode("t", "debug")
    expect(followHostPlanAgent("t", "build", "plan")).toBe("entered")
    expect(getActiveCursorMode("t")).toBe("plan")
  })

  it("leaves other modes alone outside the host plan agent", () => {
    setActiveCursorMode("s", "plan")
    expect(followHostPlanAgent("s", "build", "build")).toBeUndefined()
    expect(followHostPlanAgent("s", undefined, "build")).toBeUndefined()
    expect(followHostPlanAgent("s", "plan", undefined)).toBeUndefined()
    expect(followHostPlanAgent(undefined, "plan", "build")).toBeUndefined()
    expect(getActiveCursorMode("s")).toBe("plan")

    // Outside Cursor plan mode there is nothing to end.
    setActiveCursorMode("t", "debug")
    expect(followHostPlanAgent("t", "plan", "build")).toBeUndefined()
    expect(getActiveCursorMode("t")).toBe("debug")
  })
})

describe("cursorAgentModeWireValue", () => {
  it("maps Cursor modes onto agent.v1.AgentMode as Cursor CLI does", () => {
    expect(cursorAgentModeWireValue("plan")).toBe(3)
    expect(cursorAgentModeWireValue(" Plan ")).toBe(3)
    expect(cursorAgentModeWireValue("chat")).toBe(2)
    expect(cursorAgentModeWireValue("ask")).toBe(2)
    expect(cursorAgentModeWireValue("search")).toBe(2)
    expect(cursorAgentModeWireValue("debug")).toBe(4)
    for (const mode of ["agent", "build", "spec", "triage", "project", "multitask", "", undefined]) {
      expect(cursorAgentModeWireValue(mode)).toBe(1)
    }
  })
})

describe("takeHostPlanAgentNote", () => {
  it("leaves a host plan-stage tool's workflow alone", () => {
    resetActiveCursorModesForTests()
    expect(takeHostPlanAgentNote("s", "c", "plan", [
      { name: "plan_exit", inputSchema: { type: "object", properties: {} } },
      { name: "cursor_plan_stage" },
    ])).toBeUndefined()
  })

  beforeEach(() => resetActiveCursorModesForTests())

  const pathSchema = {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-local plan file." } },
  }

  it("translates the host workflow into CreatePlan when the host plan file is known", () => {
    const tools = [{ name: "plan_exit", inputSchema: pathSchema }]
    const note = takeHostPlanAgentNote("s", "conv-1", "plan", tools, {
      hostPlanFile: "/repo/.opencode/plans/17-x.md",
    })!
    expect(note).toContain("record it with CreatePlan")
    expect(note).toContain("/repo/.opencode/plans/17-x.md")
    expect(note).toContain("so do neither yourself")
    expect(note).not.toContain("GetMcpTools")
  })

  it("gives the plan agent plan_exit's exact arguments once per conversation", () => {
    const tools = [{ name: "read" }, { name: "plan_exit", inputSchema: pathSchema }]
    const note = takeHostPlanAgentNote("s", "conv-1", "plan", tools)!
    expect(note).toContain("MCP tool `plan_exit` on server `opencode`")
    expect(note).toContain("do not look it up with GetMcpTools first")
    expect(note).toContain("- `path` (string, optional): Workspace-local plan file.")
    expect(takeHostPlanAgentNote("s", "conv-1", "plan", tools)).toBeUndefined()
    // A rotated conversation has not seen it.
    expect(takeHostPlanAgentNote("s", "conv-2", "plan", tools)).toBeDefined()
  })

  it("describes an argument-less plan_exit and required arguments", () => {
    expect(takeHostPlanAgentNote("a", "c", "plan", [{ name: "plan_exit", inputSchema: { type: "object", properties: {} } }]))
      .toContain("It takes no arguments: call it with `{}`.")
    expect(takeHostPlanAgentNote("b", "c", "plan", [{
      name: "plan_exit",
      inputSchema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
    }])).toContain("- `plan` (string, required)")
  })

  it("stays silent outside the host plan agent or without plan_exit, and re-arms on re-entry", () => {
    const tools = [{ name: "plan_exit", inputSchema: pathSchema }]
    expect(takeHostPlanAgentNote("s", "c", "build", tools)).toBeUndefined()
    expect(takeHostPlanAgentNote("s", "c", "plan", [{ name: "read" }])).toBeUndefined()
    expect(takeHostPlanAgentNote(undefined, "c", "plan", tools)).toBeUndefined()
    expect(takeHostPlanAgentNote("s", "c", "plan", tools)).toBeDefined()
    expect(takeHostPlanAgentNote("s", "c", "build", tools)).toBeUndefined()
    expect(takeHostPlanAgentNote("s", "c", "plan", tools)).toBeDefined()
  })
})

describe("OpenCode 1.x prompt-based host-agent switch", () => {
  beforeEach(() => resetHostAgentModeSwitchForTests())

  function recorder(primary: ReadonlySet<string> = new Set(["build", "plan"])) {
    const prompts: Array<{ sessionID: string; agent: string; text: string }> = []
    const { apply, accepts } = createPromptHostAgentModeSwitch(async (input) => {
      prompts.push(input)
    }, () => primary)
    return { prompts, apply, accepts }
  }

  it("enters the host plan agent with a synthetic plan turn", async () => {
    const { prompts, apply, accepts } = recorder(new Set(["build", "plan"]))
    expect(accepts({ sessionID: "s", targetModeID: "plan", hostAgent: "build" })).toBe(true)
    expect(accepts({ sessionID: "s", targetModeID: "SPEC", hostAgent: "build" })).toBe(true)
    await apply({ sessionID: "s", targetModeID: "spec", hostAgent: "build" })
    expect(prompts).toEqual([{ sessionID: "s", agent: "plan", text: hostAgentSwitchPromptText("plan") }])
  })

  it("leaves the observed host plan agent for build", async () => {
    const { prompts, apply, accepts } = recorder()
    expect(accepts({ sessionID: "s", targetModeID: "agent", hostAgent: "plan" })).toBe(true)
    await apply({ sessionID: "s", targetModeID: "agent", hostAgent: "plan" })
    expect(prompts).toEqual([{ sessionID: "s", agent: "build", text: hostAgentSwitchPromptText("build") }])
  })

  it("accepts only a real transition of a host primary-agent session", () => {
    const { accepts } = recorder()
    // Already in the requested agent.
    expect(accepts({ sessionID: "s", targetModeID: "plan", hostAgent: "plan" })).toBe(false)
    expect(accepts({ sessionID: "s", targetModeID: "agent", hostAgent: "build" })).toBe(false)
    // Unknown, subagent, or hidden internal sessions never get a user turn.
    expect(accepts({ sessionID: "s", targetModeID: "plan" })).toBe(false)
    expect(accepts({ sessionID: "s", targetModeID: "plan", hostAgent: "summary" })).toBe(false)
    expect(accepts({ sessionID: "s", targetModeID: "plan", hostAgent: "explore" })).toBe(false)
    // A host without a plan agent, or whose agents are not known yet.
    expect(recorder(new Set(["build"])).accepts({ sessionID: "s", targetModeID: "plan", hostAgent: "build" }))
      .toBe(false)
    const unknownAgents = createPromptHostAgentModeSwitch(async () => {}, () => undefined)
    expect(unknownAgents.accepts({ sessionID: "s", targetModeID: "plan", hostAgent: "build" })).toBe(false)
  })

  it("does not queue (or defer CreatePlan for) a request the switch rejects", () => {
    const { apply, accepts } = recorder()
    setHostAgentModeSwitch(apply, { resumesTurn: true, accepts })
    expect(queueHostAgentModeSwitch({ sessionID: "bg", targetModeID: "plan", hostAgent: "summary" }))
      .toBe(false)
    expect(isHostPlanEntryPending("bg")).toBe(false)
    expect(queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "plan", hostAgent: "build" })).toBe(true)
    expect(isHostPlanEntryPending("s")).toBe(true)
  })

  it("carries the owning Run's host agent to the switch", async () => {
    const seen: Array<string | undefined> = []
    setHostAgentModeSwitch(({ hostAgent }) => {
      seen.push(hostAgent)
    })
    queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "plan", cursorSessionID: "c", hostAgent: "build" })
    expect(await flushHostAgentModeSwitch("s", { cursorSessionID: "c", terminal: true })).toBe(true)
    expect(seen).toEqual(["build"])
  })

  it("reports pending plan entry only for a switch that resumes the turn", async () => {
    setHostAgentModeSwitch(() => {})
    queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "plan", cursorSessionID: "c" })
    // A switch that only selects an agent (OpenCode 2.0) leaves planning in this Run.
    expect(isHostPlanEntryPending("s")).toBe(false)

    setHostAgentModeSwitch(() => {}, { resumesTurn: true })
    queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "plan", cursorSessionID: "c" })
    expect(isHostPlanEntryPending("s")).toBe(true)
    expect(isHostPlanEntryPending("other")).toBe(false)
    expect(await flushHostAgentModeSwitch("s", { cursorSessionID: "c", terminal: true })).toBe(true)
    expect(isHostPlanEntryPending("s")).toBe(false)

    queueHostAgentModeSwitch({ sessionID: "s", targetModeID: "agent", cursorSessionID: "c" })
    expect(isHostPlanEntryPending("s")).toBe(false)
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
