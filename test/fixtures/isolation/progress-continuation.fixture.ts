// Run by test/test-isolation.test.ts with a caller-supplied progress continuation setting.
import { expect, it } from "bun:test"
import { shouldContinueProgressOnlyTurn } from "../../../src/protocol/progress-continuation.js"

const progressFragment = {
  allowTools: true,
  advertisedToolCount: 1,
  assistantText: "Checking the workspace",
  emittedHostTools: 0,
  continuationAttempts: 0,
  pendingExecs: 0,
}

it("starts with the default progress continuation", () => {
  expect(process.env.CURSOR_PROGRESS_CONTINUATION).toBeUndefined()
  expect(shouldContinueProgressOnlyTurn(progressFragment)).toBe(true)
})

it("allows an explicit opt-out inside a test", () => {
  const previous = process.env.CURSOR_PROGRESS_CONTINUATION
  try {
    process.env.CURSOR_PROGRESS_CONTINUATION = "0"
    expect(shouldContinueProgressOnlyTurn(progressFragment)).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.CURSOR_PROGRESS_CONTINUATION
    else process.env.CURSOR_PROGRESS_CONTINUATION = previous
  }
})

it("returns to the default progress continuation", () => {
  expect(process.env.CURSOR_PROGRESS_CONTINUATION).toBeUndefined()
  expect(shouldContinueProgressOnlyTurn(progressFragment)).toBe(true)
})
