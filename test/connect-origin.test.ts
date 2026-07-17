import { describe, it, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  buildBaseHeaders,
  cursorRunTerminationError,
  HTTP2_SESSION_MAX_AGE_MS,
  isAllowedAgentHost,
  normalizeAgentRunOrigin,
  resolveAgentOrigin,
  shouldReuseHttp2Session,
} from "../src/transport/connect.js"
import { createCursor } from "../src/index.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"

const INSTALLER_FIXTURE = `var x="https://downloads.cursor.com/lab/2026.07.09-a3815c0/";`

describe("resolveAgentOrigin", () => {
  it("requires an explicit resolved agent host", () => {
    expect(() => resolveAgentOrigin("")).toThrow("requires an allowlisted Cursor agent base URL")
  })

  it("uses the origin of an allowlisted Cursor agent host", () => {
    expect(resolveAgentOrigin("https://agentn.us.api5.cursor.sh/agent")).toBe(
      "https://agentn.us.api5.cursor.sh",
    )
  })

  it("keeps distinct allowlisted origins distinct (cache key property)", () => {
    const a = resolveAgentOrigin("https://agentn.us.api5.cursor.sh")
    const b = resolveAgentOrigin("https://agentn.eu.api5.cursor.sh")
    expect(a).not.toBe(b)
  })

  it("rejects non-agent hosts at the transport boundary", () => {
    expect(() => resolveAgentOrigin("https://alt.example:9443/agent")).toThrow(
      "requires an allowlisted Cursor agent base URL",
    )
    expect(() => resolveAgentOrigin("https://127.0.0.1:8443")).toThrow(
      "requires an allowlisted Cursor agent base URL",
    )
  })
})

describe("normalizeAgentRunOrigin", () => {
  it("accepts https origins under *.cursor.sh", () => {
    expect(normalizeAgentRunOrigin("https://agentn.us.api5.cursor.sh")).toBe(
      "https://agentn.us.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("agentn.eu.api5.cursor.sh")).toBe(
      "https://agentn.eu.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agent.api5.cursor.sh")).toBe(
      "https://agent.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agentn.api5.cursor.sh")).toBe(
      "https://agentn.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agent-gcpp-uswest.api5.cursor.sh")).toBe(
      "https://agent-gcpp-uswest.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agent-gcpp-eucentral.api5.cursor.sh")).toBe(
      "https://agent-gcpp-eucentral.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agent-gcpp-apsoutheast.api5.cursor.sh")).toBe(
      "https://agent-gcpp-apsoutheast.api5.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agentn.global.api5lat.cursor.sh")).toBe(
      "https://agentn.global.api5lat.cursor.sh",
    )
    expect(normalizeAgentRunOrigin("https://agentn.global.api5.cursor.sh")).toBe(
      "https://agentn.global.api5.cursor.sh",
    )
  })

  it("strips paths and rejects non-*.cursor.sh hosts and http", () => {
    expect(normalizeAgentRunOrigin("https://evil.example")).toBeNull()
    expect(normalizeAgentRunOrigin("http://agentn.us.api5.cursor.sh")).toBeNull()
    expect(normalizeAgentRunOrigin("https://agentn.us.api5.cursor.sh/extra?a=b#c")).toBe(
      "https://agentn.us.api5.cursor.sh",
    )
    expect(isAllowedAgentHost("agentn.us.api5.cursor.sh")).toBe(true)
    expect(isAllowedAgentHost("agent-gcpp-uswest.api5.cursor.sh")).toBe(true)
    expect(isAllowedAgentHost("evil.example")).toBe(false)
    expect(isAllowedAgentHost("cursor.sh")).toBe(false)
    expect(isAllowedAgentHost("cursor.sh.evil.com")).toBe(false)
  })
})

describe("buildBaseHeaders", () => {
  it("uses the supplied client version", () => {
    const headers = buildBaseHeaders("token", "cli-test-123")
    expect(headers["x-cursor-client-version"]).toBe("cli-test-123")
  })
})

describe("Run transport lifecycle", () => {
  it("rotates an otherwise-open shared HTTP/2 session before its maximum age", () => {
    const state = { destroyed: false, closed: false }
    expect(shouldReuseHttp2Session(state, 1_000, 1_000 + HTTP2_SESSION_MAX_AGE_MS - 1)).toBe(true)
    expect(shouldReuseHttp2Session(state, 1_000, 1_000 + HTTP2_SESSION_MAX_AGE_MS)).toBe(false)
    expect(shouldReuseHttp2Session({ destroyed: true, closed: false }, 1_000, 1_001)).toBe(false)
  })

  it("uses response trailers when reporting a remotely ended Run", () => {
    const error = cursorRunTerminationError({
      responseStatus: 200,
      responseHeaders: { "grpc-status": "0" },
      responseTrailers: { "grpc-status": "14", "grpc-message": "upstream unavailable" },
    })
    expect(error.message).toContain("gRPC status 14: upstream unavailable")
  })

  it("does not classify bare HTTP 200 EOF as successful completion", () => {
    expect(cursorRunTerminationError({ responseStatus: 200 }).message).toContain(
      "ended before turn_ended",
    )
  })
})

describe("explicit agent Run host overrides", () => {
  it("rejects non-*.cursor.sh hosts before opening a Run stream", async () => {
    const model = createCursor({
      name: "cursor",
      accessToken: "token",
      agentBaseURL: "https://evil.example",
    }).languageModel("cursor-test")

    await expect(
      model.doStream({
        prompt: [{ role: "user", content: "hello" }],
      } as LanguageModelV3CallOptions),
    ).rejects.toThrow("Invalid Cursor agent base URL override")
  })

  it("surfaces GetServerConfig failure from the model call", async () => {
    const realFetch = globalThis.fetch
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      if (url.includes("GetServerConfig")) {
        throw new Error("config down")
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      const model = createCursor({
        name: "cursor",
        accessToken: "token",
      }).languageModel("cursor-test")

      await expect(
        model.doStream({
          prompt: [{ role: "user", content: "hello" }],
        } as LanguageModelV3CallOptions),
      ).rejects.toThrow("config down")
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })
})
