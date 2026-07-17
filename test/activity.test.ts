import { describe, expect, it } from "bun:test"
import { SessionActivityTracker } from "../src/activity.js"

describe("SessionActivityTracker retention", () => {
  it("evicts activity that is older than the retention window", () => {
    const tracker = new SessionActivityTracker()
    const now = Date.now()
    tracker.recordActivity("expired", now - 25 * 60 * 60 * 1_000)
    tracker.recordActivity("current", now)

    expect(tracker.lastActivityAt("expired")).toBeUndefined()
    expect(tracker.lastActivityAt("current")).toBe(now)
  })
})
