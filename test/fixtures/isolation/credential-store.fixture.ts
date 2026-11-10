// Run by test/test-isolation.test.ts in a child `bun test`; the first two tests must fail.
import { expect, it } from "bun:test"
import { readStoredAuth } from "../../../src/context/auth-store.js"
import { hostGlobalDataDir } from "../../../src/context/paths.js"

it("leaves the native data root unset", () => {
  delete process.env.XDG_DATA_HOME
})

it("leaves injected credentials behind", () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ cursor: { type: "api", key: "example-left-behind" } })
})

it("still reads the run's own empty store", async () => {
  // The directory first: were it the operator's, the store must not be read.
  expect(hostGlobalDataDir().startsWith(`${process.env.TMPDIR}/`)).toBe(true)
  expect(await readStoredAuth("cursor")).toBeUndefined()
})
