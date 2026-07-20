import { describe, expect, it } from "bun:test"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors, toolsToMcpDescriptors } from "../src/protocol/tools.js"
import { pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

function writeVarint(out: number[], value: number): void {
  let remaining = value >>> 0
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  out.push(remaining)
}

/** Build an unknown ToolCall oneof variant from raw field numbers (await-style ignore path). */
function rawToolCallWithFields(callId: string, fieldNums: number[]): Uint8Array {
  // ToolCall { tool_call_id=57, <field>: empty message }
  const tool: number[] = []
  const idBytes = new TextEncoder().encode(callId)
  writeVarint(tool, (57 << 3) | 2)
  writeVarint(tool, idBytes.length)
  tool.push(...idBytes)
  for (const field of fieldNums) {
    writeVarint(tool, (field << 3) | 2)
    writeVarint(tool, 0) // empty submessage
  }

  const started: number[] = []
  const callIdBytes = new TextEncoder().encode(callId)
  writeVarint(started, (1 << 3) | 2)
  writeVarint(started, callIdBytes.length)
  started.push(...callIdBytes)
  writeVarint(started, (2 << 3) | 2)
  writeVarint(started, tool.length)
  started.push(...tool)

  const iu: number[] = []
  writeVarint(iu, (2 << 3) | 2) // tool_call_started = 2
  writeVarint(iu, started.length)
  iu.push(...started)

  const asm: number[] = []
  writeVarint(asm, (1 << 3) | 2) // interaction_update = 1
  writeVarint(asm, iu.length)
  asm.push(...iu)
  return Uint8Array.from(asm)
}

function rawExecPayload(
  execId: number,
  variantField: number,
  argsBytes = new Uint8Array(0),
): Uint8Array {
  const exec: number[] = []
  writeVarint(exec, (1 << 3) | 0)
  writeVarint(exec, execId)
  writeVarint(exec, (variantField << 3) | 2)
  writeVarint(exec, argsBytes.length)
  exec.push(...argsBytes)

  const asm: number[] = []
  writeVarint(asm, (2 << 3) | 2)
  writeVarint(asm, exec.length)
  asm.push(...exec)
  return Uint8Array.from(asm)
}

function rawSubagentArgs(): Uint8Array {
  const out: number[] = []
  const text = new TextEncoder()
  const writeString = (field: number, value: string) => {
    const bytes = text.encode(value)
    writeVarint(out, (field << 3) | 2)
    writeVarint(out, bytes.length)
    out.push(...bytes)
  }
  writeString(1, "task-call-34")
  writeString(2, "generalPurpose")
  writeString(4, "Investigate why the conversation stopped")
  return Uint8Array.from(out)
}

function rawBackgroundShellArgs(): Uint8Array {
  const out: number[] = []
  const text = new TextEncoder()
  const writeString = (field: number, value: string) => {
    const bytes = text.encode(value)
    writeVarint(out, (field << 3) | 2)
    writeVarint(out, bytes.length)
    out.push(...bytes)
  }
  writeString(1, "zig translate-c /tmp/tiny.c -lc")
  writeString(2, "/tmp")
  writeString(3, "shell-call-49")
  return Uint8Array.from(out)
}

function displayPayload(
  kind: "started" | "completed",
  callId: string,
  toolCall: Record<string, unknown>,
): Uint8Array {
  const key = kind === "started" ? "tool_call_started" : "tool_call_completed"
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      [key]: {
        call_id: callId,
        tool_call: toolCall,
      },
    },
  })
}

function turnEndedPayload(): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
  })
}

function fakeSession(
  payloads: Uint8Array[],
  writes: Uint8Array[],
  definitionsOverride?: Array<{ name: string; description: string }>,
): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () =>
      index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++] } }
        : { done: true, value: undefined },
  }
  const definitions = definitionsOverride ?? [
    { name: "question", description: "Ask" },
    { name: "todowrite", description: "Todos" },
    { name: "plan_enter", description: "Enter plan" },
    { name: "bash", description: "Shell" },
    { name: "write", description: "Write" },
    { name: "task", description: "Delegate" },
    { name: "github_get_me", description: "Who am I" },
  ]
  const tools = toolsToDescriptors(definitions, "opencode", ["github"])
  const mcpDescriptors = toolsToMcpDescriptors(definitions, "opencode", ["github"])
  return {
    sessionId: "display-bridge-session",
    conversationId: "display-bridge-conversation",
    stream: {
      write(data: Uint8Array) {
        writes.push(data)
      },
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: tools,
    requestContext: {
      tools,
      mcp_file_system_options: { enabled: true, mcp_descriptors: mcpDescriptors },
    },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

describe("display-only ToolCall pump bridge", () => {
  it("continues a new-file edit through write instead of shell fallback", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "edit-new-file"
    const target = `/tmp/cursor-opencode-missing-${process.pid}-${Date.now()}.md`
    const session = fakeSession(
      [
        displayPayload("started", callId, {
          edit_tool_call: {
            args: { path: target, stream_content: "# New file\n" },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 15,
            read_args: { path: target, tool_call_id: callId },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 16,
            write_args: {
              path: target,
              file_text: "# New file\n",
              tool_call_id: callId,
            },
          },
        }),
      ],
      writes,
      [
        { name: "read", description: "Read" },
        { name: "edit", description: "Edit" },
        { name: "write", description: "Write" },
      ],
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes).toHaveLength(2)
    const read = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .exec_client_message.read_result
    expect(read.success).toMatchObject({ path: target, content: "", total_lines: 0 })
    expect(decodeMessage<any>("AgentClientMessage", writes[1]!))
      .toEqual({ exec_client_control_message: { stream_close: { id: 15 } } })
    const toolCalls = parts.filter((part) => part.type === "tool-call")
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].toolName).toBe("write")
    expect(JSON.parse(toolCalls[0].input)).toEqual({
      filePath: target,
      content: "# New file\n",
    })
    expect(session.displayToolCalls.has(callId)).toBe(false)
    sessionManager.resolve(session.sessionId, 16)
  })

  it("keeps the normal read step for an existing-file edit", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "edit-existing-file"
    const target = path.join(process.cwd(), "README.md")
    const session = fakeSession(
      [
        displayPayload("started", callId, {
          edit_tool_call: {
            args: { path: target, stream_content: "replacement" },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 17,
            read_args: { path: target, tool_call_id: callId },
          },
        }),
      ],
      writes,
      [
        { name: "read", description: "Read" },
        { name: "edit", description: "Edit" },
        { name: "write", description: "Write" },
      ],
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes).toHaveLength(0)
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ filePath: target })
    sessionManager.resolve(session.sessionId, 17)
  })

  it("does not replay a completed ask_question_tool_call", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const callId = "ask-q-1"
    const toolCall = {
      ask_question_tool_call: {
        args: {
          title: "Choose",
          questions: [
            {
              id: "q1",
              prompt: "Pick one?",
              options: [{ id: "a", label: "A" }],
              allow_multiple: false,
            },
          ],
        },
      },
    }
    const session = fakeSession(
      [
        displayPayload("started", callId, toolCall),
        displayPayload("completed", callId, toolCall),
        turnEndedPayload(),
      ],
      writes,
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
    expect(parts.some((p) => p.type === "finish" && p.finishReason?.unified === "stop")).toBe(true)
    expect(sessionManager.pendingFor(session.sessionId, 900_000)).toBeUndefined()
    expect(session.displayToolCalls.size).toBe(0)
  })

  it("bridges create_plan_tool_call → todowrite", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "plan-1"
    const toolCall = {
      create_plan_tool_call: {
        args: {
          name: "Ship",
          overview: "Do the thing",
          plan: "1. A\n2. B",
          todos: [{ id: "t1", content: "A", status: 1 }],
        },
      },
    }
    const session = fakeSession(
      [displayPayload("started", callId, toolCall), displayPayload("completed", callId, toolCall)],
      writes,
    )
    session.nextBridgedExecId = 900_010
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const toolPart = parts.find((p) => p.type === "tool-call")
    expect(toolPart?.toolName).toBe("todowrite")
    const input = JSON.parse(toolPart.input)
    expect(Array.isArray(input.todos)).toBe(true)
    expect(input.todos.length).toBeGreaterThan(0)
    sessionManager.resolve(session.sessionId, 900_010)
  })

  it("bridges a todo merge only from the completed final list", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "todos-merge"
    const started = {
      update_todos_tool_call: {
        args: {
          merge: true,
          todos: [{ id: "changed", content: "Changed", status: 3 }],
        },
      },
    }
    const completed = {
      update_todos_tool_call: {
        args: started.update_todos_tool_call.args,
        result: {
          success: {
            was_merge: true,
            todos: [
              { id: "kept", content: "Kept", status: 1 },
              { id: "changed", content: "Changed", status: 3 },
            ],
          },
        },
      },
    }
    const session = fakeSession(
      [displayPayload("started", callId, started), displayPayload("completed", callId, completed)],
      writes,
    )
    session.nextBridgedExecId = 900_020
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const toolPart = parts.find((p) => p.type === "tool-call")
    expect(toolPart?.toolName).toBe("todowrite")
    expect(JSON.parse(toolPart.input).todos.map((todo: { id: string }) => todo.id)).toEqual([
      "kept",
      "changed",
    ])
    sessionManager.resolve(session.sessionId, 900_020)
  })

  it("continues without a tool call when a todo merge lacks final state", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "todos-unsafe-merge"
    const toolCall = {
      update_todos_tool_call: {
        args: {
          merge: true,
          todos: [{ id: "changed", content: "Changed", status: 3 }],
        },
      },
    }
    const session = fakeSession(
      [
        displayPayload("started", callId, toolCall),
        displayPayload("completed", callId, toolCall),
        turnEndedPayload(),
      ],
      writes,
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(session.pending.size).toBe(0)
  })

  it("decodes await_tool_call without bridging when await is not advertised", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "await-1"
    const toolCall = {
      await_tool_call: {
        args: { task_id: "shell_1", block_until_ms: 1000, regex: "DONE" },
      },
    }
    const session = fakeSession(
      [
        displayPayload("started", callId, toolCall),
        displayPayload("completed", callId, toolCall),
        turnEndedPayload(),
      ],
      writes,
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(session.displayToolCalls.size).toBe(0)
    expect(session.pending.size).toBe(0)
  })

  it("ignores unknown display oneof fields without hanging the stream", async () => {
    // Field 44 = get_mcp_tools_tool_call is in schema; use a future field 77.
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession([rawToolCallWithFields("future-1", [77]), turnEndedPayload()], writes)
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
  })

  it("fails promptly for an unknown exec variant instead of guessing a response", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const session = fakeSession([rawExecPayload(42, 38)], writes)
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError?.message).toContain(
      "Unsupported Cursor exec variant smart_mode_classifier_args " +
      "(request field #38, expected result smart_mode_classifier_result field #38, handling=unsupported)",
    )
    expect(writes).toHaveLength(0)
    expect(parts.some((p) => p.type === "finish")).toBe(false)
  })

  it("distinguishes future protocol drift from a known unsupported exec", async () => {
    const writes: Uint8Array[] = []
    let streamError: Error | undefined
    const session = fakeSession([rawExecPayload(42, 53)], writes)
    const controller = {
      enqueue() {},
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError?.message).toContain(
      "Unsupported Cursor exec variant unknown request field #53 (id=42)",
    )
    expect(writes).toHaveLength(0)
  })

  it("emits canonical subagent field #28 as an OpenCode task call", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const session = fakeSession([rawExecPayload(34, 28, rawSubagentArgs())], writes)
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("task")
    expect(JSON.parse(toolCall.input)).toEqual({
      description: "Investigate why the conversation stopped",
      prompt: "Investigate why the conversation stopped",
      subagent_type: "general",
    })
    expect(parts.some((part) =>
      part.type === "finish" && part.finishReason?.unified === "tool-calls"
    )).toBe(true)
    expect(sessionManager.pendingFor(session.sessionId, 34)?.resultField).toBe("subagent_result")
    sessionManager.resolve(session.sessionId, 34)
  })

  it("rejects native Task on Cursor's typed channel when the current agent omits task", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const session = fakeSession(
      [rawExecPayload(34, 28, rawSubagentArgs()), turnEndedPayload()],
      writes,
      [
        { name: "bash", description: "Shell" },
        { name: "read", description: "Read" },
        { name: "write", description: "Write" },
      ],
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(parts.some((part) =>
      part.type === "finish" && part.finishReason?.unified === "stop"
    )).toBe(true)
    expect(writes).toHaveLength(2)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .exec_client_message.subagent_result
    expect(result.error.error).toContain("OpenCode tool 'task' is unavailable")
    expect(result.error.error).toContain("Available tools: bash, read, write")
    expect(decodeMessage<any>("AgentClientMessage", writes[1]!))
      .toEqual({ exec_client_control_message: { stream_close: { id: 34 } } })
    expect(sessionManager.pendingFor(session.sessionId, 34)).toBeUndefined()
  })

  it("rejects every unavailable native exec target before OpenCode sees it", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 7,
            write_args: { path: "/tmp/should-not-write", file_text: "blocked" },
          },
        }),
        turnEndedPayload(),
      ],
      writes,
      [{ name: "read", description: "Read" }],
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(writes).toHaveLength(2)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .exec_client_message.write_result
    expect(result.error.error).toContain("OpenCode tool 'write' is unavailable")
    expect(result.error.error).toContain("Available tools: read")
    expect(sessionManager.pendingFor(session.sessionId, 7)).toBeUndefined()
  })

  it("emits canonical background shell field #16 once and claims its display call", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const callId = "shell-call-49"
    const session = fakeSession([
      displayPayload("started", callId, {
        shell_tool_call: {
          args: { command: "zig translate-c /tmp/tiny.c -lc", working_directory: "/tmp" },
        },
      }),
      rawExecPayload(49, 16, rawBackgroundShellArgs()),
    ], writes)
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    const toolCalls = parts.filter((part) => part.type === "tool-call")
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].toolName).toBe("bash")
    const input = JSON.parse(toolCalls[0].input)
    expect(input.workdir).toBe("/tmp")
    expect(input.command).toContain("nohup sh -c 'zig translate-c /tmp/tiny.c -lc'")
    expect(input.command).toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(session.displayToolCalls.has(callId)).toBe(false)
    expect(sessionManager.pendingFor(session.sessionId, 49)).toMatchObject({
      resultField: "background_shell_spawn_result",
      resultMetadata: {
        background_shell_spawn: true,
        command: "zig translate-c /tmp/tiny.c -lc",
        working_directory: "/tmp",
      },
    })
    sessionManager.resolve(session.sessionId, 49)
  })

  it("answers MCP state field #36 before emitting the requested write", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 0,
            mcp_state_exec_args: { server_identifiers: ["opencode"] },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 1,
            write_args: { path: "/tmp/result.txt", file_text: "done" },
          },
        }),
      ],
      writes,
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    expect(writes).toHaveLength(1)
    const state = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .exec_client_message.mcp_state_exec_result.success
    expect(state.servers.map((server: any) => server.server_identifier)).toEqual(["opencode"])
    expect(state.servers[0].tools.some((tool: any) => tool.tool_name === "write")).toBe(true)
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("write")
    expect(JSON.parse(toolCall.input)).toEqual({ filePath: "/tmp/result.txt", content: "done" })
    sessionManager.resolve(session.sessionId, 1)
  })

  it("translates a custom web alias back to the executable host tool", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 77,
            mcp_args: {
              name: "custom_webfetch",
              provider_identifier: "opencode",
              tool_name: "custom_webfetch",
              args: [],
            },
          },
        }),
      ],
      writes,
      [{ name: "custom_webfetch", description: "Fetch a URL" }],
    )
    session.toolAliases = new Map([["custom_webfetch", "webfetch"]])
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("webfetch")
    expect(sessionManager.pendingFor(session.sessionId, 77)).toMatchObject({
      resultField: "mcp_result",
      toolName: "webfetch",
    })
    sessionManager.resolve(session.sessionId, 77)
  })

  it("fails closed when request_context write throws (F5)", async () => {
    const parts: any[] = []
    let streamError: Error | undefined
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 10,
            request_context_args: {},
          },
        }),
        turnEndedPayload(),
      ],
      [],
    )
    session.stream.write = () => {
      throw new Error("simulated request_context write failure")
    }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        streamError = error
      },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError?.message).toContain("request_context")
    expect(session.closed).toBe(true)
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
  })

  it("fails closed when a KV reply write throws (F5)", async () => {
    let streamError: Error | undefined
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          kv_server_message: {
            id: 11,
            get_blob_args: { blob_id: new TextEncoder().encode("missing blob") },
          },
        }),
        turnEndedPayload(),
      ],
      [],
    )
    session.stream.write = () => {
      throw new Error("simulated KV write failure")
    }
    const controller = {
      enqueue() {},
      error(error: Error) {
        streamError = error
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError?.message).toContain("KV blob request")
    expect(session.closed).toBe(true)
  })
})
