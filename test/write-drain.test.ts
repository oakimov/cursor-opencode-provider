import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import { CursorLocalCancellationError, CursorProviderError } from "../src/errors.js"
import { pump, resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager, type Frame } from "../src/session.js"
import { writeStreamMessage } from "../src/stream-write.js"
import {
  bidiRunStream,
  cacheHttp2SessionForTests,
  closeCachedHttp2SessionsForTests,
  resetRunCompressionForTests,
} from "../src/transport/connect.js"
import { sessionFixture } from "./session-fixture.js"

// Adapted from the throttling-relay tests in #77 (by @nkoynov).

const ORIGIN = "https://agentn.drain-test.cursor.sh"

/**
 * An h2c "Cursor" behind a relay that forwards what the client sends at
 * `bytesPerSecond`, or nothing once stalled. The server answers each Run with
 * one frame and then stays silent.
 */
async function startSlowCursor(bytesPerSecond: number, options: { endWithoutReading?: boolean } = {}) {
  const received: number[] = []
  const bodies: Buffer[][] = []
  const serverStreams: http2.ServerHttp2Stream[] = []
  let stalled = false
  const sessions = new Set<http2.Http2Session>()
  const server = http2.createServer()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    const index = received.push(0) - 1
    serverStreams.push(stream)
    bodies.push([])
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, encodeMessage("AgentServerMessage", { interaction_update: { heartbeat: {} } })))
    stream.on("error", () => {})
    if (options.endWithoutReading) return void setTimeout(() => stream.end(), 100)
    stream.on("data", (chunk: Buffer) => {
      received[index]! += chunk.length
      bodies[index]!.push(chunk)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const serverPort = (server.address() as net.AddressInfo).port

  const sockets = new Set<net.Socket>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const relay = net.createServer((client) => {
    const upstream = net.connect(serverPort, "127.0.0.1")
    sockets.add(client).add(upstream)
    const queue: Buffer[] = []
    const tick = setInterval(() => {
      if (stalled) return void client.pause()
      let budget = bytesPerSecond / 20
      while (queue.length > 0 && budget > 0) {
        const head = queue[0]!
        const sent = head.subarray(0, budget)
        upstream.write(sent)
        budget -= sent.length
        if (sent.length === head.length) queue.shift()
        else queue[0] = head.subarray(sent.length)
      }
      if (queue.length > 4) client.pause()
      else client.resume()
    }, 50)
    timers.add(tick)
    client.on("data", (chunk) => queue.push(chunk))
    upstream.on("data", (chunk) => client.write(chunk))
    client.on("error", () => {})
    upstream.on("error", () => {})
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const relayPort = (relay.address() as net.AddressInfo).port
  const client = http2.connect(ORIGIN, { createConnection: () => net.connect(relayPort, "127.0.0.1") })
  client.on("error", () => {})
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
  cacheHttp2SessionForTests(ORIGIN, client)

  return {
    received,
    body: (index: number) => Buffer.concat(bodies[index] ?? []),
    send(index: number, message: Record<string, unknown>) {
      serverStreams[index]!.write(encodeFrame(0, encodeMessage("AgentServerMessage", message)))
    },
    stall() { stalled = true },
    async close() {
      for (const timer of timers) clearInterval(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => relay.close(resolve))
      for (const session of sessions) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

async function waitUntil(condition: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10))
}

let fake: Awaited<ReturnType<typeof startSlowCursor>> | undefined
const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

beforeEach(() => {
  process.env.CURSOR_CLIENT_VERSION = "cli-drain-test-1"
  resetClientVersionCache()
  // The filled payloads would compress below the relay's buffers and never block.
  resetRunCompressionForTests(ORIGIN)
})

afterEach(async () => {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetRunCompressionForTests()
  closeCachedHttp2SessionsForTests()
  await fake?.close()
  fake = undefined
  if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
  else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
  resetClientVersionCache()
})

describe("Run write drain", () => {
  it("answers a large KV get_blob whose reply takes longer than five seconds to upload", async () => {
    fake = await startSlowCursor(800_000)
    const stream = await bidiRunStream("token", { baseURL: ORIGIN })
    const blobId = Uint8Array.of(0xb1, 0x0b)
    const blob = new Uint8Array(5_000_000).map((_, i) => i % 241)
    const frames: Frame[] = [
      { kv_server_message: { id: 4, get_blob_args: { blob_id: blobId } } },
      { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
    ].map((message) => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) }))
    const iterator = { next: async () =>
      frames.length ? { done: false as const, value: frames.shift()! } : { done: true as const, value: undefined } }
    const session = sessionFixture({
      sessionId: "kv-drain", conversationId: "kv-drain-conversation",
      pending: new Map(), blobs: new Map([["b10b", blob]]), displayToolCalls: new Map(), editToolCalls: new Map(),
      nextBridgedExecId: 900_000, pumpActive: false, heartbeat: null,
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      stream, frames: iterator, allowTools: false, toolCatalog: [], toolDescriptors: [], requestContext: {},
    })
    const controller = {
      enqueue() {}, error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>

    const startedAt = Date.now()
    await pump(session, controller, { textId: "t", reasoningId: "r" })

    expect(Date.now() - startedAt).toBeGreaterThan(5_000)
    await waitUntil(() => fake!.received[0]! >= blob.length)
    const reply = decodeMessage<any>("AgentClientMessage", fake.body(0).subarray(5))
    expect(reply.kv_client_message.id).toBe(4)
    expect(reply.kv_client_message.get_blob_result.blob_data).toEqual(blob)
    stream.end()
  }, 20_000)

  it("resolves at once when the write was not backpressured", async () => {
    fake = await startSlowCursor(2_000_000)
    const run = await bidiRunStream("token", { baseURL: ORIGIN })

    expect(run.write(new Uint8Array(1_000))).toBe(true)
    await run.waitForDrain!()
    run.end()
  })

  it("settles a pending drain at once when the Run is aborted", async () => {
    fake = await startSlowCursor(200_000)
    const controller = new AbortController()
    const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: controller.signal })

    expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
    const drain = failureOf(run.waitForDrain!())
    await waitUntil(() => fake!.received[0]! > 50_000)
    const startedAt = Date.now()
    controller.abort()
    const error = await drain

    expect(error).toBeInstanceOf(CursorLocalCancellationError)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  }, 15_000)

  it("settles a pending drain at once when the Run is destroyed or ended", async () => {
    for (const close of ["destroy", "end"] as const) {
      fake = await startSlowCursor(200_000)
      const run = await bidiRunStream("token", { baseURL: ORIGIN })

      expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
      const drain = failureOf(writeStreamMessage(run, new Uint8Array(10), `after-${close}`))
      const pending = failureOf(run.waitForDrain!())
      await waitUntil(() => fake!.received[0]! > 50_000)
      fake.stall()
      const startedAt = Date.now()
      run[close]()

      expect(await pending).toBeInstanceOf(CursorLocalCancellationError)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      await drain
      expect(await failureOf(run.waitForDrain!())).toBeInstanceOf(CursorLocalCancellationError)
      closeCachedHttp2SessionsForTests()
      await fake.close()
      fake = undefined
    }
  }, 15_000)

  it("settles a pending drain when Cursor ends its response without reading the request", async () => {
    fake = await startSlowCursor(200_000, { endWithoutReading: true })
    const run = await bidiRunStream("token", { baseURL: ORIGIN })

    expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
    const error = await failureOf(run.waitForDrain!())

    expect(error).toBeInstanceOf(CursorProviderError)
    expect(error).not.toBeInstanceOf(CursorLocalCancellationError)
    expect(await failureOf(run.waitForDrain!())).toBeInstanceOf(CursorProviderError)
  }, 5_000)

  it("leaves a stalled write to the read-idle watchdog", async () => {
    fake = await startSlowCursor(200_000)
    const run = await bidiRunStream("token", { baseURL: ORIGIN, readIdleMs: 500 })

    expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
    const drain = failureOf(run.waitForDrain!())
    await waitUntil(() => fake!.received[0]! > 50_000)
    fake.stall()
    const error = await drain

    expect(error).toBeInstanceOf(CursorProviderError)
    expect((error as CursorProviderError).code).toBe("CURSOR_READ_IDLE_TIMEOUT")
    expect(run.isClosed()).toBe(true)
  }, 15_000)
})

describe("provider upload cancellation", () => {
  it("cancels a blocked KV reply while the current provider step is pumping", async () => {
    fake = await startSlowCursor(200_000)
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-kv-cancel-"))
    const previousCache = getHostCacheDirOverride()
    const abort = new AbortController()
    let consumed: Promise<unknown> | undefined
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
        tools: [{ type: "function", name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
        headers: { "x-opencode-session-id": "ses_kv_upload" }, abortSignal: abort.signal,
      } as LanguageModelV3CallOptions)
      const session = sessionManager.findOpenByOpenCodeSessionId("ses_kv_upload")!
      session.blobs.set("b10b", new Uint8Array(3_000_000))
      const reader = result.stream.getReader()
      consumed = (async () => { while (!(await reader.read()).done) { /* consume */ } })()
      const outcome = failureOf(consumed)
      await waitUntil(() => fake!.received.length === 1)
      fake.send(0, { kv_server_message: { id: 4, get_blob_args: { blob_id: Uint8Array.of(0xb1, 0x0b) } } })
      await waitUntil(() => fake!.received[0]! > 50_000)
      expect(fake.received[0]).toBeGreaterThan(50_000)
      fake.stall()
      abort.abort()
      expect(await Promise.race([outcome, Bun.sleep(1_000).then(() => "still uploading")])).toBeInstanceOf(CursorLocalCancellationError)
      expect(fake.received).toHaveLength(1)
    } finally {
      sessionManager.dispose()
      closeCachedHttp2SessionsForTests()
      if (consumed) await failureOf(consumed)
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  }, 15_000)

  it("keeps a successfully uploaded Run alive after the host aborts a completed tool step", async () => {
    fake = await startSlowCursor(2_000_000)
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-tool-step-abort-"))
    const previousCache = getHostCacheDirOverride()
    const controller = new AbortController()
    const sessionKey = "ses_uploaded_tool_step"
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Read the file" }] }],
        tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: {
          type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"],
        } }],
        headers: { "x-opencode-session-id": sessionKey }, abortSignal: controller.signal,
      } as LanguageModelV3CallOptions)
      await fs.writeFile(path.join(cacheDir, "example.txt"), "example content")
      await waitUntil(() => fake!.received.length === 1)
      fake.send(0, { exec_server_message: { id: 4, read_args: { path: path.join(cacheDir, "example.txt") } } })
      const reader = result.stream.getReader()
      const parts = []
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        parts.push(next.value)
      }
      expect(parts.some((part) => part.type === "tool-call")).toBe(true)
      const session = sessionManager.findOpenByOpenCodeSessionId(sessionKey)!
      controller.abort()
      expect(session.pending.size).toBe(1)
      expect(session.closed).toBe(false)
      expect(session.stream.isClosed()).toBe(false)
      expect(await failureOf(session.reopenWithUserMessage!("Do not upload", AbortSignal.abort())))
        .toBeInstanceOf(CursorLocalCancellationError)
      expect(fake.received).toHaveLength(1)
      expect(session.closed).toBe(false)
      const nextStep = new AbortController()
      const reopened = session.reopenWithUserMessage!("x".repeat(3_000_000), nextStep.signal)
      const outcome = failureOf(reopened)
      await waitUntil(() => fake!.received[1]! > 50_000)
      expect(fake.received[1]).toBeGreaterThan(50_000)
      fake.stall()
      nextStep.abort()
      expect(await Promise.race([outcome, Bun.sleep(1_000).then(() => "still uploading")])).toBeInstanceOf(CursorLocalCancellationError)
    } finally {
      sessionManager.dispose()
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(["abort", "host-stop"] as const)("cancels an unregistered replacement upload on %s", async (stop) => {
    fake = await startSlowCursor(200_000)
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-reopen-cancel-"))
    const previousCache = getHostCacheDirOverride()
    const controller = new AbortController()
    const sessionKey = `ses_reopen_upload_${stop}`
    let reopened: Promise<unknown> | undefined
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
        tools: [{ type: "function", name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
        headers: { "x-opencode-session-id": sessionKey }, abortSignal: controller.signal,
      } as LanguageModelV3CallOptions)
      // The replacement has not been assigned to the registered session yet.
      const session = sessionManager.findOpenByOpenCodeSessionId(sessionKey)!
      reopened = session.reopenWithUserMessage!("x".repeat(3_000_000), controller.signal)
      const outcome = failureOf(reopened)
      await waitUntil(() => fake!.received[1]! > 50_000)
      expect(fake.received[1]).toBeGreaterThan(50_000)
      fake.stall()
      if (stop === "abort") controller.abort()
      else await notifyHostInterrupt(sessionKey, "user", Date.now())
      expect(await Promise.race([outcome, Bun.sleep(1_000).then(() => "still uploading")])).toBeInstanceOf(CursorLocalCancellationError)
      sessionManager.dispose()
      await failureOf(result.stream.cancel())
    } finally {
      sessionManager.dispose()
      closeCachedHttp2SessionsForTests()
      if (reopened) await failureOf(reopened)
      // The stop saves the cancelled Run afterwards; that write would recreate the dir.
      await settleRunSavesForTests()
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  }, 15_000)

  it("closes the held Run when a Stop lands while its tool image is still decoding", async () => {
    fake = await startSlowCursor(200_000)
    const stream = await bidiRunStream("token", { baseURL: ORIGIN })
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-continuation-decode-cancel-"))
    const previousCache = getHostCacheDirOverride()
    const controller = new AbortController()
    const sessionKey = "ses_decode_continuation"
    let imageRequested = false
    const sockets = new Set<net.Socket>()
    // Accepts the image request and never answers it.
    const images = net.createServer((socket) => {
      imageRequested = true
      sockets.add(socket)
      socket.on("error", () => {})
    })
    await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve))
    const { port } = images.address() as net.AddressInfo
    const session = sessionFixture({
      sessionId: "decode-continuation", conversationId: "decode-continuation-conversation", openCodeSessionId: sessionKey,
      cacheDir, pending: new Map(), blobs: new Map(), displayToolCalls: new Map(), editToolCalls: new Map(),
      nextBridgedExecId: 900_000, pumpActive: false, heartbeat: null,
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      stream, frames: stream.frames()[Symbol.asyncIterator](), allowTools: true, toolCatalog: [], toolDescriptors: [], requestContext: {},
    })
    sessionManager.registerPending(4, session, "read_result", "read")
    let opening: Promise<unknown> | undefined
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      const toolCallId = `cursor_${session.sessionId}_4`
      opening = Promise.resolve(model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Read the image" }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "read", input: { filePath: "image.png" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "read", output: { type: "content", value: [
            { type: "text", text: "Image read successfully" },
            { type: "image-url", url: `http://127.0.0.1:${port}/image.png` },
          ] } }] },
        ],
        headers: { "x-opencode-session-id": sessionKey }, abortSignal: controller.signal,
      } as LanguageModelV3CallOptions))
      const outcome = failureOf(opening)
      await waitUntil(() => imageRequested)
      controller.abort()
      const error = await Promise.race([outcome, Bun.sleep(1_000).then(() => "still decoding")])
      expect(error).toBeInstanceOf(CursorLocalCancellationError)
      expect(session.closed).toBe(true)
      expect(fake.received.reduce((total, bytes) => total + bytes, 0)).toBe(0)
    } finally {
      closeCachedHttp2SessionsForTests()
      if (opening) await failureOf(opening)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => images.close(() => resolve()))
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(["before-call", "during-upload"] as const)("cancels a tool-result upload on a %s abort", async (when) => {
    fake = await startSlowCursor(200_000)
    const stream = await bidiRunStream("token", { baseURL: ORIGIN })
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-continuation-cancel-"))
    const previousCache = getHostCacheDirOverride()
    const controller = new AbortController()
    const sessionKey = "ses_upload_continuation"
    const session = sessionFixture({
      sessionId: "upload-continuation", conversationId: "upload-continuation-conversation", openCodeSessionId: sessionKey,
      cacheDir, pending: new Map(), blobs: new Map(), displayToolCalls: new Map(), editToolCalls: new Map(),
      nextBridgedExecId: 900_000, pumpActive: false, heartbeat: null,
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      stream, frames: stream.frames()[Symbol.asyncIterator](), allowTools: true, toolCatalog: [], toolDescriptors: [], requestContext: {},
    })
    sessionManager.registerPending(4, session, "read_result", "read")
    let opening: Promise<unknown> | undefined
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      const toolCallId = `cursor_${session.sessionId}_4`
      if (when === "before-call") controller.abort()
      opening = Promise.resolve(model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Read the file" }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "read", input: { filePath: "example.txt" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "read", output: { type: "text", value: "x".repeat(3_000_000) } }] },
        ],
        headers: { "x-opencode-session-id": sessionKey }, abortSignal: controller.signal,
      } as LanguageModelV3CallOptions))
      const outcome = failureOf(opening)
      if (when === "during-upload") {
        await waitUntil(() => fake!.received[0]! > 50_000)
        expect(fake.received[0]).toBeGreaterThan(50_000)
        fake.stall()
        controller.abort()
      }
      const error = await Promise.race([outcome, Bun.sleep(1_000).then(() => "still uploading")])
      expect(error).toBeInstanceOf(CursorLocalCancellationError)
      expect(session.closed).toBe(true)
      if (when === "before-call") {
        expect(fake.received.reduce((total, bytes) => total + bytes, 0)).toBe(0)
        expect(fake.received.length).toBeLessThanOrEqual(1)
      }
    } finally {
      closeCachedHttp2SessionsForTests()
      if (opening) await failureOf(opening)
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(["abort", "host-stop", "other-session", "shutdown", "title-host-stop"] as const)("handles %s during the initial upload before a session is registered", async (stop) => {
    fake = await startSlowCursor(200_000)
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-upload-cancel-"))
    const previousCache = getHostCacheDirOverride()
    const controller = new AbortController()
    const sessionKey = `ses_upload_${stop}`
    let opening: Promise<unknown> | undefined
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      opening = Promise.resolve(model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(3_000_000) }] }],
        tools: stop === "title-host-stop" ? [] : [{ type: "function", name: "read", description: "Read a file", inputSchema: {
          type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"],
        } }],
        headers: { "x-opencode-session-id": sessionKey }, abortSignal: controller.signal,
      } as LanguageModelV3CallOptions))
      const outcome = failureOf(opening)
      await waitUntil(() => fake!.received[0]! > 50_000)
      expect(fake.received[0]).toBeGreaterThan(50_000)
      fake.stall()
      if (stop === "abort") controller.abort()
      else if (stop === "host-stop") await notifyHostInterrupt(sessionKey, "user", Date.now())
      else {
        await notifyHostInterrupt(stop === "other-session" ? "ses_other" : sessionKey,
          stop === "shutdown" ? "shutdown" : "user", Date.now())
        expect(await Promise.race([outcome, Bun.sleep(50).then(() => "still uploading")])).toBe("still uploading")
        controller.abort()
      }
      const error = await Promise.race([outcome, Bun.sleep(1_000).then(() => "still uploading")])
      expect(error).toBeInstanceOf(CursorLocalCancellationError)
    } finally {
      closeCachedHttp2SessionsForTests()
      if (opening) await failureOf(opening)
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  }, 15_000)
})
