import { describe, expect, it } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import {
  CursorAuthError,
  CursorProtocolError,
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  cursorGrpcError,
  cursorHttpError,
  hostFacingError,
  hostRetryError,
  noProgressResumeError,
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
      maxAttempts: undefined,
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

  it("shows Cursor's ErrorDetails and hands a non-retryable verdict to the host as a 4xx APICallError", () => {
    const failure = connectFrameError(JSON.stringify({
      error: {
        code: "invalid_argument",
        message: "Error",
        details: [{
          type: "aiserver.v1.ErrorDetails",
          // ErrorDetails{error:13, details{title, detail, is_retryable:false, analytics}, is_expected:true}
          value: "CA0SlgEKHFJlcXVlc3QgYmxvY2tlZCBieSBBbnRocm9waWMSXVdlIGFyZSB1bmFibGUgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0IGJlY2F1c2UgaXQgd2FzIGJsb2NrZWQgdW5kZXIgQW50aHJvcGljJ3MgVXNhZ2UgUG9saWN5LiAAUhUKE2N5YmVyX3BvbGljeV9yZXZpZXcYAQ",
        }],
      },
    }))
    const message = "Cursor API error (code=invalid_argument): Request blocked by Anthropic " +
      "We are unable to complete this request because it was blocked under Anthropic's Usage Policy."
    expect(failure).toMatchObject({ message, code: "invalid_argument", transient: false, retryable: false })

    const host = hostFacingError(failure)
    expect(APICallError.isInstance(host)).toBe(true)
    expect(host).toMatchObject({
      message,
      statusCode: 400,
      isRetryable: false,
      responseHeaders: { "x-should-retry": "false" },
    })
    expect((host as APICallError).cause).toBe(failure)
  })

  it("keeps a non-retryable verdict on codes whose HTTP status reads as retryable", () => {
    // ErrorDetails{details{title:"Limit", is_retryable:false}}
    const value = Buffer.from([0x12, 0x09, 0x0a, 0x05, ...Buffer.from("Limit"), 0x20, 0x00]).toString("base64")
    // OpenCode 1.x retries any status >= 500, so 5xx codes are reported as 400.
    for (const [code, statusCode] of [["resource_exhausted", 429], ["internal", 400], ["aborted", 409], ["constructor", 400]] as const) {
      const failure = connectFrameError(JSON.stringify({
        error: { code, details: [{ type: "aiserver.v1.ErrorDetails", value }] },
      }))
      expect(failure).toMatchObject({ transient: false, retryable: false })
      expect(hostFacingError(failure)).toMatchObject({
        statusCode,
        isRetryable: false,
        responseHeaders: { "x-should-retry": "false" },
      })
    }
  })

  it("keeps OpenCode 1.x from retrying a non-retryable verdict through its message text", () => {
    // OpenCode 1.19 SessionRetry retries any APIError whose message matches these,
    // even with isRetryable false (upstream packages/opencode/src/session/retry.ts).
    const opencode1Retries = (message: string) => [
      /429|500|502|503|504|524/i,
      /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
      /overloaded|service unavailable|internal error|server error|provider returned error/i,
      /terminated|fetch failed|network[-_\s]error|connection error|socket hang up|econnreset|etimedout/i,
      /try your request again|retry your request|resource exhausted|resource_exhausted/i,
      /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
    ].some((pattern) => pattern.test(message))
    // ErrorDetails{details{title, detail, is_retryable:false}}, shaped like a live usage-limit refusal.
    const title = Buffer.from("You've hit your usage limit")
    const detail = Buffer.from("Saved $1500 on the 500k tier. Rate limit: try again later.")
    const inner = Buffer.from([0x0a, title.length, ...title, 0x12, detail.length, ...detail, 0x20, 0x00])
    const value = Buffer.from([0x12, inner.length, ...inner]).toString("base64")
    const failure = connectFrameError(JSON.stringify({
      error: { code: "resource_exhausted", details: [{ type: "aiserver.v1.ErrorDetails", value }] },
    }))
    expect(failure).toMatchObject({ code: "resource_exhausted", retryable: false })
    expect(opencode1Retries(failure.message)).toBe(true)

    const host = hostFacingError(failure) as APICallError
    expect(host).toMatchObject({ statusCode: 429, isRetryable: false })
    expect(opencode1Retries(host.message)).toBe(false)
    expect(host.message.toLowerCase()).not.toMatch(/exhausted|unavailable/)
    expect(host.message.replaceAll("\u2060", "")).toBe(
      "Cursor API error (code=capacity_limit): You've hit your usage limit " +
        "Saved $1500 on the 500k tier. Rate limit: try again later.",
    )
    expect(sanitizeHostTerminalMessage("Request blocked by Anthropic")).toBe("Request blocked by Anthropic")
  })

  it("follows Cursor CLI's verdict for error codes, required actions and permission_denied", () => {
    // Hand-encoded ErrorDetails{error #1, details #2{title #1, is_retryable #4,
    // analytics_metadata #10{action_required #1}}} per aiserver.v1.
    const text = (field: number, value: string) => [(field << 3) | 2, value.length, ...Buffer.from(value)]
    const nested = (field: number, bytes: number[]) => [(field << 3) | 2, bytes.length, ...bytes]
    const errorFor = (code: string, error: number, options: { retryable?: boolean; action?: string } = {}) => {
      const details = nested(2, [
        ...text(1, "Stop"),
        ...(options.retryable === undefined ? [] : [0x20, options.retryable ? 1 : 0]),
        ...(options.action ? nested(10, text(1, options.action)) : []),
      ])
      const value = Buffer.from([...(error ? [0x08, error] : []), ...details]).toString("base64")
      return connectFrameError(JSON.stringify({
        error: { code, details: [{ type: "aiserver.v1.ErrorDetails", value }] },
      }))
    }
    // Cursor CLI ends the request on usage/rate limits, login, pricing and API-key
    // errors and on cancellation, even when is_retryable says true.
    const terminalCodes = [51, 50, 10, 2, 44, 1, 30, 21, 35]
    expect(terminalCodes.filter(error => errorFor("resource_exhausted", error, { retryable: true }).retryable !== false))
      .toEqual([])
    expect(errorFor("internal", 0, { retryable: true, action: "upgrade" }).retryable).toBe(false)
    expect(errorFor("internal", 29).retryable).toBe(false)
    expect(errorFor("internal", 29, { retryable: true })).toMatchObject({ retryable: true, transient: true })
    expect(errorFor("internal", 13)).toMatchObject({ transient: true })
    expect(errorFor("internal", 13).retryable).toBeUndefined()
    expect(errorFor("permission_denied", 0, { retryable: true })).toMatchObject({ retryable: true })
    expect(errorFor("canceled", 0).retryable).toBe(false)

    const denied = connectFrameError(JSON.stringify({ error: { code: "permission_denied" } }))
    expect(denied).toBeInstanceOf(CursorServerError)
    expect(denied).toMatchObject({ code: "permission_denied", retryable: false, transient: false })
    expect(hostFacingError(denied)).toMatchObject({ statusCode: 403, isRetryable: false })

    const final = hostFacingError(errorFor("unknown", 29)) as APICallError
    expect(final).toMatchObject({ statusCode: 400, isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
    expect((final.cause as CursorServerError).code).toBe("unknown")
  })

  it("ends the turn on an authentication failure as Cursor CLI does", () => {
    const expired = connectFrameError(JSON.stringify({ error: { code: "unauthenticated" } }))
    expect(expired).toBeInstanceOf(CursorAuthError)
    expect(hostFacingError(expired)).toMatchObject({
      statusCode: 401,
      isRetryable: false,
      responseHeaders: { "x-should-retry": "false" },
    })
    expect(hostFacingError(new CursorAuthError(undefined, { statusCode: 403 }))).toMatchObject({ statusCode: 403 })
  })

  it("obeys an explicit retryable verdict and keeps other errors unchanged for the host", () => {
    // ErrorDetails{details{title:"Busy", is_retryable:true}}
    const value = Buffer.from([0x12, 0x08, 0x0a, 0x04, ...Buffer.from("Busy"), 0x20, 0x01]).toString("base64")
    const failure = connectFrameError(JSON.stringify({
      error: { code: "failed_precondition", details: [{ type: "aiserver.v1.ErrorDetails", value }] },
    }))
    expect(failure).toMatchObject({
      message: "Cursor API error (code=failed_precondition): Busy",
      transient: true,
      retryable: true,
    })
    expect(hostFacingError(failure)).toBe(failure)

    const plain = connectFrameError(JSON.stringify({ error: { code: "invalid_argument" } }))
    expect(plain).toMatchObject({ message: "Cursor API error (code=invalid_argument)", transient: false })
    expect(plain.retryable).toBeUndefined()
    expect(hostFacingError(plain)).toBe(plain)
  })

  it("ignores undecodable ErrorDetails", () => {
    const failure = connectFrameError(JSON.stringify({
      error: { code: "internal", details: [{ type: "aiserver.v1.ErrorDetails", value: "EgX/" }] },
    }))
    expect(failure).toMatchObject({ message: "Cursor API error (code=internal)", transient: true })
    expect(failure.retryable).toBeUndefined()
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

  it("projects spent and unsafe retries as terminal even when their cause was an HTTP 503", () => {
    const last = cursorHttpError("Cursor request failed:", 503)
    const failures = [
      new CursorRetryExhaustedError(3, last),
      retrySuppressedError(last, "after visible output", 1, 3),
    ]
    expect(failures.map(failure => {
      const host = hostFacingError(failure) as APICallError
      return {
        statusCode: failure.statusCode,
        transient: failure.transient,
        retryable: failure.retryable,
        hostInstance: APICallError.isInstance(host),
        hostStatus: host.statusCode ?? null,
        hostRetryable: host.isRetryable ?? null,
        hostShouldRetry: host.responseHeaders?.["x-should-retry"] ?? null,
        sameCause: host.cause === failure,
        mentions503: host.message.includes("503"),
      }
    })).toEqual(failures.map(() => ({
      statusCode: 503,
      transient: false,
      retryable: false,
      hostInstance: true,
      hostStatus: 400,
      hostRetryable: false,
      hostShouldRetry: "false",
      sameCause: true,
      mentions503: false,
    })))
  })

  it("lets the host retry a turn that only showed output, as Cursor CLI resends the action", () => {
    const cause = new CursorTransportError("Cursor Run transport interrupted", {
      transient: true,
      replaySafe: false,
      code: "NGHTTP2_INTERNAL_ERROR",
      retryAfterMs: 1_500,
    })
    const failure = hostRetryError(cause)
    expect(failure).toMatchObject({ hostRetryable: true, transient: false, replaySafe: false })
    expect(failure.retryable).toBeUndefined()
    const host = hostFacingError(failure)
    expect(APICallError.isInstance(host)).toBe(true)
    // No status: OpenCode 2 then treats it as a transport failure and honours the header.
    expect(host).toMatchObject({
      statusCode: undefined,
      isRetryable: true,
      responseHeaders: { "x-should-retry": "true", "retry-after-ms": "1500" },
    })
    expect((host as APICallError).cause).toBe(failure)
  })

  it("ends the turn after resumes that made no progress, as Cursor CLI does", () => {
    const cause = new CursorTransportError("Cursor Run transport interrupted", { transient: true, replaySafe: false })
    const host = hostFacingError(noProgressResumeError(cause, 2))
    expect(APICallError.isInstance(host)).toBe(true)
    expect(host).toMatchObject({ isRetryable: false, responseHeaders: { "x-should-retry": "false" } })
    expect(host.message).toContain("2 resume attempts made no progress")
  })
})
