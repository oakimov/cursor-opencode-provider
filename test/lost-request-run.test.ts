import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { seedText } from "./seed-text.js"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetLostRequestsForTests } from "../src/lost-request.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"

const ORIGIN = "https://agentn.lost-request-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
// Every Run streams some text, then fails before Cursor sends a checkpoint.
const PARTIAL = "partial answer"
const FAILURE = { error: { code: "invalid_argument" } }

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let sentTexts: string[] = []
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
        const message = decodeMessage<Record<string, any>>("AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }))
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        sentTexts.push(seedText(message.run_request.action?.user_message_action))
        stream.write(frame(encodeMessage("AgentServerMessage", {
          interaction_update: { text_delta: { text: PARTIAL } },
        })))
        stream.write(frame(Buffer.from(JSON.stringify(FAILURE)), 2))
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
  resetLostRequestsForTests()
  sentTexts = []
})

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as LanguageModelV3Prompt[number]
// What the host keeps of the failed turn: the text it had read.
const partial = { role: "assistant", content: [{ type: "text", text: PARTIAL }] } as LanguageModelV3Prompt[number]

async function failedTurn(root: string, sessionKey: string, prompt: LanguageModelV3Prompt): Promise<void> {
  cacheHttp2SessionForTests(ORIGIN, client)
  const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root })
    .languageModel("composer-2.5")
  try {
    const { stream } = await model.doStream({
      prompt,
      // A tool-less call is a lifecycle Run (title), which never records a lost request.
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    // Expected: every Run fails before a checkpoint.
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe("lost request through startSession", () => {
  it("prepends a request Cursor never checkpointed to the next turn on the same checkpoint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lost-run-"))
    try {
      restoreConversationBinding("ses_lost_checkpoint", "conv-lost-checkpoint")
      // ConversationStateStructure{root_prompt_messages_json: ["x"]}
      setCheckpoint("conv-lost-checkpoint", Uint8Array.from([0x0a, 0x01, 0x78]))
      await failedTurn(root, "ses_lost_checkpoint", [user("first request")])
      await failedTurn(root, "ses_lost_checkpoint", [user("first request"), partial, user("second request")])

      expect(sentTexts).toHaveLength(2)
      expect(sentTexts[1]).toContain("first request\n\nsecond request")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("keeps a request Cursor never checkpointed across a restart after the failed turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lost-run-"))
    try {
      restoreConversationBinding("ses_lost_restart", "conv-lost-restart")
      setCheckpoint("conv-lost-restart", Uint8Array.from([0x0a, 0x01, 0x78]))
      await failedTurn(root, "ses_lost_restart", [user("first request")])

      // Everything in memory is gone; only the conversation snapshot remains.
      sessionManager.dispose()
      resetTurnStateForTests()
      resetLostRequestsForTests()
      resetConversationBindingsForTests()
      resetCheckpointsForTests()
      resetConversationBlobsForTests()
      resetConversationPersistenceForTests()
      resetFrozenRequestContextsForTests()
      await failedTurn(root, "ses_lost_restart", [user("first request"), partial, user("second request")])

      expect(sentTexts).toHaveLength(2)
      expect(sentTexts[1]).not.toContain("<conversation_history>")
      expect(sentTexts[1]).toContain("first request\n\nsecond request")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("sends the request once after host retries that keep failing on the same checkpoint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lost-run-"))
    // OpenCode 2 adds this note as a user message before each retry of an interrupted response.
    const note = user("The previous response was interrupted. Continue from where you left off without repeating completed content.")
    try {
      restoreConversationBinding("ses_lost_retries", "conv-lost-retries")
      setCheckpoint("conv-lost-retries", Uint8Array.from([0x0a, 0x01, 0x78]))
      const prompt: LanguageModelV3Prompt = [user("first request")]
      await failedTurn(root, "ses_lost_retries", prompt)
      for (let attempt = 0; attempt < 3; attempt++) {
        prompt.push(partial, note)
        await failedTurn(root, "ses_lost_retries", [...prompt])
      }
      prompt.push(partial, user("second request"))
      await failedTurn(root, "ses_lost_retries", prompt)

      const last = sentTexts.at(-1)!
      expect(sentTexts).toHaveLength(5)
      expect(occurrences(last, "first request")).toBe(1)
      expect(occurrences(last, "The previous response was interrupted.")).toBe(1)
      expect(last).toContain("second request")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("keeps a request the user repeats after a different one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lost-run-"))
    try {
      restoreConversationBinding("ses_lost_repeat", "conv-lost-repeat")
      setCheckpoint("conv-lost-repeat", Uint8Array.from([0x0a, 0x01, 0x78]))
      const prompt: LanguageModelV3Prompt = [user("Use red")]
      await failedTurn(root, "ses_lost_repeat", prompt)
      prompt.push(partial, user("Use blue"))
      await failedTurn(root, "ses_lost_repeat", [...prompt])
      prompt.push(partial, user("Use red"))
      await failedTurn(root, "ses_lost_repeat", prompt)

      expect(sentTexts).toHaveLength(3)
      expect(sentTexts[2]).toContain("Use red\n\nUse blue\n\nUse red")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("does not prepend a request that the seeded host history already carries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lost-run-"))
    try {
      await failedTurn(root, "ses_lost_seeded", [user("first request")])
      await failedTurn(root, "ses_lost_seeded", [user("first request"), partial, user("second request")])

      expect(sentTexts).toHaveLength(2)
      expect(sentTexts[1]).toContain("<conversation_history>")
      expect(occurrences(sentTexts[1]!, "first request")).toBe(1)
      expect(sentTexts[1]).not.toContain("first request\n\nsecond request")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
