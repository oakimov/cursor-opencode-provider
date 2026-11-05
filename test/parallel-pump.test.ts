import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { deliverContinuationResults, drainSessionUntilTurnEnded, pump, pumpWithRecovery, resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { noteToolRequestsListedSeen, resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { OPENCODE_1_TOOL_DIALECT, OPENCODE_2_TOOL_DIALECT, toolsToDescriptors } from "../src/protocol/tools.js"
import { readSessionFrame, sessionManager, type Frame } from "../src/session.js"
import { setActiveCursorMode, resetActiveCursorModesForTests } from "../src/protocol/switch-mode.js"
import { sessionFixture } from "./session-fixture.js"

function frame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

const listed = (call_count: number) => frame({ interaction_update: { tool_requests_listed: { call_count } } })
const ended = () => frame({ interaction_update: { turn_ended: {} } })
const text = (value: string) => frame({ interaction_update: { text_delta: { text: value } } })
const shell = (id: number, tool_call_id = `call-${id}`) => frame({
  exec_server_message: { id, shell_stream_args: { command: "echo test", tool_call_id } },
})
const mode = (tool_call_id: string) => frame({ interaction_query: {
  id: 42,
  switch_mode_request_query: encodeMessage("SwitchModeRequestQuery", {
    args: { target_mode_id: "plan", tool_call_id },
  }),
} })
const question = (tool_call_id: string) => frame({ interaction_query: {
  id: 43,
  ask_question_interaction_query: encodeMessage("AskQuestionInteractionQuery", {
    tool_call_id,
    args: { questions: [{ id: "q", prompt: "Continue?", options: [{ id: "yes", label: "Yes" }] }] },
  }),
} })
const completed = (call_id: string) => frame({ interaction_update: { tool_call_completed: { call_id } } })
/**
 * ExecServerMessage #30/#31 (`ForceBackground{Shell,Subagent}Args|1 tool_call_id`)
 * are not in the decoder's schema; the pump finds them by raw field.
 */
const forceBackground = (field: number, id: number, toolCallId: string): Frame => {
  const callId = new TextEncoder().encode(toolCallId)
  const args = [0x0a, callId.length, ...callId]
  const tag = (field << 3) | 2
  const exec = [0x08, id, (tag & 0x7f) | 0x80, tag >> 7, args.length, ...args]
  return { flags: 0, payload: Uint8Array.of(0x12, exec.length, ...exec) }
}

function fixture(frames: Frame[]) {
  const writes: Uint8Array[] = []
  let reads = 0
  const iterator: AsyncIterator<Frame> = {
    next: async () => {
      reads++
      const value = frames.shift()
      return value ? { done: false, value } : { done: true, value: undefined }
    },
  }
  const tools = [{ name: "bash", description: "Run shell command" }]
  const session = sessionFixture({
    sessionId: "parallel-pump", conversationId: "parallel-conversation",
    stream: {
      write(data) { writes.push(data) }, end() {}, destroy() {}, isClosed: () => false,
      onTerminal: () => () => {},
      frames: () => ({ [Symbol.asyncIterator]: () => iterator }),
    },
    frames: iterator, pending: new Map(), displayToolCalls: new Map(),
    nextBridgedExecId: 900_000, blobs: new Map(), toolCatalog: tools,
    toolDescriptors: toolsToDescriptors(tools, "opencode"), requestContext: {},
    allowTools: true, pumpActive: false, heartbeat: null,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
  })
  return { session, writes, reads: () => reads }
}

function collect() {
  const parts: LanguageModelV3StreamPart[] = []
  const controller = {
    desiredSize: 1, close() {},
    enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
    error(error: unknown) { throw error },
  } as ReadableStreamDefaultController<LanguageModelV3StreamPart>
  return { parts, controller }
}

const ids = { textId: "text", reasoningId: "reasoning" }
const toolCalls = (parts: LanguageModelV3StreamPart[]) => parts.filter(p => p.type === "tool-call")
const finishes = (parts: LanguageModelV3StreamPart[]) => parts.filter(p => p.type === "finish")

async function authorizeRead(session: ReturnType<typeof fixture>["session"], parts: LanguageModelV3StreamPart[], execId: number) {
  const read = toolCalls(parts).find(call => call.toolName === "read")!
  expect(read).toBeDefined()
  expect(await deliverContinuationResults(session, [{
    sessionId: session.sessionId, execId, toolCallId: read.toolCallId,
    toolName: "read", output: "[Partial read: host-capped content]",
  }])).toBe(session)
}

describe("parallel tool-call pump", () => {
  beforeEach(resetToolRequestsListedSeenForTests)
  afterEach(() => {
    sessionManager.dispose()
    resetToolRequestsListedSeenForTests()
    resetTurnStateForTests()
    resetActiveCursorModesForTests()
  })

  it("emits three calls before one finish when the count arrives after the second", async () => {
    noteToolRequestsListedSeen()
    const { session, writes, reads } = fixture([shell(1), shell(2), listed(3), text("between"), shell(3), ended()])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(3)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
    expect(reads()).toBe(5)
    expect(session.pending.size).toBe(3)
    expect(session.closed).toBe(false)
    const results = toolCalls(parts).map((p, i) => ({
      toolCallId: p.toolCallId, sessionId: session.sessionId, execId: i + 1,
      toolName: p.toolName, output: "done",
    }))
    expect(await deliverContinuationResults(session, results)).toBe(session)
    expect(session.pending.size).toBe(0)
    expect(writes.length).toBeGreaterThanOrEqual(3)
    await pump(session, controller, ids)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls", "stop"])
  })

  it("finishes a counted single call immediately", async () => {
    const { session, reads } = fixture([listed(1), shell(1), ended()])
    const { controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(2)
    expect(session.parallelStep).toBeUndefined()
  })

  it("preserves immediate one-call steps before capability discovery", async () => {
    const { session, reads } = fixture([shell(1), shell(2)])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(1)
    expect(session.pending.size).toBe(1)
  })

  it("counts an internally approved interaction after an emitted exec", async () => {
    const { session, reads } = fixture([listed(2), shell(1), mode("mode-call"), text("next-generation")])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(3)
    expect(toolCalls(parts)).toHaveLength(1)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
  })

  it("counts a refused binary write and finishes without reading the next generation", async () => {
    const binary = frame({ exec_server_message: { id: 2, write_args: {
      path: "/workspace/assets/test.png", file_bytes: Uint8Array.of(0, 255, 0), tool_call_id: "binary-call",
    } } })
    const { session, reads } = fixture([listed(2), shell(1), binary, text("next-generation")])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(3)
    expect(session.pending.size).toBe(1)
  })

  it.each([false, true])("runs a streamed edit after the call before it (patch catalog: %s)", async patch => {
    const root = fs.mkdtempSync("/tmp/cursor-parallel-edit-")
    const target = path.join(root, "target.ts")
    fs.writeFileSync(target, "export const value = 1\n")
    const { session, reads, writes } = fixture([
      listed(2), shell(1),
      frame({ interaction_update: { tool_call_started: {
        call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
      } } }),
      frame({ exec_server_message: { id: 2, read_args: { path: target, tool_call_id: "edit" } } }),
      frame({ exec_server_message: { id: 3, write_args: {
        path: target, file_text: "export const value = 2\n", tool_call_id: "edit",
      } } }),
      text("later"),
    ])
    const tools = [...session.toolCatalog!, { name: "read", description: "Read" },
      ...(patch ? [{ name: "apply_patch", description: "Patch" }]
        : [{ name: "write", description: "Write" }, { name: "edit", description: "Edit" }]),
    ]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    session.requestContext.env = { workspace_paths: [root] }
    try {
      const { parts, controller } = collect()
      await pump(session, controller, ids)
      expect(reads()).toBe(4)
      // The edit's private read waits for the shell the model called before it.
      expect(toolCalls(parts).map(p => p.toolName)).toEqual(["bash"])
      expect(finishes(parts)).toHaveLength(1)
      expect(session.pending.size).toBe(2)
      const bash = toolCalls(parts)[0]!
      expect(await deliverContinuationResults(session, [{
        sessionId: session.sessionId, execId: 1, toolCallId: bash.toolCallId, toolName: "bash", output: "done",
      }])).toBe(session)
      await pump(session, controller, ids)
      expect(toolCalls(parts).map(p => p.toolName)).toEqual(["bash", "read"])
      expect(finishes(parts)).toHaveLength(2)
      expect(reads()).toBe(4)
      await authorizeRead(session, parts, 2)
      await pump(session, controller, ids)
      expect(toolCalls(parts).map(p => p.toolName)).toEqual(["bash", "read", patch ? "apply_patch" : "edit"])
      expect(session.pending.has(2)).toBe(false)
      const read = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message)
        .find(message => message?.read_result)
      expect(read.read_result.success.content).toBe("export const value = 1\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  const fileToolHosts = [
    { host: "OpenCode 1.x", dialect: OPENCODE_1_TOOL_DIALECT, shell: "bash", patchTool: "apply_patch", pathKey: "filePath" },
    { host: "OpenCode 2", dialect: OPENCODE_2_TOOL_DIALECT, shell: "shell", patchTool: "patch", pathKey: "path" },
  ] as const
  const fileToolCases = fileToolHosts.flatMap(host => (
    ["gpt", "opus", "opus-then-gpt"] as const
  ).flatMap(model => (["new", "existing"] as const).map(file => [host.host, model, file, host] as const)))

  it.each(fileToolCases)("%s: sends a %s edit_tool_call (%s file) to the host file tool", async (_name, model, file, host) => {
    const existing = file === "existing"
    const root = fs.mkdtempSync("/tmp/cursor-patch-tool-")
    const target = path.join(root, "target.txt")
    if (existing) fs.writeFileSync(target, "before\n")
    const { session, writes } = fixture([
      frame({ interaction_update: { tool_call_started: {
        call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
      } } }),
      frame({ exec_server_message: { id: 1, read_args: { path: target, tool_call_id: "edit" } } }),
      frame({ exec_server_message: { id: 2, write_args: { path: target, file_text: "created\n", tool_call_id: "edit" } } }),
      ended(),
    ])
    const base = [{ name: host.shell, description: "Shell" }, { name: "read", description: "Read" }]
    const patchTool = { name: host.patchTool, description: "Patch" }
    const editTools = [{ name: "edit", description: "Edit" }, { name: "write", description: "Write" }]
    // After a model switch the epoch catalog keeps every tool seen; only this turn's host list drops edit/write.
    const tools = model === "gpt" ? [...base, patchTool]
      : model === "opus" ? [...base, ...editTools]
      : [...base, ...editTools, patchTool]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    session.permittedToolNames = new Set((model === "opus" ? [...base, ...editTools] : [...base, patchTool]).map(t => t.name))
    session.hostToolDialect = host.dialect
    session.requestContext.env = { workspace_paths: [root] }
    const expected = model !== "opus"
      ? {
        toolName: host.patchTool,
        input: { patchText: existing
          ? `*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+created\n+\n*** End Patch`
          : `*** Begin Patch\n*** Add File: ${target}\n+created\n+\n*** End Patch` },
      }
      : existing
        ? { toolName: "edit", input: { [host.pathKey]: target, oldString: "before\n", newString: "created\n" } }
        : { toolName: "write", input: { [host.pathKey]: target, content: "created\n" } }
    try {
      const { parts, controller } = collect()
      await pump(session, controller, ids)
      if (existing) {
        expect(toolCalls(parts).map(call => call.toolName)).toEqual(["read"])
        await authorizeRead(session, parts, 1)
        parts.length = 0
        await pump(session, controller, ids)
      }
      const calls = toolCalls(parts)
      expect(calls.map(p => p.toolName)).toEqual([expected.toolName])
      expect(JSON.parse((calls[0] as { input: string }).input)).toEqual(expected.input)
      const replies = writes.map(frame => decodeMessage<any>("AgentClientMessage", frame).exec_client_message)
      expect(replies.some(message => message?.write_result?.error)).toBe(false)
      expect(replies.find(message => message?.read_result)?.read_result.success.content).toBe(existing ? "before\n" : "")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(fileToolHosts.map(host => [host.host, host] as const))(
    "%s: preserves CRLF intent when Cursor returns an LF-only correlated write",
    async (_name, host) => {
      const root = fs.mkdtempSync("/tmp/cursor-crlf-edit-")
      const target = path.join(root, "target.txt")
      const source = "one\r\ntwo\r\nthree\r\n"
      fs.writeFileSync(target, source)
      const { session, writes } = fixture([
        frame({ interaction_update: { tool_call_started: {
          call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
        } } }),
        frame({ exec_server_message: { id: 1, read_args: { path: target, tool_call_id: "edit" } } }),
        frame({ exec_server_message: { id: 2, write_args: {
          path: target, file_text: "one\nTWO\nthree\n", tool_call_id: "edit",
        } } }),
        ended(),
      ])
      const tools = [{ name: "read" }, { name: host.patchTool }]
      session.toolCatalog = tools
      session.toolDescriptors = toolsToDescriptors(tools, "opencode")
      session.permittedToolNames = new Set(tools.map(tool => tool.name))
      session.hostToolDialect = host.dialect
      session.requestContext.env = { workspace_paths: [root] }
      try {
        const { parts, controller } = collect()
        await pump(session, controller, ids)
        expect(toolCalls(parts).map(call => call.toolName)).toEqual(["read"])
        await authorizeRead(session, parts, 1)
        parts.length = 0
        await pump(session, controller, ids)
        const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message)
        expect(replies.find(message => message?.read_result)?.read_result.success.content).toBe(source)
        if (host.patchTool === "patch") {
          expect(toolCalls(parts)).toHaveLength(0)
          expect(replies.find(message => message?.write_result)?.write_result.error.error)
            .toContain("carriage return")
        } else {
          const calls = toolCalls(parts)
          expect(calls.map(call => call.toolName)).toEqual(["apply_patch"])
          expect(JSON.parse(calls[0]!.input).patchText).toContain("+TWO\r\n")
          expect(replies.some(message => message?.write_result?.error)).toBe(false)
        }
        expect(fs.readFileSync(target, "utf8")).toBe(source)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.each(fileToolHosts.map(host => [host.host, host] as const))(
    "%s: completes a large private read when only edit remains permitted",
    async (_name, host) => {
      const root = fs.mkdtempSync("/tmp/cursor-edit-only-")
      const target = path.join(root, "large.txt")
      const source = "original content\n".repeat(5000)
      const desired = source.replace("original content", "changed content")
      fs.writeFileSync(target, source)
      const { session, writes } = fixture([
        frame({ interaction_update: { tool_call_started: {
          call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
        } } }),
        frame({ exec_server_message: { id: 1, read_args: { path: target, tool_call_id: "edit" } } }),
        frame({ exec_server_message: { id: 2, write_args: { path: target, file_text: desired, tool_call_id: "edit" } } }),
        ended(),
      ])
      const tools = [{ name: "read" }, { name: "edit" }, { name: "write" }]
      session.toolCatalog = tools
      session.toolDescriptors = toolsToDescriptors(tools, "opencode")
      session.permittedToolNames = new Set(["read", "edit"])
      session.hostToolDialect = host.dialect
      session.requestContext.env = { workspace_paths: [root] }
      try {
        const { parts, controller } = collect()
        await pump(session, controller, ids)
        expect(toolCalls(parts).map(call => call.toolName)).toEqual(["read"])
        await authorizeRead(session, parts, 1)
        parts.length = 0
        await pump(session, controller, ids)
        const calls = toolCalls(parts)
        expect(calls.map(call => call.toolName)).toEqual(["edit"])
        const input = JSON.parse(calls[0]!.input)
        expect(input[host.pathKey]).toBe(target)
        expect(source.replace(input.oldString, input.newString)).toBe(desired)
        const read = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message)
          .find(message => message?.read_result)?.read_result.success
        expect(read.content).toBe(source)
        expect(read.truncated).toBe(false)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.each(fileToolHosts.map(host => [host.host, host] as const))(
    "%s: leaves an edit read to the host read tool when no file tool is permitted this turn",
    async (_name, host) => {
      const root = fs.mkdtempSync("/tmp/cursor-patch-tool-")
      const target = path.join(root, "target.txt")
      fs.writeFileSync(target, "before\n")
      const { session, writes } = fixture([
        frame({ interaction_update: { tool_call_started: {
          call_id: "edit", tool_call: { edit_tool_call: { args: { path: target } } },
        } } }),
        frame({ exec_server_message: { id: 1, read_args: { path: target, tool_call_id: "edit" } } }),
      ])
      const base = [{ name: host.shell, description: "Shell" }, { name: "read", description: "Read" }]
      const tools = [...base, { name: "edit", description: "Edit" }, { name: "write", description: "Write" },
        { name: host.patchTool, description: "Patch" }]
      session.toolCatalog = tools
      session.toolDescriptors = toolsToDescriptors(tools, "opencode")
      session.permittedToolNames = new Set(base.map(t => t.name))
      session.hostToolDialect = host.dialect
      session.requestContext.env = { workspace_paths: [root] }
      try {
        const { parts, controller } = collect()
        await pump(session, controller, ids)
        const calls = toolCalls(parts)
        expect(calls.map(p => p.toolName)).toEqual(["read"])
        expect(JSON.parse((calls[0] as { input: string }).input)).toMatchObject({ [host.pathKey]: target })
        const replies = writes.map(frame => decodeMessage<any>("AgentClientMessage", frame).exec_client_message)
        expect(replies.some(message => message?.read_result)).toBe(false)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it("includes a display-only todo mirror in the same host step", async () => {
    const tool_call = { update_todos_tool_call: { args: {
      todos: [{ id: "todo", content: "Review", status: 1 }],
    } } }
    const { session, reads } = fixture([
      listed(2), shell(1),
      frame({ interaction_update: { tool_call_started: { call_id: "todo-call", tool_call } } }),
      frame({ interaction_update: { tool_call_completed: { call_id: "todo-call", tool_call } } }),
      text("later"),
    ])
    const tools = [...session.toolCatalog!, { name: "todowrite", description: "Todos" }]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(4)
    expect(toolCalls(parts).map(p => p.toolName)).toEqual(["bash", "todowrite"])
    expect(finishes(parts)).toHaveLength(1)
    expect(session.pending.size).toBe(2)
  })

  it("retains refusals that precede the first count in the process", async () => {
    const { session, writes, reads } = fixture([question("refused"), listed(2), shell(1), text("later")])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(3)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response.id).toBe(43)
  })

  it("clears all-internal and zero-call generations before the next host step", async () => {
    const { session, reads } = fixture([listed(0), listed(1), question("refused"), listed(2), shell(1), shell(2)])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(6)
    expect(toolCalls(parts)).toHaveLength(2)
    expect(session.priorParallelStepCallIds?.has("refused")).toBe(true)
  })

  it("counts a server-side completion without a separate start frame", async () => {
    const { session, reads } = fixture([listed(2), shell(1), completed("server-tool"), text("later")])
    await pump(session, collect().controller, ids)
    expect(reads()).toBe(3)
    expect(session.pending.size).toBe(1)
  })

  it("ignores duplicate completions and calls from every earlier step", async () => {
    const { session, reads } = fixture([
      listed(1), shell(1), listed(1), shell(2),
      listed(2), shell(3), completed("call-1"), completed("call-2"), completed("call-3"), shell(4),
    ])
    await pump(session, collect().controller, ids)
    sessionManager.resolve(session.sessionId, 1)
    await pump(session, collect().controller, ids)
    sessionManager.resolve(session.sessionId, 2)
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(reads()).toBe(10)
    expect(toolCalls(parts)).toHaveLength(2)
  })

  it("lets a title Run discover the capability without owning the parent's step", async () => {
    const title = fixture([listed(0), ended()]).session
    title.allowTools = false
    await pump(title, collect().controller, ids)
    const { session } = fixture([shell(1), shell(2), listed(2)])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(2)
  })

  it.each([false, true])("bridges human prompts in a held step (known count: %s)", async known => {
    noteToolRequestsListedSeen()
    const { session, reads } = fixture([
      ...(known ? [listed(3)] : []), shell(1), question("human"), shell(2),
    ])
    const tools = [...session.toolCatalog!, { name: "question", description: "Ask" }]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(known ? 3 : 2)
    expect(reads()).toBe(known ? 4 : 2)
  })

  it("services KV inline without counting it as a tool", async () => {
    const kv = frame({ kv_server_message: { id: 50, get_blob_args: { blob_id: Uint8Array.of(1) } } })
    const { session, writes } = fixture([listed(2), shell(1), kv, shell(2)])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(toolCalls(parts)).toHaveLength(2)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).kv_client_message.id).toBe(50)
  })

  it("uses raw CLI field 15 deltas as progress for the idle guard", async () => {
    // AgentServerMessage #1 / InteractionUpdate #15 / empty delta update.
    const delta: Frame = { flags: 0, payload: Uint8Array.of(0x0a, 0x02, 0x7a, 0x00) }
    const { session } = fixture([listed(2), shell(1), delta, shell(2)])
    const next = session.frames.next.bind(session.frames)
    let reads = 0
    let recent = false
    session.frames.next = () => {
      reads++
      if (reads === 3) session.parallelStep!.lastProgressAt = Date.now() - 1_400
      if (reads === 4) recent = Date.now() - session.parallelStep!.lastProgressAt < 100
      return next()
    }
    await pump(session, collect().controller, ids)
    expect(recent).toBe(true)
  })

  it("does not extend a held step for request-context control probes", async () => {
    const probe = frame({ exec_server_message: { id: 40, request_context_args: {} } })
    const { session, writes } = fixture([listed(2), shell(1), probe, shell(2)])
    const next = session.frames.next.bind(session.frames)
    let reads = 0
    let stale = false
    session.frames.next = () => {
      reads++
      if (reads === 3) session.parallelStep!.lastProgressAt = Date.now() - 1_400
      if (reads === 4) stale = Date.now() - session.parallelStep!.lastProgressAt >= 1_400
      return next()
    }
    await pump(session, collect().controller, ids)
    expect(stale).toBe(true)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.id).toBe(40)
  })

  it.each([30, 31])("does not extend a held step for force-background request #%d", async field => {
    const { session, writes } = fixture([listed(2), shell(1), forceBackground(field, 40, "call-1"), shell(2)])
    const next = session.frames.next.bind(session.frames)
    let reads = 0
    let stale = false
    session.frames.next = () => {
      reads++
      if (reads === 3) session.parallelStep!.lastProgressAt = Date.now() - 1_400
      if (reads === 4) stale = Date.now() - session.parallelStep!.lastProgressAt >= 1_400
      return next()
    }
    await pump(session, collect().controller, ids)
    expect(stale).toBe(true)
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.id).toBe(40)
  })

  // https://github.com/oakimov/cursor-opencode-provider/issues/155, test by @nkoynov.
  it("closes a shell's step while Cursor keeps asking to background it for a queued note", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-note-stall-"))
    const target = path.join(root, "data.txt")
    fs.writeFileSync(target, "payload line\n")
    const requests = [2, 3, 4, 5, 6].map(id => forceBackground(30, id, "shell-call"))
    const frames = [
      frame({ interaction_update: { tool_call_started: {
        call_id: "read-call", tool_call: { read_tool_call: { args: { path: target } } },
      } } }),
      frame({ exec_server_message: { id: 0, read_args: { path: target, tool_call_id: "read-call" } } }),
      frame({ interaction_update: { tool_call_started: {
        call_id: "shell-call", tool_call: { shell_tool_call: { args: { command: "sleep 3; echo SLEPT" } } },
      } } }),
      listed(2), shell(1, "shell-call"),
      ...requests, text("after"),
    ]
    const { session, writes } = fixture(frames)
    const tools = [...session.toolCatalog!, { name: "read", description: "Read" }]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    session.requestContext.env = { workspace_paths: [root] }
    const next = session.frames.next.bind(session.frames)
    // Each request stands for about 0.6 s of Cursor retrying while the shell runs.
    session.frames.next = async () => {
      const result = await next()
      if (!result.done && requests.includes(result.value) && session.parallelStep) {
        session.parallelStep.lastProgressAt -= 1_000
      }
      return result
    }
    try {
      const first = collect()
      await pump(session, first.controller, ids)
      expect(toolCalls(first.parts).map(p => p.toolName)).toEqual(["read"])
      const read = toolCalls(first.parts)[0]!
      expect(await deliverContinuationResults(session, [{
        sessionId: session.sessionId, execId: 0, toolCallId: read.toolCallId, toolName: "read", output: "payload line",
      }])).toBe(session)

      const second = collect()
      await pump(session, second.controller, ids)
      expect(toolCalls(second.parts).map(p => p.toolName)).toEqual(["bash"])
      expect(finishes(second.parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
      expect(session.pending.has(1)).toBe(true)
      expect(frames.length).toBeGreaterThan(0)
      const answered = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message?.id)
      expect(answered).toContain(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("clears an aborted step's emission state while retaining its pending exec", async () => {
    const abort = new AbortController()
    const { session } = fixture([listed(2), shell(1), listed(1), shell(2)])
    const first = collect()
    const enqueue = first.controller.enqueue.bind(first.controller)
    first.controller.enqueue = part => {
      enqueue(part)
      if (part?.type === "tool-call") abort.abort()
    }
    await pump(session, first.controller, ids, abort.signal)
    expect(session.pending.size).toBe(1)
    expect(session.parallelStep).toBeUndefined()
    sessionManager.resolve(session.sessionId, 1)
    const second = collect()
    await pump(session, second.controller, ids)
    expect(toolCalls(second.parts)).toHaveLength(1)
  })

  it.each(["eof", "error"])("retains late %s after a frame-read timeout", async kind => {
    const { session } = fixture([])
    let finish: (result: IteratorResult<Frame>) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const pending = new Promise<IteratorResult<Frame>>((resolve, reject) => { finish = resolve; fail = reject })
    let reads = 0
    session.frames = { next: () => { reads++; return pending } }
    expect(await readSessionFrame(session, 1)).toMatchObject({ timedOut: true })
    if (kind === "eof") finish({ done: true, value: undefined })
    else fail(new Error("late failure"))
    await new Promise(resolve => setTimeout(resolve, 1))
    if (kind === "eof") expect(await readSessionFrame(session)).toMatchObject({ done: true })
    else await expect(readSessionFrame(session)).rejects.toThrow("late failure")
    expect(reads).toBe(1)
    expect(session.pendingFrameRead).toBeUndefined()
  })

  it("keeps pending results when TurnEnded arrives during a hold", async () => {
    const { session } = fixture([listed(2), shell(1), ended()])
    const { parts, controller } = collect()
    await pump(session, controller, ids)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
    expect(session.pending.size).toBe(1)
    expect(session.closed).toBe(false)
    sessionManager.resolve(session.sessionId, 1)
    await pump(session, controller, ids)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls", "stop"])
  })

  it.each(["eof", "error", "envelope"])("does not recover after emitting tools before %s", async kind => {
    const terminal: Frame = { flags: 2, payload: new TextEncoder().encode('{"error":{"code":"unavailable","message":"closed"}}') }
    const { session } = fixture([listed(2), shell(1), ...(kind === "envelope" ? [terminal] : [])])
    if (kind === "error") {
      const next = session.frames.next.bind(session.frames)
      let read = 0
      session.frames.next = () => ++read === 3 ? Promise.reject(new Error("closed")) : next()
    }
    // A checkpoint must not make replay eligible after host side effects.
    session.resumeCheckpoint = Uint8Array.of(1)
    const { parts, controller } = collect()
    let recoveries = 0
    await pumpWithRecovery({ initialSession: session, controller, recover: async () => {
      recoveries++
      return fixture([ended()]).session
    } })
    expect(recoveries).toBe(0)
    expect(finishes(parts).map(p => p.finishReason.unified)).toEqual(["tool-calls"])
    expect(session.closed).toBe(true)
  })

  it.each([false, true])("keeps a completed host tool as a replay barrier in the next pump (prior checkpoint: %s)", async checkpointed => {
    const { session } = fixture([
      ...(checkpointed ? [frame({ conversation_checkpoint_update: Uint8Array.of(10, 1, 1) })] : []),
      shell(1), text("after the command"),
    ])
    const first = collect()
    await pump(session, first.controller, ids)
    const call = toolCalls(first.parts)[0]!
    expect(call).toBeDefined()
    await deliverContinuationResults(session, [{
      toolCallId: call.toolCallId, sessionId: session.sessionId, execId: 1,
      toolName: call.toolName, output: "command completed",
    }])
    const failure = await pumpWithRecovery({
      initialSession: session,
      controller: collect().controller,
      recover: async () => { throw new Error("A completed command must not be replayed") },
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ retryable: false, replaySafe: false })
    expect((failure as { hostRetryable?: boolean }).hostRetryable).toBeUndefined()
  })

  it("resumes a checkpoint received after a completed host tool result", async () => {
    const checkpoint = Uint8Array.of(10, 1, 2)
    const { session } = fixture([
      shell(1), completed("call-1"), frame({ conversation_checkpoint_update: checkpoint }), text("after the result"),
    ])
    const first = collect()
    await pump(session, first.controller, ids)
    const call = toolCalls(first.parts)[0]!
    await deliverContinuationResults(session, [{
      toolCallId: call.toolCallId, sessionId: session.sessionId, execId: 1,
      toolName: call.toolName, output: "command completed",
    }])
    const recoveries: unknown[] = []
    await pumpWithRecovery({
      initialSession: session,
      controller: collect().controller,
      recover: async recovery => {
        recoveries.push(recovery)
        return fixture([ended()]).session
      },
    })
    expect(recoveries).toEqual([{ kind: "resume", conversationId: session.conversationId, checkpoint }])
  })

  const interactionAnswers = [
    { name: "question", request: question("interaction-call"), output: JSON.stringify({ answers: [["Yes"]] }) },
    { name: "plan_enter", request: mode("interaction-call"), output: "Approved" },
    { name: "cursor_plan_stage", request: frame({ interaction_query: {
      id: 44,
      create_plan_request_query: encodeMessage("CreatePlanRequestQuery", {
        args: { name: "Recovery", plan: "Inspect the checkpoint" }, tool_call_id: "interaction-call",
      }),
    } }), output: "Approved" },
  ]
  for (const dialect of [OPENCODE_1_TOOL_DIALECT, OPENCODE_2_TOOL_DIALECT]) {
    it.each(interactionAnswers)("resumes after an acknowledged $name interaction answer", async ({ name, request, output }) => {
      const checkpoint = Uint8Array.of(10, 1, 3)
      const { session } = fixture([
        request, completed("interaction-call"),
        frame({ conversation_checkpoint_update: checkpoint }), text("after the answer"),
      ])
      const root = fs.mkdtempSync("/tmp/cursor-interaction-checkpoint-")
      session.cacheDir = root
      if (name === "cursor_plan_stage") {
        session.openCodeSessionId = "ses_stage_checkpoint"
        setActiveCursorMode(session.openCodeSessionId, "plan", { bridgedPlanEntered: true })
      }
      const tools = [{ name, description: "Host interaction" }, ...(name === "cursor_plan_stage" ? [{ name: "write" }] : [])]
      session.toolCatalog = tools
      session.toolDescriptors = toolsToDescriptors(tools, "opencode")
      session.hostToolDialect = dialect
      try {
        const first = collect()
        await pump(session, first.controller, ids)
        const call = toolCalls(first.parts)[0]!
        expect(call.toolName).toBe(name)
        expect(await deliverContinuationResults(session, [{
          toolCallId: call.toolCallId, sessionId: session.sessionId, execId: 900_000,
          toolName: call.toolName, output,
        }])).toBe(session)
        const recoveries: unknown[] = []
        await pumpWithRecovery({
          initialSession: session, controller: collect().controller,
          retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
          recover: async recovery => {
            recoveries.push(recovery)
            return fixture([ended()]).session
          },
        })
        expect(session.unacknowledgedHostResults).toEqual([])
        expect(recoveries).toEqual([{ kind: "resume", conversationId: session.conversationId, checkpoint }])
      } finally {
        sessionManager.close(session, "ordinary-cleanup")
        await settleRunSavesForTests()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it("does not await a second server completion for a display-only todo mirror", async () => {
    const checkpoint = Uint8Array.of(10, 1, 5)
    const call = { update_todos_tool_call: {
      args: { todos: [{ id: "1", content: "Inspect checkpoint", status: 2 }] },
      result: { success: { todos: [{ id: "1", content: "Inspect checkpoint", status: 2 }] } },
    } }
    const { session, writes } = fixture([
      frame({ interaction_update: { tool_call_started: { call_id: "todos", tool_call: call } } }),
      frame({ interaction_update: { tool_call_completed: { call_id: "todos", tool_call: call } } }),
      frame({ conversation_checkpoint_update: checkpoint }), text("after todos"),
    ])
    const tools = [{ name: "todowrite", description: "Update todos" }]
    session.toolCatalog = tools
    session.toolDescriptors = toolsToDescriptors(tools, "opencode")
    const first = collect()
    await pump(session, first.controller, ids)
    const emitted = toolCalls(first.parts)[0]!
    expect(emitted.toolName).toBe("todowrite")
    await deliverContinuationResults(session, [{
      toolCallId: emitted.toolCallId, sessionId: session.sessionId, execId: 900_000,
      toolName: emitted.toolName, output: "Updated todos",
    }])
    expect(writes).toHaveLength(0)
    const recoveries: unknown[] = []
    await pumpWithRecovery({ initialSession: session, controller: collect().controller,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      recover: async recovery => { recoveries.push(recovery); return fixture([ended()]).session },
    })
    expect(session.unacknowledgedHostResults?.length ?? 0).toBe(0)
    expect(recoveries).toEqual([{ kind: "resume", conversationId: session.conversationId, checkpoint }])
  })

  it.each(["matching", "other-call", "malformed"] as const)("validates a %s completion while draining an abandoned Run", async completion => {
    const checkpoint = Uint8Array.of(10, 1, 4)
    const acknowledgement = completed(completion === "other-call" ? "unrelated" : "call-1")
    if (completion === "malformed") {
      // Unknown AgentServerMessage field #9 beside the lifecycle envelope.
      acknowledgement.payload = Uint8Array.from([...acknowledgement.payload, 0x4a, 0])
    }
    const { session } = fixture([
      shell(1), acknowledgement, frame({ conversation_checkpoint_update: checkpoint }), ended(),
    ])
    const first = collect()
    await pump(session, first.controller, ids)
    const call = toolCalls(first.parts)[0]!
    await deliverContinuationResults(session, [{
      toolCallId: call.toolCallId, sessionId: session.sessionId, execId: 1,
      toolName: call.toolName, output: "command completed",
    }])
    expect(await drainSessionUntilTurnEnded(session)).toBe("turn-ended")
    if (completion === "matching") {
      expect(session.unacknowledgedHostResults).toEqual([])
      expect(session.resumeCheckpoint).toEqual(checkpoint)
    } else {
      expect(session.unacknowledgedHostResults).toHaveLength(1)
      expect(session.resumeCheckpoint).toBeUndefined()
    }
  })

  it("retains a guard-timed-out iterator read for the continuation", async () => {
    noteToolRequestsListedSeen()
    const { session } = fixture([])
    let release: (value: IteratorResult<Frame>) => void = () => {}
    const waiting = new Promise<IteratorResult<Frame>>(resolve => { release = resolve })
    let reads = 0
    session.frames = { next: () => {
      reads++
      if (reads === 1) return Promise.resolve({ done: false, value: shell(1) })
      if (reads === 2) return waiting
      return Promise.resolve({ done: false, value: ended() })
    } }
    const first = collect()
    await pump(session, first.controller, ids)
    expect(reads).toBe(2)
    sessionManager.resolve(session.sessionId, 1)
    const second = collect()
    const continuation = pump(session, second.controller, ids)
    await Promise.resolve()
    expect(reads).toBe(2)
    release({ done: false, value: text("retained") })
    await continuation
    expect(second.parts.filter(p => p.type === "text-delta").map(p => p.delta).join("")).toBe("retained")
  })
})
