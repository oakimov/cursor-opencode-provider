import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { CursorAuthError, CursorRetryExhaustedError, CursorServerError, CursorTransportError } from "../src/errors.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests, frameArrival, lastFrameArrival } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"

const ORIGIN = "https://agentn.run-error-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
// ErrorDetails{error:13, details{title, detail, is_retryable:false, analytics}, is_expected:true}, as Cursor sent it.
const POLICY_BLOCK = "CA0SlgEKHFJlcXVlc3QgYmxvY2tlZCBieSBBbnRocm9waWMSXVdlIGFyZSB1bmFibGUgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0IGJlY2F1c2UgaXQgd2FzIGJsb2NrZWQgdW5kZXIgQW50aHJvcGljJ3MgVXNhZ2UgUG9saWN5LiAAUhUKE2N5YmVyX3BvbGljeV9yZXZpZXcYAQ"

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let trailer: Record<string, unknown> = {}
let runs = 0
let partialOutput = false
let bareEof = false
let scripted: ((stream: http2.ServerHttp2Stream, message: Record<string, unknown>) => void) | undefined
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
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
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<Record<string, unknown>>("AgentClientMessage", pending.subarray(5, 5 + length))
        pending = pending.subarray(5 + length)
        if (scripted) { scripted(stream, message); continue }
        if (!message.run_request) continue
        runs++
        if (partialOutput) {
          stream.write(frame(encodeMessage("AgentServerMessage", {
            interaction_update: { thinking_delta: { text: "Already delivered" } },
          })))
        }
        if (!bareEof) stream.write(frame(Buffer.from(JSON.stringify(trailer)), 2))
        stream.end()
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

afterEach(() => {
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  runs = 0
  partialOutput = false
  bareEof = false
  scripted = undefined
})

async function streamError(sessionKey: string): Promise<unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-error-"))
  cacheHttp2SessionForTests(ORIGIN, client)
  try {
    const model = createCursor({
      name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })
      .languageModel("composer-2.5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return undefined
    }
  } catch (error) {
    return error
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("checkpoint eligibility across host results", () => {
  const readParts = async (model: LanguageModelV3, options: LanguageModelV3CallOptions) => {
    const parts: LanguageModelV3StreamPart[] = []
    const { stream } = await model.doStream(options)
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return parts
      parts.push(value)
    }
  }
  const appendResult = (prompt: LanguageModelV3CallOptions["prompt"], parts: LanguageModelV3StreamPart[], output: string) => {
    const call = parts.find(part => part.type === "tool-call")
    if (!call || call.type !== "tool-call") throw new Error("Expected a host tool call")
    prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
    prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
  }

  for (const checkpointAt of ["prefix-drain", "final-drain"] as const) {
    it(`uses the actual result write cutoff when a checkpoint arrives during ${checkpointAt}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-drain-"))
      const checkpoint = Uint8Array.of(10, 1, 8)
      let resumed = false
      let resumedState: Uint8Array | undefined
      let blocked = false
      let checkpointSent = false
      let checkpointArrivedDuringDrain = false
      let boundary = 0
      let drainDone!: () => void
      const drained = new Promise<void>(resolve => { drainDone = resolve })
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          runs++
          resumed = !!(message.run_request as { action?: { resume_action?: unknown } }).action?.resume_action
          resumedState = (message.run_request as { conversation_state?: Uint8Array }).conversation_state
          if (runs > 1) {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          } else send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo done", tool_call_id: "command" } } })
          return
        }
        const control = message.exec_client_control_message as { stream_close?: { id: number } } | undefined
        const result = message.exec_client_message as { shell_stream?: { start?: unknown } } | undefined
        if (!checkpointSent && (checkpointAt === "final-drain" ? control?.stream_close?.id === 1 : result?.shell_stream?.start)) {
          checkpointSent = true
          send({ conversation_checkpoint_update: checkpoint })
        }
        if (control?.stream_close?.id === 1) {
          void drained.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(() => {
            send({ interaction_update: { thinking_delta: { text: "after the result" } } })
            stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
          })
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const key = `ses_checkpoint_${checkpointAt}`
        const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
          workspaceRoot: root, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run the command" }] }]
        const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": key },
          tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        appendResult(prompt, await readParts(model, options), "done")
        const held = sessionManager.findOpenByOpenCodeSessionId(key)!
        const write = held.stream.write.bind(held.stream)
        const waitForDrain = held.stream.waitForDrain?.bind(held.stream)
        held.stream.write = bytes => {
          const message = decodeMessage<{ exec_client_message?: { shell_stream?: { start?: unknown } }; exec_client_control_message?: { stream_close?: { id: number } } }>("AgentClientMessage", bytes)
          const block = checkpointAt === "final-drain"
            ? message.exec_client_control_message?.stream_close?.id === 1
            : !!message.exec_client_message?.shell_stream?.start
          if (block) { blocked = true; boundary = lastFrameArrival() }
          const accepted = write(bytes)
          return block ? false : accepted
        }
        held.stream.waitForDrain = async () => {
          if (!blocked) { await waitForDrain?.(); return }
          const arrived = () => held.heldFrames?.some(queued => {
            if ((frameArrival(queued) ?? 0) <= boundary) return false
            const message = decodeMessage<{ conversation_checkpoint_update?: Uint8Array }>("AgentServerMessage", queued.payload)
            return message.conversation_checkpoint_update?.every((byte, index) => byte === checkpoint[index])
              && message.conversation_checkpoint_update.length === checkpoint.length
          }) ?? false
          for (let i = 0; i < 200 && !arrived(); i++) await new Promise(resolve => setTimeout(resolve, 1))
          checkpointArrivedDuringDrain = arrived()
          expect(checkpointArrivedDuringDrain).toBe(true)
          blocked = false
          drainDone()
        }
        if (checkpointAt === "final-drain") {
          expect((await readParts(model, options)).some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(true)
          expect(resumedState).toEqual(checkpoint)
          expect(runs).toBe(2)
        } else {
          expect(await readParts(model, options).catch((error: unknown) => error)).toMatchObject({ isRetryable: false })
          expect(runs).toBe(1)
        }
        expect(checkpointArrivedDuringDrain).toBe(true)
      } finally {
        drainDone()
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const [nextId, incomplete, opaque, lateCompletion] of [
    [1, false, false, false], [2, false, false, false], [2, true, false, false],
    [2, false, true, false], [2, false, false, true],
  ] as const) {
    it(`recovers after a resumed Run's completed exec (id=${nextId}, incomplete=${incomplete}, opaque=${opaque}, lateCompletion=${lateCompletion})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-resumed-result-"))
      const requests: Array<{ conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }> = []
      const contexts: Uint8Array[] = []
      const delivered = new Set<string>()
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        if (message.run_request) {
          requests.push(message.run_request as typeof requests[number])
          if (requests.length === 3) { send({ interaction_update: { turn_ended: {} } }); stream.end(); return }
          send({ exec_server_message: { id: 90, request_context_args: {} } })
          if (requests.length === 1 && opaque) stream.write(frame(Uint8Array.of(0xa2, 0x06, 0)))
          send({ interaction_update: { tool_call_started: { call_id: `command-${requests.length}` } } })
          send({ exec_server_message: { id: requests.length === 1 ? 1 : nextId,
            shell_args: { command: `echo step-${requests.length}`, tool_call_id: `command-${requests.length}` } } })
        } else if (message.exec_client_message) {
          const reply = message.exec_client_message as { request_context_result?: { success?: { request_context?: Record<string, unknown> } } }
          const context = reply.request_context_result?.success?.request_context
          if (context) contexts.push(encodeMessage("RequestContext", context))
        } else if (message.exec_client_control_message) {
          const close = (message.exec_client_control_message as { stream_close?: { id: number } }).stream_close
          const key = `${requests.length}:${close?.id}`
          if (!close || close.id !== (requests.length === 1 ? 1 : nextId) || delivered.has(key)) return
          delivered.add(key)
          send({ interaction_update: { tool_call_completed: { call_id: `command-${requests.length}` } } })
          if (requests.length === 1) {
            send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 9) })
            send({ interaction_update: { thinking_delta: { text: "checkpointed first result" } } })
            stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
          } else {
            // A resumed conversation can still complete an older display call.
            if (lateCompletion) send({ interaction_update: { tool_call_completed: { call_id: "command-1" } } })
            stream.end()
          }
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
          workspaceRoot: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run both commands" }] }]
        const options: LanguageModelV3CallOptions = { prompt, headers: { "x-opencode-session-id": `ses_resume_owners_${nextId}_${incomplete}_${opaque}_${lateCompletion}` },
          tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        appendResult(prompt, await readParts(model, options), "first command completed")
        appendResult(prompt, await readParts(model, options), "second command completed")
        expect(requests).toHaveLength(2)
        expect(requests[1]!.action.resume_action).toBeDefined()
        expect(requests[1]!.conversation_id).toBe(requests[0]!.conversation_id)
        for (let i = 0; i < 200 && contexts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1))
        expect(contexts).toHaveLength(2)
        const beforeContext = decodeMessage<Record<string, unknown>>("RequestContext", contexts[0]!)
        const afterContext = decodeMessage<Record<string, unknown>>("RequestContext", contexts[1]!)
        const changed = [...new Set([...Object.keys(beforeContext), ...Object.keys(afterContext)])]
          .filter(key => JSON.stringify(beforeContext[key]) !== JSON.stringify(afterContext[key]))
        expect(changed).toEqual([])
        if (incomplete) prompt.splice(1, 2)
        if (incomplete || opaque) {
          expect(await readParts(model, options).catch((error: unknown) => error)).toMatchObject({ isRetryable: false })
          expect(requests).toHaveLength(2)
        } else {
          expect((await readParts(model, options)).some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(requests).toHaveLength(3)
          expect(requests[2]!.action.resume_action).toBeUndefined()
          expect(requests[2]!.conversation_id).not.toBe(requests[0]!.conversation_id)
          const text = requests[2]!.action.user_message_action!.user_message.text
          expect(text.match(/first command completed/g)).toHaveLength(1)
          expect(text.match(/second command completed/g)).toHaveLength(1)
        }
        expect(delivered.size).toBe(2)
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  for (const scenario of [
    "complete", "announced", "announced-shell", "missing-history", "unknown", "unrepresented-exec", "duplicate-exec",
    "followup-before-result", "new-output", "final-error", "cursor-run-call", "unannounced-completion", "oversized",
    "malformed-completion", "repeated-completion-id",
  ] as const) {
    it(`recovers a post-result drop only from represented completed work (${scenario})`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-history-"))
      type RunRequest = { conversation_id: string; action: { resume_action?: unknown; user_message_action?: { user_message: { text: string } } } }
      const requests: RunRequest[] = []
      const delivered: number[] = []
      // Cursor announces each host call before its exec and closes it after the result.
      const lifecycle = scenario === "announced" || scenario === "announced-shell" || scenario === "cursor-run-call"
        || scenario === "unannounced-completion" || scenario === "oversized"
        || scenario === "malformed-completion" || scenario === "repeated-completion-id"
      const shellVariant = scenario === "announced-shell" ? "shell_args" : "shell_stream_args"
      scripted = (stream, message) => {
        const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
        const shell = (callId: string, command: string) => ({ shell_tool_call: { args: { command, tool_call_id: callId } } })
        const started = (callId: string, command: string) => {
          if (lifecycle) send({ interaction_update: { tool_call_started: { call_id: callId, tool_call: shell(callId, command) } } })
        }
        const completed = (callId: string, command: string) => {
          if (lifecycle) send({ interaction_update: { tool_call_completed: { call_id: callId, tool_call: shell(callId, command) } } })
        }
        if (message.run_request) {
          requests.push(message.run_request as RunRequest)
          if (requests.length > (scenario === "followup-before-result" ? 2 : 1)) {
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
            return
          }
          if (requests.length === 1) send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
          if (scenario === "followup-before-result" && requests.length === 1) {
            send({ interaction_update: { text_delta: { text: "Checking the workspace" } } })
            send({ interaction_update: { turn_ended: {} } })
            return
          }
          if (scenario === "unknown") stream.write(frame(Uint8Array.of(0xa2, 0x06, 0))) // unknown field 100
          if (scenario === "unrepresented-exec") send({ exec_server_message: { id: 90, list_mcp_resources_exec_args: {} } })
          if (scenario === "duplicate-exec") send({ exec_server_message: { id: 1, list_mcp_resources_exec_args: {} } })
          // A call Cursor runs itself: announced, never claimed by a host exec.
          if (scenario === "cursor-run-call") send({ interaction_update: { tool_call_started: { call_id: "cursor-internal" } } })
          started("first", "echo first")
          send({ exec_server_message: { id: 1, [shellVariant]: { command: "echo first", tool_call_id: "first" } } })
        } else if (message.exec_client_message) {
          const id = (message.exec_client_message as { id: number }).id
          // A result is complete with its exit; a large stdout arrives first.
          const shellReply = message.exec_client_message as { shell_stream?: { exit?: unknown }; shell_result?: unknown }
          if ((!shellReply.shell_stream?.exit && !shellReply.shell_result) || delivered.includes(id)) return
          delivered.push(id)
          if (id === 1) {
            completed("first", "echo first")
            started("second", "echo second")
            send({ exec_server_message: { id: 2, [shellVariant]: { command: "echo second", tool_call_id: "second" } } })
          } else {
            completed("second", "echo second")
            if (scenario === "malformed-completion" || scenario === "repeated-completion-id") {
              // Independent lifecycle wire: completion #3, call_id #1.
              // The decoder discards the unknown field or duplicate call id.
              const callId = [0x0a, 5, ...Buffer.from("first")]
              const body = [...callId, ...(scenario === "malformed-completion" ? [0x9a, 0x06, 0] : callId)]
              stream.write(frame(Uint8Array.from([0x0a, body.length + 2, 0x1a, body.length, ...body])))
            }
            if (scenario === "unannounced-completion") send({ interaction_update: { tool_call_completed: { call_id: "never-started" } } })
            if (scenario === "new-output") send({ interaction_update: { text_delta: { text: "new output" } } })
            if (scenario === "final-error") stream.end(frame(Buffer.from('{"error":{"code":"permission_denied"}}'), 2))
            else stream.end() // no checkpoint after either completed result
          }
        }
      }
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
          workspaceRoot: root, cacheDir: root, retry: { baseDelayMs: 1, maxDelayMs: 1 } }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run both commands" }] }]
        const options = { prompt, headers: { "x-opencode-session-id": `ses_result_history_${scenario}` },
          tools: [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] }
        const read = async () => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            parts.push(value)
          }
          return parts
        }
        // The rebuild seeds every result; this one cannot fit composer-2.5's window.
        const secondOutput = scenario === "oversized" ? `second completed ${"z".repeat(1_000_000)}` : "second completed"
        for (const output of ["first completed", secondOutput]) {
          const parts = await read()
          const call = parts.find(part => part.type === "tool-call")
          if (!call || call.type !== "tool-call") throw new Error("Expected a host command")
          prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
          prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: output } }] })
        }
        if (scenario === "missing-history") prompt.splice(1, 2)
        if (scenario === "complete" || scenario === "announced" || scenario === "announced-shell") {
          const parts = await read()
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(parts.some(part => part.type === "tool-call")).toBe(false)
          expect(requests).toHaveLength(2)
          expect(requests[1]!.action.resume_action).toBeUndefined()
          expect(requests[1]!.conversation_id).not.toBe(requests[0]!.conversation_id)
          const text = requests[1]!.action.user_message_action!.user_message.text
          expect(text.match(/first completed/g)).toHaveLength(1)
          expect(text.match(/second completed/g)).toHaveLength(1)
          expect(text).toContain("Do not repeat completed work")
        } else if (scenario === "oversized") {
          // The host compacts on this context overflow instead of retrying.
          const error = await read().catch((caught: unknown) => caught)
          expect(APICallError.isInstance(error)).toBe(true)
          expect(error).toMatchObject({ statusCode: 413, isRetryable: false })
          expect((error as APICallError).message).toMatch(/^prompt is too long/)
          expect(requests).toHaveLength(1)
        } else {
          expect(await read().catch((error: unknown) => error)).toMatchObject({ isRetryable: false,
            responseHeaders: { "x-should-retry": "false" } })
          expect(requests).toHaveLength(scenario === "followup-before-result" ? 2 : 1)
        }
        expect(delivered).toEqual([1, 2])
      } finally {
        sessionManager.dispose()
        await settleRunSavesForTests()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  it("reports a foreign-history rebase that cannot fit as a context overflow, not a setup failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-rebase-overflow-"))
    let requests = 0
    scripted = (stream, message) => {
      if (!message.run_request) return
      requests++
      const send = (value: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", value)))
      send({ interaction_update: { text_delta: { text: "Cursor answer" } } })
      send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
      send({ interaction_update: { turn_ended: {} } })
      stream.end()
    }
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN,
        workspaceRoot: root, cacheDir: root }).languageModel("composer-2.5")
      // A tool-less call would be a lifecycle helper, which never rebases.
      const headers = { "x-opencode-session-id": "ses_rebase_overflow" }
      const tools = [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]
      const first = await model.doStream({ headers, tools, prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
      for (const reader = first.stream.getReader(); !(await reader.read()).done;) { /* drain */ }
      // Another model answered since, at a length the 200k window cannot hold.
      const error = await Promise.resolve(model.doStream({ headers, tools, prompt: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: `Other model ${"x".repeat(1_000_000)}` }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ] })).catch((caught: unknown) => caught)
      expect(APICallError.isInstance(error)).toBe(true)
      expect(error).toMatchObject({ statusCode: 413, isRetryable: false })
      expect((error as APICallError).message).toMatch(/^prompt is too long/)
      expect(requests).toBe(1)
    } finally {
      sessionManager.dispose()
      await settleRunSavesForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  for (const [afterResult, rejectReplacement] of [[false, false], [true, false], [true, true]] as const) {
    it(`only resumes a checkpoint received after the result (after: ${afterResult}, expired replacement: ${rejectReplacement})`, async () => {
      const checkpoint = Uint8Array.of(10, 1, 7)
      let resumed = false
      let renewals = 0
      scripted = (stream, message) => {
        const send = (message: Record<string, unknown>) => stream.write(frame(encodeMessage("AgentServerMessage", message)))
        if (message.run_request) {
          runs++
          resumed = !!(message.run_request as { action?: { resume_action?: unknown } }).action?.resume_action
          if (resumed) {
            if (rejectReplacement && runs === 2) {
              stream.end(frame(Buffer.from('{"error":{"code":"unauthenticated"}}'), 2))
              return
            }
            send({ interaction_update: { turn_ended: {} } })
            stream.end()
          } else {
            send({ exec_server_message: { id: 1, shell_stream_args: { command: "echo done", tool_call_id: "command" } } })
            // This frame arrives while the host tool is outstanding. The held
            // reader may queue it until after the host has delivered its result.
            if (!afterResult) send({ conversation_checkpoint_update: checkpoint })
          }
        } else if (message.exec_client_message) {
          if (afterResult) send({ conversation_checkpoint_update: checkpoint })
          send({ interaction_update: { thinking_delta: { text: "after the command" } } })
          stream.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
        }
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-result-checkpoint-"))
      cacheHttp2SessionForTests(ORIGIN, client)
      try {
        const model = createCursor({
          name: "cursor", agentBaseURL: ORIGIN, cacheDir: root,
          getAccessToken: async request => {
            if (request?.forceRefresh) renewals++
            return renewals ? "renewed-test-token" : "test-token"
          },
          retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        }).languageModel("composer-2.5")
        const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Run echo done" }] }]
        const options = {
          prompt,
          tools: [{ type: "function" as const, name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
          headers: { "x-opencode-session-id": `ses_result_checkpoint_${afterResult}` },
        }
        const read = async (options: LanguageModelV3CallOptions) => {
          const parts: LanguageModelV3StreamPart[] = []
          const { stream } = await model.doStream(options)
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return parts
            parts.push(value)
          }
        }
        const first = await read(options)
        const call = first.find(part => part.type === "tool-call")
        if (!call || call.type !== "tool-call") throw new Error("Expected the shell call")
        await new Promise<void>(resolve => setImmediate(resolve))
        prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] })
        prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "done" } }] })
        if (afterResult) {
          const parts = await read(options)
          expect(parts.some(part => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
          expect(resumed).toBe(true)
          expect(runs).toBe(rejectReplacement ? 3 : 2)
          expect(renewals).toBe(rejectReplacement ? 1 : 0)
        } else {
          const error = await read(options).catch((error: unknown) => error)
          expect(error).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
          expect(resumed).toBe(false)
          expect(runs).toBe(1)
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
})

describe("follow-up checkpoint arrival", () => {
  it("resumes a progress follow-up checkpoint received before reopen returns", async () => {
    const checkpoint = Uint8Array.of(10, 1, 8)
    let firstRun: http2.ServerHttp2Stream | undefined
    const requests: Record<string, unknown>[] = []
    scripted = (run, message) => {
      if (!message.run_request) return
      const request = message.run_request as Record<string, unknown>
      requests.push(request)
      const send = (message: Record<string, unknown>) => run.write(frame(encodeMessage("AgentServerMessage", message)))
      if (requests.length === 1) {
        firstRun = run
        send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 7) })
        send({ interaction_update: { text_delta: { text: "Checking the workspace" } } })
      } else if (requests.length === 2) {
        send({ conversation_checkpoint_update: checkpoint })
        send({ interaction_update: { thinking_delta: { text: "Continuing the follow-up" } } })
        run.end(frame(Buffer.from('{"error":{"code":"unavailable"}}'), 2))
      } else {
        send({ interaction_update: { text_delta: { text: "Finished." } } })
        send({ interaction_update: { turn_ended: {} } })
        run.end()
      }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-followup-checkpoint-"))
    cacheHttp2SessionForTests(ORIGIN, client)
    try {
      const key = "ses_progress_early_checkpoint"
      const model = createCursor({
        name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root, workspaceRoot: root,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      }).languageModel("composer-2.5")
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Check the workspace" }] }],
        tools: [{ type: "function", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
        headers: { "x-opencode-session-id": key },
      })
      let wrapped = false
      let arrivedBeforeReopenReturned = false
      const parts: LanguageModelV3StreamPart[] = []
      const reader = stream.getReader()
      for (;;) {
        const { done, value: part } = await reader.read()
        if (done) break
        parts.push(part)
        if (part.type !== "text-delta" || wrapped) continue
        wrapped = true
        const session = sessionManager.findOpenByOpenCodeSessionId(key)!
        const reopen = session.reopenWithUserMessage!
        session.reopenWithUserMessage = async (text, signal) => {
          const before = lastFrameArrival()
          await reopen(text, signal)
          // Force the replacement's frames into the transport queue while the
          // caller still awaits reopen (as while draining the previous stream).
          for (let i = 0; i < 100 && lastFrameArrival() === before; i++) await Bun.sleep(1)
          arrivedBeforeReopenReturned = lastFrameArrival() > before
          expect(arrivedBeforeReopenReturned).toBe(true)
        }
        firstRun!.write(frame(encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } })))
      }
      expect(arrivedBeforeReopenReturned).toBe(true)
      expect(requests).toHaveLength(3)
      expect(requests[2]).toMatchObject({ action: { resume_action: {} }, conversation_state: checkpoint,
        conversation_id: requests[0]!.conversation_id })
      expect(parts.some(part => part.type === "text-delta" && part.delta === "Finished.")).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("Run errors as the host sees them", () => {
  for (const method of ["doStream", "doGenerate"] as const) {
    for (const failure of ["empty token", "rejected login"] as const) {
      it(`ends ${method} on a pre-stream ${failure} without opening a Run`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-auth-error-"))
        let requests = 0
        const authError = new CursorAuthError("Cursor login expired; sign in again")
        try {
          const model = createCursor({
            name: "cursor",
            cacheDir: root,
            getAccessToken: async () => {
              requests++
              if (failure === "rejected login") throw authError
              return ""
            },
          }).languageModel("composer-2.5")
          let caught: unknown
          try {
            await model[method]({
              prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
              headers: { "x-opencode-session-id": `ses_auth_${method}_${failure}` },
            })
          } catch (error) {
            caught = error
          }
          expect(APICallError.isInstance(caught)).toBe(true)
          expect(caught).toMatchObject({
            statusCode: 401,
            isRetryable: false,
            responseHeaders: { "x-should-retry": "false" },
          })
          expect((caught as APICallError).cause).toBeInstanceOf(CursorAuthError)
          if (failure === "rejected login") expect((caught as APICallError).cause).toBe(authError)
          expect(requests).toBe(1)
          expect(runs).toBe(0)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }

  it("reports a request Cursor declared not retryable as a 400 APICallError, without a provider retry", async () => {
    trailer = {
      error: { code: "invalid_argument", message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: POLICY_BLOCK }] },
    }
    const error = await streamError("ses_policy_block")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 400, isRetryable: false })
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument): Request blocked by Anthropic " +
      "We are unable to complete this request because it was blocked under Anthropic's Usage Policy.")
    expect(runs).toBe(1)
  }, 30_000)

  it("keeps an error without a Cursor verdict as the provider error", async () => {
    trailer = { error: { code: "invalid_argument" } }
    const error = await streamError("ses_plain_error")

    expect(APICallError.isInstance(error)).toBe(false)
    expect(error).toBeInstanceOf(CursorServerError)
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument)")
    expect(runs).toBe(1)
  }, 30_000)

  it("stops host retries after the Run retry budget is spent", async () => {
    trailer = { error: { code: "unavailable" } }
    const error = await streamError("ses_terminal_budget")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: 400,
      isRetryable: false,
      responseHeaders: { "x-should-retry": "false" },
    })
    const cause = (error as APICallError).cause
    expect(cause).toBeInstanceOf(CursorRetryExhaustedError)
    expect(cause).toMatchObject({ transient: false, replaySafe: false, code: "unavailable" })
    expect(runs).toBe(2)
  }, 30_000)

  // Cursor CLI sends the same action again. The provider cannot, because the
  // host already shows the reasoning, so the host retries the turn.
  it("leaves the retry to the host after output only, before any checkpoint", async () => {
    trailer = { error: { code: "unavailable" } }
    partialOutput = true
    const error = await streamError("ses_host_retry")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({
      statusCode: undefined,
      isRetryable: true,
      responseHeaders: { "x-should-retry": "true" },
    })
    expect((error as Error).message).not.toContain("automatic retry unsafe")
    const cause = (error as APICallError).cause
    expect(cause).toMatchObject({ hostRetryable: true, transient: false, replaySafe: false, code: "unavailable" })
    expect(runs).toBe(1)
  }, 30_000)
})

describe("retry limits across OpenCode calls", () => {
  it("also budgets transient setup errors and refuses ambiguous uploads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-setup-retry-budget-"))
    let renewals = 0
    let ambiguous = false
    let transient = true
    const model = createCursor({
      name: "cursor", agentBaseURL: ORIGIN, cacheDir: root,
      getAccessToken: async () => {
        renewals++
        throw new CursorTransportError("connection reset", { transient, replaySafe: !ambiguous, code: "ECONNRESET" })
      },
    }).languageModel("composer-2.5")
    const attempt = async (): Promise<unknown> => {
      try {
        return await model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          headers: { "x-opencode-session-id": "ses_setup_retries" },
        })
      } catch (error) { return error }
    }
    try {
      for (let i = 0; i < 10; i++) {
        const error = await attempt()
        expect(error).toMatchObject({ isRetryable: true })
        expect(error).toHaveProperty("message", expect.not.stringContaining("after visible output"))
      }
      expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
      expect(renewals).toBe(11)
      await notifyHostInterrupt("ses_setup_retries", "test-stop")
      ambiguous = true
      expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
      transient = false
      expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
      expect(runs).toBe(0)
    } finally {
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const [endless, maxAttempts, retries, reminderParts, incomplete] of [
    [false, undefined, 3, false, false], [false, 2, 1, false, false], [true, 2, 14, false, false],
    [false, undefined, 3, true, false], [false, 2, 1, true, false], [true, 2, 14, true, false],
    [false, undefined, 10, true, true],
  ] as const) {
    it(`bounds output-only host retries (endless=${endless}, maxAttempts=${maxAttempts}, reminderParts=${reminderParts}, bareEOF=${incomplete})`, async () => {
      const saved = process.env.CURSOR_ENDLESS_RETRIES
      if (endless) process.env.CURSOR_ENDLESS_RETRIES = "true"
      else delete process.env.CURSOR_ENDLESS_RETRIES
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-retry-budget-"))
      cacheHttp2SessionForTests(ORIGIN, client)
      trailer = { error: { code: "unavailable" } }
      partialOutput = true
      bareEof = incomplete
      const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      const attempt = async () => {
        // Hosts may reload the SDK model between retries. State belongs to the turn.
        const model = createCursor({
          name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root,
          retry: { maxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
        }).languageModel("composer-2.5")
        try {
          // A plugin transforms this request, not the host's stored history.
          const requestPrompt = structuredClone(prompt)
          const last = requestPrompt.at(-1)
          if (reminderParts && last?.role === "user") last.content.push({ type: "text",
            text: `<system-reminder>Pending task reminder ${runs}</system-reminder>` })
          const { stream } = await model.doStream({ prompt: requestPrompt, headers: { "x-opencode-session-id": "ses_repeated_output" } })
          const reader = stream.getReader()
          while (!(await reader.read()).done) { /* drain host-visible output */ }
        } catch (error) { return error }
      }
      try {
        for (let i = 0; i < retries; i++) {
          expect(await attempt()).toMatchObject({ isRetryable: true, responseHeaders: { "x-should-retry": "true" } })
          // Canonical OpenCode 2 runner/llm.ts Continue outcome, lowered by
          // runner/to-llm-message.ts as a plain user message (no reminder wrapper).
          prompt.push({ role: "assistant", content: [{ type: "text", text: `partial ${i}` }] })
          prompt.push({ role: "user", content: [{ type: "text", text: "The previous response was interrupted. Continue from where you left off without repeating completed content." }] })
        }
        expect(runs).toBe(retries)
        if (endless) {
          trailer = { error: { code: "permission_denied" } }
          expect(await attempt()).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
        } else {
          expect(await attempt()).toMatchObject({ isRetryable: false, statusCode: 400, responseHeaders: { "x-should-retry": "false" } })
          expect(runs).toBe(retries + 1)
          // After a final error, typing the exact same text is a genuine new
          // request: there is no pending provider-requested host retry.
          prompt.push({ role: "assistant", content: [{ type: "text", text: "final partial answer" }] })
          prompt.push({ role: "user", content: [{ type: "text", text: "The previous response was interrupted. Continue from where you left off without repeating completed content." }] })
          expect(await attempt()).toMatchObject({ isRetryable: true })
          for (let i = 1; i < retries; i++) {
            prompt.push({ role: "assistant", content: [{ type: "text", text: `literal request partial ${i}` }] })
            prompt.push({ role: "user", content: [{ type: "text", text: "The previous response was interrupted. Continue from where you left off without repeating completed content." }] })
            expect(await attempt()).toMatchObject({ isRetryable: true })
          }
          expect(await attempt()).toMatchObject({ isRetryable: false })
          // A later identical user message is a new turn, even in the same session.
          prompt.push({ role: "user", content: [{ type: "text", text: "Hello" }] })
          expect(await attempt()).toMatchObject({ isRetryable: true })
          // Stop also resets a failed turn when there is no longer an open Run.
          await notifyHostInterrupt("ses_repeated_output", "test-stop")
          expect(await attempt()).toMatchObject({ isRetryable: true })
          scripted = (stream, message) => {
            if (!message.run_request) return
            stream.end(frame(encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } })))
          }
          expect(await attempt()).toBeUndefined()
          scripted = undefined
          expect(await attempt()).toMatchObject({ isRetryable: true })
        }
      } finally {
        if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
        else process.env.CURSOR_ENDLESS_RETRIES = saved
        sessionManager.dispose()
        setHostCacheDirOverride(undefined)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
})
