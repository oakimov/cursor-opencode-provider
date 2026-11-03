import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { CursorAuthError, CursorLocalCancellationError, CursorRetryExhaustedError, CursorTransportError } from "../src/errors.js"
import {
  isOfflineFailure,
  offlineDelayMs,
  setOfflineClockForTests,
  startOfflineWait,
  waitOffline,
  OFFLINE_RETRY_WINDOW_MS,
} from "../src/offline.js"

const transport = (code?: string, cause?: unknown) => new CursorTransportError("Cursor HTTP/2 connection failed", {
  transient: true,
  replaySafe: true,
  code,
  cause,
})
const dns = () => transport("ENOTFOUND")

afterEach(() => setOfflineClockForTests(undefined))

describe("offline wait", () => {
  it("treats only name-resolution and routing failures as offline, through the cause chain", () => {
    expect(isOfflineFailure(dns())).toBe(true)
    expect(isOfflineFailure(transport("EAI_AGAIN"))).toBe(true)
    expect(isOfflineFailure(transport("ENETUNREACH"))).toBe(true)
    // Bun and Node both report a DNS failure as getaddrinfo ENOTFOUND.
    expect(isOfflineFailure(new CursorTransportError("GetServerConfig network request failed", {
      transient: true,
      replaySafe: true,
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api2.cursor.sh"), { code: "ENOTFOUND" }),
    }))).toBe(true)
    // A proxy that cannot be resolved is the same outage.
    expect(isOfflineFailure(transport("CURSOR_PROXY_CONNECT_FAILED", Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" })))).toBe(true)
  })

  it("keeps the retry budget for failures where a host answered or may still answer", () => {
    // Something refused the connection, so the network is up.
    expect(isOfflineFailure(transport("ECONNREFUSED"))).toBe(false)
    expect(isOfflineFailure(transport("CURSOR_PROXY_CONNECT_FAILED", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })))).toBe(false)
    expect(isOfflineFailure(transport("ECONNRESET"))).toBe(false)
    expect(isOfflineFailure(transport("CURSOR_SEMANTIC_IDLE_TIMEOUT"))).toBe(false)
    expect(isOfflineFailure(transport("CURSOR_READ_IDLE_TIMEOUT"))).toBe(false)
    // The HTTP/2 connect timeout carries no code: a blackholed Cursor looks the same.
    expect(isOfflineFailure(new CursorTransportError("HTTP/2 connect to https://agent.example timed out after 15000ms"))).toBe(false)
    expect(isOfflineFailure(new CursorAuthError("Cursor authentication failed"))).toBe(false)
  })

  it("caps the offline backoff at 30 seconds", () => {
    expect(offlineDelayMs(0, 1)).toBe(500)
    expect(offlineDelayMs(20, 1)).toBe(30_000)
  })

  it("grows the backoff across the attempts of one outage", async () => {
    const random = spyOn(Math, "random").mockReturnValue(1)
    const sleeps: number[] = []
    setOfflineClockForTests({ now: () => 0, sleep: async (delayMs) => { sleeps.push(delayMs) } })
    try {
      const outage = startOfflineWait()
      for (let i = 0; i < 4; i++) await waitOffline(outage, dns())
      expect(sleeps).toEqual([500, 1_000, 2_000, 4_000])
      expect(outage.attempts).toBe(4)
    } finally {
      random.mockRestore()
    }
  })

  it("fails the turn once the outage window has elapsed, naming every attempt", async () => {
    let now = 0
    setOfflineClockForTests({ now: () => now, windowMs: 1_000, sleep: async () => { now += 400 } })
    const outage = startOfflineWait()
    await waitOffline(outage, dns())
    await waitOffline(outage, dns())
    const exhausted = await waitOffline(outage, dns()).then(() => undefined, (error: unknown) => error)
    expect(exhausted).toBeInstanceOf(CursorRetryExhaustedError)
    expect((exhausted as Error).message).toBe("Cursor Run failed after 4 attempts: Cursor stayed unreachable for 1 minutes")
  })

  it("cancels the wait on Stop, including a Stop before it starts", async () => {
    setOfflineClockForTests({ now: () => 0 })
    const stopped = new AbortController()
    stopped.abort()
    await expect(waitOffline(startOfflineWait(), dns(), stopped.signal)).rejects.toBeInstanceOf(CursorLocalCancellationError)

    const random = spyOn(Math, "random").mockReturnValue(1)
    try {
      const stop = new AbortController()
      const waiting = waitOffline(startOfflineWait(), dns(), stop.signal)
      stop.abort()
      await expect(waiting).rejects.toBeInstanceOf(CursorLocalCancellationError)
    } finally {
      random.mockRestore()
    }
  })

  it("sleeps the real backoff when no test clock is set", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0)
    try {
      const outage = startOfflineWait()
      await waitOffline(outage, dns(), new AbortController().signal)
      expect(outage.attempts).toBe(1)
    } finally {
      random.mockRestore()
    }
  })

  it("uses a 3 hour window by default", () => {
    expect(OFFLINE_RETRY_WINDOW_MS).toBe(3 * 60 * 60_000)
  })
})
