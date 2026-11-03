import {
  CursorLocalCancellationError,
  CursorRetryExhaustedError,
  CursorTransportError,
  errorCode,
  type CursorProviderError,
} from "./errors.js"

/** How long one outage may hold a turn before it fails. */
export const OFFLINE_RETRY_WINDOW_MS = 3 * 60 * 60_000
const OFFLINE_BASE_DELAY_MS = 500
const OFFLINE_MAX_DELAY_MS = 30_000

/**
 * Local evidence that this computer has no usable network: name resolution or
 * routing failed before any host answered. A refused, reset or silent
 * connection means something answered or may still answer, so those failures
 * keep the normal retry budget. The reopen itself is the reachability check:
 * it uses the Run's own origin and proxy, which a separate probe would not.
 */
const OFFLINE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
])

export type OfflineClock = {
  now?: () => number
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  windowMs?: number
}

let testClock: OfflineClock | undefined

export function setOfflineClockForTests(clock: OfflineClock | undefined): void {
  testClock = clock
}

/** One outage: its consecutive connectivity failures share a window and a growing backoff. */
export type OfflineWait = { since: number; attempts: number }

export function startOfflineWait(): OfflineWait {
  return { since: (testClock?.now ?? Date.now)(), attempts: 0 }
}

export function isOfflineFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false
  seen.add(error)
  const code = errorCode(error)
  if (code && OFFLINE_CODES.has(code)) return true
  return isOfflineFailure((error as { cause?: unknown }).cause, seen)
}

/** Full-jitter backoff, capped, matching the Run retry delay shape. */
export function offlineDelayMs(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(OFFLINE_MAX_DELAY_MS, OFFLINE_BASE_DELAY_MS * 2 ** Math.max(0, attempt))
  return Math.max(1, Math.floor(random * ceiling))
}

/**
 * Back off before the next attempt of this outage without spending the Run
 * retry budget. The abort signal cancels the wait; the window ending fails the turn.
 */
export async function waitOffline(wait: OfflineWait, failure: CursorProviderError, signal?: AbortSignal): Promise<void> {
  const now = testClock?.now ?? Date.now
  const sleep = testClock?.sleep ?? defaultSleep
  const windowMs = testClock?.windowMs ?? OFFLINE_RETRY_WINDOW_MS
  if (now() - wait.since >= windowMs) throw offlineWindowError(failure, wait, windowMs)
  await sleep(offlineDelayMs(wait.attempts++), signal)
  if (now() - wait.since >= windowMs) throw offlineWindowError(failure, wait, windowMs)
}

function offlineWindowError(failure: CursorProviderError, wait: OfflineWait, windowMs: number): CursorRetryExhaustedError {
  const minutes = Math.max(1, Math.round(windowMs / 60_000))
  return new CursorRetryExhaustedError(wait.attempts + 1, new CursorTransportError(
    `Cursor stayed unreachable for ${minutes} minutes`,
    { transient: true, replaySafe: true, code: failure.code, cause: failure },
  ))
}

// Not unref'd: a turn waiting for the network must keep the process alive.
function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CursorLocalCancellationError("Cursor retry cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
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
