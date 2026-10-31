import { lookup } from "node:dns/promises"
import {
  CursorLocalCancellationError,
  CursorRetryExhaustedError,
  CursorTransportError,
  errorCode,
  type CursorProviderError,
} from "./errors.js"
import { CURSOR_API_HOST } from "./shared.js"

/** How long a turn waits for this computer to reach the network again. */
export const OFFLINE_RETRY_WINDOW_MS = 3 * 60 * 60_000
const OFFLINE_BASE_DELAY_MS = 500
const OFFLINE_MAX_DELAY_MS = 30_000
const PROBE_TIMEOUT_MS = 2_000

/**
 * Failures that mean this computer could not reach a host at all. A Cursor
 * process that resets a live connection is not in this set.
 */
const DEFINITE_OFFLINE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "FailedToOpenSocket",
  "ConnectionRefused",
  "DNSException",
  "CURSOR_CONNECT_TIMEOUT",
  "CURSOR_AGENT_URL_TIMEOUT",
  "CURSOR_PROXY_CONNECT_FAILED",
])

/** Could be a dead laptop network or a dead Cursor connection. A probe decides. */
const MAYBE_OFFLINE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "ConnectionClosed",
  "ConnectionTimeout",
  "CURSOR_READ_IDLE_TIMEOUT",
  "CURSOR_SEMANTIC_IDLE_TIMEOUT",
])

const DEFINITE_OFFLINE_MESSAGE = /getaddrinfo|\b(?:enotfound|eai_again|enetunreach|enetdown|ehostunreach|econnrefused|failedtoopensocket)\b/i

export type ConnectivityClass = "offline" | "maybe" | "online"

export type OfflineClock = {
  now?: () => number
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  reachable?: () => Promise<boolean>
  windowMs?: number
}

let testClock: OfflineClock | undefined

export function setOfflineClockForTests(clock: OfflineClock | undefined): void {
  testClock = clock
}

export function connectivityClass(error: unknown, seen = new Set<unknown>()): ConnectivityClass {
  if (!error || typeof error !== "object" || seen.has(error)) return "online"
  seen.add(error)
  const code = errorCode(error)
  const message = error instanceof Error ? error.message : ""
  let kind: ConnectivityClass = "online"
  if ((code && DEFINITE_OFFLINE_CODES.has(code)) || DEFINITE_OFFLINE_MESSAGE.test(message)) kind = "offline"
  else if (code && MAYBE_OFFLINE_CODES.has(code)) kind = "maybe"
  const cause = (error as { cause?: unknown }).cause
  const nested = connectivityClass(cause, seen)
  if (nested === "offline" || kind === "offline") return "offline"
  if (nested === "maybe" || kind === "maybe") return "maybe"
  return "online"
}

export function isConnectivityFailure(error: unknown): boolean {
  return connectivityClass(error) === "offline"
}

/** True when this failure should wait for the network instead of spending a retry. */
export async function offlineHold(error: unknown): Promise<boolean> {
  const kind = connectivityClass(error)
  if (kind === "online") return false
  if (kind === "offline") return true
  const reachable = testClock?.reachable ?? (() => networkReachable())
  return !(await reachable())
}

/** Full-jitter backoff, capped, matching the Run retry delay shape. */
export function offlineDelayMs(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(OFFLINE_MAX_DELAY_MS, OFFLINE_BASE_DELAY_MS * 2 ** Math.max(0, attempt))
  return Math.max(1, Math.floor(random * ceiling))
}

export async function networkReachable(host = CURSOR_API_HOST, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns timeout")), timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([lookup(host), timeout])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Sleep until a reachability probe succeeds. Does not spend the Run attempt
 * budget. The abort signal cancels the wait; the window ending fails the turn.
 */
export async function waitUntilReachable(
  failure: CursorProviderError,
  signal?: AbortSignal,
  since = Date.now(),
): Promise<void> {
  const now = testClock?.now ?? Date.now
  const sleep = testClock?.sleep ?? defaultSleep
  const reachable = testClock?.reachable ?? (() => networkReachable())
  const windowMs = testClock?.windowMs ?? OFFLINE_RETRY_WINDOW_MS
  for (let attempt = 0; ; attempt++) {
    if (now() - since >= windowMs) throw offlineWindowError(failure, windowMs)
    await sleep(offlineDelayMs(attempt), signal)
    if (now() - since >= windowMs) throw offlineWindowError(failure, windowMs)
    if (await reachable()) return
  }
}

function offlineWindowError(failure: CursorProviderError, windowMs: number): CursorRetryExhaustedError {
  const minutes = Math.max(1, Math.round(windowMs / 60_000))
  return new CursorRetryExhaustedError(1, new CursorTransportError(
    `Cursor stayed unreachable for ${minutes} minutes`,
    { transient: true, replaySafe: true, code: failure.code, cause: failure },
  ))
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CursorLocalCancellationError("Cursor retry cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    timer.unref?.()
    const onAbort = () => finish(new CursorLocalCancellationError("Cursor retry cancelled"))
    function finish(error?: Error) {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
