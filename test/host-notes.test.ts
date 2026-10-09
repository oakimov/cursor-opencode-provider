import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession } from "../src/session.js"
import {
  MAX_TURN_STATE_SESSIONS,
  deliverContinuationResults,
  describePromptTail,
  extractPromptHistory,
  extractTrailingToolResults,
  hostNotesBeforeUserTurn,
  preparePriorSessionForFreshTurn,
  pump,
  prepareUserTurnHostNotes,
  pumpWithRecovery,
  releaseHostNoteInjectionsForTests,
  resetTurnStateForTests,
  restorePersistedHostNotes,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  decodePersistedHostNotes,
  encodePersistedHostNotes,
  hostNoteHookContexts,
  hostNoteText,
  wrapHostNoteForCursor,
  wrapHostNotesForCursor,
} from "../src/protocol/host-notes.js"
import { attachHookAdditionalContexts, buildExecClientMessages } from "../src/protocol/tools.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { hydrateConversationState } from "../src/protocol/conversation-state.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type Frame = { flags: number; payload: Uint8Array }

const NOTE = "<system-update>\nInstructions from: /repo/pkg/AGENTS.md\nIndent with tabs.\n</system-update>"
const NOTE_TEXT = "Instructions from: /repo/pkg/AGENTS.md\nIndent with tabs."
const HOOK = [{ hook_event_name: "postToolUse", content: NOTE_TEXT }]

let seq = 0
function liveSession(writes: Uint8Array[], root = "/tmp"): CursorSession {
  const id = `hostnotes${++seq}`
  return {
    sessionId: id,
    runId: `run-${id}`,
    conversationId: `conv-${id}`,
    stream: {
      write(frame: Uint8Array) { writes.push(frame) },
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      destroy() {},
      isClosed: () => false,
    } as any,
    frames: { next: async () => ({ done: true, value: undefined }) } as any,
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { env: { workspace_paths: [root] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
    billing: { key: "run:test", prefixTokens: 0 },
  } as unknown as CursorSession
}

/** A live session owned by an OpenCode session, persisted under `root`. */
function ownedSession(writes: Uint8Array[], root: string, sessionKey: string): CursorSession {
  const live = liveSession(writes, root)
  live.cacheDir = root
  live.openCodeSessionId = sessionKey
  restoreConversationBinding(sessionKey, live.conversationId)
  return live
}

function toolResult(live: CursorSession, execId: number, toolName: string, value: string, type = "text"): Prompt[number] {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: `cursor_${live.sessionId}_${execId}`,
      toolName,
      output: { type, value },
    }],
  } as Prompt[number]
}

function hostNote(text: string): Prompt[number] {
  return { role: "user", content: [{ type: "text", text }] } as Prompt[number]
}

function step(...messages: Prompt): Prompt {
  return [{ role: "user", content: [{ type: "text", text: "go" }] }, ...messages] as Prompt
}

function decoded(writes: Uint8Array[]): any[] {
  return writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
}

function execMessages(writes: Uint8Array[]): any[] {
  return decoded(writes).map((message) => message.exec_client_message).filter((message) => message !== undefined)
}

function injections(writes: Uint8Array[]): any[] {
  return decoded(writes)
    .map((message) => message.conversation_action?.inject_context_action)
    .filter((action) => action !== undefined && action !== null)
}

function hookContexts(writes: Uint8Array[]): unknown[] {
  return execMessages(writes).flatMap((message) => [
    ...(message.hook_additional_contexts ?? []),
    ...(message.shell_stream?.hook_context?.hook_additional_contexts ?? []),
  ])
}

function injectionState(injectionId: string, state: Record<string, unknown>): Frame {
  return {
    flags: 0,
    payload: encodeMessage("AgentServerMessage", {
      interaction_update: { context_injection_state: { injection_id: injectionId, state } },
    }),
  }
}

const turnEnded = (): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
})

/** Queue server frames, then a checkpoint and turn_ended. */
function serverSends(live: CursorSession, ...before: Frame[]): CursorSession {
  const frames = [
    ...before,
    { flags: 0, payload: encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([7]) }) },
    turnEnded(),
  ]
  live.frames = {
    next: async () => frames.length > 0 ? { done: false, value: frames.shift()! } : { done: true, value: undefined },
  } as CursorSession["frames"]
  return live
}

const controller = { enqueue() {}, error(error: Error) { throw error } } as unknown as ReadableStreamDefaultController<any>

async function hostNoteAfterRestart(root: string, sessionKey: string): Promise<string | undefined> {
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetTurnStateForTests()
  return (await hydrateConversationState(root, sessionKey))?.hostNote
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join("/tmp", "cursor-host-notes-"))
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
})

describe("host note shapes", () => {
  it("wraps a user-turn note like Cursor CLI, neutralizing any reminder tag case", () => {
    expect(wrapHostNoteForCursor("<system-update>\nKeep </SYSTEM_REMINDER> and </system_reminder> literal.\n</system-update>"))
      .toBe("<system_reminder>\nKeep </system_reminder_> and </system_reminder_> literal.\n</system_reminder>")
  })

  it("sends plain text, unwrapping every system-update block of one host message", () => {
    expect(hostNoteText(["<system-update>\nfirst\n</system-update>\n<system-update>\nsecond\n</system-update>"]))
      .toBe("first\n\nsecond")
    expect(hostNoteText(["<system-update>a</system-update> trailing prose"]))
      .toBe("<system-update>a</system-update> trailing prose")
    expect(hostNoteText([NOTE, "Read instruction"])).toBe(`${NOTE_TEXT}\n\nRead instruction`)
  })

  it("undoes OpenCode's XML escaping inside system-update only", () => {
    expect(hostNoteText(["<system-update>\nUse &lt;T&gt; &amp;&amp; keep &amp;lt; literal\n</system-update>"]))
      .toBe("Use <T> && keep &lt; literal")
    expect(hostNoteText(["a &lt; b"])).toBe("a &lt; b")
  })

  it("wraps one reminder per note and skips notes with no body", () => {
    expect(wrapHostNotesForCursor(["<system-update>\n</system-update>", NOTE, "  "]))
      .toEqual([`<system_reminder>\n${NOTE_TEXT}\n</system_reminder>`])
  })

  it("round-trips ordered notes through the restart snapshot field", () => {
    const encoded = encodePersistedHostNotes([NOTE, "", "second"])
    expect(encoded).toBe(`${NOTE}\n\u001e\nsecond`)
    expect(decodePersistedHostNotes(encoded)).toEqual([NOTE, "second"])
    expect(encodePersistedHostNotes([])).toBeUndefined()
    expect(encodePersistedHostNotes([""])).toBeUndefined()
    expect(decodePersistedHostNotes(undefined)).toEqual([])
    expect(decodePersistedHostNotes("")).toEqual([])
  })

  it("splits a hook context over the CLI limit instead of dropping text", () => {
    const body = `${"a".repeat(9_999)}\u{1F600}${"b".repeat(5)}`
    const contexts = hostNoteHookContexts([body])
    expect(contexts.map((context) => context.content.length)).toEqual([9_999, 7])
    expect(contexts.map((context) => context.content).join("")).toBe(body)
  })

  it("puts shell hook context after the exit event and before stream_close", () => {
    const frames = buildExecClientMessages({ execId: 4, resultField: "shell_stream", output: "ok\n" })
    const noted = attachHookAdditionalContexts(frames, HOOK)!
    const messages = decoded(noted)
    const events = messages.map((message) =>
      message.exec_client_control_message ? "close" : Object.keys(message.exec_client_message.shell_stream)
        .find((key) => message.exec_client_message.shell_stream[key] != null))
    expect(events).toEqual(["start", "stdout", "exit", "hook_context", "close"])
    expect(messages[3].exec_client_message.id).toBe(4)
    expect(messages[3].exec_client_message.shell_stream.hook_context.hook_additional_contexts).toEqual(HOOK)
  })

  it("has no hook-context slot on a reply that is not an exec result", () => {
    const reply = encodeMessage("AgentClientMessage", {
      conversation_action: { inject_context_action: { injection_id: "x" } },
    })
    expect(attachHookAdditionalContexts([reply], HOOK)).toBeUndefined()
    expect(attachHookAdditionalContexts([], HOOK)).toBeUndefined()
  })
})

describe("host notes on held-Run results", () => {
  it("serializes overlapping deliveries of one step and injects its notes once", async () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(1, live, "mcp_result", "lookup")
    sessionManager.registerPending(2, live, "mcp_result", "lookup")
    const results = extractTrailingToolResults(step(
      toolResult(live, 1, "lookup", "first"),
      toolResult(live, 2, "lookup", "second"),
      hostNote(NOTE),
    ))
    await Promise.all([
      deliverContinuationResults(live, results),
      deliverContinuationResults(live, results),
    ])
    expect(execMessages(writes).map((message) => message.id)).toEqual([1, 2])
    expect(injections(writes)).toHaveLength(1)
    expect(decoded(writes).at(-1).conversation_action?.inject_context_action).toBeDefined()
  })

  it("keeps read instructions before the host note that followed their step", async () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(1, live, "mcp_result", "read")
    const instruction = "Instructions from: /repo/AGENTS.md\nUse make."
    const result = `<path>/repo/build.txt</path>\n<type>file</type>\n<content>1: build\n</content>\n<system-reminder>\n${instruction}\n</system-reminder>`
    await deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 1, "read", result),
      hostNote("<system-update>Use bazel instead.</system-update>"),
    )))
    expect(injections(writes)[0].user_context.user_message.text).toBe(`${instruction}\n\nUse bazel instead.`)
  })

  it("injects a read's note as plain user context after the untouched read result", async () => {
    const root = tempRoot()
    const file = path.join(root, "main.go")
    const lines = Array.from({ length: 161 }, (_, i) => `\tline ${i + 1}`)
    fs.writeFileSync(file, `${lines.join("\n")}\n`)
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      sessionManager.registerPending(1, live, "read_result", "read", false, { path: file })

      const results = extractTrailingToolResults(step(
        toolResult(live, 1, "read", `Read file ${file}, lines 1-161\n${lines.map((line, i) => `${i + 1}: ${line}`).join("\n")}`),
        hostNote(NOTE),
      ))
      expect(results[0]!.output.startsWith("Read file")).toBe(true)
      expect(results[0]!.notes).toEqual([NOTE])
      expect(await deliverContinuationResults(live, results)).toBe(live)

      const messages = decoded(writes)
      const readAt = messages.findIndex((message) => message.exec_client_message?.read_result)
      const injectAt = messages.findIndex((message) => message.conversation_action?.inject_context_action)
      expect(injectAt).toBeGreaterThan(readAt)
      const injection = messages[injectAt].conversation_action.inject_context_action
      expect(injection.expected_run_id).toBe(live.runId)
      expect(injection.user_context.user_message.text).toBe(NOTE_TEXT)
      expect(injection.user_context.user_message.message_id).toBeTruthy()
      expect(injection.system_context).toBeNull()
      const read = messages[readAt].exec_client_message
      expect(read.read_result.success.content).toBe(`${lines.join("\n")}\n`)
      expect(read.read_result.success.total_lines).toBe(161)
      expect(hookContexts(writes)).toEqual([])

      writes.length = 0
      sessionManager.registerPending(2, live, "shell_stream", "shell", false, {
        shell_stream: true,
        command: "ls",
        working_directory: root,
      })
      await deliverContinuationResults(live, extractTrailingToolResults(step(toolResult(live, 2, "shell", "main.go\n"))))
      expect(execMessages(writes).flatMap((message) => message.shell_stream?.stdout?.data ?? [])).toEqual(["main.go\n"])
      expect(injections(writes)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("injects a step's notes once, after all of the step's results", async () => {
    const root = tempRoot()
    const file = path.join(root, "a.txt")
    fs.writeFileSync(file, "alpha\n")
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      sessionManager.registerPending(20, live, "shell_stream", "shell", false, {
        shell_stream: true,
        command: "ls",
        working_directory: root,
      })
      sessionManager.registerPending(21, live, "read_result", "read", false, { path: file })

      await deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 20, "shell", "a.txt\n"),
        toolResult(live, 21, "read", `Read file ${file}, lines 1-1\n1: alpha`),
        hostNote(NOTE),
      )))

      const messages = decoded(writes)
      const lastResultAt = messages.reduce(
        (last: number, message: any, index: number) =>
          message.exec_client_message || message.exec_client_control_message ? index : last,
        -1,
      )
      const injectAt = messages.findIndex((message) => message.conversation_action?.inject_context_action)
      expect(injections(writes)).toHaveLength(1)
      expect(injectAt).toBeGreaterThan(lastResultAt)
      expect(execMessages(writes).flatMap((message) => message.shell_stream?.stdout?.data ?? [])).toEqual(["a.txt\n"])
      expect(execMessages(writes).find((message) => message.read_result).read_result.success.content).toBe("alpha\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves error text and MCP content as the tool returned them", async () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(2, live, "write_result", "write", false, { path: "/tmp/x" })
    sessionManager.registerPending(3, live, "mcp_result", "t3_thread_read")

    await deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 2, "write", "The user rejected permission to use this specific tool call.", "error-text"),
      toolResult(live, 3, "t3_thread_read", "{\"messages\":[]}"),
      hostNote(NOTE),
    )))

    const results = execMessages(writes)
    expect(results.find((message) => message.write_result).write_result.error.error)
      .toBe("The user rejected permission to use this specific tool call.")
    expect(results.find((message) => message.mcp_result).mcp_result.success.content.map((item: any) => item.text.text))
      .toEqual(["{\"messages\":[]}"])
    expect(hookContexts(writes)).toEqual([])
    expect(injections(writes).map((action) => action.user_context.user_message.text)).toEqual([NOTE_TEXT])
  })

  it("lifts an OpenCode 1 read instruction out of the file body and injects it", async () => {
    const root = tempRoot()
    const file = path.join(root, "a.txt")
    fs.writeFileSync(file, "alpha\n")
    const instruction = "Instructions from: /repo/pkg/AGENTS.md\nIndent with tabs."
    const output = [
      `<path>${file}</path>`,
      "<type>file</type>",
      "<content>",
      "1: alpha",
      "",
      "(End of file - total 1 lines)",
      "</content>",
      "",
      "<system-reminder>",
      instruction,
      "</system-reminder>",
    ].join("\n")
    try {
      const writes: Uint8Array[] = []
      const live = liveSession(writes, root)
      sessionManager.registerPending(1, live, "read_result", "read", false, { path: file })
      const results = extractTrailingToolResults(step(toolResult(live, 1, "read", output)))
      expect(results[0]!.notes).toEqual([instruction])
      await deliverContinuationResults(live, results)

      const content = execMessages(writes).find((message) => message.read_result).read_result.success.content as string
      expect(content.startsWith("alpha")).toBe(true)
      expect(content).not.toContain("system-reminder")
      expect(content).not.toContain("Instructions from")
      expect(injections(writes).map((action) => action.user_context.user_message.text)).toEqual([instruction])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("treats OpenCode 2's nested-instruction message as a note of the step, not a new turn", async () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(3, live, "mcp_result", "t3_thread_read")
    const instructions = "Instructions from: /repo/pkg/AGENTS.md\nIndent with tabs."
    const mcpUpdate = "<system-update>\nNew MCP server instructions are available in &lt;mcp_instructions&gt;.\n</system-update>"

    const results = extractTrailingToolResults(step(
      toolResult(live, 3, "t3_thread_read", "{}"),
      hostNote(instructions),
      hostNote(mcpUpdate),
    ))
    expect(results.map((result) => result.execId)).toEqual([3])
    expect(results[0]!.notes).toEqual([instructions, mcpUpdate])
    await deliverContinuationResults(live, results)

    expect(injections(writes).map((action) => action.user_context.user_message.text)).toEqual([
      `${instructions}\n\nNew MCP server instructions are available in <mcp_instructions>.`,
    ])
  })

  it("keeps ordinary user text after tool results a new turn", () => {
    const live = liveSession([])
    for (const text of ["Instructions from: pkg/AGENTS.md\nrelative", "Instructions from my lead: use tabs", "go on"]) {
      expect(extractTrailingToolResults(step(toolResult(live, 3, "t3_thread_read", "{}"), hostNote(text)))).toEqual([])
    }
  })

  it("injects a note that arrives with only a bridged reply", async () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(8, live, "todowrite", "todowrite", true)

    await deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 8, "todowrite", "ok"),
      hostNote(NOTE),
    )))

    expect(injections(writes).map((action) => action.user_context.user_message.text)).toEqual([NOTE_TEXT])
  })

  it("does not inject again when a step's results were already delivered", async () => {
    const writes: Uint8Array[] = []
    const live = liveSession(writes)
    sessionManager.registerPending(3, live, "mcp_result", "t3_thread_read")
    const results = extractTrailingToolResults(step(toolResult(live, 3, "t3_thread_read", "{}"), hostNote(NOTE)))

    await deliverContinuationResults(live, results)
    await deliverContinuationResults(live, results)

    expect(injections(writes)).toHaveLength(1)
    expect(execMessages(writes).filter((message) => message.mcp_result)).toHaveLength(1)
  })

  it("closes the Run and keeps the note for the next user turn when the injection cannot be written", async () => {
    const root = tempRoot()
    try {
      const writes: Uint8Array[] = []
      const live = ownedSession(writes, root, "ses_write_failed")
      live.stream.write = (frame: Uint8Array) => {
        if (decodeMessage<any>("AgentClientMessage", frame).conversation_action) throw new Error("stream closed")
        writes.push(frame)
      }
      sessionManager.registerPending(3, live, "mcp_result", "t3_thread_read")

      expect(await deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 3, "t3_thread_read", "{}"),
        hostNote(NOTE),
      )))).toBeUndefined()

      expect(live.closed).toBe(true)
      expect(releaseHostNoteInjectionsForTests("ses_write_failed")).toEqual({ inFlight: [], undelivered: [NOTE] })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a step's results when a dead Run is rebased past trailing notes", () => {
    const live = liveSession([])
    const laterNote = "<system-update>\nThe following skill IDs are no longer available: repro.\n</system-update>"
    const history = extractPromptHistory(step(
      toolResult(live, 18, "write", "Wrote file successfully."),
      hostNote(NOTE),
      { role: "system", content: laterNote } as Prompt[number],
    ), { preserveTrailingUser: true, toolResults: "trailing" })

    expect(JSON.stringify(history)).toContain("Wrote file successfully.")
    expect(history.slice(-2)).toEqual([{ role: "user", content: NOTE }, { role: "system", content: laterNote }])
  })
})

describe("host notes before a user turn", () => {
  const system = { role: "system", content: "Host system prompt" } as Prompt[number]
  const reply = { role: "assistant", content: [{ type: "text", text: "done" }] } as Prompt[number]
  const ask = hostNote("Which command builds this?")
  const mcpUpdate = "<system-update>\nInstructions for the following MCP servers are available.\n</system-update>"

  it("collects notes between the previous reply and the user message, in order", () => {
    const instructions = "Instructions from: /repo/pkg/AGENTS.md\nIndent with tabs."
    expect(hostNotesBeforeUserTurn([system, hostNote("go"), reply, hostNote(mcpUpdate), hostNote(instructions), ask] as Prompt))
      .toEqual([mcpUpdate, instructions])
  })

  it("never treats the host's leading system prompt as a note", () => {
    expect(hostNotesBeforeUserTurn([system, ask] as Prompt)).toEqual([])
    expect(hostNotesBeforeUserTurn([system, { role: "system", content: "More system" } as Prompt[number], ask] as Prompt)).toEqual([])
  })

  it("skips plan reminders and stops at the previous reply", () => {
    const reminder = hostNote("<system-reminder>\nPlan mode.\n</system-reminder>")
    expect(hostNotesBeforeUserTurn([system, hostNote(mcpUpdate), reply, reminder, ask] as Prompt)).toEqual([])
  })

  it("returns nothing when the prompt does not end with a real user message", () => {
    expect(hostNotesBeforeUserTurn([system, ask, reply] as Prompt)).toEqual([])
    expect(hostNotesBeforeUserTurn([system, ask, reply, hostNote(mcpUpdate)] as Prompt)).toEqual([])
  })
})

describe("host notes on a new Run's user turn", () => {
  const system = { role: "system", content: "Host system prompt" } as Prompt[number]
  const reply = { role: "assistant", content: [{ type: "text", text: "done" }] } as Prompt[number]
  const ask = hostNote("Which command builds this?")
  const mcpUpdate = "<system-update>\nInstructions for the following MCP servers are available.\n</system-update>"
  const prompt = [system, hostNote("go"), reply, ask] as Prompt
  const flags = { startedWithCheckpoint: true, isCompaction: false, ephemeralRun: false, resuming: false }
  const stored = (sessionKey: string) => releaseHostNoteInjectionsForTests(sessionKey).undelivered

  it("sends undelivered notes on a checkpointed turn and forgets them once the Run is written", () => {
    restorePersistedHostNotes("ses_turn", encodePersistedHostNotes([NOTE]))
    const notes = prepareUserTurnHostNotes({ sessionKey: "ses_turn", prompt, ...flags })

    expect(notes.reminders).toEqual([wrapHostNoteForCursor(NOTE)])
    expect(stored("ses_turn")).toEqual([NOTE])
    notes.sent()
    expect(stored("ses_turn")).toEqual([])
  })

  it("puts notes from before the user message after undelivered ones", () => {
    restorePersistedHostNotes("ses_order", encodePersistedHostNotes([NOTE]))
    const notes = prepareUserTurnHostNotes({
      sessionKey: "ses_order",
      prompt: [system, hostNote("go"), reply, hostNote(mcpUpdate), ask] as Prompt,
      ...flags,
    })

    expect(notes.reminders).toEqual([wrapHostNoteForCursor(NOTE), wrapHostNoteForCursor(mcpUpdate)])
  })

  it("forgets without duplicating a note actually present in the seeded host history", () => {
    restorePersistedHostNotes("ses_seeded", encodePersistedHostNotes([NOTE]))
    const notes = prepareUserTurnHostNotes({
      sessionKey: "ses_seeded",
      prompt: [system, hostNote("go"), hostNote(NOTE), reply, hostNote(mcpUpdate), ask] as Prompt,
      ...flags,
      startedWithCheckpoint: false,
    })

    expect(notes.reminders).toEqual([])
    notes.sent()
    expect(stored("ses_seeded")).toEqual([])
  })

  it("carries deferred notes missing from compacted or rewritten seed history", () => {
    restorePersistedHostNotes("ses_rewritten", encodePersistedHostNotes([NOTE]))
    const notes = prepareUserTurnHostNotes({
      sessionKey: "ses_rewritten", prompt, ...flags, startedWithCheckpoint: false,
    })
    expect(notes.reminders).toEqual([wrapHostNoteForCursor(NOTE)])
    expect(stored("ses_rewritten")).toEqual([NOTE])
    notes.sent()
    expect(stored("ses_rewritten")).toEqual([])
  })

  it("does not resend a deferred note the seed already carries inside a merged or tool entry", () => {
    const instruction = "Instructions from: /repo/pkg/AGENTS.md\nIndent with tabs."
    restorePersistedHostNotes("ses_seed_inside", encodePersistedHostNotes([NOTE, instruction]))
    const notes = prepareUserTurnHostNotes({
      sessionKey: "ses_seed_inside",
      prompt,
      ...flags,
      startedWithCheckpoint: false,
      seedHistory: [
        { role: "user", content: "go" },
        // A note followed by the next step's tool observation merges into one user entry.
        { role: "user", content: `${NOTE}\n\nOpenCode host observation {"tool":"shell"}:\nok` },
        // A lifted read instruction is seeded inside its read observation.
        { role: "user", content: `OpenCode host observation {"tool":"read"}:\n<content>…</content>\n\n<system-reminder>\n${instruction}\n</system-reminder>` },
      ],
    })

    expect(notes.reminders).toEqual([])
  })

  for (const [name, overrides] of [
    ["compaction", { isCompaction: true }],
    ["lifecycle or helper", { ephemeralRun: true }],
    ["interrupted-turn resume", { resuming: true }],
  ] as const) {
    it(`leaves notes for the next user turn on a ${name} Run`, () => {
      const sessionKey = `ses_${name.replaceAll(/\W/g, "_")}`
      restorePersistedHostNotes(sessionKey, encodePersistedHostNotes([NOTE]))
      const notes = prepareUserTurnHostNotes({
        sessionKey,
        prompt: [system, hostNote("go"), reply, hostNote(mcpUpdate), ask] as Prompt,
        ...flags,
        ...overrides,
      })

      expect(notes.reminders).toEqual([])
      notes.sent()
      expect(stored(sessionKey)).toEqual([NOTE])
    })
  }

  it("keeps notes that changed between preparing and sending the Run", () => {
    restorePersistedHostNotes("ses_changed", encodePersistedHostNotes([NOTE]))
    const notes = prepareUserTurnHostNotes({ sessionKey: "ses_changed", prompt, ...flags })
    restorePersistedHostNotes("ses_changed", encodePersistedHostNotes(["other"]))
    notes.sent()
    expect(stored("ses_changed")).toEqual(["other"])

    restorePersistedHostNotes("ses_changed", encodePersistedHostNotes([NOTE, "other"]))
    notes.sent()
    expect(stored("ses_changed")).toEqual([NOTE, "other"])
  })

  it("needs a session key to keep or send undelivered notes", () => {
    const notes = prepareUserTurnHostNotes({ prompt: [system, hostNote("go"), reply, hostNote(mcpUpdate), ask] as Prompt, ...flags })
    expect(notes.reminders).toEqual([wrapHostNoteForCursor(mcpUpdate)])
    notes.sent()
  })

  it("restores nothing from an empty snapshot field", () => {
    restorePersistedHostNotes("ses_empty", undefined)
    restorePersistedHostNotes("ses_empty", "")
    expect(stored("ses_empty")).toEqual([])
  })

  it("sends a closed Run's unacknowledged note on the next user turn, once", async () => {
    const root = tempRoot()
    try {
      const writes: Uint8Array[] = []
      const live = ownedSession(writes, root, "ses_next_turn")
      sessionManager.registerPending(1, live, "mcp_result", "t3_thread_read")
      await deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 1, "t3_thread_read", "{}"),
        hostNote(NOTE),
      )))
      sessionManager.close(live, "remote-error")

      const first = prepareUserTurnHostNotes({ sessionKey: "ses_next_turn", prompt, ...flags })
      expect(first.reminders).toEqual([wrapHostNoteForCursor(NOTE)])
      first.sent()
      expect(prepareUserTurnHostNotes({ sessionKey: "ses_next_turn", prompt, ...flags }).reminders).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("restores a note kept across a restart and sends it with the next user turn", async () => {
    const root = tempRoot()
    try {
      const live = ownedSession([], root, "ses_restart")
      sessionManager.registerPending(1, live, "mcp_result", "t3_thread_read")
      await deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 1, "t3_thread_read", "{}"),
        hostNote(NOTE),
      )))
      await pump(serverSends(live), controller, { textId: "t", reasoningId: "r" })

      const persisted = await hostNoteAfterRestart(root, "ses_restart")
      restorePersistedHostNotes("ses_restart", persisted)
      expect(prepareUserTurnHostNotes({ sessionKey: "ses_restart", prompt, ...flags }).reminders)
        .toEqual([wrapHostNoteForCursor(NOTE)])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("host note store bounds", () => {
  it("evicts the oldest session's undelivered notes beyond the session cap", () => {
    for (let index = 0; index <= MAX_TURN_STATE_SESSIONS; index++) {
      restorePersistedHostNotes(`ses_cap_${index}`, encodePersistedHostNotes([`note ${index}`]))
    }

    expect(releaseHostNoteInjectionsForTests("ses_cap_0").undelivered).toEqual([])
    expect(releaseHostNoteInjectionsForTests("ses_cap_1").undelivered).toEqual(["note 1"])
    expect(releaseHostNoteInjectionsForTests(`ses_cap_${MAX_TURN_STATE_SESSIONS}`).undelivered)
      .toEqual([`note ${MAX_TURN_STATE_SESSIONS}`])
  })

  it("evicts the oldest session's in-flight injections beyond the session cap", async () => {
    for (let index = 0; index <= MAX_TURN_STATE_SESSIONS; index++) {
      const live = liveSession([])
      live.openCodeSessionId = `ses_flight_${index}`
      sessionManager.registerPending(1, live, "mcp_result", "t3_thread_read")
      await deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, 1, "t3_thread_read", "{}"),
        hostNote(NOTE),
      )))
    }

    // The session manager closes older idle Runs past its own cap, so a kept
    // note may already have moved to the next-user-turn store.
    const kept = (sessionKey: string) => {
      const { inFlight, undelivered } = releaseHostNoteInjectionsForTests(sessionKey)
      return [...inFlight.flat(), ...undelivered]
    }
    expect(kept("ses_flight_0")).toEqual([])
    expect(kept("ses_flight_1")).toEqual([NOTE])
    expect(kept(`ses_flight_${MAX_TURN_STATE_SESSIONS}`)).toEqual([NOTE])
  })
})

describe("prompt tail debug summary", () => {
  it("names roles, part kinds, short previews, tool media, and provider options", () => {
    const long = "x".repeat(70)
    const prompt = [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read",
          output: { type: "content", value: [{ type: "text", text: "a" }, { type: "image-data", data: "AQ==" }] },
        }],
      },
      {
        role: "user",
        content: [{ type: "text", text: long }, { type: "file", data: "AQ==", mediaType: "image/png" }],
        providerOptions: { opencode: { synthetic: true } },
      },
    ] as unknown as Prompt

    expect(describePromptTail(prompt)).toBe([
      `system:scalar("sys")`,
      "assistant:[tool-call]",
      "tool:[tool-result(read,content,mediaish=1)]",
      `user{opencode:{"synthetic":true}}:[text("${"x".repeat(60)}…"),file]`,
    ].join(" | "))
    expect(describePromptTail(prompt, 1)).toStartWith("user{")
  })
})

describe("host note injection outcomes", () => {
  let root: string
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  /** Deliver one MCP result with NOTE on a session owned by `sessionKey`; return the injection id. */
  async function injectNote(sessionKey: string): Promise<{ live: CursorSession; injectionId: string }> {
    root = tempRoot()
    const writes: Uint8Array[] = []
    const live = ownedSession(writes, root, sessionKey)
    sessionManager.registerPending(1, live, "mcp_result", "t3_thread_read")
    await deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 1, "t3_thread_read", "{}"),
      hostNote(NOTE),
    )))
    const [injection] = injections(writes)
    return { live, injectionId: injection.injection_id }
  }

  const delivered = { delivered: { step: 1 } }

  it("persists deferred notes in injection order when acknowledgements arrive out of order", async () => {
    root = tempRoot()
    const writes: Uint8Array[] = []
    const live = ownedSession(writes, root, "ses_ack_order")
    const first = "<system-update>Use make.</system-update>"
    const second = "<system-update>Use bazel instead.</system-update>"
    for (const [id, note] of [[1, first], [2, second]] as const) {
      sessionManager.registerPending(id, live, "mcp_result", "lookup")
      await deliverContinuationResults(live, extractTrailingToolResults(step(
        toolResult(live, id, "lookup", "ok"), hostNote(note),
      )))
    }
    const [a, b] = injections(writes)
    await pump(serverSends(live,
      injectionState(b.injection_id, { rejected: { reason: "run ended" } }),
      injectionState(a.injection_id, { cancelled: {} }),
    ), controller, { textId: "t", reasoningId: "r" })
    expect(decodePersistedHostNotes(await hostNoteAfterRestart(root, "ses_ack_order"))).toEqual([first, second])
  })

  it("clears only the deferred notes included in a user action when new acknowledgements arrive", async () => {
    const { live, injectionId } = await injectNote("ses_user_write_race")
    restorePersistedHostNotes("ses_user_write_race", encodePersistedHostNotes(["earlier note"]))
    const prepared = prepareUserTurnHostNotes({
      sessionKey: "ses_user_write_race", prompt: [hostNote("continue")],
      startedWithCheckpoint: true, isCompaction: false, ephemeralRun: false, resuming: false,
    })
    await pump(serverSends(live, injectionState(injectionId, { rejected: { reason: "run ended" } })),
      controller, { textId: "t", reasoningId: "r" })
    prepared.sent()
    expect(releaseHostNoteInjectionsForTests("ses_user_write_race"))
      .toEqual({ inFlight: [], undelivered: [NOTE] })
  })

  it("clears a note Cursor delivered", async () => {
    const { live, injectionId } = await injectNote("ses_delivered")
    await pump(serverSends(live, injectionState(injectionId, { queued: {} }), injectionState(injectionId, delivered)),
      controller, { textId: "t", reasoningId: "r" })

    expect(await hostNoteAfterRestart(root, "ses_delivered")).toBeUndefined()
  })

  for (const [state, value] of [
    ["rejected", { rejected: { reason: "producer_not_allowlisted" } }],
    ["cancelled", { cancelled: {} }],
    ["queued_for_next_turn", { queued_for_next_turn: {} }],
  ] as const) {
    it(`keeps a ${state} note for the next user turn`, async () => {
      const { live, injectionId } = await injectNote(`ses_${state}`)
      await pump(serverSends(live, injectionState(injectionId, value)), controller, { textId: "t", reasoningId: "r" })

      expect(await hostNoteAfterRestart(root, `ses_${state}`)).toBe(NOTE)
    })
  }

  it("keeps a note still unacknowledged when the turn ends", async () => {
    const { live, injectionId } = await injectNote("ses_unacked")
    await pump(serverSends(live, injectionState(injectionId, { queued: {} })), controller, { textId: "t", reasoningId: "r" })

    expect(await hostNoteAfterRestart(root, "ses_unacked")).toBe(NOTE)
  })

  it("ignores an acknowledgement for an injection it did not send", async () => {
    const { live } = await injectNote("ses_foreign_ack")
    await pump(serverSends(live, injectionState("someone-else", delivered)), controller, { textId: "t", reasoningId: "r" })

    expect(await hostNoteAfterRestart(root, "ses_foreign_ack")).toBe(NOTE)
  })

  it("reads acknowledgements while a fresh turn drains the prior Run", async () => {
    const { live, injectionId } = await injectNote("ses_drain_delivered")
    serverSends(live, injectionState(injectionId, delivered))
    sessionManager.registerSession(live)

    expect(await preparePriorSessionForFreshTurn("ses_drain_delivered", { timeoutMs: 1_000 })).toBe("drained")
    expect(await hostNoteAfterRestart(root, "ses_drain_delivered")).toBeUndefined()
  })

  it("keeps a note the drained Run never acknowledged", async () => {
    const { live } = await injectNote("ses_drain_unacked")
    serverSends(live)
    sessionManager.registerSession(live)

    expect(await preparePriorSessionForFreshTurn("ses_drain_unacked", { timeoutMs: 1_000 })).toBe("drained")
    expect(await hostNoteAfterRestart(root, "ses_drain_unacked")).toBe(NOTE)
  })

  /** A Run whose stream ends without turn_ended, so recovery takes over. */
  function failsMidTurn(live: CursorSession, checkpoint: boolean): CursorSession {
    if (checkpoint) live.resumeCheckpoint = Uint8Array.from([1])
    live.frames = { next: async () => ({ done: true, value: undefined }) } as CursorSession["frames"]
    return live
  }

  it("re-injects an unacknowledged note into the Run that resumes the turn and keeps it if never acknowledged", async () => {
    const { live } = await injectNote("ses_resume_unacked")
    const resumedWrites: Uint8Array[] = []
    let recovery: string | undefined
    await pumpWithRecovery({
      initialSession: failsMidTurn(live, true),
      controller,
      recover: async (kind) => {
        recovery = kind.kind
        return serverSends(ownedSession(resumedWrites, root, "ses_resume_unacked"))
      },
    })

    expect(recovery).toBe("resume")
    expect(injections(resumedWrites).map((action) => action.user_context.user_message.text)).toEqual([NOTE_TEXT])
    expect(await hostNoteAfterRestart(root, "ses_resume_unacked")).toBe(NOTE)
  })

  it("clears a re-injected note the resumed Run delivers", async () => {
    const { live } = await injectNote("ses_resume_delivered")
    const resumedWrites: Uint8Array[] = []
    await pumpWithRecovery({
      initialSession: failsMidTurn(live, true),
      controller,
      recover: async () => {
        const resumed = ownedSession(resumedWrites, root, "ses_resume_delivered")
        let acked = false
        const rest = serverSends(liveSession([])).frames
        resumed.frames = {
          next: async () => {
            if (!acked) {
              acked = true
              const [injection] = injections(resumedWrites)
              return { done: false, value: injectionState(injection.injection_id, delivered) }
            }
            return rest.next()
          },
        } as CursorSession["frames"]
        return resumed
      },
    })

    expect(injections(resumedWrites)).toHaveLength(1)
    expect(await hostNoteAfterRestart(root, "ses_resume_delivered")).toBeUndefined()
  })

  it("keeps the note for the next user turn when recovery itself fails", async () => {
    const { live } = await injectNote("ses_recover_failed")
    await expect(pumpWithRecovery({
      initialSession: failsMidTurn(live, true),
      controller,
      recover: async () => { throw new Error("no Run") },
    })).rejects.toThrow("no Run")

    expect(releaseHostNoteInjectionsForTests("ses_recover_failed")).toEqual({ inFlight: [], undelivered: [NOTE] })
  })

  it("does not re-inject into a Run rebased from host history, which already holds the note", async () => {
    const { live } = await injectNote("ses_rebased")
    const rebasedWrites: Uint8Array[] = []
    let recovery: string | undefined
    await pumpWithRecovery({
      initialSession: failsMidTurn(live, false),
      controller,
      recover: async (kind) => {
        recovery = kind.kind
        const seeded = prepareUserTurnHostNotes({
          sessionKey: "ses_rebased", prompt: [hostNote(NOTE), hostNote("continue")],
          startedWithCheckpoint: false, isCompaction: false, ephemeralRun: false, resuming: false,
        })
        expect(seeded.reminders).toEqual([])
        seeded.sent()
        return serverSends(ownedSession(rebasedWrites, root, "ses_rebased"))
      },
    })

    expect(recovery).toBe("rebase")
    expect(injections(rebasedWrites)).toEqual([])
    expect(releaseHostNoteInjectionsForTests("ses_rebased")).toEqual({ inFlight: [], undelivered: [] })
  })

  it("reports a failed resume injection as the write failure and retains its note", async () => {
    const { live } = await injectNote("ses_resume_write_failed")
    await expect(pumpWithRecovery({
      initialSession: failsMidTurn(live, true), controller,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      recover: async () => {
        const resumed = ownedSession([], root, "ses_resume_write_failed")
        resumed.stream.write = () => { throw new Error("injection write broken") }
        return resumed
      },
    })).rejects.toThrow("Cursor host note injection write failed")
    expect(releaseHostNoteInjectionsForTests("ses_resume_write_failed"))
      .toEqual({ inFlight: [], undelivered: [NOTE] })
  })

  it("retains every note in original order when the first resume injection fails", async () => {
    const { live } = await injectNote("ses_resume_batches_failed")
    const later = "<system-update>Use bazel instead.</system-update>"
    sessionManager.registerPending(2, live, "mcp_result", "lookup")
    await deliverContinuationResults(live, extractTrailingToolResults(step(
      toolResult(live, 2, "lookup", "ok"), hostNote(later),
    )))
    await expect(pumpWithRecovery({
      initialSession: failsMidTurn(live, true), controller,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      recover: async () => {
        const resumed = ownedSession([], root, "ses_resume_batches_failed")
        resumed.stream.write = () => { throw new Error("injection write broken") }
        return resumed
      },
    })).rejects.toThrow("Cursor host note injection write failed")
    expect(releaseHostNoteInjectionsForTests("ses_resume_batches_failed"))
      .toEqual({ inFlight: [], undelivered: [NOTE, later] })
  })

  it("releases a closed Run's notes to the next Run but leaves an open Run's alone", async () => {
    const { live } = await injectNote("ses_closed")
    expect(releaseHostNoteInjectionsForTests("ses_closed")).toEqual({ inFlight: [[NOTE]], undelivered: [] })

    sessionManager.close(live, "remote-error")
    expect(releaseHostNoteInjectionsForTests("ses_closed")).toEqual({ inFlight: [], undelivered: [NOTE] })
    expect(releaseHostNoteInjectionsForTests("ses_closed")).toEqual({ inFlight: [], undelivered: [NOTE] })
  })
})
