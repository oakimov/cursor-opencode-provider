import { describe, expect, it } from "bun:test"
import {
  CursorAuthError,
  CursorProtocolError,
  CursorServerError,
  CursorTransportError,
  cursorGrpcError,
  cursorHttpError,
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
})
