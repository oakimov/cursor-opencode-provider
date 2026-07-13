import { describe, it, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  resolveConversationId,
  sessionIdToUuid,
} from "../src/language-model.js"

describe("sessionIdToUuid / resolveConversationId", () => {
  it("is deterministic for the same OpenCode session id", () => {
    const a = sessionIdToUuid("ses_0a630a3a0ffeutu6u0DKQrDZii")
    const b = sessionIdToUuid("ses_0a630a3a0ffeutu6u0DKQrDZii")
    expect(a).toBe(b)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it("differs across OpenCode sessions", () => {
    expect(sessionIdToUuid("ses_aaa")).not.toBe(sessionIdToUuid("ses_bbb"))
  })

  it("reads X-Session-Id from callOptions.headers", () => {
    const id = resolveConversationId({
      prompt: [],
      headers: { "X-Session-Id": "ses_stable_1" },
    } as LanguageModelV3CallOptions)
    expect(id).toBe(sessionIdToUuid("ses_stable_1"))
  })

  it("reads x-session-affinity as a fallback", () => {
    const id = resolveConversationId({
      prompt: [],
      headers: { "x-session-affinity": "ses_affinity" },
    } as LanguageModelV3CallOptions)
    expect(id).toBe(sessionIdToUuid("ses_affinity"))
  })

  it("falls back to a random UUID when no session header is present", () => {
    const a = resolveConversationId({ prompt: [] } as LanguageModelV3CallOptions)
    const b = resolveConversationId({ prompt: [] } as LanguageModelV3CallOptions)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(a).not.toBe(b)
  })
})
