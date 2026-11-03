import { afterAll, afterEach, beforeAll, expect, it } from "bun:test"
import fs from "node:fs/promises"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { createCursor } from "../src/index.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { mapAvailableModelsResponse, writeCache } from "../src/models.js"
import { setOfflineClockForTests } from "../src/offline.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { resetRetryBudgetsForTests } from "../src/retry-budget.js"
import { sessionManager } from "../src/session.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

// Opening a turn while offline: OpenCode ends the turn once doStream throws,
// so a setup failure caused by a dropped network is waited out inside it.

const origin = "https://agentn.offline-run-test.cursor.sh"
const proxyKeys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const savedProxy = new Map<string, string | undefined>()
let server: http2.Http2Server
let client: http2.ClientHttp2Session
let runs = 0

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

const reply = encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "ok" } } })
const turnEnded = encodeMessage("AgentServerMessage", {
  interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
})

beforeAll(async () => {
  for (const key of proxyKeys) {
    savedProxy.set(key, process.env[key])
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
        const message = decodeMessage<{ run_request?: unknown }>(
          "AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }),
        )
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        runs++
        stream.write(frame(reply))
        stream.write(frame(turnEnded))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server")
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
})

afterEach(async () => {
  await settleRunSavesForTests()
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationBindingsForTests()
  resetConversationPersistenceForTests()
  resetCheckpointsForTests()
  resetRetryBudgetsForTests()
  setOfflineClockForTests(undefined)
  setHostCacheDirOverride(undefined)
  runs = 0
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of proxyKeys) {
    const value = savedProxy.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const networkError = (code: string) => Object.assign(new Error(`getaddrinfo ${code} api2.cursor.sh`), { code })

async function withModel(
  getAccessToken: () => Promise<string>,
  run: (model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>) => Promise<void>,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-offline-run-"))
  try {
    const models = mapAvailableModelsResponse({ models: [{ name: "offline-fixture" }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
    cacheHttp2SessionForTests(origin, client)
    await run(createCursor({ name: "cursor", getAccessToken, cacheDir: directory, agentBaseURL: origin })
      .languageModel("offline-fixture"))
  } finally {
    await settleRunSavesForTests()
    sessionManager.dispose()
    setHostCacheDirOverride(undefined)
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const call = (signal?: AbortSignal) => ({
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
  tools: [{ type: "function" as const, name: "read", inputSchema: { type: "object" as const, properties: {} } }],
  headers: { "x-opencode-session-id": "ses_offline_run" },
  abortSignal: signal,
})

async function drain(stream: ReadableStream<{ type: string }>): Promise<string[]> {
  const types: string[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return types
    types.push(value.type)
  }
}

it("waits out an outage while opening the turn, beyond the transport budget", async () => {
  let calls = 0
  setOfflineClockForTests({ now: () => 0, sleep: async () => {} })
  await withModel(async () => {
    calls++
    if (calls <= 12) throw networkError("ENOTFOUND")
    return "example-token"
  }, async (model) => {
    const { stream } = await model.doStream(call())
    const types = await drain(stream)
    expect(types).toContain("finish")
    expect(types).not.toContain("error")
  })
  expect(calls).toBe(13)
  expect(runs).toBe(1)
})

it("leaves a refused connection while opening to the host retry", async () => {
  let calls = 0
  await withModel(async () => {
    calls++
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" })
  }, async (model) => {
    await expect(model.doStream(call())).rejects.toThrow("the Run could not start")
  })
  expect(calls).toBe(1)
  expect(runs).toBe(0)
})

it("stops waiting while opening the turn on Stop", async () => {
  const stop = new AbortController()
  let calls = 0
  setOfflineClockForTests({ now: () => 0, sleep: async () => { stop.abort(); throw new Error("Cursor retry cancelled") } })
  await withModel(async () => {
    calls++
    throw networkError("ENOTFOUND")
  }, async (model) => {
    await expect(model.doStream(call(stop.signal))).rejects.toThrow("Cursor retry cancelled")
  })
  expect(calls).toBe(1)
  expect(runs).toBe(0)
})
