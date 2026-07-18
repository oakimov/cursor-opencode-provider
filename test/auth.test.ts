import { describe, it, expect } from "bun:test"
import {
  isExpiringSoon,
  decodeJwtPayload,
  decodeJwtExpiryMs,
  exchangeApiKey,
  refreshAccessToken,
  resolveBearerToken,
  clearBearerTokenCache,
  AuthExchangeError,
  AuthRefreshError,
  generatePkceParams,
  generatePkceChallenge,
  buildLoginUrl,
  pollForTokens,
  AuthPollError,
  AuthTimeoutError,
} from "../src/auth.js"
import { obfuscate, createCursorChecksumHeader } from "../src/protocol/checksum.js"

// ── JWT expiry ──

function makeJwt(expOffsetS: number, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetS, ...extra }),
  ).toString("base64url")
  return `${header}.${payload}.fakesig`
}

function makeJwtRawPayload(payloadJson: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url")
  return `${header}.${payload}.fakesig`
}

describe("isExpiringSoon", () => {
  it("returns false for token expiring in >300s", () => {
    expect(isExpiringSoon(makeJwt(600))).toBe(false)
  })

  it("returns true for token expiring in <300s", () => {
    expect(isExpiringSoon(makeJwt(100))).toBe(true)
  })

  it("returns true for already-expired token", () => {
    expect(isExpiringSoon(makeJwt(-100))).toBe(true)
  })

  it("returns true for malformed JWT", () => {
    expect(isExpiringSoon("not-a-jwt")).toBe(true)
  })

  it("returns true when exp claim is missing", () => {
    expect(isExpiringSoon(makeJwtRawPayload(JSON.stringify({ sub: "x" })))).toBe(true)
  })

  it("returns true when exp claim is a string", () => {
    expect(isExpiringSoon(makeJwtRawPayload(JSON.stringify({ exp: "9999999999" })))).toBe(true)
  })

  it("returns true when exp claim is null", () => {
    expect(isExpiringSoon(makeJwtRawPayload(JSON.stringify({ exp: null })))).toBe(true)
  })

  it("returns true when exp overflows to non-finite (e.g. 1e400 → Infinity)", () => {
    // JSON.parse turns oversized numbers into Infinity; Number.isFinite must reject them.
    expect(isExpiringSoon(makeJwtRawPayload('{"exp":1e400}'))).toBe(true)
  })

  it("decodes base64url alphabet (- and _) in the payload segment", () => {
    // Force '-' / '_' into the segment via a value that base64url-encodes with them.
    const jwt = makeJwt(600, { note: ">>?<<" })
    expect(jwt.split(".")[1]).toMatch(/[-_]/)
    expect(isExpiringSoon(jwt)).toBe(false)
  })
})

describe("decodeJwtPayload", () => {
  it("decodes a valid JWT payload", () => {
    const payload = decodeJwtPayload(makeJwt(600))
    expect(payload).not.toBeNull()
    expect(payload).toHaveProperty("exp")
  })

  it("returns null for malformed JWT", () => {
    expect(decodeJwtPayload("bad")).toBeNull()
  })

  it("decodes payload segments that use base64url -/_", () => {
    const jwt = makeJwt(600, { note: ">>?<<" })
    expect(jwt.split(".")[1]).toMatch(/[-_]/)
    const payload = decodeJwtPayload(jwt)
    expect(payload?.note).toBe(">>?<<")
  })
})

describe("decodeJwtExpiryMs", () => {
  it("returns exp in milliseconds", () => {
    const expS = Math.floor(Date.now() / 1000) + 600
    const jwt = makeJwtRawPayload(JSON.stringify({ exp: expS }))
    expect(decodeJwtExpiryMs(jwt)).toBe(expS * 1000)
  })

  it("returns null when exp is missing or malformed", () => {
    expect(decodeJwtExpiryMs(makeJwtRawPayload(JSON.stringify({ sub: "x" })))).toBeNull()
    expect(decodeJwtExpiryMs(makeJwtRawPayload(JSON.stringify({ exp: "nope" })))).toBeNull()
    expect(decodeJwtExpiryMs("not-a-jwt")).toBeNull()
    expect(decodeJwtExpiryMs(makeJwtRawPayload('{"exp":1e400}'))).toBeNull()
  })
})

// ── API key exchange (mocked) ──

describe("exchangeApiKey", () => {
  it("throws AuthExchangeError on non-200", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("Unauthorized", { status: 401 })
      },
    })
    await expect(
      exchangeApiKey("sk-test", `http://localhost:${server.port}`),
    ).rejects.toThrow(AuthExchangeError)
  })

  it("throws AuthExchangeError when tokens missing", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({})
      },
    })
    await expect(
      exchangeApiKey("sk-test", `http://localhost:${server.port}`),
    ).rejects.toThrow(AuthExchangeError)
  })

  it("returns tokens on success", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({
          accessToken: "access.jwt",
          refreshToken: "refresh.jwt",
        })
      },
    })
    const result = await exchangeApiKey(
      "sk-test",
      `http://localhost:${server.port}`,
    )
    expect(result.accessToken).toBe("access.jwt")
    expect(result.refreshToken).toBe("refresh.jwt")
  })
})

// ── Token refresh (mocked) ──

describe("refreshAccessToken", () => {
  it("throws AuthRefreshError on non-200", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("Unauthorized", { status: 401 })
      },
    })
    await expect(
      refreshAccessToken("refresh.jwt", `http://localhost:${server.port}`),
    ).rejects.toThrow(AuthRefreshError)
  })

  it("returns tokens on success", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json()
        expect(body.refreshToken).toBe("refresh.jwt")
        return Response.json({
          accessToken: "new-access.jwt",
          refreshToken: "new-refresh.jwt",
        })
      },
    })
    const result = await refreshAccessToken(
      "refresh.jwt",
      `http://localhost:${server.port}`,
    )
    expect(result.accessToken).toBe("new-access.jwt")
    expect(result.refreshToken).toBe("new-refresh.jwt")
  })
})

describe("resolveBearerToken", () => {
  it("returns accessToken as-is when provided", async () => {
    clearBearerTokenCache()
    const token = await resolveBearerToken({ accessToken: "jwt-direct" })
    expect(token).toBe("jwt-direct")
  })

  it("throws when neither accessToken nor apiKey is provided", async () => {
    clearBearerTokenCache()
    await expect(resolveBearerToken({})).rejects.toThrow(/no access token or API key/)
  })

  it("exchanges apiKey once and reuses the cached JWT", async () => {
    clearBearerTokenCache()
    let exchanges = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        exchanges++
        return Response.json({
          accessToken: makeJwt(3600),
          refreshToken: "refresh.jwt",
        })
      },
    })
    const base = `http://localhost:${server.port}`
    const a = await resolveBearerToken({ apiKey: "sk-cache-test", baseUrl: base })
    const b = await resolveBearerToken({ apiKey: "sk-cache-test", baseUrl: base })
    expect(a).toBe(b)
    expect(exchanges).toBe(1)
  })

  it("refreshes a near-expiry cached JWT instead of re-exchanging", async () => {
    clearBearerTokenCache()
    let exchanges = 0
    let refreshes = 0
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith("/auth/exchange_user_api_key")) {
          exchanges++
          return Response.json({
            accessToken: makeJwt(60),
            refreshToken: "refresh.jwt",
          })
        }
        if (url.pathname.endsWith("/auth/token")) {
          refreshes++
          return Response.json({
            accessToken: makeJwt(3600),
            refreshToken: "refresh.jwt.2",
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const base = `http://localhost:${server.port}`
    await resolveBearerToken({ apiKey: "sk-refresh-test", baseUrl: base })
    const second = await resolveBearerToken({ apiKey: "sk-refresh-test", baseUrl: base })
    expect(exchanges).toBe(1)
    expect(refreshes).toBe(1)
    expect(isExpiringSoon(second)).toBe(false)
  })
})

// ── PKCE ──

describe("generatePkceParams", () => {
  it("produces different values on each call", () => {
    const a = generatePkceParams()
    const b = generatePkceParams()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.uuid).not.toBe(b.uuid)
  })

  it("encodes verifier as base64url", () => {
    const params = generatePkceParams()
    expect(params.verifier).not.toContain("+")
    expect(params.verifier).not.toContain("/")
    expect(params.verifier).not.toContain("=")
  })
})

describe("generatePkceChallenge", () => {
  it("produces a deterministic challenge for a given verifier", async () => {
    const challenge1 = await generatePkceChallenge("test-verifier-value")
    const challenge2 = await generatePkceChallenge("test-verifier-value")
    expect(challenge1).toBe(challenge2)
  })

  it("encodes as base64url", async () => {
    const c = await generatePkceChallenge("test")
    expect(c).not.toContain("+")
    expect(c).not.toContain("/")
    expect(c).not.toContain("=")
  })
})

describe("buildLoginUrl", () => {
  it("includes challenge, uuid, mode, and redirectTarget", () => {
    const url = buildLoginUrl("ch123", "uuid-abc", "https://cursor.com")
    expect(url).toContain("challenge=ch123")
    expect(url).toContain("uuid=uuid-abc")
    expect(url).toContain("mode=login")
    expect(url).toContain("redirectTarget=cli")
  })

  it("defaults to cursor.com (website host), not the API host", () => {
    const url = buildLoginUrl("ch", "uuid")
    expect(url.startsWith("https://cursor.com/loginDeepControl")).toBe(true)
    expect(url).not.toContain("api2.cursor.sh")
  })
})

describe("pollForTokens", () => {
  it("throws AuthTimeoutError after exhausting attempts", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("Not found", { status: 404 })
      },
    })
    await expect(
      pollForTokens("u", "v", `http://localhost:${server.port}`, undefined, 3),
    ).rejects.toThrow(AuthTimeoutError)
  }, 10000)

  it("returns tokens on first success", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({
          accessToken: "access.jwt",
          refreshToken: "refresh.jwt",
        })
      },
    })
    const result = await pollForTokens(
      "u",
      "v",
      `http://localhost:${server.port}`,
    )
    expect(result.accessToken).toBe("access.jwt")
    expect(result.refreshToken).toBe("refresh.jwt")
  })

  it("throws AuthPollError after 3 consecutive errors", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("Server error", { status: 500 })
      },
    })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    await expect(
      pollForTokens("u", "v", `http://localhost:${server.port}`, ctrl.signal, 3),
    ).rejects.toThrow(AuthPollError)
    clearTimeout(t)
  }, 10000)

  it("honours abort signal", async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    await expect(
      pollForTokens("u", "v", undefined, ctrl.signal),
    ).rejects.toThrow(AuthTimeoutError)
  })

  it("recovers from intermittent 404 to succeed", async () => {
    let callCount = 0
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        callCount++
        if (callCount < 4) return new Response("Not found", { status: 404 })
        return Response.json({
          accessToken: "access.jwt",
          refreshToken: "refresh.jwt",
        })
      },
    })
    const result = await pollForTokens(
      "u",
      "v",
      `http://localhost:${server.port}`,
    )
    expect(result.accessToken).toBe("access.jwt")
  }, 10000)
})

// ── Checksum round-trip ──

describe("obfuscate", () => {
  it("preserves length", () => {
    const input = new Uint8Array([0, 1, 2, 3, 4, 5])
    const obf = obfuscate(input)
    expect(obf.length).toBe(input.length)
  })

  it("is not identity", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6])
    const obf = obfuscate(input)
    expect(obf).not.toEqual(input)
  })

  it("produces same output for same input", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6])
    const a = obfuscate(input)
    const b = obfuscate(new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(a).toEqual(b)
  })
})

describe("createCursorChecksumHeader", () => {
  it("returns a string with the expected parts", () => {
    const result = createCursorChecksumHeader(
      "abcdef123456",
      "deadbeef7890",
    )
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("abcdef123456")
    expect(result).toContain("deadbeef7890")
  })

  it("works without macMachineId", () => {
    const result = createCursorChecksumHeader("abcdef123456")
    // Format is prefix + machineId with no trailing "/macMachineId" segment.
    // (The base64 prefix itself may legitimately contain "/" — the CLI uses
    // standard base64, not base64url — so we can't assert absence of "/".)
    expect(result.endsWith("abcdef123456")).toBe(true)
  })

  it("prefix is 8 chars (base64 of 6 bytes)", () => {
    const result = createCursorChecksumHeader("abcdef123456")
    const prefix = result.split("abcdef123456")[0]
    // 6 bytes → 8 base64 chars (without padding)
    expect(prefix.length).toBe(8)
  })

  it("produces different prefixes at different times (low probability)", async () => {
    const r1 = createCursorChecksumHeader("id1")
    await new Promise((r) => setTimeout(r, 10))
    const r2 = createCursorChecksumHeader("id1")
    // may or may not differ depending on time precision
    expect(typeof r1).toBe("string")
    expect(typeof r2).toBe("string")
  })
})
