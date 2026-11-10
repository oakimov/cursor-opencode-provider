// Run by test/test-isolation.test.ts in a child `bun test`; the first test must fail.
import { expect, it } from "bun:test"

it("swallows a refused request", async () => {
  // 192.0.2.1 is TEST-NET-1 (RFC 5737), which is never routed.
  await fetch("https://192.0.2.1/models?token=example").catch(() => undefined)
})

it("runs after it unaffected", () => {
  expect(true).toBe(true)
})
