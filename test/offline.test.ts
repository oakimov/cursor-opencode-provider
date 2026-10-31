import { describe, expect, it } from "bun:test"
import { CursorTransportError } from "../src/errors.js"
import {
  connectivityClass,
  offlineDelayMs,
  offlineHold,
  setOfflineClockForTests,
  waitUntilReachable,
  OFFLINE_RETRY_WINDOW_MS,
} from "../src/offline.js"

const dns = () => new CursorTransportError("Cursor HTTP/2 connection failed", {
  transient: true,
  replaySafe: true,
  code: "ENOTFOUND",
})

describe("offline wait", () => {
  it("treats DNS and network-down codes as offline, and walks the cause", () => {
    expect(connectivityClass(dns())).toBe("offline")
    expect(connectivityClass(new CursorTransportError("Cursor HTTP/2 connection failed", {
      transient: true,
      replaySafe: true,
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api2.cursor.sh"), { code: "ENOTFOUND" }),
    }))).toBe("offline")
    expect(connectivityClass(new CursorTransportError("Cursor Run sent no frames for 30000ms", {
      transient: true,
      replaySafe: true,
      code: "CURSOR_SEMANTIC_IDLE_TIMEOUT",
    }))).toBe("maybe")
    expect(connectivityClass(new Error("Cursor authentication failed"))).toBe("online")
  })

  it("caps the offline backoff at 30 seconds", () => {
    expect(offlineDelayMs(0, 1)).toBe(500)
    expect(offlineDelayMs(20, 1)).toBe(30_000)
  })

  it("does not hold a silence timeout while the network probe succeeds", async () => {
    setOfflineClockForTests({ reachable: async () => true })
    try {
      const silence = new CursorTransportError("Cursor Run sent no frames for 30000ms", {
        transient: true,
        replaySafe: true,
        code: "CURSOR_SEMANTIC_IDLE_TIMEOUT",
      })
      expect(await offlineHold(silence)).toBe(false)
      expect(await offlineHold(dns())).toBe(true)
    } finally {
      setOfflineClockForTests(undefined)
    }
  })

  it("waits out an outage without ending the window early, then returns when the probe succeeds", async () => {
    let probes = 0
    const sleeps: number[] = []
    setOfflineClockForTests({
      now: () => 1_000,
      windowMs: 60_000,
      sleep: async (delayMs) => { sleeps.push(delayMs) },
      reachable: async () => ++probes >= 4,
    })
    try {
      await waitUntilReachable(dns(), undefined, 1_000)
      expect(probes).toBe(4)
      expect(sleeps.length).toBe(4)
    } finally {
      setOfflineClockForTests(undefined)
    }
  })

  it("fails the turn once the offline window has elapsed", async () => {
    setOfflineClockForTests({
      now: () => 10_000,
      windowMs: 1_000,
      sleep: async () => {},
      reachable: async () => false,
    })
    try {
      await expect(waitUntilReachable(dns(), undefined, 0)).rejects.toThrow(/unreachable for/)
    } finally {
      setOfflineClockForTests(undefined)
    }
  })

  it("uses a 3 hour window by default", () => {
    expect(OFFLINE_RETRY_WINDOW_MS).toBe(3 * 60 * 60_000)
  })
})
