import { describe, expect, it, afterEach } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { encodeJsonAsValue, readAllFields } from "../src/protocol/struct.js"
import { hostToolDialectFromTools, toolsToDescriptors, toolsToMcpDescriptors } from "../src/protocol/tools.js"
import {
  pump,
  rememberMirroredTodos,
  resetTurnStateForTests,
  snapshotMirroredTodosBySession,
} from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { billingLedger } from "../src/billing.js"
import { sessionFixture } from "./session-fixture.js"

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
  argsBytes: Uint8Array = new Uint8Array(0),
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

function rawSubagentArgs(subagentType = "generalPurpose"): Uint8Array {
  const out: number[] = []
  const text = new TextEncoder()
  const writeString = (field: number, value: string) => {
    const bytes = text.encode(value)
    writeVarint(out, (field << 3) | 2)
    writeVarint(out, bytes.length)
    out.push(...bytes)
  }
  writeString(1, "task-call-34")
  writeString(2, subagentType)
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
  definitionsOverride?: Array<{ name: string; description: string; inputSchema?: unknown }>,
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
  return sessionFixture({
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
    toolCatalog: definitions,
    knownMcpServers: ["github"],
    toolDescriptors: tools,
    requestContext: {
      tools,
      mcp_file_system_options: { enabled: true, mcp_descriptors: mcpDescriptors },
    },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
  })
}

describe("display-only ToolCall pump bridge", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
  })

  it("rejects a shell call with only a file path, then emits the corrected command", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const exec = (id: number, args: Record<string, unknown>) => {
      const struct = readAllFields(encodeJsonAsValue(args)).find((field) => field.fn === 5)!.bytes!
      const entries = readAllFields(struct).map((field) => field.bytes!)
      return encodeMessage("AgentServerMessage", {
        exec_server_message: { id, mcp_args: { name: "opencode-bash", args: entries } },
      })
    }
    const session = fakeSession([
      exec(1, { filePath: "/tmp/log-extract.txt" }),
      exec(2, { command: "wc -l /tmp/log-extract.txt" }),
    ], writes, [{
      name: "bash",
      description: "Run a shell command",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }])
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const rejection = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
    expect(rejection.id).toBe(1)
    expect(JSON.stringify(rejection.mcp_result)).toContain("missing required arguments: command")
    expect(session.pending.has(1)).toBe(false)
    expect(parts.filter((part) => part.type === "tool-call").map((part) => JSON.parse(part.input)))
      .toEqual([{ command: "wc -l /tmp/log-extract.txt" }])
    expect(session.pending.has(2)).toBe(true)
  })

  it("validates native shell calls after supplying the advertised description", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession([
      encodeMessage("AgentServerMessage", { exec_server_message: { id: 1, shell_args: { command: "pwd" } } }),
    ], writes, [{ name: "bash", description: "Run command", inputSchema: {
      type: "object", properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command", "description"],
    } }])
    session.hostToolDialect = hostToolDialectFromTools(session.toolCatalog ?? [])
    const controller: ReadableStreamDefaultController<any> = {
      desiredSize: 0, close() {}, enqueue(part) { parts.push(part) }, error(error) { throw error },
    }
    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    expect(writes).toHaveLength(0)
    expect(session.pending.has(1)).toBe(true)
    expect(parts.filter(part => part.type === "tool-call").map(part => JSON.parse(part.input)))
      .toEqual([{ command: "pwd", description: "Run: pwd", timeout: 30_000 }])
  })

  it("refuses a shell command sent to a file tool even when all its fields are optional", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const exec = (id: number, name: string, args: Record<string, unknown>) => {
      const struct = readAllFields(encodeJsonAsValue(args)).find((field) => field.fn === 5)!.bytes!
      const entries = readAllFields(struct).map((field) => field.bytes!)
      return encodeMessage("AgentServerMessage", {
        exec_server_message: { id, mcp_args: { name: `opencode-${name}`, args: entries } },
      })
    }
    const session = fakeSession([
      exec(1, "ls", { command: "wc -l /workspace/extract.txt" }),
      exec(2, "bash", { command: "wc -l /workspace/extract.txt" }),
    ], writes, [
      { name: "ls", description: "List", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Shell", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    ])
    await pump(session, {
      desiredSize: 0,
      close() {},
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    }, { textId: "text", reasoningId: "reasoning" })
    const rejection = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
    expect(rejection.id).toBe(1)
    expect(JSON.stringify(rejection.mcp_result)).toContain("No command was executed")
    expect(session.pending.has(1)).toBe(false)
    expect(parts.filter(part => part.type === "tool-call").map(part => part.toolName)).toEqual(["bash"])
    expect(session.pending.has(2)).toBe(true)
  })

  it("observes a server-side dynamic-call rejection without inventing host execution", async () => {
    const parts: any[] = []
    const writes: Uint8Array[] = []
    const session = fakeSession([
      displayPayload("completed", "server-rejected", {
        mcp_tool_call: { result: { error: { error: "Tool execution error", detail: "Missing required fields: namespace, toolName" } } },
      }),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "Recovered answer" } } }),
      turnEndedPayload(),
    ], writes)
    await pump(session, {
      desiredSize: 0,
      close() {},
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    }, { textId: "text", reasoningId: "reasoning" })
    expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
    expect(parts.filter(part => part.type === "text-delta").map(part => part.delta).join("")).toBe("Recovered answer")
    expect(session.pending.size).toBe(0)
    expect(writes).toHaveLength(0)
  })

  it("starts text after a tool call as a new paragraph", async () => {
    const parts: any[] = []
    const text = (value: string) => encodeMessage("AgentServerMessage", {
      interaction_update: { text_delta: { text: value } },
    })
    const switchCall = { switch_mode_tool_call: { args: { target_mode_id: "plan" } } }
    const session = fakeSession(
      [
        text("Switching to plan mode."),
        displayPayload("started", "switch-1", switchCall),
        displayPayload("completed", "switch-1", switchCall),
        text("Recording the plan."),
        text(" Done."),
        text("\nAlready on a new line."),
        turnEndedPayload(),
      ],
      [],
      [{ name: "read", description: "Read" }],
    )
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const emitted = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    expect(emitted).toBe(
      "Switching to plan mode.\n\nRecording the plan. Done.\nAlready on a new line.",
    )
  })

  it("keeps only the answer of a tool-less turn, not narration before a refused call", async () => {
    const parts: any[] = []
    const writes: Uint8Array[] = []
    const text = (value: string) => encodeMessage("AgentServerMessage", {
      interaction_update: { text_delta: { text: value } },
    })
    const session = fakeSession(
      [
        text("I'll read the guide first."),
        encodeMessage("AgentServerMessage", {
          exec_server_message: { id: 1, read_args: { path: "/tmp/guide.md", tool_call_id: "read-1" } },
        }),
        text("Run the self-verify"),
        text(" checklist"),
        turnEndedPayload(),
      ],
      writes,
      [{ name: "read", description: "Read" }],
    )
    session.allowTools = false
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const read = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.read_result
    expect(read.error ?? read.rejected).toBeDefined()
    const emitted = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    expect(emitted).toBe("Run the self-verify checklist")
    expect(parts.findIndex((part) => part.type === "text-start"))
      .toBeLessThan(parts.findIndex((part) => part.type === "finish"))
  })

  it("preserves a tool-less answer about unavailable resources after refusing an exec", async () => {
    const parts: any[] = []
    const answer = "Fix unavailable skills after restart"
    const session = fakeSession([
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 1, read_args: { path: "/tmp/guide.md", tool_call_id: "read-1" } },
      }),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: answer } } }),
      turnEndedPayload(),
    ], [])
    session.allowTools = false
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>
    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")).toBe(answer)
  })

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
    } as unknown as ReadableStreamDefaultController<any>

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

  it("answers the private read directly and exposes a correlated existing-file write as edit", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "edit-existing-file"
    const target = path.join(
      "/tmp",
      `cursor-opencode-edit-${process.pid}-${Date.now()}.txt`,
    )
    fs.writeFileSync(target, "line one\nline two\nline three\nline four\n")
    const session = fakeSession(
      [
        displayPayload("started", callId, {
          edit_tool_call: {
            args: {
              path: target,
              // Some started frames arrive before streamed content is present;
              // the correlated write_args remains authoritative.
            },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 17,
            read_args: { path: target, tool_call_id: callId },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 18,
            write_args: {
              path: target,
              file_text: "edited one\nedited two\nedited three\nline four\n",
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
    session.requestContext.env = { workspace_paths: [path.dirname(target)] }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as unknown as ReadableStreamDefaultController<any>

    try {
      await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

      expect(writes).toHaveLength(2)
      const read = decodeMessage<any>("AgentClientMessage", writes[0]!)
        .exec_client_message.read_result.success
      expect(read).toMatchObject({
        path: target,
        content: "line one\nline two\nline three\nline four\n",
        truncated: false,
        range_applied: false,
      })
      expect(parts.some((part) => part.type === "tool-call" && part.toolName === "read")).toBe(false)

      const editCall = parts.find((part) => part.type === "tool-call")
      expect(editCall?.toolName).toBe("edit")
      expect(JSON.parse(editCall.input)).toEqual({
        filePath: target,
        oldString: "line one\nline two\nline three\n",
        newString: "edited one\nedited two\nedited three\n",
      })
      expect(session.editToolCalls?.has(callId)).toBe(false)
      sessionManager.resolve(session.sessionId, 18)
    } finally {
      fs.rmSync(target, { force: true })
    }
  })

  it("edits a file above OpenCode's 50 KB read cap without a partial replacement", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "edit-large-file"
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-opencode-large-edit-"))
    const target = path.join(root, "large.ts")
    const prefix = Array.from(
      { length: 1800 },
      (_, index) => `export const line${index} = "${"x".repeat(32)}"`,
    ).join("\n") + "\n"
    const source = `${prefix}export const target = 1\nexport const trailer = true\n`
    const replacement = `${prefix}export const target = 2\nexport const trailer = true\n`
    expect(Buffer.byteLength(source)).toBeGreaterThan(50 * 1024)
    fs.writeFileSync(target, source)

    const session = fakeSession(
      [
        displayPayload("started", callId, {
          edit_tool_call: { args: { path: target } },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 25,
            read_args: { path: target, tool_call_id: callId },
          },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 26,
            write_args: {
              path: target,
              file_text: replacement,
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
    session.requestContext.env = { workspace_paths: [root] }

    try {
      await pump(session, {
        enqueue(part: unknown) { parts.push(part) },
        error(error: Error) { throw error },
      } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

      const read = decodeMessage<any>("AgentClientMessage", writes[0]!)
        .exec_client_message.read_result.success
      expect(read.content).toBe(source)
      expect(read.truncated).toBe(false)
      expect(read.content).not.toContain("[Partial read:")

      const editCall = parts.find((part) => part.type === "tool-call")
      expect(editCall?.toolName).toBe("edit")
      const input = JSON.parse(editCall.input)
      expect(input.oldString).toContain("export const target = 1")
      expect(input.newString).toContain("export const target = 2")
      expect(input.newString.length).toBeLessThan(500)
      expect(session.editToolCalls?.has(callId)).toBe(false)
      sessionManager.resolve(session.sessionId, 26)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a correlated edit read on OpenCode's permission path when a workspace symlink escapes", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "edit-external-symlink"
    const root = fs.mkdtempSync(path.join("/tmp", "cursor-opencode-edit-root-"))
    const externalRoot = fs.mkdtempSync(path.join("/tmp", "cursor-opencode-edit-external-"))
    const external = path.join(externalRoot, "external.ts")
    const target = path.join(root, "linked.ts")
    fs.writeFileSync(external, "export const external = true\n")
    fs.symlinkSync(external, target)

    const session = fakeSession(
      [
        displayPayload("started", callId, {
          edit_tool_call: { args: { path: target } },
        }),
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 27,
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
    session.requestContext.env = { workspace_paths: [root] }

    try {
      await pump(session, {
        enqueue(part: unknown) { parts.push(part) },
        error(error: Error) { throw error },
      } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

      expect(writes).toHaveLength(0)
      const readCall = parts.find((part) => part.type === "tool-call")
      expect(readCall?.toolName).toBe("read")
      expect(JSON.parse(readCall.input)).toEqual({ filePath: target })
      expect(session.editToolCalls?.get(callId)?.completeRead).not.toBe(true)
      expect(sessionManager.pendingFor(session.sessionId, 27)?.resultMetadata).toMatchObject({
        path: target,
        correlatedEditCallId: callId,
      })
      sessionManager.resolve(session.sessionId, 27)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  it("rejects a read of a missing path with a typed file_not_found before OpenCode sees it", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const target = `/tmp/cursor-opencode-hallucinated-${process.pid}-${Date.now()}.ts`
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: { id: 21, read_args: { path: target } },
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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    // No host tool-call is emitted — the user never sees a permission prompt.
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(sessionManager.pendingFor(session.sessionId, 21)).toBeUndefined()
    // The provider answers Cursor with the typed ReadResult.file_not_found case,
    // then closes the exec stream, exactly as the CLI client does.
    expect(writes).toHaveLength(2)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
    expect(result.id).toBe(21)
    expect(result.read_result.file_not_found).toMatchObject({ path: target })
    expect(result.read_result.success).toBeUndefined()
    expect(result.read_result.error).toBeUndefined()
    expect(decodeMessage<any>("AgentClientMessage", writes[1]!)).toEqual({
      exec_client_control_message: { stream_close: { id: 21 } },
    })
  })

  it("forwards a scheme-addressed read target to the host instead of refusing it", async () => {
    // URI-backed capabilities belong to the advertised executor. Resolving them
    // as workspace-relative paths would produce a false local missing-file error.
    for (const target of ["resource://catalog/item", "https://example.com/spec.json"]) {
      const writes: Uint8Array[] = []
      const parts: any[] = []
      const session = fakeSession(
        [
          encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 22, read_args: { path: target } },
          }),
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
      } as unknown as ReadableStreamDefaultController<any>

      await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

      // The host executes it: a tool-call is emitted and no typed rejection is written.
      const toolCall = parts.find((part) => part.type === "tool-call")
      expect(toolCall?.toolName, target).toBe("read")
      expect(JSON.parse(toolCall.input), target).toEqual({ filePath: target })
      expect(writes, target).toHaveLength(0)
      expect(sessionManager.pendingFor(session.sessionId, 22), target).toMatchObject({
        resultField: "read_result",
        toolName: "read",
      })
      sessionManager.resolve(session.sessionId, 22)
    }
  })

  it("rejects a read of a directory with a typed invalid_file", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const target = process.cwd() // a real directory, not a file
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: { id: 22, read_args: { path: target } },
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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
    expect(result.read_result.invalid_file).toMatchObject({
      path: target,
      reason: "Path is a directory, not a file",
    })
  })

  it("still emits a read tool-call for an existing file", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const target = path.join(process.cwd(), "README.md")
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: { id: 23, read_args: { path: target } },
        }),
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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes).toHaveLength(0)
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("read")
    expect(JSON.parse(toolCall.input)).toEqual({ filePath: target })
    sessionManager.resolve(session.sessionId, 23)
  })

  it("does not reject a write to a new file whose parent exists", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const target = path.join(process.cwd(), `new-file-${process.pid}-${Date.now()}.txt`)
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 24,
            write_args: { path: target, file_text: "hello\n" },
          },
        }),
      ],
      writes,
      [{ name: "write", description: "Write" }],
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    // File creation must never be denied — the write reaches OpenCode as a real
    // tool-call even though the target does not exist yet.
    expect(writes).toHaveLength(0)
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("write")
    expect(JSON.parse(toolCall.input)).toEqual({ filePath: target, content: "hello\n" })
    sessionManager.resolve(session.sessionId, 24)
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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(session.pending.size).toBe(0)
  })

  it("bridges a merge without final state when the Run already has a mirrored prior", async () => {
    // Cursor often sends merge:true with only the patch and no success.todos.
    // Expand against session.mirroredTodos and emit a replace-all todowrite so
    // completions still land on the host.
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "todos-merge-from-prior"
    const toolCall = {
      update_todos_tool_call: {
        args: {
          merge: true,
          todos: [{ id: "1", content: "Wire bridge", status: 3 }],
        },
      },
    }
    const session = fakeSession(
      [displayPayload("started", callId, toolCall), displayPayload("completed", callId, toolCall)],
      writes,
    )
    session.nextBridgedExecId = 900_021
    session.mirroredTodos = [
      { id: "1", content: "Wire bridge", status: "in_progress", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ]
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const toolPart = parts.find((p) => p.type === "tool-call")
    expect(toolPart?.toolName).toBe("todowrite")
    expect(JSON.parse(toolPart.input).todos).toEqual([
      { id: "1", content: "Wire bridge", status: "completed", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ])
    expect(session.mirroredTodos).toEqual([
      { id: "1", content: "Wire bridge", status: "completed", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ])
    sessionManager.resolve(session.sessionId, 900_021)
  })

  it("seeds merges after Run close from the per-OpenCode-session mirrored snapshot", async () => {
    // startSession seeds mirroredTodos from snapshotMirroredTodosBySession.
    // Prove the contract end-to-end: store → wipe Run → reseed → merge without
    // success.todos still bridges. Process restart is intentionally out of scope.
    resetTurnStateForTests()
    const openCodeSessionId = `mirror-seed-${Date.now()}`
    const prior = [
      { id: "kept", content: "Kept", status: "pending", priority: "medium" },
      { id: "changed", content: "Old title", status: "in_progress", priority: "medium" },
    ]
    rememberMirroredTodos(openCodeSessionId, prior)
    expect(snapshotMirroredTodosBySession(openCodeSessionId)).toEqual(prior)

    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "todos-merge-after-reseed"
    const toolCall = {
      update_todos_tool_call: {
        args: {
          merge: true,
          todos: [{ id: "changed", content: "Old title", status: 3 }],
        },
      },
    }
    const session = fakeSession(
      [displayPayload("started", callId, toolCall), displayPayload("completed", callId, toolCall)],
      writes,
    )
    session.nextBridgedExecId = 900_022
    session.openCodeSessionId = openCodeSessionId
    // Same seeding startSession performs after turn_ended closed the prior Run.
    session.mirroredTodos = snapshotMirroredTodosBySession(openCodeSessionId)
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const toolPart = parts.find((p) => p.type === "tool-call")
    expect(toolPart?.toolName).toBe("todowrite")
    expect(JSON.parse(toolPart.input).todos).toEqual([
      { id: "kept", content: "Kept", status: "pending", priority: "medium" },
      { id: "changed", content: "Old title", status: "completed", priority: "medium" },
    ])
    expect(snapshotMirroredTodosBySession(openCodeSessionId)).toEqual([
      { id: "kept", content: "Kept", status: "pending", priority: "medium" },
      { id: "changed", content: "Old title", status: "completed", priority: "medium" },
    ])
    sessionManager.resolve(session.sessionId, 900_022)
    resetTurnStateForTests()
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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
  })

  it("does not replay GetMcpTools display completions as a host tool", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const callId = "get-mcp-tools-1"
    const toolCall = {
      get_mcp_tools_tool_call: {
        args: { server: "opencode" },
        result: {
          success: {
            content: '{"note":"Large output has been written to: /tmp/agent-tools/a.txt","filePath":"/tmp/agent-tools/a.txt"}',
            output_file_path: "/tmp/agent-tools/a.txt",
          },
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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(session.displayToolCalls.size).toBe(0)
    expect(session.pending.size).toBe(0)
  })

  it("finishes a rejected native discovery notification without inventing host execution", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession([
      displayPayload("completed", "native-discovery-error", {
        get_mcp_tools_tool_call: { result: { error: { error: "CreatePlan is available directly" } } },
      }),
      turnEndedPayload(),
    ], writes)
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) }, error() {},
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })
    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
    expect(parts.some((p) => p.type === "finish")).toBe(true)
    expect(writes).toHaveLength(0)
    expect(session.pending.size).toBe(0)
  })

  it("soft-denies a known unsupported exec variant and keeps the Run alive", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession([rawExecPayload(42, 38), turnEndedPayload()], writes)
    session.requestContext.env = { workspace_paths: ["/tmp"] }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes.length).toBeGreaterThanOrEqual(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
      .smart_mode_classifier_result
    expect(result.error.error).toContain("Cursor-native 'smart_mode_classifier_args' is not available")
    expect(result.error.error).toContain("Workspace root:")
    expect(writes.some((frame) => {
      try {
        return !!decodeMessage<any>("AgentClientMessage", frame).exec_client_control_message?.stream_close
      } catch { return false }
    })).toBe(true)
    expect(session.closed).toBe(true)
    expect(parts.some((p) => p.type === "finish" && p.finishReason?.unified === "stop")).toBe(true)
  })

  it("soft-denies an allowlist precheck with allowlisted:false", async () => {
    const writes: Uint8Array[] = []
    const session = fakeSession([rawExecPayload(42, 41), turnEndedPayload()], writes)
    const controller = {
      enqueue() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes.length).toBeGreaterThanOrEqual(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message
      .shell_allowlist_precheck_result
    expect(result.allowlisted).toBe(false)
    expect(session.closed).toBe(true)
  })

  it("answers git_diff as provider-control and throws when cwd is not a repo", async () => {
    const writes: Uint8Array[] = []
    const session = fakeSession([rawExecPayload(42, 44), turnEndedPayload()], writes)
    session.requestContext.env = { workspace_paths: ["/tmp"] }
    const controller = {
      enqueue() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes.length).toBeGreaterThanOrEqual(2)
    const thrown = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_control_message.throw
    expect(thrown.error).toMatch(/not a git repository|fatal:/i)
    expect(decodeMessage<any>("AgentClientMessage", writes[1]!).exec_client_control_message.stream_close.id).toBe(42)
  })

  it("distinguishes future protocol drift from a known unsupported exec", async () => {
    const writes: Uint8Array[] = []
    const session = fakeSession([rawExecPayload(42, 99)], writes)
    const controller = {
      enqueue() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await expect(
      pump(session, controller, { textId: "text", reasoningId: "reasoning" }),
    ).rejects.toMatchObject({
      message: "Unsupported Cursor exec variant unknown request field #99 (id=42)",
      code: "CURSOR_RUN_REQUEST_UNSUPPORTED",
    })
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
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("task")
    expect(JSON.parse(toolCall.input)).toEqual({
      description: "Investigate why the conversation stopped",
      prompt: "Investigate why the conversation stopped",
      subagent_type: "general",
    })
    const finish = parts.find((part) =>
      part.type === "finish" && part.finishReason?.unified === "tool-calls"
    )
    expect(finish).toBeDefined()
    expect(finish.usage).toEqual({
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    })
    expect(finish.providerMetadata).toEqual({
      copilot: { totalNanoAiu: 0 },
      cursor: {
        usageVersion: 3,
        occupancyOnly: true,
        billing: { stepUsd: 0, estimate: true, sessionRealUsd: 0, sessionBilledUsd: 0 },
      },
    })
    expect(sessionManager.pendingFor(session.sessionId, 34)?.resultField).toBe("subagent_result")
    sessionManager.resolve(session.sessionId, 34)
  })

  it("emits checkpoint occupancy on tool-call finish so OpenCode can update mid-turn", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession([rawExecPayload(34, 28, rawSubagentArgs())], writes)
    session.tokenDetails = { usedTokens: 153_744, maxTokens: 256_000 }
    session.tokenDetailsFresh = true
    // The context the previous step sent is read from cache on this one.
    session.billing.prefixTokens = 123_651
    session.cacheDiagnostics = {
      conversationId: "display-bridge-conversation",
      priorTokenDetails: { usedTokens: 123_651, maxTokens: 256_000 },
      startedWithCheckpoint: true,
      requestContextReused: true,
      requestContextHash: "abc",
      checkpointUpdates: 1,
      tokenDetailUpdates: 1,
      pumpPasses: 1,
      stepStarts: 1,
      stepCompletes: 0,
      displayToolCalls: 0,
      execRequests: 1,
    }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const finish = parts.find((part) =>
      part.type === "finish" && part.finishReason?.unified === "tool-calls"
    )
    expect(finish.usage.outputTokens.total).toBe(1)
    expect(finish.usage.inputTokens.total + finish.usage.outputTokens.total).toBe(153_744)
    expect(finish.usage.inputTokens.cacheRead).toBe(123_651)
    expect(finish.providerMetadata).toEqual({
      copilot: { totalNanoAiu: 0 },
      cursor: {
        usageVersion: 3,
        occupancyOnly: true,
        billing: { stepUsd: 0, estimate: true, sessionRealUsd: 0, sessionBilledUsd: 0 },
        context: {
          contextUsageVersion: 2,
          source: "checkpoint-current-run",
          stale: false,
          usedTokens: 153_744,
          maxTokens: 256_000,
          remainingTokens: 256_000 - 153_744,
          usedPercent: 60.1,
        },
      },
    })
    sessionManager.resolve(session.sessionId, 34)
  })


  it("bills a priced tool-call step like one model call and tells both hosts the same amount", async () => {
    const parts: any[] = []
    const session = fakeSession([rawExecPayload(34, 28, rawSubagentArgs())], [])
    session.tokenDetails = { usedTokens: 29_467, maxTokens: 256_000 }
    session.tokenDetailsFresh = true
    session.billing = { key: "ses_priced_step", cost: { input: 2, output: 6, cache_read: 0.5 }, prefixTokens: 22_944 }
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>
    try {
      await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
      const finish = parts.find((part) => part.type === "finish" && part.finishReason?.unified === "tool-calls")
      expect(finish.usage.inputTokens).toEqual({ total: 29_466, noCache: 6_522, cacheRead: 22_944, cacheWrite: 0 })
      const usd = (6_522 * 2 + 22_944 * 0.5 + 6) / 1e6
      expect(finish.providerMetadata.copilot.totalNanoAiu / 1e11).toBeCloseTo(usd, 9)
      expect(finish.providerMetadata.cursor.billing).toEqual({
        stepUsd: usd, estimate: true, sessionRealUsd: 0, sessionBilledUsd: usd,
      })
      // The next step reads this step's context from cache.
      expect(session.billing.prefixTokens).toBe(29_467)
    } finally {
      sessionManager.resolve(session.sessionId, 34)
      billingLedger.clear()
    }
  })
  it("routes Cursor guide through an enabled custom scout without changing local explore", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [rawExecPayload(34, 28, rawSubagentArgs("cursor-guide"))],
      writes,
    )
    session.subagentCatalog = {
      executor: "task",
      agents: [{ name: "general" }, { name: "explore" }, { name: "scout" }],
      complete: true,
    }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const toolCall = parts.find((part) => part.type === "tool-call")
    expect(toolCall?.toolName).toBe("task")
    expect(JSON.parse(toolCall.input).subagent_type).toBe("scout")
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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

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
    } as unknown as ReadableStreamDefaultController<any>

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

  it("answers native list_mcp_resources exec (field 17) with an empty success and keeps pumping", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: { id: 13, list_mcp_resources_exec_args: { server: "everything" } },
        }),
        turnEndedPayload(),
      ],
      writes,
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes).toHaveLength(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .exec_client_message.list_mcp_resources_exec_result
    expect(result.error).toBeUndefined()
    expect(result.success.resources).toEqual([])
    expect(parts.some((part) => part.type === "finish")).toBe(true)
  })

  it("answers native read_mcp_resource exec (field 18) with a not-found-server error and keeps pumping", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          exec_server_message: {
            id: 13,
            read_mcp_resource_exec_args: {
              server: "everything",
              uri: "demo://resource/static/document/1",
            },
          },
        }),
        turnEndedPayload(),
      ],
      writes,
    )
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(error: Error) {
        throw error
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(writes).toHaveLength(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .exec_client_message.read_mcp_resource_exec_result
    expect(result.success).toBeUndefined()
    expect(result.error).toMatchObject({
      uri: "demo://resource/static/document/1",
      error: 'Server "everything" not found',
    })
    expect(parts.some((part) => part.type === "finish")).toBe(true)
  })

  it("no longer fails the Run for fields 17/18 (regression for the original CURSOR_RUN_REQUEST_UNSUPPORTED crash)", async () => {
    for (const field of [17, 18]) {
      const writes: Uint8Array[] = []
      const session = fakeSession([rawExecPayload(42, field), turnEndedPayload()], writes)
      const controller = {
        enqueue() {},
        error(error: Error) {
          throw error
        },
      } as unknown as ReadableStreamDefaultController<any>

      await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

      expect(writes).toHaveLength(1)
    }
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
    } as unknown as ReadableStreamDefaultController<any>

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
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await expect(
      pump(session, controller, { textId: "text", reasoningId: "reasoning" }),
    ).rejects.toEqual(expect.objectContaining({
      message: "Cursor request-context reply failed",
      code: "CURSOR_RUN_REPLY_FAILED",
    }))

    expect(session.closed).toBe(true)
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
  })

  it("fails closed when a KV reply write throws (F5)", async () => {
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
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await expect(
      pump(session, controller, { textId: "text", reasoningId: "reasoning" }),
    ).rejects.toEqual(expect.objectContaining({
      message: "Cursor KV reply failed",
      code: "CURSOR_RUN_REPLY_FAILED",
    }))

    expect(session.closed).toBe(true)
  })

  it("emits checkpoint occupancy and preserves raw turn_ended counters", async () => {
    const parts: any[] = []
    const session = fakeSession(
      [
        encodeMessage("AgentServerMessage", {
          interaction_update: {
            turn_ended: {
              input_tokens: 100,
              output_tokens: 40,
              cache_read: 12,
              cache_write: 3,
              reasoning_tokens: 9,
            },
          },
        }),
      ],
      [],
    )
    session.tokenDetails = { usedTokens: 140, maxTokens: 256_000 }
    session.tokenDetailsFresh = false
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    const finish = parts.find((part) => part.type === "finish")
    expect(finish).toBeDefined()
    expect(finish!.usage.inputTokens.total).toBe(139)
    expect(
      finish!.usage.inputTokens.noCache
        + finish!.usage.inputTokens.cacheRead
        + finish!.usage.inputTokens.cacheWrite,
    ).toBe(139)
    expect(finish!.usage.inputTokens.cacheWrite).toBe(0)
    expect(finish!.usage.outputTokens).toEqual({ total: 1, text: 1, reasoning: 0 })
    expect(finish!.providerMetadata).toMatchObject({
      copilot: { totalNanoAiu: 0 },
      cursor: {
        inputTokensRaw: 100,
        outputTokensRaw: 40,
        cacheReadRaw: 12,
        cacheWriteRaw: 3,
        reasoningTokensRaw: 9,
        context: { usedTokens: 140, maxTokens: 256_000 },
      },
    })
  })
})

function textDeltaPayload(text: string): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: { text_delta: { text } },
  })
}

function iteratorFrom(payloads: Uint8Array[]): AsyncIterator<Frame> {
  let index = 0
  return {
    next: async () =>
      index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++] } }
        : { done: true, value: undefined },
  }
}

describe("progress-only continuation pump", () => {
  it("reopens once for a progress fragment and still finishes the original turn later", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [textDeltaPayload("Checking the workspace"), turnEndedPayload()],
      writes,
    )
    session.resumeCheckpoint = Uint8Array.of(1, 2, 3)
    let reopenCalls = 0
    session.reopenWithUserMessage = async () => {
      reopenCalls++
      session.frames = iteratorFrom([
        textDeltaPayload("Checking the workspace"),
        turnEndedPayload(),
      ])
    }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(reopenCalls).toBe(1)
    expect(parts.some((p) => p.type === "finish" && p.finishReason?.unified === "stop")).toBe(true)
    expect(session.closed).toBe(true)
  })

  it("does not reopen a complete answer that starts with a progress verb", async () => {
    const writes: Uint8Array[] = []
    const session = fakeSession(
      [textDeltaPayload("Reviewing this PR: LGTM"), turnEndedPayload()],
      writes,
    )
    session.resumeCheckpoint = Uint8Array.of(1)
    let reopenCalls = 0
    session.reopenWithUserMessage = async () => {
      reopenCalls++
    }
    const controller = {
      enqueue() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(reopenCalls).toBe(0)
  })

  it("does not reopen when allowTools is false", async () => {
    const writes: Uint8Array[] = []
    const session = fakeSession(
      [textDeltaPayload("Checking the workspace"), turnEndedPayload()],
      writes,
    )
    session.allowTools = false
    session.resumeCheckpoint = Uint8Array.of(1)
    let reopenCalls = 0
    session.reopenWithUserMessage = async () => {
      reopenCalls++
    }
    const controller = {
      enqueue() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(reopenCalls).toBe(0)
  })

  it("finishes the original turn_ended when continuation reopen fails", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = fakeSession(
      [textDeltaPayload("Checking the workspace"), turnEndedPayload()],
      writes,
    )
    session.resumeCheckpoint = Uint8Array.of(1)
    session.reopenWithUserMessage = async () => {
      throw new Error("continuation run 401")
    }
    const controller = {
      enqueue(part: unknown) {
        parts.push(part)
      },
      error(err: unknown) {
        throw err
      },
    } as unknown as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(parts.some((p) => p.type === "finish" && p.finishReason?.unified === "stop")).toBe(true)
    expect(session.closed).toBe(true)
  })
})
