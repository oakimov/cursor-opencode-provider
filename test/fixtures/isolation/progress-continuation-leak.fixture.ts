// Run by test/test-isolation.test.ts; only the first test must fail.
import { expect, it } from "bun:test"

it("leaves a progress continuation opt-out behind", () => {
  process.env.CURSOR_PROGRESS_CONTINUATION = "0"
})

it("still starts with the default progress continuation", () => {
  expect(process.env.CURSOR_PROGRESS_CONTINUATION).toBeUndefined()
})
