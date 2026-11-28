/**
 * A turn stopped mid-step, then continued in the next process (#74): doStream →
 * startSession → bidiRunStream → pump against a local HTTP/2 server that plays
 * Cursor's Run endpoint. No network access.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { hasSeedHistory } from "./seed-text.js"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import { HELD_RUN_SAVE_DELAY_MS, resetTurnStateForTests } from "../src/language-model.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetConversationPersistenceForTests, setConversationPersistenceHookForTests } from "../src/protocol/conversation-persistence.js"
import { resetTurnProvenanceForTests } from "../src/protocol/turn-provenance.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type ClientMessage = Record<string, any>

const ORIGIN = "https://agentn.interrupt-restart-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

type FakeRun = {
  received: ClientMessage[]
  send(message: Record<string, unknown>): void
  end(): void
}

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let onRun: (run: FakeRun, message: ClientMessage) => void = () => {}
const runs: FakeRun[] = []
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
    const run: FakeRun = {
      received: [],
      send: (message) => {
        if (!stream.destroyed && !stream.closed) stream.write(frame(encodeMessage("AgentServerMessage", message)))
      },
      end: () => stream.end(),
    }
    runs.push(run)
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<ClientMessage>("AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }))
        pending = pending.subarray(5 + length)
        run.received.push(message)
        onRun(run, message)
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

/** Everything a new OpenCode server process starts without. */
function restartProcess(): void {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetTurnProvenanceForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetConversationBlobsForTests()
  resetToolRequestsListedSeenForTests()
}

// Each test starts as a new process, whatever an earlier test file left behind.
beforeEach(restartProcess)

afterEach(() => {
  setHostCacheDirOverride(undefined)
  restartProcess()
  runs.length = 0
  onRun = () => {}
})

async function collect(model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>, prompt: Prompt, sessionKey: string) {
  const { stream } = await model.doStream({
    prompt,
    tools: [{
      type: "function",
      name: "read",
      description: "Read a file from the local filesystem.",
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
        additionalProperties: false,
      },
    }],
    headers: { "x-opencode-session-id": sessionKey },
  } as LanguageModelV3CallOptions)
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const checkpoint = (label: string) => encodeMessage("ConversationStateStructure", { root_prompt_messages_json: [label] })
const runRequest = (run: FakeRun) => run.received.find((message) => message.run_request)!.run_request
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
}

type Stop = "shutdown" | "cancel without turn_ended" | "held tool, then crash"

/**
 * #74's timeline: a turn ends with text; the next turn's step reasons and
 * calls a tool; the host stops it; a new process gets the next user message.
 */
async function continueAfterStop(stop: Stop, abortedMessage: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-interrupt-restart-"))
  cacheHttp2SessionForTests(ORIGIN, client)
  try {
    const file = path.join(root, "probe.txt")
    fs.writeFileSync(file, "alpha\n")
    const sessionKey = `ses_restart_${stop.replace(/\W+/g, "_")}_${abortedMessage}`
    const model = () =>
      createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
    onRun = (run, message) => {
      const index = runs.indexOf(run)
      if (message.run_request && index === 0) {
        run.send({ interaction_update: { text_delta: { text: "First answer." } } })
        run.send({ conversation_checkpoint_update: checkpoint("after-turn-1") })
        run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
      } else if (message.run_request && index === 1) {
        run.send({ interaction_update: { thinking_delta: { text: "Let me look at the file." } } })
        run.send({ conversation_checkpoint_update: checkpoint("before-the-read") })
        run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
      } else if (message.conversation_action?.cancel_action && index === 1) {
        run.send({ conversation_checkpoint_update: checkpoint("cancelled") })
        run.end()
      } else if (message.run_request) {
        run.send({ interaction_update: { text_delta: { text: "Checked." } } })
        run.send({ conversation_checkpoint_update: checkpoint("after-turn-3") })
        run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
      }
    }
    const turn1: Prompt = [{ role: "user", content: [{ type: "text", text: "Say hi." }] }]
    await collect(model(), turn1, sessionKey)
    const turn2: Prompt = [
      ...turn1,
      { role: "assistant", content: [{ type: "text", text: "First answer." }] },
      { role: "user", content: [{ type: "text", text: "Read probe.txt." }] },
    ]
    const step = await collect(model(), turn2, sessionKey)
    const call = step.find((part) => part.type === "tool-call") as { toolCallId: string; input: string }
    expect(call).toBeDefined()

    if (stop === "shutdown") {
      await notifyHostInterrupt(undefined, "shutdown")
    } else if (stop === "cancel without turn_ended") {
      await notifyHostInterrupt(sessionKey, "user", Date.now())
      await until(() => !sessionManager.findOpenByOpenCodeSessionId(sessionKey))
      // The restart below is a graceful one, which lets a cancel finish saving.
      await notifyHostInterrupt(undefined, "shutdown")
    } else {
      await Bun.sleep(HELD_RUN_SAVE_DELAY_MS + 200)
    }
    restartProcess()

    const turn3: Prompt = [
      ...turn2,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me look at the file." },
          { type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "read",
          output: { type: "error-text", value: "Tool execution aborted" },
        }],
      },
      ...(abortedMessage ? [{ role: "assistant" as const, content: [] }] : []),
      { role: "user", content: [{ type: "text", text: "check again" }] },
    ]
    await collect(model(), turn3, sessionKey)
    const stopped = runRequest(runs[1]!)
    const next = runRequest(runs[runs.length - 1]!)
    const state = decodeMessage<Record<string, any>>("ConversationStateStructure", next.conversation_state)
    return {
      sameConversation: next.conversation_id === stopped.conversation_id,
      checkpoint: state.root_prompt_messages_json ?? [],
      requestContextReused: JSON.stringify(next.action.user_message_action.request_context)
        === JSON.stringify(stopped.action.user_message_action.request_context),
      reseeded: hasSeedHistory(next.action.user_message_action),
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("a turn stopped mid-step, continued by the next process", () => {
  for (const abortedMessage of [false, true]) {
    const shape = abortedMessage ? "with" : "without"

    it(`keeps the conversation and checkpoint after a shutdown, ${shape} the aborted empty message`, async () => {
      expect(await continueAfterStop("shutdown", abortedMessage)).toEqual({
        sameConversation: true,
        checkpoint: ["before-the-read"],
        requestContextReused: true,
        reseeded: false,
      })
    }, 30_000)

    it(`keeps the conversation and Cursor's last checkpoint after a cancel without turn_ended, ${shape} the aborted empty message`, async () => {
      expect(await continueAfterStop("cancel without turn_ended", abortedMessage)).toEqual({
        sameConversation: true,
        checkpoint: ["cancelled"],
        requestContextReused: true,
        reseeded: false,
      })
    }, 30_000)
  }

  it("keeps the conversation after a Stop while text streams, when the host kept less of it than was sent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-interrupt-stream-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = "ses_restart_streaming"
      const model = () =>
        createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        const index = runs.indexOf(run)
        if (message.run_request && index === 0) {
          run.send({ interaction_update: { thinking_delta: { text: "Thinking." } } })
          run.send({ interaction_update: { text_delta: { text: "Partial " } } })
          run.send({ interaction_update: { text_delta: { text: "answer" } } })
          run.send({ conversation_checkpoint_update: checkpoint("mid-answer") })
        } else if (message.conversation_action?.cancel_action && index === 0) {
          run.send({ conversation_checkpoint_update: checkpoint("cancelled") })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        } else if (message.run_request) {
          run.send({ interaction_update: { text_delta: { text: "Going on." } } })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        }
      }
      const turn1: Prompt = [{ role: "user", content: [{ type: "text", text: "Explain it." }] }]
      const { stream } = await model().doStream({
        prompt: turn1,
        tools: [{ type: "function", name: "read", description: "Read a file.", inputSchema: { type: "object", properties: {} } }],
        headers: { "x-opencode-session-id": sessionKey },
      } as LanguageModelV3CallOptions)
      const reader = stream.getReader()
      for (;;) {
        const { value } = await reader.read()
        if (value?.type === "text-delta") break
      }
      // The provider queues the next delta; the host stops before reading it.
      await Bun.sleep(50)
      // OpenCode 2's Stop: the stream is cancelled first, Cursor sends on, then the interrupt is reported.
      await reader.cancel()
      runs[0]!.send({ interaction_update: { text_delta: { text: " and more" } } })
      await Bun.sleep(50)
      await notifyHostInterrupt(sessionKey, "user", Date.now())
      await reader.read().then(async function drain(result): Promise<void> {
        if (!result.done) return reader.read().then(drain)
      }).catch(() => {})
      await until(() => !sessionManager.findOpenByOpenCodeSessionId(sessionKey))
      await notifyHostInterrupt(undefined, "shutdown")
      restartProcess()

      await collect(model(), [
        ...turn1,
        { role: "assistant", content: [{ type: "reasoning", text: "Thinking." }, { type: "text", text: "Partial " }] },
        { role: "user", content: [{ type: "text", text: "go on" }] },
      ], sessionKey)
      const stopped = runRequest(runs[0]!)
      const next = runRequest(runs[runs.length - 1]!)
      const state = decodeMessage<Record<string, any>>("ConversationStateStructure", next.conversation_state)
      expect(runs[0]!.received.filter((message) => message.conversation_action?.cancel_action)).toHaveLength(1)
      expect(next.conversation_id).toBe(stopped.conversation_id)
      expect(state.root_prompt_messages_json).toEqual(["cancelled"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("cancels at Cursor on an OpenCode 1.x Stop, which aborts the call before it cancels the stream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-interrupt-abort-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = "ses_restart_aborted"
      const model = () =>
        createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        const index = runs.indexOf(run)
        if (message.run_request && index === 0) {
          run.send({ interaction_update: { text_delta: { text: "Partial " } } })
          run.send({ conversation_checkpoint_update: checkpoint("mid-answer") })
        } else if (message.conversation_action?.cancel_action && index === 0) {
          run.send({ conversation_checkpoint_update: checkpoint("cancelled") })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        } else if (message.run_request) {
          run.send({ interaction_update: { text_delta: { text: "Going on." } } })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        }
      }
      const turn1: Prompt = [{ role: "user", content: [{ type: "text", text: "Explain it." }] }]
      const stop = new AbortController()
      const { stream } = await model().doStream({
        prompt: turn1,
        tools: [{ type: "function", name: "read", description: "Read a file.", inputSchema: { type: "object", properties: {} } }],
        headers: { "x-opencode-session-id": sessionKey },
        abortSignal: stop.signal,
      } as LanguageModelV3CallOptions)
      const reader = stream.getReader()
      for (;;) {
        const { value } = await reader.read()
        if (value?.type === "text-delta") break
      }
      // AI SDK streamText sees the aborted signal on its next read, then cancels the provider stream.
      stop.abort()
      await reader.cancel()
      await until(() => !sessionManager.findOpenByOpenCodeSessionId(sessionKey))
      await notifyHostInterrupt(undefined, "shutdown")
      restartProcess()

      await collect(model(), [
        ...turn1,
        { role: "assistant", content: [{ type: "text", text: "Partial " }] },
        { role: "user", content: [{ type: "text", text: "go on" }] },
      ], sessionKey)
      const stopped = runRequest(runs[0]!)
      const next = runRequest(runs[runs.length - 1]!)
      const state = decodeMessage<Record<string, any>>("ConversationStateStructure", next.conversation_state)
      expect(runs[0]!.received.filter((message) => message.conversation_action?.cancel_action)).toHaveLength(1)
      expect(next.conversation_id).toBe(stopped.conversation_id)
      expect(state.root_prompt_messages_json).toEqual(["cancelled"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("keeps the conversation after a Stop while Cursor's turn end is being saved, when the host kept less than was sent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-interrupt-turn-end-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const sessionKey = "ses_restart_turn_end_save"
      const model = () =>
        createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        const index = runs.indexOf(run)
        if (message.run_request && index === 0) {
          run.send({ interaction_update: { text_delta: { text: "Partial " } } })
          run.send({ interaction_update: { text_delta: { text: "answer" } } })
          run.send({ conversation_checkpoint_update: checkpoint("turn-1") })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        } else if (message.run_request) {
          run.send({ interaction_update: { text_delta: { text: "Going on." } } })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        }
      }
      const turn1: Prompt = [{ role: "user", content: [{ type: "text", text: "Explain it." }] }]
      const { stream } = await model().doStream({
        prompt: turn1,
        tools: [{ type: "function", name: "read", description: "Read a file.", inputSchema: { type: "object", properties: {} } }],
        headers: { "x-opencode-session-id": sessionKey },
      } as LanguageModelV3CallOptions)
      const reader = stream.getReader()
      // The host has read "Partial " when OpenCode 2's Stop cancels the stream during the turn-end save.
      let stopped = false
      setConversationPersistenceHookForTests(async (phase) => {
        if (phase !== "before-write" || stopped) return
        stopped = true
        await reader.cancel()
      })
      for (;;) {
        const { value, done } = await reader.read()
        if (done || value?.type === "text-delta") break
      }
      await until(() => stopped)
      setConversationPersistenceHookForTests(undefined)
      await notifyHostInterrupt(sessionKey, "user", Date.now())
      await until(() => !sessionManager.findOpenByOpenCodeSessionId(sessionKey))
      await notifyHostInterrupt(undefined, "shutdown")
      restartProcess()

      await collect(model(), [
        ...turn1,
        { role: "assistant", content: [{ type: "text", text: "Partial " }] },
        { role: "user", content: [{ type: "text", text: "go on" }] },
      ], sessionKey)
      const first = runRequest(runs[0]!)
      const next = runRequest(runs[runs.length - 1]!)
      expect(next.conversation_id).toBe(first.conversation_id)
      expect(hasSeedHistory(next.action.user_message_action)).toBe(false)
    } finally {
      setConversationPersistenceHookForTests(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("leaves the continuation's answer running when the tool-call step's stream is cancelled late", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-interrupt-late-cancel-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const file = path.join(root, "probe.txt")
      fs.writeFileSync(file, "alpha\n")
      const sessionKey = "ses_late_step_cancel"
      const model = () =>
        createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root }).languageModel("composer-2.5")
      onRun = (run, message) => {
        if (message.run_request) {
          run.send({ conversation_checkpoint_update: checkpoint("before-the-read") })
          run.send({ exec_server_message: { id: 1, read_args: { path: file } } })
        } else if (message.exec_client_message) {
          run.send({ interaction_update: { text_delta: { text: "The file says " } } })
        }
      }
      const options = (prompt: Prompt) => ({
        prompt,
        tools: [{
          type: "function",
          name: "read",
          description: "Read a file from the local filesystem.",
          inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
        }],
        headers: { "x-opencode-session-id": sessionKey },
      }) as LanguageModelV3CallOptions
      const turn1: Prompt = [{ role: "user", content: [{ type: "text", text: "Read probe.txt." }] }]
      const step = (await model().doStream(options(turn1))).stream.getReader()
      let call: { toolCallId: string; input: string } | undefined
      while (!call) {
        const { value } = await step.read()
        if (value?.type === "tool-call") call = value as { toolCallId: string; input: string }
      }
      // The host left the step's finish unread; its cancel comes after the continuation took over the Run.
      const continuation = (await model().doStream(options([
        ...turn1,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: "alpha" } }] },
      ]))).stream.getReader()
      const parts: LanguageModelV3StreamPart[] = []
      while (!parts.some((part) => part.type === "text-delta")) {
        const { value, done } = await continuation.read()
        if (done) break
        parts.push(value)
      }
      await step.cancel()
      await Bun.sleep(50)
      runs[0]!.send({ interaction_update: { text_delta: { text: "alpha." } } })
      runs[0]!.send({ conversation_checkpoint_update: checkpoint("after-the-read") })
      runs[0]!.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
      for (;;) {
        const { value, done } = await continuation.read()
        if (done) break
        parts.push(value)
      }

      expect(runs[0]!.received.filter((message) => message.conversation_action?.cancel_action)).toHaveLength(0)
      expect(parts.filter((part) => part.type === "text-delta").map((part) => (part as { delta: string }).delta).join(""))
        .toBe("The file says alpha.")
      expect(parts.find((part) => part.type === "finish")).toMatchObject({ finishReason: { unified: "stop" } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("keeps the conversation when the process dies while the host runs a tool", async () => {
    expect(await continueAfterStop("held tool, then crash", false)).toEqual({
      sameConversation: true,
      checkpoint: ["before-the-read"],
      requestContextReused: true,
      reseeded: false,
    })
  }, 30_000)
})
