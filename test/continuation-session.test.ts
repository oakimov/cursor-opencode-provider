import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession } from "../src/session.js"
import { findContinuationSession, extractTrailingToolResults } from "../src/language-model.js"

let _seq = 0
function fakeSession(id?: string): CursorSession {
  return {
    sessionId: id ?? `sess_test_${++_seq}`,
    conversationId: `conv_test_${_seq}`,
    stream: {
      write() {},
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      destroy() {},
    } as any,
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

function toolMsg(sessionId: string, execId: number): LanguageModelV3CallOptions["prompt"][number] {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `cursor_${sessionId}_${execId}`,
        toolName: "glob",
        output: { type: "text", value: "ok" },
      },
    ],
  } as LanguageModelV3CallOptions["prompt"][number]
}

afterEach(() => {
  sessionManager.dispose()
})

describe("findContinuationSession", () => {
  it("prefers the newest tool result whose session is still pending", () => {
    const live = fakeSession("live-sess")
    sessionManager.registerPending(0, live, "grep_result")

    const toolResults = [
      { sessionId: "dead-sess", execId: 0 },
      { sessionId: "dead-sess", execId: 3 },
      { sessionId: "live-sess", execId: 0 },
    ]
    expect(findContinuationSession(toolResults)).toBe(live)
  })

  it("returns undefined when no result matches a live pending exec", () => {
    const toolResults = [
      { sessionId: "gone-a", execId: 1 },
      { sessionId: "gone-b", execId: 2 },
    ]
    expect(findContinuationSession(toolResults)).toBeUndefined()
  })

  it("skips newer results that are not pending and falls back to an older live one", () => {
    const older = fakeSession("older-sess")
    sessionManager.registerPending(5, older, "read_result")
    const toolResults = [
      { sessionId: "older-sess", execId: 5 },
      { sessionId: "newer-gone", execId: 9 },
    ]
    expect(findContinuationSession(toolResults)).toBe(older)
  })
})

describe("extractTrailingToolResults", () => {
  it("returns only tool results after the last non-tool message", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      toolMsg("old", 0),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      toolMsg("live", 1),
      toolMsg("live", 2),
    ] as LanguageModelV3CallOptions["prompt"]

    const trailing = extractTrailingToolResults(prompt)
    expect(trailing).toEqual([
      { sessionId: "live", execId: 1, toolName: "glob", output: "ok", error: undefined },
      { sessionId: "live", execId: 2, toolName: "glob", output: "ok", error: undefined },
    ])
  })

  it("returns empty when the prompt ends with a user message (fresh turn)", () => {
    // Regression: after turn_ended, the next OpenCode step still carries
    // historical tool results mid-prompt — must NOT be treated as continuation.
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      toolMsg("old", 0),
      toolMsg("old", 1),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as LanguageModelV3CallOptions["prompt"]

    expect(extractTrailingToolResults(prompt)).toEqual([])
  })

  it("returns empty for an empty prompt", () => {
    expect(extractTrailingToolResults([])).toEqual([])
  })
})
