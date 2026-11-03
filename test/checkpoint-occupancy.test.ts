import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { billingLedger } from "../src/billing.js"
import { drainSessionUntilTurnEnded, pump } from "../src/language-model.js"
import { sessionManager } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"
import { isUnexplainedOccupancyJump, parseOccupancyGuard } from "../src/checkpoint-occupancy.js"
import {
  checkpointTokenDetails, clearCheckpoint, getCheckpoint, getCheckpointOccupancy, resetCheckpointsForTests,
  restoreCheckpointOccupancy, restoreCheckpointOccupancyGuard, serializeCheckpointOccupancyGuard, setCheckpoint,
} from "../src/protocol/checkpoint.js"
import { encodeMessage } from "../src/protocol/messages.js"
import { cursorContextUsageMetadata, decodeConversationTokenDetails, type CursorConversationTokenDetails } from "../src/protocol/token-details.js"

// Totals from issue #139; category/character evidence below is explicitly synthetic.
function details(usedTokens: number, characters = 120_000, maxTokens = 256_000): CursorConversationTokenDetails {
  return { usedTokens, maxTokens, breakdown: { totalUsedTokens: usedTokens, maxTokens, categories: [
    { id: "rules", label: "Rules", estimatedTokens: 10_000, characterCount: 40_000 },
    { id: "tools", label: "Tools", estimatedTokens: 10_000, characterCount: 40_000 },
    { id: "conversation", label: "Conversation", estimatedTokens: usedTokens - 20_000, characterCount: characters },
  ] } }
}

function wire(value: CursorConversationTokenDetails, marker = "state"): Uint8Array {
  return encodeMessage("ConversationStateStructure", { root_prompt_messages_json: [marker], token_details: {
    used_tokens: value.usedTokens, max_tokens: value.maxTokens,
    ...(value.breakdown ? { breakdown: { total_used_tokens: value.breakdown.totalUsedTokens, max_tokens: value.breakdown.maxTokens,
      categories: value.breakdown.categories.map(c => ({ id: c.id, label: c.label, estimated_tokens: c.estimatedTokens,
        ...(c.characterCount !== undefined ? { character_count: c.characterCount } : {}) })) } } : {}),
  } })
}

function update(value: CursorConversationTokenDetails, boundary = "run:step-1", model = "example-model", bypass = false) {
  const bytes = wire(value)
  setCheckpoint("conv", bytes, { boundary, model, bypass })
  expect(getCheckpoint("conv")).toEqual(bytes)
  return checkpointTokenDetails("conv", bytes)!
}

beforeEach(resetCheckpointsForTests)
afterEach(() => { sessionManager.dispose(); billingLedger.clear() })

function session(payloads: Uint8Array[]) {
  let index = 0
  const frames = { next: async () => index < payloads.length
    ? { done: false as const, value: { flags: 0, payload: payloads[index++]! } }
    : { done: true as const, value: undefined } }
  return sessionFixture({
    sessionId: "occupancy-run", runId: "occupancy-first-stream", conversationId: "conv",
    stream: { write() {}, end() {}, destroy() {}, isClosed: () => false, onTerminal: () => () => {}, frames: () => ({ [Symbol.asyncIterator]: () => frames }) },
    frames, pending: new Map(), displayToolCalls: new Map(), nextBridgedExecId: 900_000, blobs: new Map(),
    toolDescriptors: [], requestContext: {}, allowTools: false,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 }, pumpActive: false, heartbeat: null,
    cacheDiagnostics: { conversationId: "conv", startedWithCheckpoint: false, requestContextReused: false, requestContextHash: "fixture",
      checkpointUpdates: 0, tokenDetailUpdates: 0, pumpPasses: 0, stepStarts: 0, stepCompletes: 0, displayToolCalls: 0, execRequests: 0 },
  })
}
const updateFrame = (value: CursorConversationTokenDetails) => encodeMessage("AgentServerMessage", { conversation_checkpoint_update: wire(value) })
const terminalFrame = () => encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {
  input_tokens: 300_000, output_tokens: 1_500, cache_read: 250_000, reasoning_tokens: 400,
} } })

describe("checkpoint occupancy confirmation", () => {
  it.each([[47_817, 96_549, 48_694], [49_462, 99_389, 50_185]])("holds an isolated reported spike (%s -> %s -> %s)", (before, spike, after) => {
    expect(update(details(before!)).usedTokens).toBe(before)
    const held = update(details(spike!, 122_000))
    expect(held.usedTokens).toBe(before)
    expect(held.rawUsedTokens).toBe(spike)
    expect(cursorContextUsageMetadata(held)).toMatchObject({ source: "checkpoint-held-spike", stale: true, usedTokens: before, rawUsedTokens: spike })
    expect(update(details(after!, 124_000)).usedTokens).toBe(after)
    expect(serializeCheckpointOccupancyGuard("conv")).not.toContain("pending")
  })

  it("does not let duplicate checkpoint pairs confirm a spike", () => {
    update(details(120_000))
    const high = details(240_000, 121_000)
    update(high)
    const duplicate = wire(high, "tool-result-updated-state")
    setCheckpoint("conv", duplicate, { boundary: "run:step-1", model: "example-model" })
    expect(checkpointTokenDetails("conv", duplicate)).toMatchObject({ usedTokens: 120_000, rawUsedTokens: 240_000 })
    // A later host observation admits a genuinely sustained unchanged count.
    expect(update(high, "run:step-2").usedTokens).toBe(240_000)
  })

  it("does not substitute a different recovery checkpoint with the same raw total", () => {
    update(details(120_000)); update(details(240_000, 121_000))
    expect(checkpointTokenDetails("conv", wire(details(240_000, 250_000)))?.usedTokens).toBe(240_000)
    expect(checkpointTokenDetails("conv", wire({ usedTokens: 240_000, maxTokens: 256_000 }))?.usedTokens).toBe(240_000)
  })

  it("admits fresh evidence after restoring a candidate without an observation id", () => {
    const low = wire(details(120_000)); const high = wire(details(240_000))
    setCheckpoint("conv", low); setCheckpoint("conv", high)
    expect(checkpointTokenDetails("conv", high)?.usedTokens).toBe(120_000)
    expect(update(details(240_000), "fresh-run").usedTokens).toBe(240_000)
  })

  it("carries an invalidated media baseline across a zero marker and restore", () => {
    update(details(120_000))
    update({ usedTokens: 0, maxTokens: 256_000 }, "media-run", "example-model", true)
    const guard = serializeCheckpointOccupancyGuard("conv")
    expect(parseOccupancyGuard(guard)?.needsFreshBaseline).toBe(true)
    restoreCheckpointOccupancyGuard("conv", guard)
    expect(update(details(240_000)).usedTokens).toBe(240_000)
  })

  it("admits a distinct compatible high measurement within the same observation", () => {
    update(details(120_000))
    update(details(240_000, 121_000))
    expect(update(details(241_000, 122_000)).usedTokens).toBe(241_000)
  })

  it("retains the current raw evidence when an unconfirmed jump grows again", () => {
    update(details(40_000))
    update(details(80_000))
    const higher = update(details(120_000))
    expect(higher).toMatchObject({ usedTokens: 40_000, rawUsedTokens: 120_000 })
  })

  it("does not suppress genuine character growth, shrinking windows, model changes or known media", () => {
    for (const changed of [details(240_000, 250_000), details(240_000, 90_000), details(240_000, 120_000, 512_000)]) {
      resetCheckpointsForTests(); update(details(120_000))
      expect(update(changed).usedTokens).toBe(240_000)
    }
    resetCheckpointsForTests(); update(details(120_000))
    expect(update(details(240_000), "run:step-1", "different-model").usedTokens).toBe(240_000)
    resetCheckpointsForTests(); update(details(120_000))
    expect(update(details(240_000), "run:step-1", "example-model", true).usedTokens).toBe(240_000)
  })

  it("admits the first reading even if it is large", () => {
    expect(update(details(240_000)).usedTokens).toBe(240_000)
  })

  it("passes raw readings when category evidence is missing or inconsistent", () => {
    const missing = details(240_000); delete missing.breakdown
    const noChars = details(240_000); delete noChars.breakdown!.categories[2]!.characterCount
    const duplicate = details(240_000); duplicate.breakdown!.categories[1]!.id = "rules"
    const sum = details(240_000); sum.breakdown!.categories[2]!.estimatedTokens++
    const changed = details(240_000); changed.breakdown!.categories[0]!.characterCount!++
    const stale = details(240_000); stale.breakdown!.totalUsedTokens--
    for (const value of [missing, noChars, duplicate, sum, changed, stale]) {
      resetCheckpointsForTests(); update(details(120_000))
      expect(update(value).usedTokens).toBe(240_000)
    }
  })

  it.each([false, true])("restores pending evidence across restart, including zero-token terminal state (%s)", zero => {
    update(details(120_000)); update(details(240_000, 121_000))
    if (zero) update({ usedTokens: 0, maxTokens: 256_000 })
    const raw = getCheckpoint("conv")!
    const accepted = getCheckpointOccupancy("conv")!
    const guard = serializeCheckpointOccupancyGuard("conv")!
    resetCheckpointsForTests()
    restoreCheckpointOccupancy("conv", accepted)
    restoreCheckpointOccupancyGuard("conv", guard)
    setCheckpoint("conv", raw)
    expect(checkpointTokenDetails("conv", raw)).toMatchObject({ usedTokens: 120_000, rawUsedTokens: 240_000 })
    expect(update(details(240_000, 121_000), "new-run:step-1").usedTokens).toBe(240_000)
  })

  it("clears policy state on conversation reset", () => {
    update(details(120_000)); update(details(240_000))
    clearCheckpoint("conv")
    expect(serializeCheckpointOccupancyGuard("conv")).toBeUndefined()
    expect(update(details(240_000)).usedTokens).toBe(240_000)
  })

  it.each([false, true])("applies the same observation policy while draining (next step: %s)", async nextStep => {
    const high = details(240_000, 121_000)
    const run = session([
      updateFrame(details(120_000)), updateFrame(high), updateFrame(high),
      ...(nextStep ? [encodeMessage("AgentServerMessage", { interaction_update: { step_started: {} } }), updateFrame(high),
        encodeMessage("AgentServerMessage", { interaction_update: { step_completed: {} } })] : []),
      terminalFrame(),
    ])
    sessionManager.registerSession(run)
    expect(await drainSessionUntilTurnEnded(run, { timeoutMs: 1_000 })).toBe("turn-ended")
    expect(run.tokenDetails?.usedTokens).toBe(nextStep ? 240_000 : 120_000)
    expect(run.cacheDiagnostics?.stepStarts).toBe(nextStep ? 1 : 0)
    expect(run.cacheDiagnostics?.stepCompletes).toBe(nextStep ? 1 : 0)
  })

  it("prices the accepted snapshot's tier consistently for both host projections", async () => {
    const run = session([updateFrame(details(120_000)), updateFrame(details(240_000, 121_000)), terminalFrame()])
    run.billing.cost = { input: 2, output: 6, cache_read: 0.5, context_over_200k: { input: 4, output: 12, cache_read: 1 } }
    const parts: LanguageModelV3StreamPart[] = []
    const controller = { desiredSize: 1, enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, close() {}, error(e: unknown) { throw e } }
    await pump(run, controller, { textId: "text", reasoningId: "reasoning" })
    const finish = parts.find(part => part.type === "finish")
    if (!finish || finish.type !== "finish") throw new Error("Missing finish")
    const usage = finish.usage
    expect((usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0)).toBe(120_000)
    const input = usage.inputTokens
    const hostPrice = ((input.noCache ?? 0) * 2 + (input.cacheRead ?? 0) * 0.5 + (usage.outputTokens.total ?? 0) * 6) / 1e6
    expect(billingLedger.totals(run.billing.key).realUsd).toBeCloseTo(0.234, 12)
    expect(hostPrice).toBeCloseTo(0.234, 6)
    const copilot = finish.providerMetadata?.copilot?.totalNanoAiu
    if (typeof copilot !== "number") throw new Error("Missing classic cost")
    expect(copilot / 1e11).toBeCloseTo(hostPrice, 9)
  })

  it("does not mistake equal totals without category evidence for comparable readings", () => {
    expect(isUnexplainedOccupancyJump({ usedTokens: 120_000, maxTokens: 256_000 }, details(240_000))).toBe(false)
    expect(decodeConversationTokenDetails(wire(details(120_000)))?.usedTokens).toBe(120_000)
  })
})

describe("private occupancy guard validation", () => {
  it("rejects malformed, oversized or unsupported cache data", () => {
    for (const value of [undefined, "{", " ".repeat(65_537), "null", "{}", '{"version":2}',
      '{"version":1,"model":4}', '{"version":1,"pending":{}}',
      JSON.stringify({ version: 1, pending: { details: details(240_000), boundary: 4 } }),
      JSON.stringify({ version: 1, pending: { details: { usedTokens: 0, maxTokens: 0, breakdown: { categories: [] } } } }),
    ]) expect(parseOccupancyGuard(value)).toBeUndefined()
    expect(parseOccupancyGuard('{"version":1}')).toEqual({ version: 1 })
  })
})
