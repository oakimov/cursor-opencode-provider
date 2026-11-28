/**
 * Native compaction through the real provider against a local HTTP/2 server
 * that plays Cursor's Run endpoint (no network). A host compaction never sends
 * its transcript as a prompt: Cursor summarizes the session's conversation with
 * `summarize_action` (Cursor CLI `/summarize`), answering as it did live
 * 2026-11-28: summary updates, a checkpoint, an empty `turn_ended`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3Prompt, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { sessionManager } from "../src/session.js"
import {
  COMPACTED_TOOL_RESULT_NOTE,
  compactionCallHistory,
  HISTORY_IMPORT_ACK,
  resetTurnStateForTests,
  settleRunSavesForTests,
} from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { CURSOR_COMPACTION_HOOK_OPTION, CURSOR_COMPACTION_OPTION } from "../src/shared.js"
import { seedText } from "./seed-text.js"

const ORIGIN = "https://agentn.native-compaction-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

type Run = {
  request: Record<string, any>
  received: Array<Record<string, any>>
  send: (message: Record<string, unknown>) => void
  end: () => void
}
let server: http2.Http2Server
let client: http2.ClientHttp2Session
let runs: Run[] = []
let script: (run: Run, message: Record<string, any>) => void = () => {}
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.on("error", () => {})
    let pending = Buffer.alloc(0)
    let run: Run | undefined
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<Record<string, any>>("AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }))
        pending = pending.subarray(5 + length)
        if (message.run_request) {
          run = {
            request: message.run_request,
            received: [],
            send: (value) => { if (!stream.closed) stream.write(frame(encodeMessage("AgentServerMessage", value))) },
            end: () => { if (!stream.closed) stream.end() },
          }
          runs.push(run)
        } else {
          run?.received.push(message)
        }
        if (run) script(run, message)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as net.AddressInfo
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
})

let previousCache: string | undefined
let root = ""
beforeEach(() => {
  previousCache = getHostCacheDirOverride()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-native-compaction-"))
  cacheHttp2SessionForTests(ORIGIN, client)
})

afterEach(async () => {
  sessionManager.dispose()
  await settleRunSavesForTests()
  setHostCacheDirOverride(previousCache)
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetToolRequestsListedSeenForTests()
  fs.rmSync(root, { recursive: true, force: true })
  runs = []
  script = () => {}
})

const checkpoint = (n: number) => Uint8Array.from([0x2a, 5, 8, 42, 16, 0x80, n])
const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): LanguageModelV3Prompt[number] => ({ role: "assistant", content: [{ type: "text", text }] })
const tools = [{ type: "function" as const, name: "bash", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]
const SESSION = "ses_native_compaction"

function model() {
  return createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root, workspaceRoot: root })
    .languageModel("composer-2.5")
}

async function read(options: Partial<LanguageModelV3CallOptions>): Promise<LanguageModelV3StreamPart[]> {
  const { stream } = await model().doStream({ headers: { "x-opencode-session-id": SESSION }, ...options } as LanguageModelV3CallOptions)
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}
const textOf = (parts: LanguageModelV3StreamPart[]) => parts.map((part) => part.type === "text-delta" ? part.delta : "").join("")
const compaction = (prompt: LanguageModelV3Prompt, extra: Record<string, unknown> = {}) =>
  read({ prompt, tools: [], providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true, ...extra } } })

/** Cursor's answer: an ordinary turn, or a summary for `summarize_action`. */
function answer(run: Run, message: Record<string, any>, summaryText = "CURSOR SUMMARY"): void {
  if (!message.run_request) return
  if (message.run_request.action.summarize_action) {
    run.send({ interaction_update: { summary_started: {} } })
    run.send({ interaction_update: { summary: { summary: summaryText } } })
    run.send({ interaction_update: { summary_completed: {} } })
    run.send({ conversation_checkpoint_update: checkpoint(90 + runs.length) })
    run.send({ interaction_update: { turn_ended: {} } })
    run.end()
    return
  }
  run.send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
  run.send({ conversation_checkpoint_update: checkpoint(runs.length) })
  run.send({ interaction_update: { turn_ended: {} } })
  run.end()
}

describe("native compaction", () => {
  it("summarizes the idle conversation in place, and the next turn continues on the summary's checkpoint", async () => {
    script = (run, message) => answer(run, message)
    await read({ prompt: [user("Hello")], tools })
    const parts = await compaction([user("<conversation>\n[User]: Hello\n</conversation>\n\nSummarize.")])
    expect(textOf(parts)).toBe("CURSOR SUMMARY")
    const finish = parts.find((part) => part.type === "finish")
    expect(finish?.type === "finish" && finish.providerMetadata?.cursor?.compactionMode).toBe("live")

    const summarize = runs[1]!.request
    expect(summarize.action.summarize_action).toEqual({})
    expect(summarize.action.user_message_action).toBeUndefined()
    expect(summarize.conversation_id).toBe(runs[0]!.request.conversation_id)
    expect(Array.from(summarize.conversation_state)).toEqual(Array.from(checkpoint(1)))
    // Cursor asks for the request context; the Run carries none of its own.
    expect(summarize.action.user_message_action?.request_context).toBeUndefined()

    // OpenCode 1.x after a compaction: tail, compaction request, summary, next message.
    await read({ prompt: [user("Hello"), assistant("Cursor answer"), user("Summarize."), assistant("CURSOR SUMMARY"), user("Next")], tools })
    const next = runs[2]!.request
    expect(next.conversation_id).toBe(runs[0]!.request.conversation_id)
    expect(Array.from(next.conversation_state)).toEqual(Array.from(checkpoint(92)))
    expect(next.action.user_message_action.prepend_user_messages ?? []).toEqual([])
    expect(next.action.user_message_action.user_message.text).toContain("Next")
  })

  it("answers Cursor's request_context_args exec on the summarize Run with the conversation's RequestContext", async () => {
    script = (run, message) => {
      if (message.run_request?.action.summarize_action) {
        run.send({ exec_server_message: { id: 3, request_context_args: {} } })
        return
      }
      if (message.exec_client_message?.request_context_result) {
        answer(run, { run_request: { action: { summarize_action: {} } } })
        return
      }
      answer(run, message)
    }
    await read({ prompt: [user("Hello")], tools })
    expect(textOf(await compaction([user("Summarize.")]))).toBe("CURSOR SUMMARY")
    const reply = runs[1]!.received.find((message) => message.exec_client_message)!.exec_client_message
    expect(reply.id).toBe(3)
    expect(reply.request_context_result.success.request_context).toEqual(runs[0]!.request.action.user_message_action.request_context)
  })

  it("fails a host model call after the 2.x hook declined, without opening a Run", async () => {
    script = (run, message) => answer(run, message)
    await read({ prompt: [user("Hello")], tools })
    const failure = await read({
      prompt: [user("Summarize.")], tools: [],
      providerOptions: { cursor: { [CURSOR_COMPACTION_OPTION]: true, [CURSOR_COMPACTION_HOOK_OPTION]: "declined" } },
    }).then(() => undefined, (error: unknown) => error)
    expect(APICallError.isInstance(failure)).toBe(true)
    const error = failure as APICallError
    // Final, not payload-too-large and not an overflow: OpenCode neither shrinks nor retries.
    expect(error.statusCode).toBe(400)
    expect(error.responseHeaders?.["x-should-retry"]).toBe("false")
    expect(error.message).not.toMatch(/too long|too large|context/i)
    expect(runs).toHaveLength(1)
  })

  it("imports history Cursor does not hold as earlier turns, then summarizes that conversation", async () => {
    script = (run, message) => answer(run, message, "IMPORTED SUMMARY")
    const prompt = [user(
      "Here is the conversation so far:\n\n<conversation>\n[User]: Build the parser\n[Assistant]: Done: parser.ts\n\n" +
      "[User]: Add tests\n[Assistant]: Added parser.test.ts\n</conversation>\n\n" +
      "Create a new anchored summary from the conversation history in the <conversation> tags above.\n## Objective",
    )]
    expect(textOf(await compaction(prompt))).toBe("IMPORTED SUMMARY")
    expect(runs).toHaveLength(2)
    const imported = runs[0]!.request.action.user_message_action
    expect(imported.user_message.text).toBe(HISTORY_IMPORT_ACK)
    const parts = (imported.prepend_user_messages as Array<{ text: string }>).map((part) => part.text)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain("[User]: Build the parser")
    expect(parts[1]).toContain("[User]: Add tests")
    // The host's own summary instructions stay out of the import.
    expect(seedText(imported)).not.toContain("anchored summary")
    expect(runs[1]!.request.action.summarize_action).toEqual({})
    expect(runs[1]!.request.conversation_id).toBe(runs[0]!.request.conversation_id)
  })

  it("summarizes a fork of a held Run, notes a result compacted away, then summarizes the live conversation at turn end", async () => {
    script = (run, message) => {
      if (runs.indexOf(run) === 0) {
        if (message.run_request) {
          run.send({ conversation_checkpoint_update: checkpoint(1) })
          run.send({ exec_server_message: { id: 1, shell_args: { command: "make", tool_call_id: "call-make" } } })
        } else if (message.exec_client_message) {
          run.send({ conversation_checkpoint_update: checkpoint(2) })
          run.send({ interaction_update: { turn_ended: {} } })
          run.end()
        }
        return
      }
      answer(run, message)
    }
    const first = await read({ prompt: [user("Run make")], tools })
    expect(first.some((part) => part.type === "tool-call")).toBe(true)
    const liveId = runs[0]!.request.conversation_id

    // OpenCode compacts mid-turn while Cursor waits on the shell result.
    const summary = await compaction([user("Summarize.")])
    expect(textOf(summary)).toBe("CURSOR SUMMARY")
    const fork = runs[1]!.request
    expect(fork.action.summarize_action).toEqual({})
    expect(fork.conversation_id).not.toBe(liveId)
    expect(Array.from(fork.conversation_state)).toEqual(Array.from(checkpoint(1)))
    // The held Run is untouched: no result, no cancel.
    expect(runs[0]!.received.filter((message) => message.exec_client_message || message.conversation_action)).toEqual([])

    // OpenCode 1.x continues with a synthetic user message; the shell result fell outside its tail.
    await read({ prompt: [user("Summarize."), assistant("CURSOR SUMMARY"), user("Continue if you have next steps.")], tools })
    const delivered = JSON.stringify(runs[0]!.received.find((message) => message.exec_client_message))
    expect(delivered).toContain("removed by context compaction")
    expect(delivered).not.toContain("Host started a new user turn")
    // The turn ended: Cursor summarizes the live conversation before the next Run opens on it.
    const live = runs[2]!.request
    expect(live.action.summarize_action).toEqual({})
    expect(live.conversation_id).toBe(liveId)
    expect(Array.from(live.conversation_state)).toEqual(Array.from(checkpoint(2)))
    const next = runs[3]!.request
    expect(next.conversation_id).toBe(liveId)
    expect(Array.from(next.conversation_state)).toEqual(Array.from(checkpoint(93)))
    expect(COMPACTED_TOOL_RESULT_NOTE).toContain("removed by context compaction")
  })
})

describe("native compaction across OpenCode Locations", () => {
  it("refuses to summarize a conversation whose Run another module copy holds", async () => {
    script = (run, message) => answer(run, message)
    await read({ prompt: [user("Hello")], tools })
    const shared = (globalThis as unknown as Record<symbol, Map<string, Set<string>>>)[
      Symbol.for("cursor-opencode-provider.open-runs-by-session.v1")]!
    shared.set(SESSION, new Set(["run-in-another-location"]))
    try {
      const failure = await compaction([user("Summarize.")]).then(() => undefined, (error: unknown) => error)
      expect(APICallError.isInstance(failure)).toBe(true)
      expect((failure as APICallError).message).toContain("another OpenCode location")
      expect(runs).toHaveLength(1)
    } finally {
      shared.delete(SESSION)
    }
  })
})

describe("compactionCallHistory", () => {
  it("takes OpenCode 1.x's transcript, split at each user entry, with its prior summary and without the template", () => {
    const history = compactionCallHistory([user(
      "Here is the conversation so far:\n\n<conversation>\n[User]: a\n[Assistant]: b\n\n[Tool result]: c\n\n[User]: d\n</conversation>\n\n" +
      "Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\nOLD\n</prior-summary>\n\n## Objective",
    )])
    expect(history.map((message) => (message.content as Array<{ text: string }>)[0]!.text)).toEqual([
      "[Summary of the conversation before these turns]\nOLD",
      "[User]: a\n[Assistant]: b\n\n[Tool result]: c",
      "[User]: d",
    ])
  })

  it("keeps a message-shaped history without its final request, and imports any other single message whole", () => {
    expect(compactionCallHistory([user("a"), assistant("b"), user("Summarize.")])).toEqual([user("a"), assistant("b")])
    expect(compactionCallHistory([user("custom prompt")])).toEqual([user("custom prompt")])
    expect(compactionCallHistory([])).toEqual([])
  })
})
