import { describe, expect, it } from "bun:test"
import {
  buildLanguageModelV3UsageFromEstimate,
  buildLanguageModelV3UsageFromTurnEnded,
  kiloShapedUsageFromV3,
  turnEndedCounter,
} from "../src/usage.js"
import { estimateTokens } from "../src/language-model.js"

describe("turnEndedCounter", () => {
  it("truncates finite non-negative numbers", () => {
    expect(turnEndedCounter({ x: 12.9 }, "x")).toBe(12)
    expect(turnEndedCounter({ x: -1 }, "x")).toBe(0)
    expect(turnEndedCounter({ x: NaN }, "x")).toBe(0)
    expect(turnEndedCounter({}, "x")).toBe(0)
  })
})

describe("buildLanguageModelV3UsageFromTurnEnded", () => {
  const te = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read: 10,
    cache_write: 5,
    reasoning_tokens: 7,
  }

  it("maps nested V3 usage from TurnEnded", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(te)
    expect(usage.inputTokens?.total).toBe(115)
    expect(usage.inputTokens?.noCache).toBe(100)
    expect(usage.inputTokens?.cacheRead).toBe(10)
    expect(usage.inputTokens?.cacheWrite).toBe(5)
    expect(usage.outputTokens?.total).toBe(57)
    expect(usage.outputTokens?.text).toBe(50)
    expect(usage.outputTokens?.reasoning).toBe(7)
  })

  it("defaults missing reasoning_tokens to zero", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded({
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 0,
      cache_write: 0,
    })
    expect(usage.outputTokens?.reasoning).toBe(0)
    expect(usage.outputTokens?.total).toBe(2)
  })

  it("matches Kilo-shaped flat fields", () => {
    const flat = kiloShapedUsageFromV3(buildLanguageModelV3UsageFromTurnEnded(te))
    expect(flat).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 7,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 5,
    })
  })
})

describe("buildLanguageModelV3UsageFromEstimate", () => {
  it("uses prompt estimate when no cache breakdown", () => {
    const usage = buildLanguageModelV3UsageFromEstimate(
      { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      42,
      8,
      estimateTokens,
    )
    expect(usage.inputTokens?.total).toBe(42)
    expect(usage.outputTokens?.total).toBe(estimateTokens(8))
  })
})
