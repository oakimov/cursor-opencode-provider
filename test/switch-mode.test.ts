import { describe, expect, it, beforeEach } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  USER_REJECTED_REASON,
  cursorModeSystemReminder,
  decodeSwitchModeQuery,
  mapSwitchModeTarget,
  resetActiveCursorModesForTests,
  resolveSwitchModeHostTool,
  setActiveCursorMode,
  switchModeResultFromToolOutput,
  switchModeToolInput,
  takeActiveCursorModeReminder,
} from "../src/protocol/switch-mode.js"
import { parseDisplayToolCall, resolveBridgedOpenCodeToolCall } from "../src/protocol/tool-call-bridge.js"

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

describe("resolveSwitchModeHostTool", () => {
  it("requires the matching host tool to be advertised", () => {
    expect(
      resolveSwitchModeHostTool("plan", {
        allowTools: true,
        advertised: ["plan_exit"],
      }).ok,
    ).toBe(false)
    expect(
      resolveSwitchModeHostTool("plan", {
        allowTools: true,
        advertised: ["plan_enter"],
      }),
    ).toEqual({ ok: true, toolName: "plan_enter" })
  })

  it("rejects when tools are not allowed this turn", () => {
    const resolved = resolveSwitchModeHostTool("agent", {
      allowTools: false,
      advertised: ["plan_exit"],
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain("`plan_exit`")
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
})

describe("handleInteractionQuery switch-mode routing", () => {
  const handle = (
    payload: Uint8Array,
    options: { allowTools?: boolean; advertisedTools?: string[] } = {},
  ) => {
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    return handleInteractionQuery(query, payload, {
      allowTools: options.allowTools ?? true,
      advertisedTools: options.advertisedTools ?? ["plan_enter", "plan_exit"],
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

  it("rejects when the host tool is unavailable", () => {
    const handled = handle(switchModePayload(), {
      allowTools: true,
      advertisedTools: ["question"],
    })
    expect(handled.outcome).toBe("rejected")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.switch_mode_request_response.rejected.reason).toContain("`plan_enter`")
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
