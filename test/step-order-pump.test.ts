import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  attachSessionHeartbeat,
  cancelRunForHostInterrupt,
  deliverContinuationResults,
  pump,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { billingLedger } from "../src/billing.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { encodeJsonAsValue, readAllFields } from "../src/protocol/struct.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { HELD_CALL_CANCELLED_REASON } from "../src/step-order.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"
import { withTempHostCache } from "./host-cache.js"

const frame = (message: Record<string, unknown>): Frame => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) })
const listed = (call_count: number) => frame({ interaction_update: { tool_requests_listed: { call_count } } })
const started = (call_id: string, tool_call: Record<string, unknown>) =>
  frame({ interaction_update: { tool_call_started: { call_id, tool_call } } })
const editStarted = (callId: string, target: string) => started(callId, { edit_tool_call: { args: { path: target } } })
const shellStarted = (callId: string, command = "git commit -am change") =>
  started(callId, { shell_tool_call: { args: { command } } })
const readExec = (id: number, target: string, tool_call_id: string) =>
  frame({ exec_server_message: { id, read_args: { path: target, tool_call_id } } })
const writeExec = (id: number, target: string, file_text: string, tool_call_id: string) =>
  frame({ exec_server_message: { id, write_args: { path: target, file_text, tool_call_id } } })
const shellExec = (id: number, tool_call_id: string, command = "git commit -am change") =>
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id } } })
const completed = (call_id: string) => frame({ interaction_update: { tool_call_completed: { call_id } } })
const execAbort = (id: number) => frame({ exec_server_control_message: { abort: { id } } })
const ended = () => frame({ interaction_update: { turn_ended: {} } })

/** Frames in order; a read past the end waits until the test pushes more. */
function scriptedFrames(initial: Frame[]) {
  const queue = [...initial]
  let waiting: ((result: IteratorResult<Frame>) => void) | undefined
  const iterator: AsyncIterator<Frame> = {
    next: () => {
      const next = queue.shift()
      if (next) return Promise.resolve({ done: false, value: next })
      return new Promise((resolve) => { waiting = resolve })
    },
  }
  return {
    iterator,
    push(...frames: Frame[]) {
      queue.push(...frames)
      const resolve = waiting
      waiting = undefined
      const next = queue.shift()
      if (resolve && next) resolve({ done: false, value: next })
      else if (next) queue.unshift(next)
    },
  }
}

const roots: string[] = []
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-step-order-"))
  roots.push(root)
  return root
}

function fixture(initial: Frame[], root: string) {
  const script = scriptedFrames(initial)
  const writes: Uint8Array[] = []
  const tools = [
    { name: "bash", description: "Shell" },
    { name: "read", description: "Read" },
    { name: "grep", description: "Search" },
    { name: "edit", description: "Edit" },
    { name: "write", description: "Write" },
  ]
  const session = sessionFixture({
    sessionId: `step-order-${Math.random().toString(16).slice(2)}`,
    conversationId: `step-order-conversation-${Math.random().toString(16).slice(2)}`,
    stream: {
      write(data: Uint8Array) { writes.push(data); return true }, end() {}, destroy() {}, isClosed: () => false,
      onTerminal: () => () => {},
      frames: () => ({ [Symbol.asyncIterator]: () => script.iterator }),
    },
    frames: script.iterator, pending: new Map(), displayToolCalls: new Map(),
    nextBridgedExecId: 900_000, blobs: new Map(), toolCatalog: tools,
    toolDescriptors: toolsToDescriptors(tools, "opencode"), requestContext: { env: { workspace_paths: [root] } },
    allowTools: true, pumpActive: false, heartbeat: null, heartbeatCancel: null,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
  })
  const parts: LanguageModelV3StreamPart[] = []
  const controller = {
    desiredSize: 1, close() {},
    enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
    error(error: unknown) { throw error },
  } as ReadableStreamDefaultController<LanguageModelV3StreamPart>
  const run = () => pump(session, controller, { textId: "text", reasoningId: "reasoning" })
  return { session, writes, parts, run, push: script.push }
}

type Part = LanguageModelV3StreamPart
const toolCalls = (parts: Part[]) => parts.filter((part): part is Extract<Part, { type: "tool-call" }> => part.type === "tool-call")
const finishes = (parts: Part[]) => parts.filter((part): part is Extract<Part, { type: "finish" }> => part.type === "finish")
const replies = (writes: Uint8Array[]) => writes
  .map((bytes) => decodeMessage<any>("AgentClientMessage", bytes).exec_client_message)
  .filter((message) => message !== undefined)
/** Exec ids in the order Cursor got their first reply frame (a shell result streams several). */
const replyOrder = (writes: Uint8Array[]) => [...new Set(replies(writes).map((message) => message.id))]
const replyText = (writes: Uint8Array[], id: number) =>
  JSON.stringify(replies(writes).filter((message) => message.id === id))

async function answer(session: CursorSession, call: Extract<Part, { type: "tool-call" }>, execId: number, extra: Record<string, unknown> = {}) {
  expect(await deliverContinuationResults(session, [{
    sessionId: session.sessionId, execId, toolCallId: call.toolCallId, toolName: call.toolName, output: "done", ...extra,
  }])).toBe(session)
}

/** An edit of an existing file, then a command that depends on it, in one step. */
function editThenShell(root: string) {
  const target = path.join(root, "target.txt")
  fs.writeFileSync(target, "before\n")
  return {
    target,
    frames: [
      listed(2),
      editStarted("edit", target),
      readExec(1, target, "edit"),
      shellStarted("shell"),
      shellExec(2, "shell"),
    ],
  }
}

describe("model order in a step that changes a file", () => {
  beforeEach(resetToolRequestsListedSeenForTests)
  afterEach(() => {
    sessionManager.dispose()
    resetToolRequestsListedSeenForTests()
    resetTurnStateForTests()
    billingLedger.clear()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("runs the command after the edit's write lands, and answers Cursor in that order", async () => {
    const root = workspace()
    const { target, frames } = editThenShell(root)
    const f = fixture(frames, root)

    await f.run()
    // The edit's private read goes to the host; the command waits.
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read"])
    expect(finishes(f.parts)).toHaveLength(1)
    expect([...f.session.pending.keys()].sort()).toEqual([1, 2])
    expect(f.session.stepOrder?.held.map((held) => held.execId)).toEqual([2])

    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    f.push(writeExec(3, target, "after\n", "edit"))
    await f.run()
    // The write is the edit's host call; the command still waits for its result.
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read", "edit"])
    expect(f.session.stepOrder?.held.map((held) => held.execId)).toEqual([2])

    await answer(f.session, toolCalls(f.parts)[1]!, 3)
    await f.run()
    const calls = toolCalls(f.parts)
    expect(calls.map((call) => call.toolName)).toEqual(["read", "edit", "bash"])
    expect(calls[2]!.toolCallId).toBe(`cursor_${f.session.sessionId}_2`)
    expect(JSON.parse(calls[2]!.input).command).toBe("git commit -am change")
    expect(finishes(f.parts).map((finish) => finish.finishReason.unified)).toEqual(["tool-calls", "tool-calls", "tool-calls"])
    expect(f.session.stepOrder?.held).toEqual([])

    await answer(f.session, calls[2]!, 2)
    expect(replyOrder(f.writes)).toEqual([1, 3, 2])
    f.push(completed("edit"), completed("shell"), ended())
    await f.run()
    expect(finishes(f.parts).at(-1)!.finishReason.unified).toBe("stop")
  })

  it("holds a command whose exec arrives before an announced host edit called through MCP", async () => {
    const root = workspace()
    const target = path.join(root, "target.txt")
    fs.writeFileSync(target, "before\n")
    const mcpArgs = (args: Record<string, unknown>) => ({
      name: "opencode-edit",
      args: readAllFields(readAllFields(encodeJsonAsValue(args)).find((field) => field.fn === 5)!.bytes!)
        .map((field) => field.bytes!),
      tool_call_id: "edit",
    })
    const edit = mcpArgs({ filePath: target, oldString: "before", newString: "after" })
    const f = fixture([
      listed(2),
      started("edit", { mcp_tool_call: { args: edit } }),
      shellStarted("shell"),
      shellExec(2, "shell"),
      frame({ exec_server_message: { id: 1, mcp_args: edit } }),
    ], root)

    await f.run()
    // The command came first on the wire but follows the edit in the model's order.
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["edit"])
    expect(f.session.stepOrder?.held.map((held) => held.execId)).toEqual([2])

    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["edit", "bash"])
    expect(f.session.stepOrder?.held).toEqual([])
    await answer(f.session, toolCalls(f.parts)[1]!, 2)
    expect(replyOrder(f.writes)).toEqual([1, 2])
  })

  it("holds the command behind an edit whose read Cursor answers locally", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(2),
      editStarted("edit", target),
      readExec(1, target, "edit"),
      shellStarted("shell"),
      shellExec(2, "shell"),
      writeExec(3, target, "created\n", "edit"),
    ], root)

    await f.run()
    // A missing target's read is answered here; the write is the step's only host call.
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write"])
    expect(replyOrder(f.writes)).toEqual([1])
    expect(f.session.stepOrder?.held.map((held) => held.execId)).toEqual([2])

    await answer(f.session, toolCalls(f.parts)[0]!, 3)
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write", "bash"])
  })

  it("settles a locally rejected read without a display id before a later edit", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(3),
      frame({ exec_server_message: { id: 1, read_args: { path: path.join(root, "missing.txt") } } }),
      editStarted("edit", target),
      writeExec(2, target, "created\n", "edit"),
      shellStarted("shell"),
      shellExec(3, "shell"),
      ended(),
    ], root)

    await f.run()
    expect(replyOrder(f.writes)).toEqual([1])
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write"])
    await answer(f.session, toolCalls(f.parts)[0]!, 2)
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write", "bash"])
  })

  it("runs the command when Cursor finishes the edit without a write", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    // Cursor could not apply the edit and completes it; that ends the hold.
    f.push(completed("edit"))
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read", "bash"])
    expect(f.session.stepOrder?.held).toEqual([])
  })

  it("cancels the command when the host refuses the edit", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(2),
      editStarted("edit", target),
      readExec(1, target, "edit"),
      shellStarted("shell"),
      shellExec(2, "shell"),
      writeExec(3, target, "created\n", "edit"),
    ], root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 3, {
      output: "The user rejected permission to use this specific tool call.",
      error: "The user rejected permission to use this specific tool call.",
      refusal: "rejected",
    })
    f.push(ended())
    await f.run()

    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write"])
    expect(replyText(f.writes, 2)).toContain(HELD_CALL_CANCELLED_REASON)
    expect(f.session.closed).toBe(true)
  })

  it("cancels the command when the user stops the edit", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(2),
      editStarted("edit", target),
      readExec(1, target, "edit"),
      shellStarted("shell"),
      shellExec(2, "shell"),
      writeExec(3, target, "created\n", "edit"),
    ], root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 3, { error: "Tool execution aborted", interrupted: true })
    f.push(ended())
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write"])
    expect(replyText(f.writes, 2)).toContain(HELD_CALL_CANCELLED_REASON)
  })

  it("keeps a denied change's cancellation when a listed follower arrives after the idle boundary", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([listed(2), editStarted("edit", target), writeExec(1, target, "created\n", "edit")], root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1, { error: "Permission rejected", refusal: "rejected" })
    f.push(shellStarted("shell"), shellExec(2, "shell"), ended())
    await f.run()

    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write"])
    expect(replyText(f.writes, 2)).toContain(HELD_CALL_CANCELLED_REASON)
    expect(finishes(f.parts).at(-1)!.finishReason.unified).toBe("stop")
  })

  it("never runs a held call Cursor withdraws", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    f.push(execAbort(2), completed("edit"), ended())
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read"])
    expect(replyOrder(f.writes)).toEqual([1])
    expect(finishes(f.parts).at(-1)!.finishReason.unified).toBe("stop")
  })

  it("applies an already queued abort before releasing its held call", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    f.session.heldFrames = [completed("edit"), execAbort(2), ended()]

    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read"])
    expect(replyOrder(f.writes)).toEqual([1])
    expect(finishes(f.parts).at(-1)!.finishReason.unified).toBe("stop")
  })

  it("never redispatches a held call whose pending owner was removed", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    sessionManager.resolve(f.session.sessionId, 2)
    f.push(completed("edit"), ended())
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read"])
    expect(replyOrder(f.writes)).toEqual([1])
  })

  it("does not reply to a cancelled follower whose pending owner was removed", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1, { error: "Permission rejected", refusal: "rejected" })
    sessionManager.resolve(f.session.sessionId, 2)
    f.push(ended())
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read"])
    expect(replyOrder(f.writes)).toEqual([1])
  })

  it("rechecks a held tool against the permitted catalog on release", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(2), editStarted("edit", target), writeExec(1, target, "created\n", "edit"),
      shellStarted("shell"), shellExec(2, "shell"),
    ], root)
    await f.run()
    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    f.session.permittedToolNames = new Set(["read", "write"])
    f.push(ended())
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write"])
    expect(replyText(f.writes, 2)).toContain("not permitted")
    expect(f.session.pending.size).toBe(0)
  })

  it("releases a follower when the provider refuses the change's mapping", async () => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(2), editStarted("edit", target), shellStarted("shell"), shellExec(2, "shell"),
      writeExec(1, target, "created\n", "edit"),
    ], root)
    f.session.permittedToolNames = new Set(["read", "bash"])
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["bash"])
    expect(replyText(f.writes, 1)).toContain("not permitted")
    expect(replyText(f.writes, 2)).toBe("[]")
  })

  it("never runs a held call after the host stops the turn", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    await f.run()
    expect(f.session.pending.has(2)).toBe(true)

    const cancelled = cancelRunForHostInterrupt(f.session, "user", { graceMs: 1_000 })
    for (let i = 0; i < 200 && !f.writes.some((bytes) => decodeMessage<any>("AgentClientMessage", bytes).conversation_action); i++) {
      await Bun.sleep(5)
    }
    f.push(ended())
    await cancelled

    expect(f.session.closed).toBe(true)
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["read"])
    expect(replies(f.writes)).toEqual([])
    expect(sessionManager.classify(f.session.sessionId, 2)).toEqual({ kind: "terminal", reason: "host-interrupted" })
  })

  it("emits every call of a step without a file change at once", async () => {
    const root = workspace()
    const f = fixture([
      listed(3),
      shellStarted("status", "git status"),
      shellExec(1, "status", "git status"),
      started("search", { grep_tool_call: { args: { pattern: "TODO" } } }),
      frame({ exec_server_message: { id: 2, grep_args: { pattern: "TODO", path: root, tool_call_id: "search" } } }),
      shellStarted("log", "git log -1"),
      shellExec(3, "log", "git log -1"),
    ], root)
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["bash", "grep", "bash"])
    expect(finishes(f.parts)).toHaveLength(1)
    expect(f.session.stepOrder?.held ?? []).toEqual([])
  })

  it("does not count an unordered image-copy refusal as a listed model call", async () => {
    const root = workspace()
    const f = fixture([
      listed(2),
      frame({ exec_server_message: { id: 99, write_args: { path: path.join(root, "copy.png"), file_bytes: new Uint8Array([0, 255, 0]) } } }),
      shellStarted("status", "git status"), shellExec(1, "status", "git status"),
      shellStarted("log", "git log -1"), shellExec(2, "log", "git log -1"),
    ], root)
    await f.run()
    expect(replyOrder(f.writes)).toEqual([99])
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["bash", "bash"])
    expect(finishes(f.parts)).toHaveLength(1)
  })

  it("runs a call before the edit with it and holds only the call after it", async () => {
    const root = workspace()
    const target = path.join(root, "target.txt")
    fs.writeFileSync(target, "before\n")
    const f = fixture([
      listed(3),
      shellStarted("status", "git status"),
      shellExec(1, "status", "git status"),
      editStarted("edit", target),
      shellStarted("commit"),
      shellExec(3, "commit"),
      readExec(2, target, "edit"),
    ], root)
    await f.run()
    // The edit's read waits for the status the model asked for first; the commit waits for the edit.
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["bash"])
    expect(f.session.stepOrder?.held.map((held) => held.execId)).toEqual([2, 3])
    await answer(f.session, toolCalls(f.parts)[0]!, 1)
    await f.run()
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["bash", "read"])
    expect(f.session.stepOrder?.held.map((held) => held.execId)).toEqual([3])
  })

  it("books one Cursor step once when its calls run in two host steps", async () => withTempHostCache(async cacheDir => {
    const root = workspace()
    const target = path.join(root, "new.txt")
    const f = fixture([
      listed(2),
      editStarted("edit", target),
      readExec(1, target, "edit"),
      shellStarted("shell"),
      shellExec(2, "shell"),
      writeExec(3, target, "created\n", "edit"),
    ], root)
    f.session.cacheDir = cacheDir
    f.session.openCodeSessionId = "ses_step_order_billing"
    f.session.tokenDetails = { usedTokens: 40_000, maxTokens: 256_000 }
    f.session.tokenDetailsFresh = true
    f.session.billing = { key: "ses_step_order", cost: { input: 2, output: 6, cache_read: 0.5 }, prefixTokens: 30_000 }

    await f.run()
    const first = finishes(f.parts)[0]!
    expect(first.usage.inputTokens.total! + first.usage.outputTokens.total!).toBe(40_000)
    const booked = billingLedger.totals(f.session.billing.key).billedUsd
    expect(booked).toBeGreaterThan(0)

    await answer(f.session, toolCalls(f.parts)[0]!, 3)
    await f.run()
    const released = finishes(f.parts)[1]!
    expect(toolCalls(f.parts).map((call) => call.toolName)).toEqual(["write", "bash"])
    expect(released.usage.inputTokens.total ?? 0).toBe(0)
    expect(released.usage.outputTokens.total ?? 0).toBe(0)
    expect(released.providerMetadata).toMatchObject({ copilot: { totalNanoAiu: 0 }, cursor: { releasedStep: true } })
    expect(billingLedger.totals(f.session.billing.key).billedUsd).toBe(booked)
  }))

  it("keeps a held call owed to Cursor with the usual exec heartbeats", async () => {
    const root = workspace()
    const { frames } = editThenShell(root)
    const f = fixture(frames, root)
    f.session.policy = { heartbeatMs: 1_000, semanticIdleMs: 60_000, hardCapMs: 120_000 }
    await f.run()
    attachSessionHeartbeat(f.session)
    try {
      await Bun.sleep(3_300)
      const heartbeats = f.writes.flatMap((bytes) => {
        const control = decodeMessage<any>("AgentClientMessage", bytes).exec_client_control_message
        return control?.heartbeat ? [control.heartbeat.id ?? 0] : []
      })
      expect(heartbeats.sort()).toEqual([1, 2])
    } finally {
      f.session.heartbeatCancel?.()
    }
  }, 15_000)
})
