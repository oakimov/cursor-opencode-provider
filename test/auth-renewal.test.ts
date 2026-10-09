import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import {
  SESSION_RENEWAL_WINDOW_MS,
  latestSessionTokens,
  renewSessionIfDue,
  resetAuthRenewalState,
  resolveApiKeyToken,
  resolveBearerToken,
  sessionRenewalDueAt,
  tokenTimes,
} from "../src/auth-renewal.js"
import { CursorAuthError, CursorServerError } from "../src/errors.js"

const DAY_S = 86_400

/** Cursor-shaped session JWT: `time` (issue, seconds as a string) and `exp`. */
function sessionJwt(issuedAgoS: number, lifetimeS = 60 * DAY_S, tag = Math.random().toString(36).slice(2)): string {
  const issued = Math.floor(Date.now() / 1000) - issuedAgoS
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    type: "session",
    time: String(issued),
    exp: issued + lifetimeS,
    randomness: tag,
  })).toString("base64url")
  return `${header}.${payload}.sig`
}

/** API-key JWT expiring `expInS` from now. */
function keyJwt(expInS: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expInS,
    randomness: Math.random(),
  })).toString("base64url")
  return `${header}.${payload}.sig`
}

type Recorded = { path: string; body?: unknown; authorization?: string | null }

function cursorStub(respond: (req: Recorded) => Response | Promise<Response>) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const recorded: Recorded = {
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: await req.json().catch(() => undefined),
      }
      requests.push(recorded)
      return respond(recorded)
    },
  })
  return { server, requests, base: `http://localhost:${server.port}` }
}

beforeEach(() => resetAuthRenewalState())
afterEach(() => setSystemTime())

describe("session token timing", () => {
  it("reads Cursor's string `time` claim as the issue time", () => {
    const token = sessionJwt(10 * DAY_S)
    const { issuedAtMs, expiresAtMs } = tokenTimes(token)
    expect(expiresAtMs! - issuedAtMs!).toBe(60 * DAY_S * 1000)
  })

  it("is due 1272 h before expiry (7 days into a 60-day session)", () => {
    const token = sessionJwt(0)
    const { issuedAtMs, expiresAtMs } = tokenTimes(token)
    expect(sessionRenewalDueAt(token)).toBe(expiresAtMs! - SESSION_RENEWAL_WINDOW_MS)
    expect(sessionRenewalDueAt(token)! - issuedAtMs!).toBe(7 * DAY_S * 1000)
  })

  it("is never due within an hour of issue, whatever the lifetime", () => {
    const token = sessionJwt(0, 2 * 3600)
    expect(sessionRenewalDueAt(token)).toBe(tokenTimes(token).issuedAtMs! + 3_600_000)
  })
})

describe("renewSessionIfDue", () => {
  it("does not contact Cursor before renewal is due", async () => {
    const stub = cursorStub(() => Response.json({ access_token: sessionJwt(0), shouldLogout: false }))
    using _ = stub.server
    const token = sessionJwt(DAY_S)
    const result = await renewSessionIfDue({ accessToken: token, refreshToken: token }, { baseUrl: stub.base })
    expect(result).toEqual({ accessToken: token, renewed: false })
    expect(stub.requests).toHaveLength(0)
  })

  it("renews a due session through /oauth/token, never /auth/token", async () => {
    const fresh = sessionJwt(0)
    const stub = cursorStub(() => Response.json({ access_token: fresh, id_token: "id", shouldLogout: false }))
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const result = await renewSessionIfDue({ accessToken: token, refreshToken: token }, { baseUrl: stub.base })
    expect(result).toEqual({ accessToken: fresh, renewed: true })
    expect(stub.requests.map((r) => r.path)).toEqual(["/oauth/token"])
    expect(stub.requests[0]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: token })
  })

  it("hands later callers holding the old credential the renewed token without another request", async () => {
    const fresh = sessionJwt(0)
    const stub = cursorStub(() => Response.json({ access_token: fresh, shouldLogout: false }))
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    await renewSessionIfDue({ accessToken: token, refreshToken: token }, { baseUrl: stub.base })
    const again = await renewSessionIfDue({ accessToken: token, refreshToken: token }, { baseUrl: stub.base })
    expect(again).toEqual({ accessToken: fresh, renewed: true })
    expect(latestSessionTokens({ accessToken: token, refreshToken: token }, stub.base).accessToken).toBe(fresh)
    expect(stub.requests).toHaveLength(1)
  })

  it("coalesces concurrent renewals", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fresh = sessionJwt(0)
    const stub = cursorStub(async () => {
      await gate
      return Response.json({ access_token: fresh, shouldLogout: false })
    })
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const tokens = { accessToken: token, refreshToken: token }
    const pending = [
      renewSessionIfDue(tokens, { baseUrl: stub.base }),
      renewSessionIfDue(tokens, { baseUrl: stub.base }),
    ]
    release()
    const results = await Promise.all(pending)
    expect(results.map((r) => r.accessToken)).toEqual([fresh, fresh])
    expect(stub.requests).toHaveLength(1)
  })

  it("renews a session that is not yet due when forced (after Cursor rejected it)", async () => {
    const fresh = sessionJwt(0)
    const stub = cursorStub(() => Response.json({ access_token: fresh, shouldLogout: false }))
    using _ = stub.server
    const token = sessionJwt(DAY_S)
    const result = await renewSessionIfDue({ accessToken: token, refreshToken: token }, { baseUrl: stub.base, force: true })
    expect(result.accessToken).toBe(fresh)
  })

  it("uses a forced renewal with the same expiry instead of the rejected token", async () => {
    const old = sessionJwt(0)
    const fresh = sessionJwt(0)
    const stub = cursorStub(() => Response.json({ access_token: fresh }))
    using _ = stub.server
    const tokens = { accessToken: old, refreshToken: old }
    expect((await renewSessionIfDue(tokens, { baseUrl: stub.base, force: true })).accessToken).toBe(fresh)
    expect((await renewSessionIfDue(tokens, { baseUrl: stub.base })).accessToken).toBe(fresh)
    expect(stub.requests).toHaveLength(1)
  })

  it("keeps a valid session through a transient failure and backs off", async () => {
    const stub = cursorStub(() => new Response("down", { status: 503 }))
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const tokens = { accessToken: token, refreshToken: token }
    const first = await renewSessionIfDue(tokens, { baseUrl: stub.base })
    expect(first.accessToken).toBe(token)
    expect(first.renewed).toBe(false)
    expect(first.retryAt).toBeGreaterThan(Date.now())

    // Within the backoff: no request.
    await renewSessionIfDue(tokens, { baseUrl: stub.base })
    expect(stub.requests).toHaveLength(1)

    // After it: one more attempt, with a longer backoff.
    setSystemTime(new Date(first.retryAt! + 1))
    const second = await renewSessionIfDue(tokens, { baseUrl: stub.base })
    expect(stub.requests).toHaveLength(2)
    expect(second.retryAt! - (first.retryAt! + 1)).toBeGreaterThan(first.retryAt! - Date.now())
  })

  it("raises a sign-in error when an expired session cannot be renewed", async () => {
    const stub = cursorStub(() => new Response("down", { status: 503, statusText: "Service Unavailable" }))
    using _ = stub.server
    const expired = sessionJwt(61 * DAY_S)
    const error = await renewSessionIfDue({ accessToken: expired, refreshToken: expired }, { baseUrl: stub.base })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CursorAuthError)
    expect((error as CursorAuthError).code).toBe("session_expired")
    expect((error as Error).message).toMatch(/sign in to Cursor again/)
    expect((error as Error).message).not.toMatch(/unavailable|exhausted/i)
  })

  it("latches a session Cursor ended and does not ask again", async () => {
    const stub = cursorStub(() => Response.json({ access_token: "", id_token: "", shouldLogout: true }))
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const tokens = { accessToken: token, refreshToken: token }
    for (let i = 0; i < 2; i++) {
      const error = await renewSessionIfDue(tokens, { baseUrl: stub.base }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(CursorAuthError)
      expect((error as CursorAuthError).code).toBe("session_logout")
    }
    expect(stub.requests).toHaveLength(1)
  })

  it("does not remember an expired refresh token returned as success", async () => {
    const expired = sessionJwt(61 * DAY_S)
    const stub = cursorStub(() => Response.json({ access_token: expired }))
    using _ = stub.server
    const old = sessionJwt(8 * DAY_S)
    const tokens = { accessToken: old, refreshToken: old }
    const renewal = await renewSessionIfDue(tokens, { baseUrl: stub.base })
    expect(renewal.accessToken).toBe(old)
    expect(renewal.retryAt).toBeGreaterThan(Date.now())
    await renewSessionIfDue(tokens, { baseUrl: stub.base })
    expect(stub.requests).toHaveLength(1)
  })

  it("reports a sign-in policy block", async () => {
    const stub = cursorStub(() => Response.json({ access_token: "", shouldLogout: true, error: "sign_in_policy_violation" }))
    using _ = stub.server
    const token = sessionJwt(8 * DAY_S)
    const error = await renewSessionIfDue({ accessToken: token, refreshToken: token }, { baseUrl: stub.base })
      .catch((e: unknown) => e)
    expect((error as CursorAuthError).code).toBe("sign_in_policy_violation")
  })
})

describe("resolveApiKeyToken", () => {
  it("exchanges once, caches, and never calls a refresh endpoint", async () => {
    const stub = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "unused" }))
    using _ = stub.server
    const a = await resolveApiKeyToken("crsr_cache", { baseUrl: stub.base })
    const b = await resolveApiKeyToken("crsr_cache", { baseUrl: stub.base })
    expect(b.accessToken).toBe(a.accessToken)
    expect(stub.requests.map((r) => r.path)).toEqual(["/auth/exchange_user_api_key"])
    expect(stub.requests[0]!.authorization).toBe("Bearer crsr_cache")
  })

  it("re-exchanges the key when the cached JWT nears expiry", async () => {
    let n = 0
    const stub = cursorStub(() => Response.json({ accessToken: keyJwt(++n === 1 ? 120 : 3600), refreshToken: "unused" }))
    using _ = stub.server
    const first = await resolveApiKeyToken("crsr_renew", { baseUrl: stub.base })
    const second = await resolveApiKeyToken("crsr_renew", { baseUrl: stub.base })
    expect(second.accessToken).not.toBe(first.accessToken)
    expect(stub.requests.map((r) => r.path)).toEqual(["/auth/exchange_user_api_key", "/auth/exchange_user_api_key"])
  })

  it("uses a forced exchange with the same expiry instead of its rejected seed", async () => {
    const old = keyJwt(3600)
    const fresh = keyJwt(3600)
    const stub = cursorStub(() => Response.json({ accessToken: fresh, refreshToken: "unused" }))
    using _ = stub.server
    expect((await resolveApiKeyToken("crsr_forced", { baseUrl: stub.base, seed: old, force: true })).accessToken).toBe(fresh)
    expect((await resolveApiKeyToken("crsr_forced", { baseUrl: stub.base, seed: old })).accessToken).toBe(fresh)
    expect(stub.requests).toHaveLength(1)
  })

  it("keys its cache by API base URL as well as the key", async () => {
    const one = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "x" }))
    const two = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "x" }))
    using _a = one.server
    using _b = two.server
    const a = await resolveApiKeyToken("crsr_shared", { baseUrl: one.base })
    const b = await resolveApiKeyToken("crsr_shared", { baseUrl: two.base })
    expect(a.accessToken).not.toBe(b.accessToken)
    expect(one.requests).toHaveLength(1)
    expect(two.requests).toHaveLength(1)
  })

  it("uses a stored JWT seed while it is valid, and ignores a raw key as seed", async () => {
    const stub = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "x" }))
    using _ = stub.server
    const seed = keyJwt(3000)
    expect(await resolveApiKeyToken("crsr_seed", { baseUrl: stub.base, seed })).toEqual({ accessToken: seed, renewed: false })
    expect(stub.requests).toHaveLength(0)
    const fromRaw = await resolveApiKeyToken("crsr_seed2", { baseUrl: stub.base, seed: "crsr_seed2" })
    expect(fromRaw.accessToken.startsWith("crsr_")).toBe(false)
    expect(fromRaw.renewed).toBe(true)
  })

  it("latches a rejected key, still serving a JWT that has not expired yet", async () => {
    const stub = cursorStub(() => new Response("no", { status: 401 }))
    using _ = stub.server
    const valid = keyJwt(200) // inside the five-minute renewal window, still usable
    expect((await resolveApiKeyToken("crsr_revoked", { baseUrl: stub.base, seed: valid })).accessToken).toBe(valid)
    expect((await resolveApiKeyToken("crsr_revoked", { baseUrl: stub.base, seed: valid })).accessToken).toBe(valid)
    expect(stub.requests).toHaveLength(1)
  })

  it("raises a clear error for a rejected key with no usable JWT", async () => {
    const stub = cursorStub(() => new Response("no", { status: 401 }))
    using _ = stub.server
    const error = await resolveApiKeyToken("crsr_revoked2", { baseUrl: stub.base }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CursorAuthError)
    expect((error as CursorAuthError).code).toBe("api_key_rejected")
    expect((error as CursorAuthError).statusCode).toBe(401)
  })

  it("reports a sign-in policy block", async () => {
    const stub = cursorStub(() => Response.json({ error: "sign_in_policy_violation" }, { status: 403 }))
    using _ = stub.server
    const error = await resolveApiKeyToken("crsr_blocked", { baseUrl: stub.base }).catch((e: unknown) => e)
    expect((error as CursorAuthError).code).toBe("sign_in_policy_violation")
  })

  it("fails transiently without a token, then backs off", async () => {
    const stub = cursorStub(() => new Response("down", { status: 503, statusText: "Service Unavailable" }))
    using _ = stub.server
    for (let i = 0; i < 2; i++) {
      const error = await resolveApiKeyToken("crsr_down", { baseUrl: stub.base }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(CursorServerError)
      expect((error as CursorServerError).transient).toBe(true)
      // OpenCode's SessionRetry re-arms on these words in provider messages.
      expect((error as Error).message).not.toMatch(/unavailable|exhausted/i)
    }
    expect(stub.requests).toHaveLength(1)
  })

  it.each(["", "not-a-jwt", "crsr_returned_key", keyJwt(-60)])(
    "rejects an unusable exchanged access token and backs off: %s", async (accessToken) => {
      const stub = cursorStub(() => Response.json({ accessToken, refreshToken: "unused" }))
      using _ = stub.server
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await resolveApiKeyToken("crsr_invalid_result", { baseUrl: stub.base }).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(CursorServerError)
        expect((error as CursorServerError).transient).toBe(true)
      }
      expect(stub.requests).toHaveLength(1)
    },
  )

  it("backs off on a rate limit instead of treating the key as rejected", async () => {
    let n = 0
    const stub = cursorStub(() => ++n === 1
      ? new Response("slow down", { status: 429 })
      : Response.json({ accessToken: keyJwt(3600), refreshToken: "x" }))
    using _ = stub.server
    const first = await resolveApiKeyToken("crsr_limited", { baseUrl: stub.base }).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(CursorServerError)
    const retried = await resolveApiKeyToken("crsr_limited", { baseUrl: stub.base, force: true })
    expect(retried.accessToken.startsWith("crsr_")).toBe(false)
  })
})

describe("resolveBearerToken", () => {
  it("prefers getAccessToken and forwards forceRefresh", async () => {
    const calls: unknown[] = []
    const token = await resolveBearerToken({
      getAccessToken: async (request) => {
        calls.push(request)
        return "host.jwt"
      },
      accessToken: "static.jwt",
      apiKey: "crsr_unused",
      forceRefresh: true,
    })
    expect(token).toBe("host.jwt")
    expect(calls).toEqual([{ forceRefresh: true }])
  })

  it("uses accessToken as-is and never exchanges a key given alongside it", async () => {
    const stub = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "x" }))
    using _ = stub.server
    const expired = keyJwt(-60)
    expect(await resolveBearerToken({ accessToken: expired, apiKey: "crsr_x", baseUrl: stub.base })).toBe(expired)
    expect(stub.requests).toHaveLength(0)
  })

  it("exchanges a raw apiKey and passes any other apiKey through", async () => {
    const stub = cursorStub(() => Response.json({ accessToken: keyJwt(3600), refreshToken: "x" }))
    using _ = stub.server
    const exchanged = await resolveBearerToken({ apiKey: "crsr_y", baseUrl: stub.base })
    expect(exchanged.startsWith("crsr_")).toBe(false)
    expect(await resolveBearerToken({ apiKey: "already.a.jwt", baseUrl: stub.base })).toBe("already.a.jwt")
    expect(stub.requests).toHaveLength(1)
  })

  it("never sends a raw key as a Bearer token", async () => {
    const asAccessToken = await resolveBearerToken({ accessToken: "crsr_raw" }).catch((e: unknown) => e)
    const fromHost = await resolveBearerToken({ getAccessToken: async () => "crsr_raw" }).catch((e: unknown) => e)
    expect(asAccessToken).toBeInstanceOf(CursorAuthError)
    expect(fromHost).toBeInstanceOf(CursorAuthError)
  })

  it("throws when no credential is given", async () => {
    const error = await resolveBearerToken({}).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/no access token or API key/)
  })
})
