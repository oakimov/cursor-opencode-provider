import { describe, it, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  buildOpenCodeInteractionGuidance,
  estimateTokens,
  extractPromptHistory,
  groundCheckpointTurnText,
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
      { name: "todoread" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `question` tool")
    expect(guidance).toContain("OpenCode `todowrite` / `todoread`")
    expect(guidance).toContain("do not use Cursor TodoWrite")
    expect(guidance).toContain("do not narrate Cursor-vs-OpenCode todo-tool differences")
    expect(guidance).not.toContain("opencode-todowrite")
    expect(guidance).not.toContain("TodoRead is missing")
    expect(guidance).toContain("Cursor-native CreatePlan is accepted as a Cursor interaction")
    expect(guidance).toContain("Do not narrate that CreatePlan is missing")
    expect(guidance).toContain("Emit the actual tool call")
    expect(guidance).not.toContain("`plan_enter`")
    expect(guidance).not.toContain("`webfetch`")
  })

  it("tells a staged plan to follow the host approval call", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "cursor_plan_stage" },
      { name: "plan_enter" },
      { name: "plan_exit" },
      { name: "write" },
    ], false, "/workspace/project")
    expect(guidance).toContain("waits for the host plan review")
    expect(guidance).toContain("Do not call `plan_exit` to submit or skip")
    expect(guidance).not.toContain("handles execution approval")
  })

  it("uses native plan tools and collision-safe custom web aliases", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "plan_enter" },
      { name: "plan_exit" },
      { name: "custom_websearch" },
      { name: "custom_webfetch" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `plan_enter` tool")
    expect(guidance).toContain("Cursor-native SwitchMode requests for plan/spec")
    expect(guidance).toContain("OpenCode `plan_exit` tool")
    expect(guidance).toContain("Cursor-native SwitchMode for any non-plan target")
    expect(guidance).toContain("Cursor-native CreatePlan is accepted as a Cursor interaction")
    expect(guidance).toContain("`custom_websearch`")
    expect(guidance).toContain("`custom_webfetch`")
    expect(guidance).not.toContain("OpenCode `custom_web")
    expect(guidance).not.toContain("`todowrite`")
    // AskQuestion is named only in the bridged-interactions note; without
    // `question` advertised there must be no host-tool redirect.
    expect(guidance).not.toContain("OpenCode `question` tool")
  })

  it("prefers OpenCode todos even when plan_enter is also advertised", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "plan_enter" },
      { name: "todowrite" },
      { name: "todoread" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `plan_enter` tool")
    expect(guidance).toContain("OpenCode `todowrite` / `todoread`")
    expect(guidance).toContain("do not use Cursor TodoWrite")
    expect(guidance).toContain("do not narrate Cursor-vs-OpenCode todo-tool differences")
  })

  it("does not alter compaction and clarifies bridged interactions are not MCP tools", () => {
    expect(buildOpenCodeInteractionGuidance([
      { name: "question" },
    ], true, "/workspace/project")).toBeUndefined()
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(guidance).toContain("these direct tools for this turn: `bash`, `read`")
    expect(guidance).toContain("Call only tools in that direct OpenCode list")
    expect(guidance).toContain("not an OpenCode or MCP catalog tool")
    expect(guidance).toContain("do not narrate that they are missing")
    expect(guidance).toContain("without claiming a missing MCP tool")
    expect(guidance).not.toContain("OpenCode `question` tool")
    expect(buildOpenCodeInteractionGuidance([], false, "/workspace/project")).toBeUndefined()
  })

  it("requires absolute path arguments when the host file tools use path", () => {
    const opencode2 = buildOpenCodeInteractionGuidance([
      {
        name: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      { name: "shell" },
    ], false, "/workspace/project")
    expect(opencode2).toContain("take `path` as an absolute path")
    expect(opencode2).toContain("do not invent a different absolute prefix")

    const classic = buildOpenCodeInteractionGuidance([
      {
        name: "read",
        inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
      },
      { name: "bash" },
    ], false, "/workspace/project")
    expect(classic).not.toContain("take `path` as an absolute path")
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

  it("distinguishes OpenCode execute Code Mode from the shell tool", () => {
    const withShell = buildOpenCodeInteractionGuidance([
      { name: "execute" },
      { name: "shell" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(withShell).toContain("OpenCode `execute` is Code Mode JavaScript (`code`)")
    expect(withShell).toContain("it is not a shell")
    expect(withShell).toContain("call OpenCode `shell`")
    expect(withShell).toContain("Do not pass `command` to `execute`")
    expect(withShell).toContain("Call tools named in the direct list by their own names, even when a server instruction says to reach them through `execute`")
    expect(withShell).toContain("Use `execute` only for tools that appear in the host Code Mode catalog")
    expect(withShell).toContain("exact paths and signatures from that catalog or its `search` function")
    expect(withShell).toContain("call `execute` with `{ code }`")
    expect(withShell).not.toContain("including MCP server tools")

    const withBash = buildOpenCodeInteractionGuidance([
      { name: "execute" },
      { name: "bash" },
    ], false, "/workspace/project")
    expect(withBash).toContain("call OpenCode `bash`")

    const executeOnly = buildOpenCodeInteractionGuidance([
      { name: "execute" },
    ], false, "/workspace/project")
    expect(executeOnly).toContain("Do not pass `command` to `execute`")
    expect(executeOnly).not.toContain("call OpenCode `shell`")
    expect(executeOnly).not.toContain("call OpenCode `bash`")
    expect(executeOnly).toContain("host Code Mode catalog")

    const withoutExecute = buildOpenCodeInteractionGuidance([
      { name: "shell" },
    ], false, "/workspace/project")
    expect(withoutExecute).not.toContain("host Code Mode catalog")
  })

  it("prefers edit and write over shell file mutation", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
      { name: "edit" },
      { name: "write" },
    ], false, "/workspace/project")

    expect(guidance).toContain("OpenCode `edit` for targeted changes")
    expect(guidance).toContain("`write` to create files")
    expect(guidance).toContain("do not use shell, Python, or heredocs")
    expect(guidance).toContain("Never use a read result as complete file content")
    expect(guidance).toContain("output is capped, partial")
  })

  it("documents Cursor-native Task subtype mapping when subagents are advertised", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      {
        name: "task",
        inputSchema: {
          properties: {
            subagent_type: { enum: ["general", "explore", "scout"] },
          },
        },
      },
    ], false, "/workspace/project")

    expect(guidance).toContain("Native Cursor Task/subagent requests are executed through OpenCode `task`")
    expect(guidance).toContain("`generalPurpose`")
    expect(guidance).toContain("`bugbot`, `security-review`, and `explore` select host `explore`")
    expect(guidance).toContain("Host `scout` is available")
    expect(guidance).toContain("local repository discovery still uses `bugbot`/`explore`")
  })

  it("documents Cursor-native Task routing through OpenCode 2 subagent", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      {
        name: "subagent",
        description: "Available subagents: - explore: Fast. - general: General-purpose.",
        inputSchema: {
          properties: {
            agent: { type: "string" },
          },
        },
      },
    ], false, "/workspace/project")

    expect(guidance).toContain("Native Cursor Task/subagent requests are executed through OpenCode `subagent`")
    expect(guidance).toContain("Spawnable host agents this turn: `explore`, `general`.")
    expect(guidance).not.toContain("OpenCode `task`")
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

  const toolHistoryPrompt = [
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
    ] as LanguageModelV3CallOptions["prompt"]

  it("omits historical tool results from normal rebases", () => {
    const history = extractPromptHistory(toolHistoryPrompt)
    expect(history).toEqual([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "Checking the debug log and recent tool-call behavior.",
      },
    ])
    expect(JSON.stringify(history)).not.toContain("Tool result")
    expect(JSON.stringify(history)).not.toContain("ACTUAL DEBUG LOG OUTPUT")
  })

  it("keeps compaction tool evidence as OpenCode host observations", () => {
    const history = extractPromptHistory(toolHistoryPrompt, { toolResults: "all" })
    expect(history).toEqual([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "Checking the debug log and recent tool-call behavior.",
      },
      {
        role: "user",
        content:
          'OpenCode host observation {"source":"opencode-tool","tool":"bash","callId":"1","status":"completed"}:\n' +
          "ACTUAL DEBUG LOG OUTPUT\n\n" +
          'OpenCode host observation {"source":"opencode-tool","tool":"grep","callId":"2","status":"error"}:\n' +
          "ACTUAL GREP ERROR",
      },
    ])
    expect(history[2]?.content).not.toContain("Tool result")
  })

  it("keeps only trailing tool results for interrupted continuation recovery", () => {
    const prompt = [
      ...toolHistoryPrompt.slice(0, -1),
      { role: "user", content: "Run one more check" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "3", toolName: "read", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "3", toolName: "read", output: { type: "text", value: "LATEST FILE" } },
        ],
      },
    ] as LanguageModelV3CallOptions["prompt"]

    const history = extractPromptHistory(prompt, {
      preserveTrailingUser: true,
      toolResults: "trailing",
    })
    expect(JSON.stringify(history)).not.toContain("ACTUAL DEBUG LOG OUTPUT")
    expect(JSON.stringify(history)).toContain("LATEST FILE")
    expect(history.at(-1)).toEqual({
      role: "user",
      content:
        "Run one more check\n\n" +
        'OpenCode host observation {"source":"opencode-tool","tool":"read","callId":"3","status":"completed"}:\nLATEST FILE',
    })
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

describe("groundCheckpointTurnText", () => {
  const root = "/workspace/project"
  const pathTools = [{
    name: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }]
  const filePathTools = [
    {
      name: "read",
      inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
    },
    { name: "bash" },
  ]

  it("leaves a fresh turn unchanged", () => {
    expect(groundCheckpointTurnText("fix it", false, root, pathTools)).toBe("fix it")
  })

  it("restates the root on a checkpoint and requires path only for that dialect", () => {
    const grounded = groundCheckpointTurnText("fix it", true, root, pathTools)
    expect(grounded.startsWith("fix it\n\nWorkspace root:")).toBe(true)
    expect(grounded).toContain(JSON.stringify(root))
    expect(grounded).toContain("take `path` as an absolute path")
    expect(grounded).toContain("never invent an absolute prefix")
    expect(groundCheckpointTurnText(grounded, true, "/other", pathTools)).toBe(grounded)

    const classic = groundCheckpointTurnText("fix it", true, root, filePathTools)
    expect(classic).toContain("Workspace root:")
    expect(classic).not.toContain("take `path` as an absolute path")

    const inferred = groundCheckpointTurnText("fix it", true, root, [{ name: "shell" }])
    expect(inferred).toContain("take `path` as an absolute path")
    expect(groundCheckpointTurnText("fix it", true, root, [{ name: "bash" }])).not.toContain(
      "take `path` as an absolute path",
    )
  })

  it("does not invent a root when none is known", () => {
    expect(groundCheckpointTurnText("fix it", true, "  ", pathTools)).toBe("fix it")
    expect(groundCheckpointTurnText("", true, root, pathTools).startsWith("Workspace root:")).toBe(true)
  })
})
