import { CURSOR_API_HOST, CURSOR_WEBSITE_HOST } from "./shared.js"

const API_BASE = `https://${CURSOR_API_HOST}`

export class AuthExchangeError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = "AuthExchangeError"
  }
}

export class AuthRefreshError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = "AuthRefreshError"
  }
}

export class AuthPollError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
    this.name = "AuthPollError"
  }
}

export class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthTimeoutError"
  }
}

// ── Helpers ──

export function isExpiringSoon(jwt: string, thresholdS = 300): boolean {
  const payload = decodeJwtPayload(jwt)
  if (!payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return true
  }
  return payload.exp * 1000 - Date.now() < thresholdS * 1000
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const segment = jwt.split(".")[1]
    if (!segment) return null
    const json = Buffer.from(segment, "base64url").toString("utf8")
    const payload = JSON.parse(json) as unknown
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
    return payload as Record<string, unknown>
  } catch {
    return null
  }
}

/** JWT `exp` claim as epoch milliseconds, or null if missing/malformed. */
export function decodeJwtExpiryMs(jwt: string): number | null {
  const payload = decodeJwtPayload(jwt)
  if (!payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return null
  }
  return payload.exp * 1000
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

// ── Mode A: pass-through auth token ──

export function useAuthToken(token: string): { accessToken: string } {
  return { accessToken: token }
}

// ── Mode B: API key exchange + refresh ──

export type TokenPair = {
  accessToken: string
  refreshToken: string
}

export async function exchangeApiKey(
  apiKey: string,
  baseUrl = API_BASE,
): Promise<TokenPair> {
  const res = await fetch(`${baseUrl}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: "{}",
  })
  if (!res.ok) {
    throw new AuthExchangeError(
      `API key exchange failed: ${res.status} ${res.statusText}`,
    )
  }
  const body = await res.json()
  if (!body.accessToken || !body.refreshToken) {
    throw new AuthExchangeError("Exchange response missing tokens")
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken }
}

export async function refreshAccessToken(
  refreshToken: string,
  baseUrl = API_BASE,
): Promise<TokenPair> {
  const res = await fetch(`${baseUrl}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  })
  if (!res.ok) {
    throw new AuthRefreshError(
      `Token refresh failed: ${res.status} ${res.statusText}`,
    )
  }
  const body = await res.json()
  if (!body.accessToken || !body.refreshToken) {
    throw new AuthRefreshError("Refresh response missing tokens")
  }
  return { accessToken: body.accessToken, refreshToken: body.refreshToken }
}

// Cache JWTs obtained via API-key exchange so doStream doesn't re-exchange
// on every turn when the caller only supplied `apiKey`.
const _apiKeyTokenCache = new Map<string, TokenPair>()

/** Clear the apiKey→JWT cache (tests). */
export function clearBearerTokenCache(): void {
  _apiKeyTokenCache.clear()
}

/**
 * Resolve a Bearer JWT for Cursor API calls. Prefer an already-exchanged
 * `accessToken`; otherwise exchange (and cache) from `apiKey`, refreshing
 * when the cached JWT is near expiry.
 */
export async function resolveBearerToken(input: {
  accessToken?: string
  apiKey?: string
  baseUrl?: string
}): Promise<string> {
  if (input.accessToken) return input.accessToken
  if (!input.apiKey) {
    throw new Error("Cursor provider: no access token or API key provided")
  }

  const baseUrl = input.baseUrl ?? API_BASE
  const cached = _apiKeyTokenCache.get(input.apiKey)
  if (cached && !isExpiringSoon(cached.accessToken)) {
    return cached.accessToken
  }
  if (cached) {
    try {
      const refreshed = await refreshAccessToken(cached.refreshToken, baseUrl)
      _apiKeyTokenCache.set(input.apiKey, refreshed)
      return refreshed.accessToken
    } catch {
      // Fall through to a fresh exchange.
    }
  }

  const pair = await exchangeApiKey(input.apiKey, baseUrl)
  _apiKeyTokenCache.set(input.apiKey, pair)
  return pair.accessToken
}

// ── Mode C: PKCE browser login ──

async function sha256(data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}

export type PkceParams = {
  verifier: string
  challenge: string
  uuid: string
}

export function generatePkceParams(): PkceParams {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64url(verifierBytes)

  const uuid = crypto.randomUUID()
  return { verifier, challenge: "", uuid } // challenge filled async
}

export async function generatePkceChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await sha256(enc.encode(verifier))
  return base64url(hash)
}

export function buildLoginUrl(
  challenge: string,
  uuid: string,
  websiteUrl = `https://${CURSOR_WEBSITE_HOST}`,
): string {
  return `${websiteUrl}/loginDeepControl?challenge=${encodeURIComponent(challenge)}&uuid=${encodeURIComponent(uuid)}&mode=login&redirectTarget=cli`
}

export async function pollForTokens(
  uuid: string,
  verifier: string,
  baseUrl = API_BASE,
  signal?: AbortSignal,
  maxAttempts = 150,
): Promise<TokenPair> {
  let failures = 0

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new AuthTimeoutError("Poll cancelled")

    const delay = Math.min(1000 * Math.pow(1.2, i), 10000)
    await new Promise((r) => setTimeout(r, delay))

    try {
      const url = `${baseUrl}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`
      const res = await fetch(url)

      if (res.status === 404) {
        failures = 0
        continue
      }
      if (!res.ok) {
        failures++
        if (failures >= 3) {
          throw new AuthPollError(
            `Poll failed after ${failures} consecutive errors (last: ${res.status})`,
          )
        }
        continue
      }

      const body = await res.json()
      if (body.accessToken && body.refreshToken) {
        return { accessToken: body.accessToken, refreshToken: body.refreshToken }
      }
      // 200 OK but missing tokens — same fail-fast policy as the other error
      // paths, otherwise a partial-body server response stalls the full
      // ~5-minute poll budget with no diagnostic.
      failures++
      if (failures >= 3) {
        throw new AuthPollError(
          "Poll returned 3 consecutive 200 responses without tokens",
        )
      }
    } catch (err) {
      if (err instanceof AuthPollError) throw err
      failures++
      if (failures >= 3) {
        throw new AuthPollError(
          "Poll failed after 3 consecutive network errors",
          err,
        )
      }
    }
  }

  throw new AuthTimeoutError(
    `Poll timed out after ${maxAttempts} attempts (~5 min)`,
  )
}
