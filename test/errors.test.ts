import { describe, expect, it } from "bun:test"
import {
  CursorAuthError,
  CursorProtocolError,
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  cursorGrpcError,
  cursorHttpError,
  retrySuppressedError,
  sanitizeHostTerminalMessage,
  toCursorProviderError,
} from "../src/errors.js"
import { connectFrameError, resolveRetryPolicy } from "../src/language-model.js"

describe("Cursor provider errors", () => {
  it("classifies auth, server, and transport failures without response payloads", () => {
    expect(cursorHttpError("request failed:", 401)).toBeInstanceOf(CursorAuthError)
    expect(cursorHttpError("request failed:", 429)).toMatchObject({
      origin: "server",
      transient: true,
      replaySafe: true,
    })
    expect(cursorGrpcError("request failed:", "unavailable")).toMatchObject({
      origin: "server",
      transient: true,
    })
    expect(toCursorProviderError(Object.assign(new Error("reset"), { code: "ECONNRESET" }), {
      replaySafe: true,
    })).toBeInstanceOf(CursorTransportError)
  })

  it("does not treat bare TypeError configuration failures as transient", () => {
    expect(toCursorProviderError(new TypeError("Invalid URL"), {
      replaySafe: true,
    })).toBeInstanceOf(CursorProtocolError)
  })

  it("strictly bounds retry policy options", () => {
    expect(resolveRetryPolicy(undefined)).toEqual({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
    })
    expect(() => resolveRetryPolicy({ maxAttempts: 0 })).toThrow()
    expect(() => resolveRetryPolicy({ maxAttempts: 11 })).toThrow()
    expect(() => resolveRetryPolicy({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow()
    expect(() => resolveRetryPolicy({ typo: 1 } as any)).toThrow()
  })

  it("decodes and caps protobuf RetryInfo delays", () => {
    const failure = connectFrameError(JSON.stringify({
      error: {
        code: "resource_exhausted",
        details: [
          // google.rpc.RetryInfo{retry_delay: Duration{seconds:45}}
          { type: "google.rpc.RetryInfo", value: "CgIILQ==" },
        ],
      },
    }))
    expect(failure).toMatchObject({ transient: true, retryAfterMs: 30_000 })
  })

  it("uses the shared gRPC retry classification for Connect envelopes", () => {
    for (const code of ["resource_exhausted", "internal"]) {
      expect(connectFrameError(JSON.stringify({ error: { code } }))).toMatchObject({
        code,
        transient: true,
        replaySafe: true,
      })
    }
  })

  it("preserves structured server diagnostics without exposing a cause message", () => {
    const failure = new CursorServerError("Cursor API error (code=unavailable)", {
      transient: true,
      replaySafe: true,
      code: "unavailable",
      retryAfterMs: 500,
      cause: new Error("private backend detail"),
    })
    expect(failure.message).not.toContain("private backend detail")
    expect(failure).toMatchObject({ code: "unavailable", retryAfterMs: 500 })
  })

  it("strips OpenCode SessionRetry trigger words from terminal host messages", () => {
    expect(sanitizeHostTerminalMessage("Cursor API error (code=unavailable)")).toBe(
      "Cursor API error (code=capacity_limit)",
    )
    expect(sanitizeHostTerminalMessage("resource_exhausted / overloaded")).toBe(
      "capacity_limit / capacity_limit",
    )

    const last = new CursorServerError("Cursor API error (code=unavailable)", {
      transient: true,
      replaySafe: true,
      code: "unavailable",
      grpcStatus: "unavailable",
    })
    const exhausted = new CursorRetryExhaustedError(3, last)
    expect(exhausted.transient).toBe(false)
    expect(exhausted.code).toBe("unavailable")
    expect(exhausted.grpcStatus).toBe("unavailable")
    expect(exhausted.message.toLowerCase()).not.toMatch(/unavailable|exhausted/)
    expect(exhausted.message).toContain("capacity_limit")

    const suppressed = retrySuppressedError(
      last,
      "after visible output or stateful server activity",
      1,
      3,
    )
    expect(suppressed.transient).toBe(false)
    expect(suppressed.code).toBe("unavailable")
    expect(suppressed.message.toLowerCase()).not.toMatch(/unavailable|exhausted/)
    expect(suppressed.message).toContain("automatic retry unsafe")
  })
})
