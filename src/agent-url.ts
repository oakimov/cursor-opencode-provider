import { createHash } from "node:crypto"
import { fetchAgentUrl } from "./transport/connect.js"
import { trace } from "./debug.js"
import { CURSOR_API_HOST } from "./shared.js"

const DEFAULT_API_BASE = `https://${CURSOR_API_HOST}`

// In-process memo of the region-specific Run stream origin (agentnUrl). Resolved
// once per process — the auth loader warms it, and the first startSession reuses
// it — and held for the process lifetime. Region routing is near-static, and
// re-resolving mid-session would break a held-open bidi Run stream anyway.
//
// Unlike the models/version caches this is NOT persisted to disk. A wrong agent
// host is fatal and silent (HTTP 200 + immediate close, "This region is not
// available for your team"), so persisting it would risk pinning the process —
// or the next process — to a stale region or the legacy global host that some
// accounts reject. Resolving fresh per process is cheap (one unary RPC on the
// API host) and self-heals after a Cursor-side region migration on restart.
//
function normalizeApiBaseURL(baseURL: string | undefined): string {
  if (!baseURL) return DEFAULT_API_BASE
  return new URL(baseURL).origin
}

type AgentUrlOptions = {
  apiBaseURL?: string
  baseURL?: string
  telemetryEnabled?: boolean
  timeoutMs?: number
}

function resolveCacheKey(token: string, options: AgentUrlOptions): string {
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16)
  return `${tokenHash}|${normalizeApiBaseURL(options.apiBaseURL ?? options.baseURL)}|telem:${options.telemetryEnabled === true}`
}

const _resolved = new Map<string, string>()
// In-flight fetches share the same key as resolved URLs so concurrent callers dedup per account.
const _inflight = new Map<string, Promise<string>>()

/**
 * Resolve the Run stream origin for this account via the `GetServerConfig`
 * Connect RPC. Memoized for the process lifetime.
 *
 *   - already resolved → return the memo (no fetch)
 *   - otherwise → fetch `agentUrlConfig.agentnUrl` (then `agentUrl`), memoize, return
 *   - fetch fails / no valid `agentUrlConfig` → throw (no global-host fallback)
 *
 * Concurrent callers share a single in-flight fetch.
 */
export async function resolveAgentUrl(
  token: string,
  options: AgentUrlOptions = {},
): Promise<string> {
  const cacheKey = resolveCacheKey(token, options)
  const memo = _resolved.get(cacheKey)
  if (memo) {
    trace(`agent-url: reuse in-process memo → ${memo}`)
    return memo
  }
  const inflight = _inflight.get(cacheKey)
  if (inflight) {
    trace("agent-url: awaiting in-flight GetServerConfig")
    return inflight
  }

  const promise = (async () => {
    try {
      const url = await fetchAgentUrl(token, options)
      _resolved.set(cacheKey, url)
      trace(`agent-url: resolved via GetServerConfig → ${url}`)
      return url
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      trace(`agent-url: GetServerConfig failed (${reason}); no fallback agent host will be used`)
      throw err
    } finally {
      _inflight.delete(cacheKey)
    }
  })()
  _inflight.set(cacheKey, promise)
  return promise
}

/** Reset the in-process memo. Tests only. */
export function resetAgentUrlCache(): void {
  _resolved.clear()
  _inflight.clear()
}
