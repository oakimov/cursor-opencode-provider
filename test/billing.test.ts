import { afterEach, describe, expect, it } from "bun:test"
import type { LanguageModelV3Usage } from "@ai-sdk/provider"
import {
  BillingLedger,
  billingLedger,
  cursorPricingId,
  hostStepPrices,
  hostUsageCostUsd,
  nanoAiuForUsd,
  shapeStepUsage,
  turnEndedCostUsd,
} from "../src/billing.js"
import { pump } from "../src/language-model.js"
import { encodeMessage } from "../src/protocol/messages.js"
import { getCursorModelCost, toOpenCode2Costs, type OpenCodeModelCost } from "../src/pricing.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

const GROK: OpenCodeModelCost = {
  input: 2, output: 6, cache_read: 0.5,
  context_over_200k: { input: 4, output: 12, cache_read: 1 },
}
const CLAUDE: OpenCodeModelCost = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }

/** OpenCode 2 `cm`: the step's tokens at the tier its prompt size selects. */
function openCode2Cost(cost: OpenCodeModelCost, usage: LanguageModelV3Usage): number {
  const tokens = {
    input: usage.inputTokens.noCache ?? 0,
    cacheRead: usage.inputTokens.cacheRead ?? 0,
    cacheWrite: usage.inputTokens.cacheWrite ?? 0,
    output: usage.outputTokens.total ?? 0,
  }
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const tiers = toOpenCode2Costs(cost)
  const tier = tiers
    .filter((entry) => entry.tier?.type === "context" && prompt > entry.tier.size)
    .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ?? tiers.find((entry) => !entry.tier)!
  return (tokens.input * tier.input + tokens.output * tier.output
    + tokens.cacheRead * tier.cache.read + tokens.cacheWrite * tier.cache.write) / 1e6
}

/** OpenCode 1.x getUsage with a Copilot `totalNanoAiu`. */
const openCode1Cost = (nanoAiu: number) => nanoAiu / 1e11

const total = (usage: LanguageModelV3Usage) => (usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0)

afterEach(() => billingLedger.clear())

describe("pricing a Run", () => {
  it("uses the catalog's Fast entry only for a Fast variant with its own rate", () => {
    expect(cursorPricingId("grok-4.7", [{ id: "fast", value: "true" }])).toBe("grok-4.7-fast")
    expect(cursorPricingId("grok-4.7", [{ id: "fast", value: "false" }])).toBe("grok-4.7")
    expect(cursorPricingId("grok-4.7", [])).toBe("grok-4.7")
    expect(cursorPricingId("no-such-model", [{ id: "fast", value: "true" }])).toBe("no-such-model")
    expect(getCursorModelCost(cursorPricingId("grok-4.7", [{ id: "fast", value: "true" }]))?.input).toBe(4)
  })

  it("prices a step at the tier its prompt size selects, unpriced cache categories at nothing", () => {
    expect(hostStepPrices(GROK, 200_000)).toEqual({ input: 2e-6, output: 6e-6, cacheRead: 5e-7, cacheWrite: 0 })
    expect(hostStepPrices(GROK, 200_001)).toEqual({ input: 4e-6, output: 12e-6, cacheRead: 1e-6, cacheWrite: 0 })
    expect(hostStepPrices(undefined, 10)).toBeUndefined()
  })

  it("computes what Cursor billed for a Run from TurnEnded", () => {
    // Observed Grok 4.7 turn: 322,441 input (282,240 cached), 7,229 output.
    const usd = turnEndedCostUsd(GROK, {
      inputTokens: 322_441, outputTokens: 7_229, cacheRead: 282_240, cacheWrite: 0, reasoningTokens: 4_941,
    }, 45_934)!
    expect(usd).toBeCloseTo(40_201 * 2e-6 + 282_240 * 5e-7 + 7_229 * 6e-6, 9)
    // A cache category without its own rate is billed as input.
    expect(turnEndedCostUsd({ input: 1, output: 1 }, {
      inputTokens: 100, outputTokens: 0, cacheRead: 40, cacheWrite: 10, reasoningTokens: 0,
    }, 100)).toBeCloseTo(100e-6, 12)
    expect(turnEndedCostUsd(undefined, {
      inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0,
    }, 1)).toBeUndefined()
  })
})

describe("shapeStepUsage", () => {
  it("bills a step like one model call: the carried-over context from cache, the rest as input", () => {
    const { usage, costUsd } = shapeStepUsage({ usedTokens: 29_467, prefixTokens: 22_944, prices: hostStepPrices(GROK, 29_466) })
    expect(usage).toEqual({
      inputTokens: { total: 29_466, noCache: 6_522, cacheRead: 22_944, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    })
    expect(costUsd).toBeCloseTo(openCode2Cost(GROK, usage), 12)
    expect(hostUsageCostUsd(hostStepPrices(GROK, 29_466)!, usage)).toBe(costUsd)
    expect(openCode1Cost(nanoAiuForUsd(costUsd))).toBeCloseTo(costUsd, 9)
  })

  it("settles a target within the input/cache range at the occupancy total", () => {
    for (const target of [0.021, 0.048, 0.0799]) {
      const { usage, costUsd } = shapeStepUsage({
        usedTokens: 40_000, prefixTokens: 30_000, prices: hostStepPrices(GROK, 39_999), targetUsd: target,
      })
      expect(total(usage)).toBe(40_000)
      expect(usage.inputTokens.cacheWrite).toBe(0)
      expect(Math.abs(openCode2Cost(GROK, usage) - target)).toBeLessThan(2e-6)
      expect(costUsd).toBeCloseTo(openCode2Cost(GROK, usage), 12)
    }
  })

  it("clamps a target outside what the occupancy can carry", () => {
    const prices = hostStepPrices(GROK, 39_999)
    const high = shapeStepUsage({ usedTokens: 40_000, prefixTokens: 0, prices, targetUsd: 10 })
    expect(high.usage.inputTokens.noCache).toBe(39_999)
    expect(high.costUsd).toBeCloseTo(39_999 * 2e-6 + 6e-6, 12)
    // Grok has no cache-write rate, so the host charges it nothing: an
    // over-billed session can be brought down to the output token alone.
    const low = shapeStepUsage({ usedTokens: 40_000, prefixTokens: 30_000, prices, targetUsd: -1 })
    expect(low.usage.inputTokens.cacheWrite).toBe(39_999)
    expect(low.costUsd).toBeCloseTo(6e-6, 12)
    expect(total(low.usage)).toBe(40_000)
  })

  it("reaches above the input rate through a dearer cache-write rate", () => {
    const prices = hostStepPrices(CLAUDE, 9_999)
    const { usage, costUsd } = shapeStepUsage({ usedTokens: 10_000, prefixTokens: 0, prices, targetUsd: 0.035 })
    expect(usage.inputTokens.cacheWrite).toBeGreaterThan(0)
    expect(Math.abs(openCode2Cost(CLAUDE, usage) - 0.035)).toBeLessThan(4e-6)
    expect(costUsd).toBeCloseTo(openCode2Cost(CLAUDE, usage), 12)
  })

  it("keeps the occupancy split and costs nothing for an unpriced model", () => {
    const { usage, costUsd } = shapeStepUsage({ usedTokens: 1_000, prefixTokens: 400, prices: undefined, targetUsd: 5 })
    expect(usage.inputTokens).toEqual({ total: 999, noCache: 599, cacheRead: 400, cacheWrite: 0 })
    expect(costUsd).toBe(0)
  })

  it("reports nothing before any occupancy is known", () => {
    expect(shapeStepUsage({ usedTokens: 0, prefixTokens: 5, prices: hostStepPrices(GROK, 0) }).costUsd).toBe(0)
  })
})

describe("BillingLedger", () => {
  it("tracks real against billed per session", () => {
    const ledger = new BillingLedger()
    ledger.recordReal("s", 0.3)
    ledger.recordBilled("s", 0.1)
    ledger.recordBilled("s", 0.05)
    expect(ledger.outstanding("s")).toBeCloseTo(0.15, 12)
    expect(ledger.outstanding("other")).toBe(0)
    ledger.recordReal("s", Number.NaN)
    ledger.recordBilled("s", -1)
    expect(ledger.totals("s")).toEqual({ realUsd: 0.3, billedUsd: 0.15000000000000002 })
  })
})

function serverFrame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

function checkpoint(usedTokens: number): Uint8Array {
  return encodeMessage("ConversationStateStructure", {
    token_details: { used_tokens: usedTokens, max_tokens: 256_000 },
  })
}

function pricedRun(id: string, key: string, frames: Frame[], prefixTokens: number): CursorSession {
  let index = 0
  return sessionFixture({
    sessionId: id,
    conversationId: `conv-${id}`,
    billing: { key, cost: GROK, prefixTokens },
    stream: {
      write() {},
      end() {},
      frames: () => ({ async *[Symbol.asyncIterator]() { yield* frames } }),
      destroy() {},
      isClosed: () => false,
      onTerminal: () => () => {},
    },
    frames: {
      next: async () => index < frames.length
        ? { done: false, value: frames[index++]! }
        : { done: true, value: undefined },
    },
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    allowTools: true,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    pumpActive: false,
    heartbeat: null,
  })
}

async function finishOf(session: CursorSession): Promise<any> {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  try {
    await pump(session, controller, { textId: "t", reasoningId: "r" })
  } finally {
    sessionManager.dispose()
  }
  return parts.find((part) => part.type === "finish")
}

const turn = (input: number, cacheRead: number, output: number) => serverFrame({
  interaction_update: {
    turn_ended: { input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_write: 0 },
  },
})

describe("turn-end settlement through a Run", () => {
  it("bills Cursor's real turn cost on both hosts while reporting the occupancy snapshot", async () => {
    const finish = await finishOf(pricedRun("settle", "ses_settle", [
      serverFrame({ conversation_checkpoint_update: checkpoint(40_000) }),
      turn(60_000, 50_000, 500),
    ], 30_000))
    const real = 10_000 * 2e-6 + 50_000 * 5e-7 + 500 * 6e-6
    expect(total(finish.usage)).toBe(40_000)
    expect(Math.abs(openCode2Cost(GROK, finish.usage) - real)).toBeLessThan(2e-6)
    expect(openCode1Cost(finish.providerMetadata.copilot.totalNanoAiu)).toBeCloseTo(openCode2Cost(GROK, finish.usage), 9)
    expect(finish.providerMetadata.cursor.billing).toMatchObject({ estimate: false })
    expect(finish.providerMetadata.cursor.billing.sessionRealUsd).toBeCloseTo(real, 12)
    expect(billingLedger.outstanding("ses_settle")).toBeCloseTo(real - openCode2Cost(GROK, finish.usage), 12)
  })

  it("carries what one turn's snapshot cannot hold to the next turn", async () => {
    // A long agent Run: far more request work than one 20k-token snapshot can carry.
    const first = await finishOf(pricedRun("carry-1", "ses_carry", [
      serverFrame({ conversation_checkpoint_update: checkpoint(20_000) }),
      turn(200_000, 180_000, 2_000),
    ], 0))
    const realFirst = 20_000 * 2e-6 + 180_000 * 5e-7 + 2_000 * 6e-6
    expect(first.providerMetadata.cursor.billing.stepUsd).toBeCloseTo(19_999 * 2e-6 + 6e-6, 12)
    const second = await finishOf(pricedRun("carry-2", "ses_carry", [
      serverFrame({ conversation_checkpoint_update: checkpoint(80_000) }),
      turn(22_000, 20_000, 100),
    ], 20_000))
    const realSecond = 2_000 * 2e-6 + 20_000 * 5e-7 + 100 * 6e-6
    const billed = openCode2Cost(GROK, first.usage) + openCode2Cost(GROK, second.usage)
    expect(Math.abs(billed - (realFirst + realSecond))).toBeLessThan(4e-6)
    expect(Math.abs(billingLedger.outstanding("ses_carry"))).toBeLessThan(4e-6)
  })

  it("keeps an unpriced model at no cost", async () => {
    const session = pricedRun("unpriced", "ses_unpriced", [
      serverFrame({ conversation_checkpoint_update: checkpoint(10_000) }),
      turn(10_000, 0, 10),
    ], 0)
    delete session.billing.cost
    const finish = await finishOf(session)
    expect(finish.providerMetadata.copilot).toEqual({ totalNanoAiu: 0 })
    expect(total(finish.usage)).toBe(10_000)
    expect(billingLedger.totals("ses_unpriced")).toEqual({ realUsd: 0, billedUsd: 0 })
  })
})
