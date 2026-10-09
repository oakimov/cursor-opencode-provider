import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  beginEmittedStep,
  detectForeignHistory,
  getTurnProvenance,
  MAX_PROVENANCE_SESSIONS,
  parseTurnProvenance,
  recordEmittedPart,
  resetTurnProvenanceForTests,
  serializeTurnProvenance,
  trackTurnProvenance,
} from "../src/protocol/turn-provenance.js"
import {
  assertForeignHistoryRebaseFits,
  extractPromptHistory,
  pump,
  resetTurnStateForTests,
} from "../src/language-model.js"
import {
  getPersistedConversation,
  resetConversationPersistenceForTests,
} from "../src/protocol/conversation-persistence.js"
import { hydrateConversationState, hydrateTurnProvenance } from "../src/protocol/conversation-state.js"
import {
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { encodeMessage } from "../src/protocol/messages.js"
import type { CursorSession, Frame } from "../src/session.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

const SESSION = "ses_mixed"
const CONVERSATION = "conv-1"

function promptEndingWith(assistant: Prompt[number]): Prompt {
  return [
    { role: "user", content: [{ type: "text", text: "first" }] },
    assistant,
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]
}

function assistantText(text: string): Prompt[number] {
  return { role: "assistant", content: [{ type: "text", text }] }
}

function assistantToolCall(toolCallId: string, text = ""): Prompt[number] {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      { type: "tool-call", toolCallId, toolName: "read", input: { path: "a.ts" } },
    ],
  }
}

function detect(prompt: Prompt) {
  return detectForeignHistory({ sessionKey: SESSION, conversationId: CONVERSATION, prompt })
}

describe("detectForeignHistory", () => {
  beforeEach(resetTurnProvenanceForTests)

  it("has no opinion without a record for this conversation", () => {
    expect(detect(promptEndingWith(assistantText("anything")))).toBeUndefined()
    trackTurnProvenance(SESSION, "other-conversation")
    expect(detect(promptEndingWith(assistantText("anything")))).toBeUndefined()
  })

  it("accepts the host echo of our own text regardless of whitespace", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Done.\n\nThe  fix " })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "is in place." })
    expect(detect(promptEndingWith(assistantText("Done. The fix is in place.")))).toBeUndefined()
  })

  it("accepts an assistant turn carrying one of our tool call ids", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    expect(detect(promptEndingWith(assistantToolCall("call_ours", "Reading it")))).toBeUndefined()
  })

  it("flags an assistant turn another model produced", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Cursor answer" })
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    expect(detect(promptEndingWith(assistantText("Local model answer")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith(assistantToolCall("call_theirs")))).toBe("foreign-assistant")
  })

  it("ignores reasoning when comparing and has no opinion on an empty turn", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Answer" })
    expect(detect(promptEndingWith({
      role: "assistant",
      content: [{ type: "reasoning", text: "private thoughts" }, { type: "text", text: "Answer" }],
    }))).toBeUndefined()
    expect(detect(promptEndingWith({ role: "assistant", content: [{ type: "reasoning", text: "x" }] })))
      .toBeUndefined()
  })

  it("accepts our turn when OpenCode 1.x replays our reasoning as text after a model switch", () => {
    // OpenCode 1.x session/message-v2.ts: when the request model differs from the
    // message's model, reasoning parts are replayed as text parts in place.
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Check the file." })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "First." })
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Then the test." })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Done." })
    const replayedAsText = { role: "assistant", content: [
      { type: "text", text: "Check the file." },
      { type: "text", text: "First." },
      { type: "text", text: "Then the test." },
      { type: "text", text: "Done." },
    ] } as Prompt[number]
    expect(detect(promptEndingWith(replayedAsText))).toBeUndefined()
    // Same model: reasoning stays typed and the text parts alone match.
    expect(detect(promptEndingWith({ role: "assistant", content: [
      { type: "reasoning", text: "Check the file." },
      { type: "text", text: "First." },
      { type: "reasoning", text: "Then the test." },
      { type: "text", text: "Done." },
    ] }))).toBeUndefined()
    // Reordered or foreign text still does not match.
    expect(detect(promptEndingWith(assistantText("First.Check the file.Done.Then the test.")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith({ role: "assistant", content: [
      { type: "text", text: "Other model thinking" },
      { type: "text", text: "Done." },
    ] }))).toBe("foreign-assistant")
  })

  it("records a reasoning-only step so its replay as text still matches", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Earlier answer" })
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Only thinking" })
    expect(getTurnProvenance(SESSION)).toMatchObject({ text: "", textWithReasoning: "Onlythinking" })
    expect(detect(promptEndingWith(assistantText("Only thinking")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("Earlier answer")))).toBe("foreign-assistant")
  })

  it("compares only against the latest step, not older Cursor turns", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Done." })
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Refactored the parser." })
    // A foreign model answering "Done." must not match the older Cursor step.
    expect(detect(promptEndingWith(assistantText("Done.")))).toBe("foreign-assistant")
    expect(detect(promptEndingWith(assistantText("Refactored the parser.")))).toBeUndefined()
    // Nor a fragment of the latest step.
    expect(detect(promptEndingWith(assistantText("Refactored")))).toBe("foreign-assistant")
  })

  it("keeps the previous step when a new step emits nothing", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    beginEmittedStep(SESSION, CONVERSATION)
    expect(detect(promptEndingWith(assistantToolCall("call_ours")))).toBeUndefined()
  })

  it("identifies a long step by its first 4 KiB of text", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    const long = "a".repeat(10_000)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: long })
    expect(getTurnProvenance(SESSION)!.text.length).toBe(4 * 1024)
    expect(detect(promptEndingWith(assistantText(long)))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("b" + long)))).toBe("foreign-assistant")
  })

  it("bounds the number of tracked sessions", () => {
    for (let i = 0; i <= MAX_PROVENANCE_SESSIONS; i++) trackTurnProvenance(`ses_${i}`, "conv")
    expect(getTurnProvenance("ses_0")).toBeUndefined()
    expect(getTurnProvenance(`ses_${MAX_PROVENANCE_SESSIONS}`)).toBeDefined()
  })

  it("keeps one record across Runs on the same conversation (Cursor model switch)", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Answer" })
    expect(detect(promptEndingWith(assistantText("Answer")))).toBeUndefined()
    // A Run on another Cursor model keeps the conversation, so it keeps the record.
    trackTurnProvenance(SESSION, CONVERSATION)
    beginEmittedStep(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Second" })
    expect(detect(promptEndingWith(assistantText("Second")))).toBeUndefined()
    expect(getTurnProvenance(SESSION)?.conversationId).toBe(CONVERSATION)
  })

  it("starts a fresh record when the conversation is reminted", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Old" })
    trackTurnProvenance(SESSION, "conv-2")
    expect(getTurnProvenance(SESSION)).toEqual({
      conversationId: "conv-2",
      toolCallIds: [],
      text: "",
      textWithReasoning: "",
    })
  })

  it("round-trips through its persisted JSON form", () => {
    trackTurnProvenance(SESSION, CONVERSATION)
    recordEmittedPart(SESSION, CONVERSATION, { type: "reasoning-delta", delta: "Thinking" })
    recordEmittedPart(SESSION, CONVERSATION, { type: "text-delta", delta: "Answer" })
    recordEmittedPart(SESSION, CONVERSATION, { type: "tool-call", toolCallId: "call_ours" })
    const value = getTurnProvenance(SESSION)!
    expect(value.textWithReasoning).toBe("ThinkingAnswer")
    expect(parseTurnProvenance(serializeTurnProvenance(value))).toEqual(value)
    expect(parseTurnProvenance("{not json")).toBeUndefined()
    expect(parseTurnProvenance("{}")).toBeUndefined()
  })
})

describe("foreign-history rebase", () => {
  it("replays every tool result as host observations", () => {
    const history = extractPromptHistory([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      assistantToolCall("call_theirs", "Reading"),
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_theirs",
          toolName: "read",
          output: { type: "text", value: "file body" },
        }],
      },
      assistantText("Fixed"),
      { role: "user", content: [{ type: "text", text: "next" }] },
    ], { toolResults: "all" })
    const text = history.map((message) => message.content).join("\n")
    expect(text).toContain("file body")
    expect(text).toContain("Fixed")
    expect(history.some((message) => message.role === "assistant" && message.content.includes("file body")))
      .toBe(false)
  })

  it("passes when the rebased history fits the model context", () => {
    expect(() => assertForeignHistoryRebaseFits({
      modelInfo: { id: "m", maxContext: 1_000, variants: [] },
      cursorModelId: "m",
      maxMode: false,
      history: [{ role: "user", content: "x".repeat(3_000) }],
      systemPrompt: "system",
      userText: "next",
    })).not.toThrow()
  })

  it("raises a host-recognised context overflow when it does not fit", () => {
    let thrown: unknown
    try {
      assertForeignHistoryRebaseFits({
        modelInfo: { id: "m", maxContext: 1_000, maxContextForMaxMode: 100_000, variants: [] },
        cursorModelId: "m",
        maxMode: false,
        history: [{ role: "user", content: "x".repeat(4_000) }],
        systemPrompt: undefined,
        userText: "next",
      })
    } catch (error) {
      thrown = error
    }
    expect(APICallError.isInstance(thrown)).toBe(true)
    expect((thrown as APICallError).statusCode).toBe(413)
    expect((thrown as APICallError).message).toMatch(/prompt is too long/i)
  })

  it("uses the long-context window in max mode", () => {
    expect(() => assertForeignHistoryRebaseFits({
      modelInfo: { id: "m", maxContext: 1_000, maxContextForMaxMode: 100_000, variants: [] },
      cursorModelId: "m",
      maxMode: true,
      history: [{ role: "user", content: "x".repeat(4_000) }],
      systemPrompt: undefined,
      userText: "next",
    })).not.toThrow()
  })
})

describe("provenance through a Cursor Run", () => {
  const roots: string[] = []

  beforeEach(() => {
    resetTurnProvenanceForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetFrozenRequestContextsForTests()
    resetTurnStateForTests()
  })

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  function textTurnSession(root: string, text: string): CursorSession {
    const payloads = [
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text } } }),
      encodeMessage("AgentServerMessage", { conversation_checkpoint_update: Uint8Array.from([1, 2, 3]) }),
      encodeMessage("AgentServerMessage", {
        interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
      }),
    ]
    let index = 0
    const frames: AsyncIterator<Frame> = {
      next: async () => index < payloads.length
        ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
        : { done: true, value: undefined },
    }
    return {
      sessionId: "provenance-run",
      conversationId: CONVERSATION,
      cacheDir: root,
      openCodeSessionId: SESSION,
      cacheDiagnostics: {
        sessionKey: SESSION,
        conversationId: CONVERSATION,
        modelId: "gpt-5",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "hash",
        checkpointUpdates: 0,
        tokenDetailUpdates: 0,
        pumpPasses: 0,
        stepStarts: 0,
        stepCompletes: 0,
        displayToolCalls: 0,
        execRequests: 0,
      },
      stream: {
        write() {},
        end() {},
        destroy() {},
        frames: () => ({ [Symbol.asyncIterator]: () => frames }),
        isClosed: () => false,
        onTerminal: () => () => {},
      },
      frames,
      pending: new Map(),
      displayToolCalls: new Map(),
      nextBridgedExecId: 900_000,
      blobs: new Map(),
      toolDescriptors: [],
      requestContext: { rules_info_complete: true },
      allowTools: true,
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      pumpActive: true,
      heartbeat: null,
      billing: { key: "run:test", prefixTokens: 0 },
    } as unknown as CursorSession
  }

  it("records streamed text and restores it after a restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-provenance-"))
    roots.push(root)
    restoreConversationBinding(SESSION, CONVERSATION)
    const session = textTurnSession(root, "Cursor wrote this")
    await pump(session, {
      enqueue() {},
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

    expect(detect(promptEndingWith(assistantText("Cursor wrote this")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBe("foreign-assistant")
    expect((await getPersistedConversation(root, SESSION))?.turnProvenance).toBeDefined()

    // Simulate a host restart: drop all in-memory state, then hydrate.
    resetTurnProvenanceForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBeUndefined()
    await hydrateConversationState(root, SESSION)
    expect(detect(promptEndingWith(assistantText("Cursor wrote this")))).toBeUndefined()
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBe("foreign-assistant")

    // Only the provenance entry evicted while the binding stays in memory.
    resetTurnProvenanceForTests()
    await hydrateTurnProvenance(root, SESSION)
    expect(detect(promptEndingWith(assistantText("Somebody else")))).toBe("foreign-assistant")
  })
})
