import { describe, expect, it } from "bun:test"
import { encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
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

function fakeSession(payloads: Uint8Array[], writes: Uint8Array[]): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () =>
      index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++] } }
        : { done: true, value: undefined },
  }
  const tools = toolsToDescriptors(
    [
      { name: "question", description: "Ask" },
      { name: "todowrite", description: "Todos" },
      { name: "plan_enter", description: "Enter plan" },
      { name: "bash", description: "Shell" },
      { name: "write", description: "Write" },
      { name: "task", description: "Delegate" },
      { name: "github_get_me", description: "Who am I" },
    ],
    "opencode",
    ["github"],
  )
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
    requestContext: { tools },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

describe("display-only ToolCall pump bridge", () => {
  it("bridges ask_question_tool_call → question and finishes with tool-calls", async () => {
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
      [displayPayload("started", callId, toolCall), displayPayload("completed", callId, toolCall)],
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
    const toolPart = parts.find((p) => p.type === "tool-call")
    expect(toolPart?.toolName).toBe("question")
    expect(toolPart?.toolCallId).toContain("cursor_display-bridge-session_900000")
    expect(parts.some((p) => p.type === "finish" && p.finishReason?.unified === "tool-calls")).toBe(true)
    expect(sessionManager.pendingFor(session.sessionId, 900_000)?.bridged).toBe(true)
    expect(session.displayToolCalls.size).toBe(0)
    sessionManager.resolve(session.sessionId, 900_000)
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
})
