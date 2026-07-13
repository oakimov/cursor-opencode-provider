import { describe, it, expect } from "bun:test"
import { computeAllowTools } from "../src/language-model.js"
import { buildExecClientMessages } from "../src/protocol/tools.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("computeAllowTools", () => {
  it("is false when OpenCode advertises no tools (compaction/summary)", () => {
    expect(computeAllowTools(0, undefined)).toBe(false)
    expect(computeAllowTools(0, { type: "auto" })).toBe(false)
  })

  it("is false when toolChoice is none", () => {
    expect(computeAllowTools(3, { type: "none" })).toBe(false)
  })

  it("is true when tools are present and toolChoice allows them", () => {
    expect(computeAllowTools(1, undefined)).toBe(true)
    expect(computeAllowTools(2, { type: "auto" })).toBe(true)
    expect(computeAllowTools(1, { type: "required" })).toBe(true)
  })
})

describe("refuse exec while tools disallowed", () => {
  it("builds a typed grep_result error + stream_close (compaction refuse path)", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: "",
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    expect(frames.length).toBe(2)
    const acm = decodeMessage("AgentClientMessage", frames[0]) as Record<string, unknown>
    const ecm = acm.exec_client_message as Record<string, unknown>
    expect(ecm.id).toBe(1)
    const grep = ecm.grep_result as Record<string, unknown>
    expect(grep.error).toEqual({
      error: "Tool calls are not available during this turn (summary/compaction).",
    })
    const close = decodeMessage("AgentClientMessage", frames[1]) as Record<string, unknown>
    expect(close.exec_client_control_message).toEqual({ stream_close: { id: 1 } })
  })
})
