/**
 * OpenCode 2 steers injected while Cursor works on a step, through the real provider against a
 * local HTTP/2 server that plays Cursor's Run endpoint. No network access.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { buildHeartbeat } from "../src/protocol/request.js"
import { resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests, lastFrameArrival } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager, type CursorSession } from "../src/session.js"
import { resetTurnProvenanceForTests } from "../src/protocol/turn-provenance.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { getPersistedConversation, resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { decodePersistedHostNotes } from "../src/protocol/host-notes.js"
import { writeStreamMessage } from "../src/stream-write.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import {
  announceHostSteer,
  forgetEarlySteerOfInbox,
  forgetUndeliveredEarlySteer,
  handOverEarlySteers,
  listenForHostSteers,
  markEarlySteersCheckpointed,
  matchEarlySteers,
  recordEarlySteer,
  restoreEarlySteers,
  serializeEarlySteers,
  settleEarlySteers,
  type EarlySteer,
  type HostSteer,
} from "../src/host-steer.js"

type Prompt = LanguageModelV3CallOptions["prompt"]
type ClientMessage = Record<string, any>

const ORIGIN = "https://agentn.early-steer-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const CHECKPOINT = Uint8Array.from([0x0a, 0x00])

type FakeRun = {
  received: ClientMessage[]
  send(message: Record<string, unknown>): void
  /** An `AgentServerMessage` built from independent bytes. */
  sendRaw(payload: Uint8Array): void
  end(error?: string): void
}

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let onRun: (run: FakeRun, message: ClientMessage) => void = () => {}
const runs: FakeRun[] = []
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
    const run: FakeRun = {
      received: [],
      send: (message) => {
        if (!stream.destroyed && !stream.closed) stream.write(frame(encodeMessage("AgentServerMessage", message)))
      },
      sendRaw: (payload) => {
        if (!stream.destroyed && !stream.closed) stream.write(frame(payload))
      },
      end: (error) => {
        if (error) stream.write(frame(Buffer.from(JSON.stringify({ error: { code: error } })), 2))
        stream.end()
      },
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

afterEach(() => {
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetToolRequestsListedSeenForTests()
  runs.length = 0
  onRun = () => {}
})

const readTool: NonNullable<LanguageModelV3CallOptions["tools"]> = [{
  type: "function",
  name: "read",
  description: "Read a file from the local filesystem.",
  inputSchema: {
    type: "object",
    properties: { filePath: { type: "string" } },
    required: ["filePath"],
    additionalProperties: false,
  },
}]

type Model = ReturnType<ReturnType<typeof createCursor>["languageModel"]>

async function collect(model: Model, prompt: Prompt, sessionKey: string, tools = readTool) {
  const { stream } = await model.doStream({
    prompt,
    tools,
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

const failure = (pending: Promise<unknown>) => pending.then(() => undefined, (error: Error) => error)
const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts.filter((part) => part.type === "text-delta").map((part) => (part as { delta: string }).delta).join("")
const injectionsOf = (run: FakeRun) =>
  run.received.map((message) => message.conversation_action?.inject_context_action).filter(Boolean)
const userText = (run: FakeRun) => run.received[0]!.run_request.action.user_message_action.user_message.text as string
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as Prompt[number]
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as Prompt[number]
const ask = user("Wait for the background job.")
const NOTE = "Instructions for the following MCP servers are available."
const note = user(`<system-update>\n${NOTE}\n</system-update>`)

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Cursor starts a step that waits on its own side (AwaitShell on a background shell). */
function startWaitingStep(run: FakeRun, text = "Waiting for the job."): void {
  run.send({ interaction_update: { text_delta: { text } } })
  run.send({ conversation_checkpoint_update: CHECKPOINT })
  run.send({ interaction_update: { tool_call_started: {
    call_id: "await-1", tool_call: { tool_call_id: "await-1", await_tool_call: { args: { task_id: "7", block_until_ms: 120_000 } } },
  } } })
}

function injectionState(run: FakeRun, injectionId: string, state: "queued" | "delivered"): void {
  run.send({ interaction_update: { context_injection_state: {
    injection_id: injectionId, state: state === "queued" ? { queued: {} } : { delivered: { step: 2 } },
  } } })
}

function lengthDelimited(field: number, bytes: Uint8Array): number[] {
  const varint = (value: number) => {
    const out: number[] = []
    for (; value >= 0x80; value >>>= 7) out.push((value & 0x7f) | 0x80)
    return [...out, value]
  }
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]
}

/**
 * Cursor's `user_message_appended` echo of a delivered injection (#159), from independent bytes:
 * InteractionUpdate #6 → user_message #1 → text #1, message_id #2, a flag and two timestamps (#24–#26).
 */
function appendedEcho(text: string, messageId: string): Uint8Array {
  const message = Uint8Array.from([
    ...lengthDelimited(1, Buffer.from(text)), ...lengthDelimited(2, Buffer.from(messageId)),
    0xc0, 0x01, 0x01, 0xc8, 0x01, 0x05, 0xd0, 0x01, 0x06,
  ])
  return Uint8Array.from(lengthDelimited(1, Uint8Array.from(lengthDelimited(6, Uint8Array.from(lengthDelimited(1, message))))))
}

function endTurn(run: FakeRun, text: string): void {
  run.send({ interaction_update: { text_delta: { text } } })
  run.send({ conversation_checkpoint_update: CHECKPOINT })
  run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
}

function answerSteer(run: FakeRun, injectionId: string): void {
  injectionState(run, injectionId, "delivered")
  endTurn(run, "STEERED")
}

let inboxSeq = 0
const steer = (sessionID: string, text: string): HostSteer => ({ sessionID, inboxID: `msg_steer_${++inboxSeq}`, text })

function pumping(sessionKey: string): CursorSession | undefined {
  const session = sessionManager.findOpenByOpenCodeSessionId(sessionKey)
  return session && sessionManager.isActivelyPumping(session) ? session : undefined
}

async function withModel(
  name: string,
  body: (model: Model, cacheDir: string) => Promise<void>,
  getAccessToken?: () => Promise<string>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cursor-early-steer-${name}-`))
  cacheHttp2SessionForTests(ORIGIN, client)
  try {
    await body(createCursor({
      name: "cursor", agentBaseURL: ORIGIN, cacheDir: root,
      ...(getAccessToken ? { getAccessToken } : { accessToken: "example-token" }),
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    }).languageModel("composer-2.5"), root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The first Run of `sessionKey` waits on Cursor's side. `inject` answers a steer injected into it;
 * `next` gets every other message, and the Runs that follow.
 */
async function waitingRun(model: Model, sessionKey: string, handlers: {
  inject?: (run: FakeRun, injectionId: string) => void
  next?: (run: FakeRun, message: ClientMessage) => void
} = {}) {
  let waiting = false
  onRun = (run, message) => {
    if (message.run_request && runs.indexOf(run) === 0) {
      startWaitingStep(run)
      waiting = true
    } else if (message.conversation_action?.inject_context_action) {
      handlers.inject?.(run, message.conversation_action.inject_context_action.injection_id)
    } else {
      handlers.next?.(run, message)
    }
  }
  const first = collect(model, [ask], sessionKey)
  first.catch(() => {})
  await waitFor(() => waiting && !!pumping(sessionKey), "the waiting Run")
  return {
    first,
    session: pumping(sessionKey)!,
    announce(text: string): HostSteer {
      const message = steer(sessionKey, text)
      expect(announceHostSteer(message)).toBe(true)
      return message
    },
  }
}

/** The next write on `stream` is a large reply that keeps draining until `release`. */
function blockBehindDrainingReply(stream: CursorSession["stream"]) {
  const write = stream.write.bind(stream)
  const written: Uint8Array[] = []
  let blocked = true
  stream.write = (chunk: Uint8Array) => {
    written.push(chunk)
    write(chunk)
    const accepted = !blocked
    blocked = false
    return accepted
  }
  let drained!: () => void
  const drain = new Promise<void>((resolve) => { drained = resolve })
  stream.waitForDrain = async () => { await drain }
  const largeReply = writeStreamMessage(stream, buildHeartbeat(), "large reply")
  const injected = () => written.some((chunk) =>
    decodeMessage<ClientMessage>("AgentClientMessage", chunk).conversation_action?.inject_context_action)
  return { injected, release: async () => { drained(); await largeReply } }
}

/** The step after Cursor's read: its result, then OpenCode's copy of the steer. */
function readStep(call: { toolCallId: string; input: string }, file: string, steerText: string): Prompt {
  return [
    ask,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "read", input: JSON.parse(call.input) }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "read", output: { type: "text", value: `Read file ${file}, lines 1-1\n1: alpha` } }] },
    user(steerText),
  ] as Prompt
}

/** Cursor answers a steer injected into the waiting Run by reading `file`, an OpenCode tool. */
function readOnSteer(file: string) {
  return (run: FakeRun, injectionId: string) => {
    injectionState(run, injectionId, "queued")
    run.send({ exec_server_message: { id: 1, exec_id: "exec-1", read_args: { path: file, tool_call_id: "tc-1" } } })
  }
}

const readCall = (parts: LanguageModelV3StreamPart[]) =>
  parts.find((part) => part.type === "tool-call") as { toolCallId: string; input: string }

function probeFile(dir: string): string {
  const file = path.join(dir, "probe.txt")
  fs.writeFileSync(file, "alpha\n")
  return file
}

describe("Greptile receipt matching regressions", () => {
  for (const mode of ["taken", "not taken", "mixed follow-up"] as const) {
    for (const restart of [false, true]) {
      it(`delivers identical new requests after promotion (${mode}, ${restart ? "restart" : "same process"})`, async () => {
        await withModel(`promotion-scope-${mode.replaceAll(" ", "-")}-${restart}`, async (model, cacheDir) => {
          const sessionKey = `ses_promotion_scope_${mode}_${restart}`
          const file = probeFile(cacheDir)
          let injectionId = ""
          const { first, announce } = await waitingRun(model, sessionKey, {
            inject: (run, id) => { injectionId = id; readOnSteer(file)(run, id) },
            next: (run, message) => {
              if (message.exec_client_message?.read_result) {
                if (mode !== "not taken") injectionState(run, injectionId, "delivered")
                endTurn(run, "Read complete.")
              } else if (message.run_request) endTurn(run, "FOLLOWUP_COMPLETE")
            },
          })
          const early = announce("REPEATABLE_PROMOTED_STEER")
          const step = readStep(readCall(await first), file, early.text)
          const repeated = mode === "mixed follow-up" ? "REPEATABLE_FOLLOWUP" : early.text
          if (mode === "mixed follow-up") step.push(user(repeated))
          const answer = textOf(await collect(model, step, sessionKey))
          const countBefore = runs.length
          if (restart) {
            coldMemory()
            cacheHttp2SessionForTests(ORIGIN, client)
            model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir }).languageModel("composer-2.5")
          }
          onRun = (run, message) => { if (message.run_request) endTurn(run, "NEW_REQUEST_ANSWERED") }
          expect(textOf(await collect(model, [...step, assistant(answer), user(repeated)], sessionKey))).toBe("NEW_REQUEST_ANSWERED")
          expect(runs).toHaveLength(countBefore + 1)
          expect(userText(runs.at(-1)!)).toContain(repeated)
          const original = runs[0]!.received[0]!.run_request
          const next = runs.at(-1)!.received[0]!.run_request
          expect(next.conversation_id).toBe(original.conversation_id)
          expect(next.conversation_state).toEqual(CHECKPOINT)
          expect(next.action.user_message_action.request_context).toEqual(original.action.user_message_action.request_context)
        })
      }, 30_000)
    }
  }

  for (const kind of ["image", "image only", "tool media", "same words with image"] as const) {
    for (const copyFirst of [false, true]) {
      for (const restart of [false, true]) {
        it(`removes an answered copy beside ${kind} (${copyFirst ? "copy first" : "copy last"}, ${restart ? "restart" : "same process"})`, async () => {
          await withModel(`attachment-copy-${kind.replaceAll(" ", "-")}-${copyFirst}-${restart}`, async (model, cacheDir) => {
            const sessionKey = `ses_attachment_copy_${kind}_${copyFirst}_${restart}`
            const { first, announce } = await waitingRun(model, sessionKey, { inject: answerSteer })
            const early = announce("ANSWERED_REQUEST_WITH_IMAGE_NEIGHBOR")
            const answer = textOf(await first)
            const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
            const text = kind === "same words with image" ? early.text : "DESCRIBE_NEW_ATTACHMENT"
            const attached: Prompt[number] = {
              role: "user",
              content: [
                ...(kind === "image only" ? [] : [{ type: "text" as const, text: kind === "tool media" ? "Attached media from tool result:" : text }]),
                { type: "file", mediaType: "image/png", filename: "receipt-test.png", data: bytes },
              ],
            }
            const tail = copyFirst ? [user(early.text), attached] : [attached, user(early.text)]
            if (restart) {
              coldMemory()
              cacheHttp2SessionForTests(ORIGIN, client)
              model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir }).languageModel("composer-2.5")
            }
            onRun = (run, message) => { if (message.run_request) endTurn(run, "ATTACHMENT_ANSWERED") }
            const result = await collect(model, [ask, assistant(answer), ...tail], sessionKey)
            expect(textOf(result)).toBe("ATTACHMENT_ANSWERED")
            const sent = userText(runs.at(-1)!)
            expect(sent.split(early.text).length - 1).toBe(kind === "same words with image" ? 1 : 0)
            if (kind === "image") expect(sent).toContain(text)
            const images = runs.at(-1)!.received[0]!.run_request.action.user_message_action.user_message.selected_context?.selected_images
            expect(images).toHaveLength(1)
            expect(Uint8Array.from(images[0].data)).toEqual(bytes)
            const original = runs[0]!.received[0]!.run_request
            const next = runs.at(-1)!.received[0]!.run_request
            expect(next.conversation_id).toBe(original.conversation_id)
            expect(next.conversation_state).toEqual(CHECKPOINT)
            expect(next.action.user_message_action.request_context).toEqual(original.action.user_message_action.request_context)
          })
        }, 30_000)
      }
    }
  }
})

describe("host steer registry", () => {
  const record = (overrides: Partial<EarlySteer> & { text: string }): EarlySteer => {
    const steer: EarlySteer = {
      sessionID: "ses_registry", inboxID: `msg_${++inboxSeq}`, injectionId: `inj_${inboxSeq}`, run: "run_a",
      delivered: false, checkpointed: false, answered: false, ...overrides,
    }
    recordEarlySteer(steer)
    return steer
  }
  afterEach(() => resetTurnStateForTests())

  it("hands a steer once, and only to the listener of its session", () => {
    const seen: string[] = []
    const stop = listenForHostSteers("ses_registry", (s) => { seen.push(s.text); return true })
    expect(announceHostSteer(steer("ses_other", "elsewhere"))).toBe(false)
    const early = steer("ses_registry", "early")
    expect(announceHostSteer(early)).toBe(true)
    expect(announceHostSteer({ ...early })).toBeUndefined()
    stop()
    expect(announceHostSteer(steer("ses_registry", "late"))).toBe(false)
    expect(seen).toEqual(["early"])
  })

  it("matches a promoted copy with host reminders but not a message that only contains the text", () => {
    const a = record({ text: "also check 3.ts" })
    record({ text: "then stop" })
    const reminder = "<system-reminder>\nKeep answers short.\n</system-reminder>"
    expect(matchEarlySteers("ses_registry", [`also check 3.ts\n${reminder}`, `${reminder}\nthen stop`], () => true)).toHaveLength(2)
    expect(matchEarlySteers("ses_registry", ["please\nthen stop"], () => true)).toEqual([])
    expect(matchEarlySteers("ses_registry", ["also check 3.ts", "unrelated"], () => true)).toEqual([])
    expect(matchEarlySteers("ses_registry", ["also check 3.ts", "also check 3.ts"], () => true)).toEqual([])
    expect(matchEarlySteers("ses_registry", ["also check 3.ts"], (r) => r === a)).toEqual([a])
  })

  it("forgets an injection Cursor never accepted, but not one it delivered or one OpenCode no longer holds", () => {
    const lost = record({ text: "lost" })
    const delivered = record({ text: "delivered", delivered: true })
    const promoted = record({ text: "promoted", promoted: true })
    for (const steer of [lost, delivered, promoted]) forgetUndeliveredEarlySteer("ses_registry", steer.injectionId)
    expect(matchEarlySteers("ses_registry", ["lost"], () => true)).toEqual([])
    expect(matchEarlySteers("ses_registry", ["delivered"], () => true)).toEqual([delivered])
    expect(settleEarlySteers("ses_registry", "run_a").undelivered).toEqual([promoted])
  })

  it("refuses a new session rather than dropping another session's steers when many are tracked", () => {
    const first = record({ sessionID: "ses_many_0", text: "answered", delivered: true, answered: true })
    for (let i = 1; i < 256; i++) record({ sessionID: `ses_many_${i}`, text: "steer" })
    expect(recordEarlySteer({ ...first, sessionID: "ses_many_256", inboxID: "msg_257", injectionId: "inj_257" })).toBe(false)
    expect(recordEarlySteer({ ...first, inboxID: "msg_same", injectionId: "inj_same", text: "same session" })).toBe(true)
    expect(matchEarlySteers("ses_many_0", ["answered"], (r) => r.answered)).toEqual([first])
  })

  it("moves to a resumed Run only the steers its checkpoint holds, and promoted ones", () => {
    const held = record({ text: "held", delivered: true })
    markEarlySteersCheckpointed("ses_registry", "run_a")
    const late = record({ text: "delivered after the checkpoint", delivered: true })
    const promoted = record({ text: "promoted", promoted: true })
    const queued = record({ text: "queued" })
    handOverEarlySteers("ses_registry", "run_a", "run_b")
    expect([held.run, promoted.run]).toEqual(["run_b", "run_b"])
    expect(held.delivered).toBe(true)
    expect(promoted.delivered).toBe(false)
    expect(matchEarlySteers("ses_registry", [late.text], () => true)).toEqual([])
    expect(matchEarlySteers("ses_registry", [queued.text], () => true)).toEqual([])
    handOverEarlySteers("ses_registry", "run_b", undefined)
    expect(matchEarlySteers("ses_registry", ["held"], () => true)).toEqual([])
  })
})

describe("a steer sent while Cursor waits inside a step", () => {
  it("is injected into the waiting Run, answered there, and needs no Run for OpenCode's copy", async () => {
    await withModel("inject", async (model) => {
      const sessionKey = "ses_early_inject"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => {
          injectionState(run, id, "queued")
          answerSteer(run, id)
        },
      })
      const message = announce("Stop waiting and say STEERED.")
      expect(textOf(await first)).toBe("Waiting for the job.\n\nSTEERED")
      expect(runs).toHaveLength(1)
      const injections = injectionsOf(runs[0]!)
      expect(injections).toHaveLength(1)
      expect(injections[0].expected_run_id).toBe(runs[0]!.received[0]!.run_request.run_id)
      expect(injections[0].user_context.user_message.text).toBe(message.text)

      // A tool-less helper Run of the session (a title) in between does not forget the answered steer.
      onRun = (run, next) => { if (next.run_request) endTurn(run, "A title") }
      await collect(model, [user("Write a title for this conversation.")], sessionKey, [])
      expect(runs).toHaveLength(2)

      const answered = [ask, assistant("Waiting for the job.\n\nSTEERED"), user(message.text)]
      const promotion = await collect(model, answered, sessionKey)
      expect(runs).toHaveLength(2)
      expect(textOf(promotion)).toBe("")
      expect(promotion.some((part) => part.type === "finish")).toBe(true)

      // The record is spent: the same words later are a new message.
      onRun = (run, next) => { if (next.run_request) endTurn(run, "Again.") }
      expect(textOf(await collect(model, [...answered, assistant("ok"), user(message.text)], sessionKey))).toBe("Again.")
      expect(runs).toHaveLength(3)
    })
  }, 30_000)

  it("needs no Run for an answered steer's copy that comes with a host note, and carries the note to the next turn", async () => {
    await withModel("note", async (model, cacheDir) => {
      const sessionKey = "ses_early_note"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: answerSteer,
        next: (run, message) => { if (message.run_request) endTurn(run, "Next answer.") },
      })
      const message = announce("Stop waiting and say STEERED.")
      await first
      const promoted = [ask, assistant("Waiting for the job.\n\nSTEERED"), note, user(message.text)]
      expect(textOf(await collect(model, promoted, sessionKey))).toBe("")
      expect(runs).toHaveLength(1)
      // A restart before the next turn still has the note.
      const saved = await getPersistedConversation(cacheDir, sessionKey)
      expect(decodePersistedHostNotes(saved?.hostNote).join("\n")).toContain(NOTE)
      await collect(model, [...promoted, assistant(""), user("And now?")], sessionKey)
      expect(runs).toHaveLength(2)
      const text = userText(runs[1]!)
      expect(text).toContain(`<system_reminder>\n${NOTE}\n</system_reminder>`)
      expect(text).toContain("And now?")
      expect(text).not.toContain(message.text)
    })
  }, 30_000)

  it("leaves an answered steer's copy out of a step that also brings a new message", async () => {
    await withModel("mixed", async (model) => {
      const sessionKey = "ses_early_mixed"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: answerSteer,
        next: (run, message) => { if (message.run_request) endTurn(run, "About the other question.") },
      })
      const message = announce("Stop waiting and say STEERED.")
      await first
      const next = await collect(model, [
        ask, assistant("Waiting for the job.\n\nSTEERED"), user("First."), user("Another question."), note, user(message.text),
      ], sessionKey)
      expect(textOf(next)).toBe("About the other question.")
      const text = userText(runs[1]!)
      expect(text).toContain("Another question.")
      expect(text).toContain(NOTE)
      expect(text).not.toContain(message.text)
    })
  }, 30_000)

  it("still leaves an answered steer's copy out when the step is retried after its Run failed to open", async () => {
    let refuseToken = false
    await withModel("retry", async (model) => {
      const sessionKey = "ses_early_retry"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: answerSteer,
        next: (run, message) => { if (message.run_request) endTurn(run, "About the other question.") },
      })
      const message = announce("Stop waiting and say STEERED.")
      await first
      const step = [ask, assistant("Waiting for the job.\n\nSTEERED"), user("Another question."), user(message.text)]
      refuseToken = true
      expect(await failure(collect(model, step, sessionKey))).toBeInstanceOf(Error)
      refuseToken = false
      expect(textOf(await collect(model, step, sessionKey))).toBe("About the other question.")
      const text = userText(runs.at(-1)!)
      expect(text).toContain("Another question.")
      expect(text).not.toContain(message.text)
    }, async () => {
      if (refuseToken) throw new Error("login expired")
      return "example-token"
    })
  }, 30_000)

  it("does not swallow a later message with the same words when the host withdrew its copy", async () => {
    await withModel("withdrawn", async (model) => {
      const sessionKey = "ses_early_withdrawn"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: answerSteer,
        next: (run, message) => { if (message.run_request) endTurn(run, "A new answer.") },
      })
      const message = announce("yes")
      await first
      forgetEarlySteerOfInbox(sessionKey, message.inboxID)
      const later = await collect(model, [ask, assistant("Waiting for the job.\n\nSTEERED"), user("yes")], sessionKey)
      expect(textOf(later)).toBe("A new answer.")
      expect(runs).toHaveLength(2)
    })
  }, 30_000)

  it("keeps a steer whose write was buffered before a failed drain, so a resumed Run still answers it once", async () => {
    await withModel("drain-failure", async (model) => {
      const sessionKey = "ses_early_drain_failure"
      const { first, session, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => setTimeout(() => {
          injectionState(run, id, "delivered")
          run.send({ interaction_update: { text_delta: { text: "STEER" } } })
          run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x01, 0x32]) })
          run.end()
        }, 20),
        next: (run, message) => { if (message.run_request) endTurn(run, "ED") },
      })
      const write = session.stream.write.bind(session.stream)
      session.stream.write = (chunk: Uint8Array) => {
        write(chunk)
        return !decodeMessage<ClientMessage>("AgentClientMessage", chunk).conversation_action?.inject_context_action
      }
      session.stream.waitForDrain = async () => { throw new Error("drain timed out") }
      const message = announce("Stop waiting and say STEERED.")
      const answer = textOf(await first)
      expect(runs).toHaveLength(2)
      expect(textOf(await collect(model, [ask, assistant(answer), user(message.text)], sessionKey))).toBe("")
      expect(runs).toHaveLength(2)
    })
  }, 30_000)

  it("waits behind a reply that is still draining instead of writing past it", async () => {
    await withModel("backpressure", async (model) => {
      const { first, session, announce } = await waitingRun(model, "ses_early_backpressure", { inject: answerSteer })
      const blocked = blockBehindDrainingReply(session.stream)
      announce("Stop waiting.")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(blocked.injected()).toBe(false)
      await blocked.release()
      await waitFor(blocked.injected, "the injection after the drain")
      expect(textOf(await first)).toBe("Waiting for the job.\n\nSTEERED")
    })
  }, 30_000)

  it("is not written when the host withdraws it while it waits behind a draining reply", async () => {
    await withModel("withdrawn-while-blocked", async (model) => {
      const sessionKey = "ses_early_withdrawn_blocked"
      const { first, session, announce } = await waitingRun(model, sessionKey)
      const blocked = blockBehindDrainingReply(session.stream)
      forgetEarlySteerOfInbox(sessionKey, announce("Never mind.").inboxID)
      await blocked.release()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(injectionsOf(runs[0]!)).toEqual([])
      endTurn(runs[0]!, " Done.")
      await first
    })
  }, 30_000)

  it("is not written to a Run that replaced the one it was meant for while it waited", async () => {
    await withModel("replaced-while-blocked", async (model) => {
      const { first, session, announce } = await waitingRun(model, "ses_early_replaced_blocked")
      const blocked = blockBehindDrainingReply(session.stream)
      announce("Too late for this Run.")
      const runId = session.runId
      session.runId = "run-of-a-follow-up"
      await blocked.release()
      await new Promise((resolve) => setTimeout(resolve, 50))
      session.runId = runId
      expect(injectionsOf(runs[0]!)).toEqual([])
      endTurn(runs[0]!, " Done.")
      await first
    })
  }, 30_000)

  it("rebuilds the retried turn from host history when the Run drops after Cursor checkpointed a steer and recovery fails", async () => {
    let refuseToken = false
    await withModel("recovery-fails", async (model) => {
      const sessionKey = "ses_early_recovery_fails"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => {
          injectionState(run, id, "delivered")
          run.send({ interaction_update: { text_delta: { text: "STEER" } } })
          run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x01, 0x34]) })
          refuseToken = true
          run.end()
        },
        next: (run, message) => { if (message.run_request) endTurn(run, "Answered once.") },
      })
      const message = announce("Stop waiting and say STEERED.")
      expect(await failure(first)).toBeInstanceOf(Error)
      refuseToken = false
      await collect(model, [ask, user(message.text)], sessionKey)
      const request = runs.at(-1)!.received[0]!.run_request
      expect(request.conversation_state.length > 0 && userText(runs.at(-1)!).includes(message.text)).toBe(false)
    }, async () => {
      if (refuseToken) throw new Error("login expired")
      return "example-token"
    })
  }, 30_000)

  it("rebuilds the retried step from host history when a promoted steer's Run drops after its checkpoint and recovery fails", async () => {
    let refuseToken = false
    await withModel("promoted-recovery-fails", async (model, cacheDir) => {
      const heldSteer = Buffer.from([0x0a, 0x01, 0x36])
      const rebuilt = Uint8Array.from([0x0a, 0x01, 0x37])
      const file = probeFile(cacheDir)
      const sessionKey = "ses_early_promoted_recovery_fails"
      let injectionId = ""
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => {
          injectionId = id
          readOnSteer(file)(run, id)
        },
        next: (run, message) => {
          if (message.exec_client_message?.read_result) {
            injectionState(run, injectionId, "delivered")
            run.send({ interaction_update: { text_delta: { text: "STEER" } } })
            run.send({ conversation_checkpoint_update: heldSteer })
            refuseToken = true
            run.end()
          } else if (message.run_request) {
            run.send({ interaction_update: { text_delta: { text: "Answered once." } } })
            run.send({ conversation_checkpoint_update: rebuilt })
            run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
          }
        },
      })
      const message = announce("Then read probe.txt and say STEERED.")
      const step = readStep(readCall(await first), file, message.text)
      expect(await failure(collect(model, step, sessionKey))).toBeInstanceOf(Error)
      refuseToken = false
      await collect(model, step, sessionKey)
      const original = runs[0]!.received[0]!.run_request
      const retried = runs.at(-1)!.received[0]!.run_request
      const resumed = Uint8Array.from(retried.conversation_state ?? [])
      const sent = userText(runs.at(-1)!)
      expect(resumed).toEqual(new Uint8Array())
      // The checkpoint taken after Cursor took the steer holds it as one copy.
      const copies = sent.split(message.text).length - 1 + (Buffer.from(resumed).equals(heldSteer) ? 1 : 0)
      expect(copies).toBe(1)
      expect(sent).toContain(`Read file ${file}, lines 1-1\n1: alpha`)
      expect(retried.action.user_message_action.request_context).toEqual(original.action.user_message_action.request_context)

      await collect(model, [...step, assistant("Answered once."), user("And then?")], sessionKey)
      const next = runs.at(-1)!.received[0]!.run_request
      expect(next.conversation_id).toBe(retried.conversation_id)
      expect(Uint8Array.from(next.conversation_state)).toEqual(rebuilt)
    }, async () => {
      if (refuseToken) throw new Error("login expired")
      return "example-token"
    })
  }, 30_000)

  for (const promoted of [true, false]) {
    it(`rebuilds a drop after the step's result past the steer's echo only once OpenCode promoted it (promoted: ${promoted})`, async () => {
      await withModel(`echo-rebuild-${promoted}`, async (model, cacheDir) => {
        const file = probeFile(cacheDir)
        const sessionKey = `ses_early_echo_rebuild_${promoted}`
        let ready = false
        onRun = (run, message) => {
          const injection = message.conversation_action?.inject_context_action
          if (message.run_request && runs.indexOf(run) === 0) {
            // Cursor works on its step without announcing a call of its own.
            run.send({ conversation_checkpoint_update: CHECKPOINT })
            ready = true
          } else if (injection) {
            readOnSteer(file)(run, injection.injection_id)
          } else if (message.exec_client_message?.read_result) {
            const injected = run.received.find((received) => received.conversation_action?.inject_context_action)!
            const { injection_id, user_context } = injected.conversation_action.inject_context_action
            injectionState(run, injection_id, "delivered")
            run.sendRaw(appendedEcho(user_context.user_message.text, user_context.user_message.message_id))
            // Cut right after the result write, before Cursor's next checkpoint.
            run.end()
          } else if (message.run_request) {
            endTurn(run, "Answered once.")
          }
        }
        const first = collect(model, [ask], sessionKey)
        await waitFor(() => ready && !!pumping(sessionKey), "the working Run")
        const message = steer(sessionKey, "Then read probe.txt and say STEERED.")
        expect(announceHostSteer(message)).toBe(true)
        const step = readStep(readCall(await first), file, message.text)
        // Without OpenCode's copy after the result, history lacks the steer Cursor appended.
        const sent = collect(model, promoted ? step : step.slice(0, -1), sessionKey)
        if (!promoted) {
          expect(await failure(sent)).toMatchObject({ isRetryable: false })
          expect(runs).toHaveLength(1)
          return
        }
        expect(textOf(await sent)).toBe("Answered once.")
        expect(runs).toHaveLength(2)
        const original = runs[0]!.received[0]!.run_request
        const rebuilt = runs[1]!.received[0]!.run_request
        expect(rebuilt.action.resume_action).toBeUndefined()
        expect(rebuilt.conversation_id).not.toBe(original.conversation_id)
        expect(Uint8Array.from(rebuilt.conversation_state ?? [])).toEqual(new Uint8Array())
        const text = userText(runs[1]!)
        expect(text.split(message.text)).toHaveLength(2)
        expect(text).toContain(`Read file ${file}, lines 1-1\n1: alpha`)
        expect(text).toContain("Do not repeat completed work")
        expect(injectionsOf(runs[1]!)).toEqual([])
        // The rebuild took the steer from history; no receipt is left to send or match it again.
        expect(matchEarlySteers(sessionKey, [message.text], () => true)).toEqual([])
      })
    }, 30_000)
  }

  it("resumes the checkpoint when a new message finishes a Run that answered a promoted steer", async () => {
    await withModel("promoted-drained", async (model, cacheDir) => {
      const answeredSteer = Uint8Array.from([0x0a, 0x01, 0x38])
      const file = probeFile(cacheDir)
      const sessionKey = "ses_early_promoted_drained"
      let injectionId = ""
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => {
          injectionId = id
          readOnSteer(file)(run, id)
        },
        next: (run, message) => {
          if (message.exec_client_message?.read_result?.success && message.exec_client_message.id === 1) {
            injectionState(run, injectionId, "delivered")
            run.send({ conversation_checkpoint_update: CHECKPOINT })
            run.send({ exec_server_message: { id: 2, exec_id: "exec-2", read_args: { path: file, tool_call_id: "tc-2" } } })
          } else if (message.exec_client_message?.id === 2) {
            run.send({ conversation_checkpoint_update: answeredSteer })
            run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
          } else if (message.run_request) {
            endTurn(run, "About the new question.")
          }
        },
      })
      const message = announce("Then read probe.txt twice.")
      const step = readStep(readCall(await first), file, message.text)
      const second = readCall(await collect(model, step, sessionKey))
      expect(second).toBeDefined()
      await collect(model, [
        ...step,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: second.toolCallId, toolName: "read", input: JSON.parse(second.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: second.toolCallId, toolName: "read", output: { type: "text", value: `Read file ${file}, lines 1-1\n1: alpha` } }] },
        user("A new question."),
      ] as Prompt, sessionKey)
      const original = runs[0]!.received[0]!.run_request
      const next = runs.at(-1)!.received[0]!.run_request
      expect(runs).toHaveLength(2)
      expect(next.conversation_id).toBe(original.conversation_id)
      expect(Uint8Array.from(next.conversation_state)).toEqual(answeredSteer)
    })
  }, 30_000)

  it("is answered once when the Run drops after Cursor checkpointed it", async () => {
    await withModel("resume", async (model) => {
      const sessionKey = "ses_early_resume"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => {
          injectionState(run, id, "delivered")
          run.send({ interaction_update: { text_delta: { text: "STEER" } } })
          run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x01, 0x31]) })
          run.end()
        },
        next: (run, message) => { if (message.run_request) endTurn(run, "ED") },
      })
      const message = announce("Stop waiting and say STEERED.")
      const answer = textOf(await first)
      expect(answer).toEndWith("ED")
      expect(runs).toHaveLength(2)
      const resumed = runs[1]!.received[0]!.run_request
      expect(resumed.action.resume_action).toBeDefined()
      expect(resumed.conversation_state).toEqual(Uint8Array.from([0x0a, 0x01, 0x31]))

      expect(textOf(await collect(model, [ask, assistant(answer), user(message.text)], sessionKey))).toBe("")
      expect(runs).toHaveLength(2)
    })
  }, 30_000)

  it("leaves OpenCode's copy to run when the Run drops before a checkpoint holds the steer", async () => {
    await withModel("resume-unheld", async (model) => {
      const sessionKey = "ses_early_resume_unheld"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: (run, id) => {
          injectionState(run, id, "delivered")
          run.end()
        },
        next: (run, message) => {
          if (message.run_request) endTurn(run, runs.indexOf(run) === 1 ? "The job finished." : "STEERED")
        },
      })
      const message = announce("Stop waiting and say STEERED.")
      const answer = textOf(await first)
      expect(runs).toHaveLength(2)
      const promotion = await collect(model, [ask, assistant(answer), user(message.text)], sessionKey)
      expect(textOf(promotion)).toBe("STEERED")
      expect(runs).toHaveLength(3)
      expect(userText(runs[2]!)).toContain(message.text)
    })
  }, 30_000)

  for (const mode of ["taken", "not taken", "follow-up fails", "follow-up drops", "follow-up checkpoint"] as const) {
    it(`continues the held Run when OpenCode adds its copy after the step's tool results (${mode})`, async () => {
      const delivered = mode === "taken"
      await withModel(`tools-${mode.replaceAll(" ", "-")}`, async (model, cacheDir) => {
        const file = probeFile(cacheDir)
        const sessionKey = `ses_early_tools_${mode.replaceAll(" ", "_")}`
        let injectionId = ""
        const { first, announce } = await waitingRun(model, sessionKey, {
          inject: (run, id) => {
            injectionId = id
            readOnSteer(file)(run, id)
          },
          next: (run, message) => {
            if (message.exec_client_message?.read_result) {
              if (delivered) injectionState(run, injectionId, "delivered")
              run.send({ interaction_update: { tool_call_completed: { call_id: "tc-1" } } })
              endTurn(run, delivered ? "Read it. STEERED" : "Read it.")
            } else if (message.run_request && mode === "follow-up checkpoint" && runs.indexOf(run) === 1) {
              run.send({ conversation_checkpoint_update: Uint8Array.of(10, 1, 42) })
              run.send({ interaction_update: { thinking_delta: { text: "Taking the follow-up" } } })
              run.end("unavailable")
            } else if (message.run_request && mode === "follow-up drops" && runs.indexOf(run) === 1) {
              // The follow-up Run drops before any checkpoint holds the steer.
              run.send({ interaction_update: { text_delta: { text: "STEER" } } })
              run.end()
            } else if (message.run_request) {
              endTurn(run, "STEERED")
            }
          },
        })
        const message = announce("Then read probe.txt and say STEERED.")
        const call = readCall(await first)
        expect(call).toBeDefined()
        if (mode === "follow-up fails") {
          sessionManager.findOpenByOpenCodeSessionId(sessionKey)!.reopenWithUserMessage = async () => {
            throw new Error("connection refused")
          }
        }
        if (mode === "follow-up checkpoint") {
          const session = sessionManager.findOpenByOpenCodeSessionId(sessionKey)!
          const reopen = session.reopenWithUserMessage!
          session.reopenWithUserMessage = async (text, signal) => {
            const before = lastFrameArrival()
            await reopen(text, signal)
            await waitFor(() => lastFrameArrival() > before, "the follow-up checkpoint before reopen returns")
          }
        }
        const step = readStep(call, file, message.text)
        const continuation = collect(model, step, sessionKey)
        if (mode === "follow-up fails") {
          expect((await failure(continuation))?.message).toContain("Cursor did not take a message sent during this turn")
          expect(runs).toHaveLength(1)
          return
        }
        if (mode === "follow-up drops") {
          // Not resumed from the checkpoint before the follow-up, which would send the steer again.
          expect(await failure(continuation)).toBeInstanceOf(Error)
          expect(runs).toHaveLength(2)
          await collect(model, [...step, assistant("Read it.\n\nSTEER"), user("Go on.")], sessionKey)
          const next = runs[2]!.received[0]!.run_request
          expect(next.conversation_id).not.toBe(runs[0]!.received[0]!.run_request.conversation_id)
          expect(userText(runs[2]!)).toContain(message.text)
          return
        }
        const second = await continuation
        if (mode === "follow-up checkpoint") {
          expect(runs).toHaveLength(3)
          expect(userText(runs[1]!)).toBe(message.text)
          expect(runs[2]!.received[0]!.run_request).toMatchObject({
            action: { resume_action: {} }, conversation_state: Uint8Array.of(10, 1, 42),
            conversation_id: runs[0]!.received[0]!.run_request.conversation_id,
          })
          expect(textOf(second)).toStartWith("Read it.")
          expect(textOf(second)).toEndWith("STEERED")
          expect(runs[0]!.received.filter(m => m.exec_client_message?.read_result)).toHaveLength(1)
          return
        }
        expect(runs[0]!.received.filter((m) => m.exec_client_message?.read_result)).toHaveLength(1)
        expect(runs[0]!.received.filter((m) => m.conversation_action?.cancel_action)).toEqual([])
        expect(injectionsOf(runs[0]!)).toHaveLength(1)
        if (delivered) {
          expect(textOf(second)).toBe("Read it. STEERED")
          expect(runs).toHaveLength(1)
        } else {
          expect(textOf(second)).toBe("Read it.\n\nSTEERED")
          expect(runs).toHaveLength(2)
          expect(runs[1]!.received[0]!.run_request.conversation_id).toBe(runs[0]!.received[0]!.run_request.conversation_id)
          expect(userText(runs[1]!)).toBe(message.text)
        }
      })
    }, 30_000)
  }

  it("rebuilds the next turn from host history when the user stops before Cursor took a promoted steer", async () => {
    await withModel("stop", async (model, cacheDir) => {
      const file = probeFile(cacheDir)
      const sessionKey = "ses_early_stop"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: readOnSteer(file),
        next: (run, message) => {
          if (message.exec_client_message?.read_result) {
            run.send({ interaction_update: { text_delta: { text: "Reading." } } })
          } else if (message.conversation_action?.cancel_action) {
            run.send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x01, 0x33]) })
            run.end("canceled")
          } else if (message.run_request) {
            endTurn(run, "Fresh.")
          }
        },
      })
      const message = announce("Then read probe.txt and say STEERED.")
      const step = readStep(readCall(await first), file, message.text)
      const continuation = failure(collect(model, step, sessionKey))
      await waitFor(() => runs[0]!.received.some((m) => m.exec_client_message?.read_result), "the read result")
      await notifyHostInterrupt(sessionKey, "user", Date.now())
      await continuation
      await collect(model, [...step, assistant("Reading."), user("What now?")], sessionKey)
      expect(runs).toHaveLength(2)
      expect(runs[1]!.received[0]!.run_request.conversation_id).not.toBe(runs[0]!.received[0]!.run_request.conversation_id)
      expect(userText(runs[1]!)).toContain(message.text)
    })
  }, 30_000)

  it("rebuilds once when the tool results for a promoted steer cannot be written", async () => {
    await withModel("result-write-fails", async (model, cacheDir) => {
      const file = probeFile(cacheDir)
      const sessionKey = "ses_early_result_write_fails"
      const { first, announce } = await waitingRun(model, sessionKey, {
        inject: readOnSteer(file),
        next: (run, message) => { if (message.run_request) endTurn(run, runs.indexOf(run) === 1 ? "Rebased." : "Next.") },
      })
      const message = announce("Then read probe.txt and say STEERED.")
      const step = readStep(readCall(await first), file, message.text)
      sessionManager.findOpenByOpenCodeSessionId(sessionKey)!.stream.write = () => { throw new Error("stream reset") }
      expect(textOf(await collect(model, step, sessionKey))).toBe("Rebased.")
      await collect(model, [...step, assistant("Rebased."), user("Next?")], sessionKey)
      expect(runs).toHaveLength(3)
      expect(runs[2]!.received[0]!.run_request.conversation_id).toBe(runs[1]!.received[0]!.run_request.conversation_id)
    })
  }, 30_000)

  it("is left to OpenCode when its session already tracks as many steers as it may", async () => {
    await withModel("full", async (model) => {
      const sessionKey = "ses_early_full"
      const { first } = await waitingRun(model, sessionKey)
      for (let i = 0; i < 32; i++) {
        recordEarlySteer({
          ...steer(sessionKey, `old ${i}`), injectionId: `inj_old_${i}`, run: "run_old",
          delivered: true, checkpointed: true, answered: true,
        })
      }
      expect(announceHostSteer(steer(sessionKey, "one too many"))).toBe(false)
      expect(injectionsOf(runs[0]!)).toEqual([])
      endTurn(runs[0]!, " Done.")
      await first
    })
  }, 30_000)

  it("ends the step for OpenCode's copy instead of nudging a turn that ended without taking it", async () => {
    await withModel("no-nudge", async (model) => {
      const sessionKey = "ses_early_no_nudge"
      let waiting = false
      onRun = (run, message) => {
        if (message.run_request && runs.indexOf(run) === 0) {
          startWaitingStep(run, "Checking the job…")
          waiting = true
        } else if (message.conversation_action?.inject_context_action) {
          injectionState(run, message.conversation_action.inject_context_action.injection_id, "queued")
          run.send({ conversation_checkpoint_update: CHECKPOINT })
          run.send({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } })
        } else if (message.run_request) {
          endTurn(run, "Nudged.")
        }
      }
      const first = collect(model, [ask], sessionKey)
      await waitFor(() => waiting && !!pumping(sessionKey), "the waiting Run")
      expect(announceHostSteer(steer(sessionKey, "Stop waiting."))).toBe(true)
      expect(textOf(await first)).toBe("Checking the job…")
      expect(runs).toHaveLength(1)
    })
  }, 30_000)

  it("is left for the next step when no Run of its session is pumping", async () => {
    await withModel("idle", async (model) => {
      const sessionKey = "ses_early_idle"
      onRun = (run, message) => { if (message.run_request) endTurn(run, "Done.") }
      await collect(model, [user("Hello.")], sessionKey)
      expect(announceHostSteer(steer(sessionKey, "too late"))).toBe(false)
      expect(runs.flatMap(injectionsOf)).toEqual([])
    })
  }, 30_000)
})

function coldMemory(): void {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetTurnProvenanceForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetConversationBlobsForTests()
}

describe("steer restart and mixed-message regressions", () => {
  for (const identical of [false, true]) {
    it(`keeps a consumed receipt across restart without swallowing the next message (${identical ? "same text" : "new text"})`, async () => {
      await withModel(`receipt-scope-${identical}`, async (model, cacheDir) => {
        const sessionKey = `ses_receipt_scope_${identical}`
        const { first, announce } = await waitingRun(model, sessionKey, { inject: answerSteer })
        const message = announce("REPEATABLE_STEER")
        const answer = textOf(await first)
        const promoted = [ask, assistant(answer), user(message.text)]
        expect(textOf(await collect(model, promoted, sessionKey))).toBe("")
        coldMemory()
        cacheHttp2SessionForTests(ORIGIN, client)
        const restarted = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir }).languageModel("composer-2.5")
        onRun = (run, next) => { if (next.run_request) endTurn(run, "NEW_ANSWER") }
        const nextText = identical ? message.text : "DISTINCT_NEW_REQUEST"
        expect(textOf(await collect(restarted, [...promoted, user(nextText)], sessionKey))).toBe("NEW_ANSWER")
        const sent = userText(runs.at(-1)!)
        expect(sent).toContain(nextText)
        expect(sent.split(message.text).length - 1).toBe(identical ? 1 : 0)
      })
    }, 30_000)
  }

  it("does not suppress the same words after another model answered", async () => {
    await withModel("foreign-reply", async (model) => {
      const sessionKey = "ses_receipt_foreign"
      const { first, announce } = await waitingRun(model, sessionKey, { inject: answerSteer })
      const message = announce("SAME_WORDS_AFTER_MODEL_CHANGE")
      await first
      onRun = (run, next) => { if (next.run_request) endTurn(run, "A new answer.") }
      expect(textOf(await collect(model, [ask, assistant("A different model answered."), user(message.text)], sessionKey))).toBe("A new answer.")
      expect(runs).toHaveLength(2)
    })
  }, 30_000)

  for (const hasCheckpoint of [false, true]) {
    it(`sends all pending user messages exactly once (${hasCheckpoint ? "warm" : "seeded"})`, async () => {
      await withModel(`live-user-turn-${hasCheckpoint}`, async (model) => {
        const sessionKey = `ses_live_turn_${hasCheckpoint}`
        onRun = (run, next) => { if (next.run_request) endTurn(run, "Done.") }
        if (hasCheckpoint) await collect(model, [ask], sessionKey)
        const prompt = hasCheckpoint ? [ask, assistant("Done.")] : []
        await collect(model, [...prompt, user("FIRST_PENDING_MESSAGE"), user("SECOND_PENDING_MESSAGE")], sessionKey)
        const sent = userText(runs.at(-1)!)
        expect(sent.split("FIRST_PENDING_MESSAGE")).toHaveLength(2)
        expect(sent.split("SECOND_PENDING_MESSAGE")).toHaveLength(2)
        expect(sent.indexOf("FIRST_PENDING_MESSAGE")).toBeLessThan(sent.indexOf("SECOND_PENDING_MESSAGE"))
      })
    }, 30_000)
  }

  it("validates restart receipts and round-trips their scope", () => {
    const record: EarlySteer = {
      ...steer("ses_receipt_validation", "RECEIPT"), injectionId: "injection", run: "run",
      delivered: true, checkpointed: true, answered: true, hostTurn: "a".repeat(64),
    }
    expect(recordEarlySteer(record)).toBe(true)
    const encoded = serializeEarlySteers(record.sessionID)
    coldMemory()
    for (const invalid of ["{", "null", JSON.stringify({ version: 2, records: [record] }), JSON.stringify({ version: 1, records: [record, {}] })]) {
      restoreEarlySteers(record.sessionID, invalid)
      expect(matchEarlySteers(record.sessionID, [record.text], () => true)).toEqual([])
    }
    restoreEarlySteers("ses_another", encoded)
    expect(matchEarlySteers("ses_another", [record.text], () => true)).toEqual([])
    restoreEarlySteers(record.sessionID, encoded)
    expect(matchEarlySteers(record.sessionID, [record.text], () => true)).toEqual([record])
  })

  it("does not resend an answered steer after a simulated process restart before its host copy", async () => {
    await withModel("restart-before-copy", async (model, cacheDir) => {
      const sessionKey = "ses_edge_restart"
      const { first, announce } = await waitingRun(model, sessionKey, { inject: answerSteer })
      const message = announce("ONCE_ONLY_RESTART_STEER")
      const answer = textOf(await first)
      const persisted = await getPersistedConversation(cacheDir, sessionKey)
      expect(persisted?.conversationId).toBeTruthy()
      expect(JSON.parse(persisted!.earlySteers!).records[0].answered).toBe(true)
      coldMemory()
      cacheHttp2SessionForTests(ORIGIN, client)
      const restarted = createCursor({
        name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir,
        retry: { maxAttempts: 1 },
      }).languageModel("composer-2.5")
      onRun = (run, next) => { if (next.run_request) endTurn(run, "REPEATED") }
      const promoted = await collect(restarted, [ask, assistant(answer), user(message.text)], sessionKey)
      expect(textOf(promoted)).toBe("")
      expect(runs).toHaveLength(1)
    })
  }, 30_000)

  for (const order of ["early-first", "early-last"] as const) {
    it(`keeps both user messages after tool results in a mixed promotion (${order})`, async () => {
      await withModel(`mixed-${order}`, async (model, cacheDir) => {
        const file = probeFile(cacheDir)
        const sessionKey = `ses_edge_mixed_${order}`
        const { first, announce } = await waitingRun(model, sessionKey, {
          inject: (run, id) => { injectionState(run, id, "delivered"); readOnSteer(file)(run, id) },
          next: (run, next) => {
            if (next.exec_client_message?.read_result) endTurn(run, "STEERED")
            else if (next.run_request) endTurn(run, "FRESH_REPLY")
          },
        })
        const early = announce("EARLY_MIXED_STEER")
        const step = readStep(readCall(await first), file, early.text)
        const late = "NEVER_INJECTED_MIXED_STEER"
        if (order === "early-first") step.push(user(late))
        else step.splice(step.length - 1, 0, user(late))
        await collect(model, step, sessionKey)
        const freshText = userText(runs.at(-1)!)
        // Cursor already received the early steer in the held Run; the new one must not be lost.
        expect(freshText).toContain(late)
        expect(freshText).not.toContain(early.text)
      })
    }, 30_000)
  }

  for (const restart of [false, true]) {
    it(`does not repeat a mixed promoted steer on host retry (${restart ? "after restart" : "same process"})`, async () => {
      let rejectRenewal = false
      let failedOnce = false
      await withModel("mixed-retry", async (model, cacheDir) => {
        const file = probeFile(cacheDir)
        const sessionKey = "ses_edge_mixed_retry"
        const { first, announce } = await waitingRun(model, sessionKey, {
          inject: (run, id) => { injectionState(run, id, "delivered"); readOnSteer(file)(run, id) },
          next: (run, next) => {
            if (next.exec_client_message?.read_result) endTurn(run, "STEERED")
            else if (next.run_request && !failedOnce) {
              failedOnce = true
              rejectRenewal = true
              run.send({ interaction_update: { text_delta: { text: "PARTIAL" } } })
              run.end()
            } else if (next.run_request) endTurn(run, "RETRIED")
          },
        })
        const early = announce("ONCE_ONLY_MIXED_RETRY_STEER")
        const step = readStep(readCall(await first), file, early.text)
        step.splice(step.length - 1, 0, user("NEW_MIXED_RETRY_REQUEST"))
        const error = await failure(collect(model, step, sessionKey))
        expect(error).toBeInstanceOf(Error)
        rejectRenewal = false
        if (restart) {
          coldMemory()
          cacheHttp2SessionForTests(ORIGIN, client)
          model = createCursor({
            name: "cursor", agentBaseURL: ORIGIN, cacheDir,
            getAccessToken: async () => "example-token",
          }).languageModel("composer-2.5")
        }
        await collect(model, step, sessionKey)
        const retryText = userText(runs.at(-1)!)

        expect(retryText).toContain("NEW_MIXED_RETRY_REQUEST")
        expect(retryText).not.toContain(early.text)
      }, async () => {
        if (rejectRenewal) throw new Error("fixture credential renewal failed")
        return "example-token"
      })
    }, 30_000)
  }

  for (const withLaterMessage of [false, true]) {
    it(`keeps an undelivered steer's host copy after Stop (${withLaterMessage ? "with another message" : "alone"})`, async () => {
      await withModel(`stop-before-copy-${withLaterMessage}`, async (model) => {
        const sessionKey = `ses_edge_stop_${withLaterMessage}`
        const { first, announce } = await waitingRun(model, sessionKey, {
          inject: (run, id) => injectionState(run, id, "queued"),
          next: (run, next) => {
            if (next.conversation_action?.cancel_action) {
              run.send({ conversation_checkpoint_update: CHECKPOINT })
              run.end("canceled")
            } else if (next.run_request) endTurn(run, "AFTER_STOP")
          },
        })
        const message = announce("UNDISPATCHED_STOP_STEER")
        const stopped = failure(first)
        await waitFor(() => injectionsOf(runs[0]!).length === 1, "the queued injection")
        await notifyHostInterrupt(sessionKey, "user", Date.now())
        await stopped
        const step = [ask, assistant("Waiting for the job."), user(message.text)]
        if (withLaterMessage) step.push(user("NEW_REQUEST_AFTER_STOP"))
        await collect(model, step, sessionKey)
        const nextText = userText(runs.at(-1)!)
        expect(nextText).toContain(message.text)
        if (withLaterMessage) expect(nextText).toContain("NEW_REQUEST_AFTER_STOP")
      })
    }, 30_000)
  }
})
