import { describe, it, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  buildOpenCodeInteractionGuidance,
  estimateTokens,
  extractPromptHistory,
} from "../src/language-model.js"
import { buildSeedConversationState } from "../src/protocol/request.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("estimateTokens", () => {
  it("ceil-divides by 4", () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1)).toBe(1)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
  })
})

describe("buildOpenCodeInteractionGuidance", () => {
  it("redirects questions and planning only to tools advertised this turn", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "question" },
      { name: "todowrite" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `question` tool")
    expect(guidance).toContain("OpenCode `todowrite` tool")
    expect(guidance).toContain("Emit the actual tool call")
    expect(guidance).not.toContain("`plan_enter`")
    expect(guidance).not.toContain("`webfetch`")
  })

  it("uses native OpenCode plan and fetch tools when they are advertised", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "plan_enter" },
      { name: "plan_exit" },
      { name: "webfetch" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `plan_enter` tool")
    expect(guidance).toContain("OpenCode `plan_exit` tool")
    expect(guidance).toContain("OpenCode `webfetch` tool")
    expect(guidance).not.toContain("`todowrite`")
    expect(guidance).not.toContain("AskQuestion")
  })

  it("does not alter compaction and forbids native tools outside the exact catalog", () => {
    expect(buildOpenCodeInteractionGuidance([
      { name: "question" },
    ], true, "/workspace/project")).toBeUndefined()
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(guidance).toContain("exactly these executable tools for this turn: `bash`, `read`")
    expect(guidance).toContain("Task/subagents")
    expect(guidance).toContain("are unavailable; do not invoke them")
    expect(guidance).not.toContain("OpenCode `question` tool")
    expect(buildOpenCodeInteractionGuidance([], false, "/workspace/project")).toBeUndefined()
  })

  it("anchors paths to the exact workspace root", () => {
    const workspaceRoot = "/workspace/project “quoted”\nline"
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
    ], false, workspaceRoot)

    expect(guidance).toContain(`Workspace root: ${JSON.stringify(workspaceRoot)}.`)
    expect(guidance).toContain("never invent an absolute prefix")
    expect(guidance).toContain("verify uncertain paths")
  })
})

describe("extractPromptHistory", () => {
  it("keeps prior turns and drops the trailing live user message", () => {
    const history = extractPromptHistory([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "Update the anchored summary" },
    ] as LanguageModelV3CallOptions["prompt"])
    expect(history).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
  })

  it("preserves real tool results instead of inventing a used-tools claim", () => {
    const history = extractPromptHistory([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the debug log and recent tool-call behavior." },
          { type: "tool-call", toolCallId: "1", toolName: "bash", input: "{}" },
          { type: "tool-call", toolCallId: "2", toolName: "grep", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "1", toolName: "bash", output: { type: "text", value: "ACTUAL DEBUG LOG OUTPUT" } },
          { type: "tool-result", toolCallId: "2", toolName: "grep", output: { type: "error-text", value: "ACTUAL GREP ERROR" } },
        ],
      },
      { role: "user", content: "Continue" },
    ] as LanguageModelV3CallOptions["prompt"])
    expect(history).toEqual([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content:
          "Checking the debug log and recent tool-call behavior.\n\n" +
          "Tool result (bash):\nACTUAL DEBUG LOG OUTPUT\n\n" +
          "Tool error (grep):\nACTUAL GREP ERROR",
      },
    ])
    expect(history[1]?.content).not.toContain("[Used tools:")
  })
})

describe("buildSeedConversationState history", () => {
  it("embeds system + history into root_prompt_messages_json", () => {
    const bytes = buildSeedConversationState({
      systemPrompt: "sys",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    })
    const cs = decodeMessage<any>("ConversationStateStructure", bytes)
    const root = (cs.root_prompt_messages_json ?? []).map((s: string) => JSON.parse(s))
    expect(root).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
  })
})
