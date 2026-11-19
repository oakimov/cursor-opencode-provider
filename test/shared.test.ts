import { describe, expect, it } from "bun:test"
import { CONVERSATION_CACHE_TTL_MS, resolveConversationCacheTtlMs } from "../src/shared.js"

describe("resolveConversationCacheTtlMs", () => {
  it("defaults to the baseline retention window", () => {
    expect(resolveConversationCacheTtlMs({})).toBe(CONVERSATION_CACHE_TTL_MS)
    expect(CONVERSATION_CACHE_TTL_MS).toBe(86_400_000)
  })

  it("accepts a positive integer override", () => {
    expect(resolveConversationCacheTtlMs({ CURSOR_PROVIDER_CACHE_TTL_MS: "604800000" }))
      .toBe(604_800_000)
    expect(resolveConversationCacheTtlMs({ CURSOR_PROVIDER_CACHE_TTL_MS: "5000" })).toBe(5000)
    expect(resolveConversationCacheTtlMs({ CURSOR_PROVIDER_CACHE_TTL_MS: "  604800000  " }))
      .toBe(604_800_000)
    expect(resolveConversationCacheTtlMs({ CURSOR_PROVIDER_CACHE_TTL_MS: "1" })).toBe(1)
  })

  it("ignores empty, malformed, non-positive, and unsafe values", () => {
    for (const value of [
      "",
      " ",
      "abc",
      "1.5",
      "0",
      "-1",
      "1e3",
      "+5000",
      "5000ms",
      "99999999999999999999",
    ]) {
      expect(resolveConversationCacheTtlMs({ CURSOR_PROVIDER_CACHE_TTL_MS: value }))
        .toBe(CONVERSATION_CACHE_TTL_MS)
    }
  })

  it("ignores an absent variable", () => {
    expect(resolveConversationCacheTtlMs({ CURSOR_PROVIDER_CACHE_TTL_MS: undefined }))
      .toBe(CONVERSATION_CACHE_TTL_MS)
  })
})
