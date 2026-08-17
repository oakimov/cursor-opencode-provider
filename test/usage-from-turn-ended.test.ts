import { describe, expect, it } from "bun:test"
import {
  buildLanguageModelV3UsageFromCounters,
  buildLanguageModelV3UsageFromTurnEnded,
  formatCursorCacheDiagnostics,
  formatCursorTokenCategories,
  formatTurnUsageValidation,
  flatUsageFromV3,
  turnEndedCounter,
} from "../src/usage.js"

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
    expect(usage.inputTokens?.total).toBe(100)
    expect(usage.inputTokens?.noCache).toBe(85)
    expect(usage.inputTokens?.cacheRead).toBe(10)
    expect(usage.inputTokens?.cacheWrite).toBe(5)
    expect(usage.outputTokens?.total).toBe(50)
    expect(usage.outputTokens?.text).toBe(43)
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

  it("projects V3 usage into flat counter fields", () => {
    const flat = flatUsageFromV3(buildLanguageModelV3UsageFromTurnEnded(te))
    expect(flat).toEqual({
      inputTokens: 85,
      outputTokens: 43,
      reasoningTokens: 7,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 5,
    })
  })

  it("maps every request independently even when counters decrease between turns", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded({
      input_tokens: 42_563,
      output_tokens: 1_141,
      cache_read: 27_392,
      cache_write: 0,
      reasoning_tokens: 801,
    })
    expect(usage.inputTokens).toEqual({
      total: 42_563,
      noCache: 15_171,
      cacheRead: 27_392,
      cacheWrite: 0,
    })
    expect(usage.outputTokens).toEqual({
      total: 1_141,
      text: 340,
      reasoning: 801,
    })
  })

  it("uses checkpoint occupancy as the total while preserving cache proportions", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_read: 60,
        cache_write: 20,
        reasoning_tokens: 5,
      },
      { contextTotalTokens: 70 },
    )

    expect(usage.inputTokens).toEqual({
      total: 50,
      noCache: 10,
      cacheRead: 30,
      cacheWrite: 10,
    })
    expect(usage.outputTokens).toEqual({
      total: 20,
      text: 15,
      reasoning: 5,
    })
    expect(flatUsageFromV3(usage)).toEqual({
      inputTokens: 10,
      outputTokens: 15,
      reasoningTokens: 5,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 10,
    })

    expect(formatTurnUsageValidation(
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 60,
        cacheWrite: 20,
        reasoningTokens: 5,
      },
      usage,
      {
        usedTokens: 70,
        maxTokens: 100,
        breakdown: {
          totalUsedTokens: 70,
          maxTokens: 100,
          categories: [
            { id: "static", label: "Static", estimatedTokens: 40 },
            { id: "conversation", label: "Conversation", estimatedTokens: 30 },
          ],
        },
      },
    )).toBe(
      "turn usage validation: status=ok source=checkpoint-current-run " +
      "cursor=70/100(70.0%) rawTotal=120 sentTotal=70 totalMatch=true " +
      "input=50 inputParts=50 inputMatch=true output=20 outputParts=20 outputMatch=true " +
      "opencodeProjectedTotal=70 opencodeMatch=true breakdownTotal=70 categorySum=70 " +
      "breakdownMatch=true rawCachedRatio=80.0% sentCachedRatio=80.0% cacheRatioMatch=true",
    )
  })

  it("marks context checks unavailable without deriving occupancy from TurnEnded", () => {
    const counters = {
      inputTokens: 10,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
    }
    const validation = formatTurnUsageValidation(
      counters,
      buildLanguageModelV3UsageFromCounters({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
      }),
    )
    expect(validation).toContain("status=ok source=unavailable cursor=unavailable")
    expect(validation).toContain("rawTotal=12 sentTotal=0 totalMatch=unavailable")
    expect(validation).toContain("opencodeProjectedTotal=0 opencodeMatch=true")
    expect(validation).toContain("breakdownMatch=unavailable")
    expect(validation).toContain("cacheRatioMatch=unavailable")
  })
})

describe("Cursor cache diagnostics", () => {
  const prior = {
    usedTokens: 40_000,
    maxTokens: 256_000,
    breakdown: {
      totalUsedTokens: 40_000,
      maxTokens: 256_000,
      categories: [
        { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
        { id: "tools", label: "Tools", estimatedTokens: 9_000 },
        { id: "conversation", label: "Conversation", estimatedTokens: 30_000 },
      ],
    },
  }
  const current = {
    usedTokens: 45_000,
    maxTokens: 256_000,
    breakdown: {
      totalUsedTokens: 45_000,
      maxTokens: 256_000,
      categories: [
        { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
        { id: "tools", label: "Tools", estimatedTokens: 9_000 },
        { id: "conversation", label: "Conversation", estimatedTokens: 35_000 },
      ],
    },
  }

  it("prints checkpoint categories as compact JSON", () => {
    expect(formatCursorTokenCategories(current)).toBe(
      '{"system_prompt":1000,"tools":9000,"conversation":35000}',
    )
    expect(formatCursorTokenCategories(undefined)).toBe("unavailable")
  })

  it("separates warm-prefix evidence from Cursor's aggregate cache ratio", () => {
    expect(formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 2_000,
        cacheRead: 20_000,
        cacheWrite: 5_000,
        reasoningTokens: 1_000,
      },
      current,
      prior,
      {
        sessionKey: "ses_cache",
        conversationId: "conversation-cache",
        conversationGroupId: "group-cache",
        modelId: "cursor/default",
        startedWithCheckpoint: true,
        requestContextReused: true,
        requestContextHash: "0123456789abcdef-rest",
        systemPromptHash: "fedcba9876543210-rest",
        checkpointUpdates: 4,
        tokenDetailUpdates: 3,
        pumpPasses: 2,
        stepStarts: 3,
        stepCompletes: 3,
        displayToolCalls: 1,
        execRequests: 5,
      },
    )).toBe(
      "cache diagnosis: sessionKey=ses_cache conversationId=conversation-cache " +
      "conversationGroupId=group-cache model=cursor/default continuity=warm " +
      "rawInput=50000 rawCacheRead=20000 " +
      "rawCacheWrite=5000 rawUncached=25000 rawReadRatio=40.0% rawWriteRatio=10.0% " +
      "priorContext=40000 currentContext=45000 contextDelta=5000 " +
      "rawReadVsPriorContext=50.0% sameSizedCategoryTokens=10000 " +
      'categoryDelta={"system_prompt":0,"tools":0,"conversation":5000} ' +
      "requestContext=reused requestContextHash=0123456789abcdef " +
      "systemPromptHash=fedcba9876543210 systemPromptSent=false " +
      "checkpointUpdates=4 tokenDetailUpdates=3 " +
      "pumpPasses=2 steps=3/3 displayToolCalls=1 execRequests=5 " +
      "perModelCallCache=unavailable",
    )
  })

  it("marks a seeded Run as cold instead of implying a cache failure", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 10_000,
        outputTokens: 100,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      current,
      undefined,
      {
        conversationId: "conversation-cold",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "abc",
        checkpointUpdates: 1,
        tokenDetailUpdates: 1,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 0,
        execRequests: 1,
      },
    )
    expect(line).toContain("continuity=cold")
    expect(line).toContain("priorContext=unavailable")
    expect(line).toContain("rawReadVsPriorContext=n/a")
    expect(line).toContain("sameSizedCategoryTokens=unavailable")
    expect(line).toContain("categoryDelta=unavailable")
    expect(line).toContain("systemPromptSent=true")
  })
})
