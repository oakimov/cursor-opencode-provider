// Run by test/test-isolation.test.ts; only the first test must fail.
import { expect, it } from "bun:test"

it("leaves a retention override behind", () => {
  process.env.CURSOR_PROVIDER_CACHE_TTL_MS = "1"
})

it("still starts with default snapshot retention", () => {
  expect(process.env.CURSOR_PROVIDER_CACHE_TTL_MS).toBeUndefined()
})
