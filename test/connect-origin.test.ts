import { describe, it, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  buildBaseHeaders,
  cursorRunTerminationError,
  fetchAgentUrl,
  HTTP2_SESSION_MAX_AGE_MS,
  isAllowedAgentHost,
  normalizeAgentRunOrigin,
  resolveAgentOrigin,
  shouldReuseHttp2Session,
  unaryAvailableModels,
} from "../src/transport/connect.js"
import { createCursor } from "../src/index.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { CursorProtocolError, CursorTransportError } from "../src/errors.js"

const INSTALLER_FIXTURE = `var x="https://downloads.cursor.com/lab/2026.07.09-a3815c0/";`

function pendingFetchUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return reject(new Error("missing timeout signal"))
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

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

describe("unary startup deadlines", () => {
  it("times out a stalled AvailableModels fetch with a sanitized typed error", async () => {
    const realFetch = globalThis.fetch
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      return pendingFetchUntilAbort(init)
    }) as typeof fetch
    try {
      const error = await unaryAvailableModels("secret-token", { timeoutMs: 10 })
        .then(() => undefined, (cause) => cause)
      expect(error).toBeInstanceOf(CursorTransportError)
      expect(error).toMatchObject({
        code: "CURSOR_AVAILABLE_MODELS_TIMEOUT",
        origin: "transport",
        transient: true,
        replaySafe: true,
      })
      expect(error.message).not.toContain("secret-token")
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })

  it("times out stalled AvailableModels and GetServerConfig JSON body reads", async () => {
    const realFetch = globalThis.fetch
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      const response = Response.json({})
      Object.defineProperty(response, "json", {
        value: () => new Promise<never>(() => {}),
      })
      return response
    }) as typeof fetch
    try {
      const availableModelsError = await unaryAvailableModels("secret-token", { timeoutMs: 10 })
        .then(() => undefined, (cause) => cause)
      const agentUrlError = await fetchAgentUrl("secret-token", { timeoutMs: 10 })
        .then(() => undefined, (cause) => cause)
      expect(availableModelsError).toMatchObject({ code: "CURSOR_AVAILABLE_MODELS_TIMEOUT" })
      expect(agentUrlError).toMatchObject({
        code: "CURSOR_AGENT_URL_TIMEOUT",
        origin: "transport",
        transient: true,
        replaySafe: true,
      })
      expect(availableModelsError.message).not.toContain("secret-token")
      expect(agentUrlError.message).not.toContain("secret-token")
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })

  it("times out a stalled GetServerConfig fetch", async () => {
    const realFetch = globalThis.fetch
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      return pendingFetchUntilAbort(init)
    }) as typeof fetch
    try {
      const error = await fetchAgentUrl("secret-token", { timeoutMs: 10 })
        .then(() => undefined, (cause) => cause)
      expect(error).toBeInstanceOf(CursorTransportError)
      expect(error).toMatchObject({ code: "CURSOR_AGENT_URL_TIMEOUT" })
      expect(error.message).not.toContain("secret-token")
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })

  it("times out unary error-body reads that ignore abort", async () => {
    const realFetch = globalThis.fetch
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      const response = new Response("", { status: 503 })
      Object.defineProperty(response, "text", {
        value: () => new Promise<never>(() => {}),
      })
      return response
    }) as typeof fetch
    try {
      const availableModelsError = await unaryAvailableModels("secret-token", { timeoutMs: 10 })
        .then(() => undefined, (cause) => cause)
      const agentUrlError = await fetchAgentUrl("secret-token", { timeoutMs: 10 })
        .then(() => undefined, (cause) => cause)
      expect(availableModelsError).toMatchObject({ code: "CURSOR_AVAILABLE_MODELS_TIMEOUT" })
      expect(agentUrlError).toMatchObject({ code: "CURSOR_AGENT_URL_TIMEOUT" })
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })

  it("rejects invalid unary timeout values before fetching", async () => {
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error("unexpected fetch")
    }) as typeof fetch
    try {
      for (const request of [
        unaryAvailableModels("secret-token", { timeoutMs: 0 }),
        fetchAgentUrl("secret-token", { timeoutMs: Number.NaN }),
      ]) {
        const error = await request.then(() => undefined, (cause) => cause)
        expect(error).toBeInstanceOf(CursorProtocolError)
        expect(error).toMatchObject({ code: "CURSOR_INVALID_TIMEOUT" })
      }
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
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
    expect(error.message).toContain("gRPC status 14")
    expect(error.message).toContain("upstream unavailable")
  })

  it("retains HTTP response diagnostics when a Run ends remotely", () => {
    const error = cursorRunTerminationError({
      responseStatus: 503,
      responseHeaders: { ":status": 503, "x-cursor-error": "overloaded" },
    })
    expect(error.message).toContain('"x-cursor-error":"overloaded"')
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
        retry: { maxAttempts: 1 },
      }).languageModel("cursor-test")

      await expect(
        model.doStream({
          prompt: [{ role: "user", content: "hello" }],
        } as LanguageModelV3CallOptions),
      ).rejects.toThrow("GetServerConfig network request failed")
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })

  it("retains unary HTTP status text and response bodies", async () => {
    const realFetch = globalThis.fetch
    const responseBody = `${"x".repeat(200)}-truncated`
    resetClientVersionCache()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("cursor.com/install")) {
        return new Response(INSTALLER_FIXTURE, { status: 200 })
      }
      if (url.includes("AvailableModels") || url.includes("GetServerConfig")) {
        return new Response(responseBody, { status: 503, statusText: "Service Unavailable" })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      const expectHttpDiagnostics = async (request: Promise<unknown>) => {
        try {
          await request
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          expect(message).toContain(`Service Unavailable - ${responseBody.slice(0, 200)}`)
          expect(message).not.toContain(responseBody.slice(200))
          return
        }
        throw new Error("expected request to fail")
      }

      await expectHttpDiagnostics(unaryAvailableModels("token"))
      await expectHttpDiagnostics(fetchAgentUrl("token"))
    } finally {
      globalThis.fetch = realFetch
      resetClientVersionCache()
    }
  })
})
