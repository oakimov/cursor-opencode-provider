import { afterAll, afterEach, beforeAll, expect, it } from "bun:test"
import fs from "node:fs/promises"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { createCursor } from "../src/index.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { mapAvailableModelsResponse, writeCache } from "../src/models.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { decodeConversationTokenDetails } from "../src/protocol/token-details.js"
import { sessionManager } from "../src/session.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { withTempHostCache } from "./host-cache.js"

// The checkpoint that ends a Run cancelled for a plan handoff carries
// `used_tokens=0`. The next Run sends it; its prior occupancy (the cached
// prefix in host usage) must stay the last measured context, not zero.

const origin = "https://agentn.checkpoint-occupancy-test.cursor.sh"
const proxyKeys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const savedProxy = new Map<string, string | undefined>()
let server: http2.Http2Server
let client: http2.ClientHttp2Session
const sentStates: Array<Uint8Array | undefined> = []
const scripts: Uint8Array[][] = []

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

function checkpoint(usedTokens: number, marker: string): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    conversation_checkpoint_update: encodeMessage("ConversationStateStructure", {
      root_prompt_messages_json: [marker],
      token_details: { used_tokens: usedTokens, max_tokens: 256_000 },
    }),
  })
}

const turnEnded = encodeMessage("AgentServerMessage", {
  interaction_update: { turn_ended: { input_tokens: 50_000, output_tokens: 10, cache_read: 45_000 } },
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
        const message = decodeMessage<{ run_request?: { conversation_state?: Uint8Array } }>(
          "AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }),
        )
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        const state = message.run_request.conversation_state
        sentStates.push(state?.length ? Uint8Array.from(state) : undefined)
        for (const payload of scripts.shift() ?? [turnEnded]) stream.write(frame(payload))
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
  setHostCacheDirOverride(undefined)
  sentStates.length = 0
  scripts.length = 0
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

const reply = encodeMessage("AgentServerMessage", {
  interaction_update: { text_delta: { text: "ok" } },
})

async function finishOf(
  model: ReturnType<ReturnType<typeof createCursor>["languageModel"]>,
  prompt: any[],
): Promise<any> {
  // One advertised tool makes this a main Run rather than a lifecycle helper.
  const { stream } = await model.doStream({
    prompt,
    tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
    headers: { "x-opencode-session-id": "ses_checkpoint_occupancy" },
  })
  const reader = stream.getReader()
  let finish: any
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return finish
    expect(value.type).not.toBe("error")
    if (value.type === "finish") finish = value
  }
}

it.each([false, true])("keeps measured occupancy on a zero-token checkpoint (restart=%s)", async restart => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-checkpoint-occupancy-"))
  try {
    const models = mapAvailableModelsResponse({ models: [{ name: "occupancy-fixture" }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
    cacheHttp2SessionForTests(origin, client)
    const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: directory, agentBaseURL: origin })
      .languageModel("occupancy-fixture")

    scripts.push(
      [reply, checkpoint(40_000, "measured"), checkpoint(0, "terminal"), turnEnded],
      [reply, checkpoint(45_000, "next"), turnEnded],
    )
    const first = [{ role: "user", content: [{ type: "text", text: "first" }] }]
    const firstFinish = await finishOf(model, first)
    if (restart) {
      await settleRunSavesForTests()
      sessionManager.dispose()
      resetTurnStateForTests()
      resetConversationBindingsForTests()
      resetConversationPersistenceForTests()
      resetCheckpointsForTests()
    }
    const second = await finishOf(model, [
      ...first,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ])

    expect(sentStates).toHaveLength(2)
    expect(sentStates[0]).toBeUndefined()
    // The second Run echoes the zero-token terminal checkpoint byte for byte.
    expect(decodeConversationTokenDetails(sentStates[1])?.usedTokens).toBe(0)
    // With no occupancy to carry it, the first Run's output goes to the next turn-end.
    expect(firstFinish.usage.outputTokens.total).toBe(0)
    expect(second.usage.outputTokens.total).toBe(20)
    expect(second.usage.inputTokens.total).toBe(44_980)
    expect(second.usage.inputTokens.cacheRead).toBe(40_000)
  } finally {
    await settleRunSavesForTests()
    sessionManager.dispose()
    setHostCacheDirOverride(undefined)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

/** Complete synthetic prompt categories let the confirmation policy inspect density. */
function categorizedState(usedTokens: number, conversationChars: number, marker: string): Uint8Array {
  return encodeMessage("ConversationStateStructure", {
    root_prompt_messages_json: [marker],
    token_details: {
      used_tokens: usedTokens,
      max_tokens: 256_000,
      breakdown: {
        total_used_tokens: usedTokens,
        max_tokens: 256_000,
        categories: [
          { id: "system_prompt", label: "System prompt", estimated_tokens: 20_000, character_count: 80_000 },
          { id: "conversation", label: "Conversation", estimated_tokens: usedTokens - 20_000, character_count: conversationChars },
        ],
      },
    },
  })
}

const checkpointUpdate = (state: Uint8Array): Uint8Array => encodeMessage("AgentServerMessage", {
  conversation_checkpoint_update: state,
})

async function resetForRestart(): Promise<void> {
  await settleRunSavesForTests()
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationBindingsForTests()
  resetConversationPersistenceForTests()
  resetCheckpointsForTests()
}

type FixtureModel = ReturnType<ReturnType<typeof createCursor>["languageModel"]>

async function withOccupancyModel(run: (model: FixtureModel) => Promise<void>): Promise<void> {
  await withTempHostCache(async directory => {
    const models = mapAvailableModelsResponse({ models: [{ name: "occupancy-fixture" }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
    cacheHttp2SessionForTests(origin, client)
    const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: directory, agentBaseURL: origin })
      .languageModel("occupancy-fixture")
    try {
      await run(model)
    } finally {
      await settleRunSavesForTests()
      sessionManager.dispose()
    }
  })
}

it.each([false, true])("holds an unexplained terminal spike without changing the resumed checkpoint (restart=%s)", async restart => {
  await withOccupancyModel(async model => {
    const baseline = categorizedState(120_000, 400_000, "before-spike")
    const spike = categorizedState(240_000, 404_000, "unconfirmed-spike")
    const normal = categorizedState(121_000, 408_000, "normal-after-spike")
    scripts.push(
      [reply, checkpointUpdate(baseline), checkpointUpdate(spike), checkpointUpdate(spike), turnEnded],
      [reply, turnEnded],
      [reply, checkpointUpdate(normal), turnEnded],
    )
    const first = [{ role: "user", content: [{ type: "text", text: "first" }] }]
    const firstFinish = await finishOf(model, first)
    expect(firstFinish.usage.inputTokens.total + firstFinish.usage.outputTokens.total).toBe(120_000)
    expect(firstFinish.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-held-spike", stale: true, usedTokens: 120_000, rawUsedTokens: 240_000,
    })
    if (restart) await resetForRestart()
    const secondPrompt = [
      ...first,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]
    const second = await finishOf(model, secondPrompt)
    expect(second.usage.inputTokens.total + second.usage.outputTokens.total).toBe(120_000)
    expect(second.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-held-spike", stale: true, usedTokens: 120_000, rawUsedTokens: 240_000,
    })
    const third = await finishOf(model, [
      ...secondPrompt,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ])
    expect(third.usage.inputTokens.total + third.usage.outputTokens.total).toBe(121_000)
    expect(third.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-current-run", stale: false, usedTokens: 121_000,
    })
    expect(third.providerMetadata.cursor.context.rawUsedTokens).toBeUndefined()
    expect(sentStates).toHaveLength(3)
    expect(sentStates[0]).toBeUndefined()
    expect(sentStates[1]).toEqual(spike)
    expect(sentStates[2]).toEqual(spike)
    expect(decodeConversationTokenDetails(sentStates[1])?.usedTokens).toBe(240_000)
  })
})

it("retains a pending spike through a zero checkpoint and restart, then confirms an independent high reading", async () => {
  await withOccupancyModel(async model => {
    const baseline = categorizedState(120_000, 400_000, "before-zero")
    const spike = categorizedState(240_000, 404_000, "held-before-zero")
    const zero = checkpoint(0, "terminal-zero")
    const zeroState = decodeMessage<{ conversation_checkpoint_update: Uint8Array }>("AgentServerMessage", zero)
      .conversation_checkpoint_update
    scripts.push(
      [reply, checkpointUpdate(baseline), checkpointUpdate(spike), zero, turnEnded],
      [reply, turnEnded],
      [reply, checkpointUpdate(spike), checkpointUpdate(spike), turnEnded],
    )
    const first = [{ role: "user", content: [{ type: "text", text: "first" }] }]
    const firstFinish = await finishOf(model, first)
    // A terminal zero still reports empty usage; its separately saved guard survives.
    expect(firstFinish.usage.inputTokens.total + firstFinish.usage.outputTokens.total).toBe(0)
    expect(firstFinish.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-current-run", stale: false, usedTokens: 0,
    })
    await resetForRestart()
    const secondPrompt = [
      ...first,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]
    const second = await finishOf(model, secondPrompt)
    expect(second.usage.inputTokens.total + second.usage.outputTokens.total).toBe(120_000)
    expect(second.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-held-spike", stale: true, usedTokens: 120_000, rawUsedTokens: 240_000,
    })
    const third = await finishOf(model, [
      ...secondPrompt,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ])
    expect(third.usage.inputTokens.total + third.usage.outputTokens.total).toBe(240_000)
    expect(third.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-current-run", stale: false, usedTokens: 240_000,
    })
    expect(third.providerMetadata.cursor.context.rawUsedTokens).toBeUndefined()
    expect(sentStates).toHaveLength(3)
    expect(sentStates[1]).toEqual(zeroState)
    expect(sentStates[2]).toEqual(zeroState)
    expect(decodeConversationTokenDetails(sentStates[1])?.usedTokens).toBe(0)
  })
})

it("admits a large reading immediately when conversation characters grow with it", async () => {
  await withOccupancyModel(async model => {
    scripts.push([
      reply,
      checkpointUpdate(categorizedState(120_000, 400_000, "before-growth")),
      checkpointUpdate(categorizedState(240_000, 880_000, "large-real-growth")),
      turnEnded,
    ])
    const finish = await finishOf(model, [{ role: "user", content: [{ type: "text", text: "first" }] }])
    expect(finish.usage.inputTokens.total + finish.usage.outputTokens.total).toBe(240_000)
    expect(finish.providerMetadata.cursor.context).toMatchObject({
      source: "checkpoint-current-run", stale: false, usedTokens: 240_000,
    })
    expect(finish.providerMetadata.cursor.context.rawUsedTokens).toBeUndefined()
  })
})
