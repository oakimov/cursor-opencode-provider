// Run by test/test-isolation.test.ts with caller-supplied retention settings.
import { expect, it } from "bun:test"

it("starts with default snapshot retention", () => {
  expect(process.env.CURSOR_PROVIDER_CACHE_TTL_MS).toBeUndefined()
})

it("allows an explicit retention override inside a test", () => {
  const previous = process.env.CURSOR_PROVIDER_CACHE_TTL_MS
  try {
    process.env.CURSOR_PROVIDER_CACHE_TTL_MS = "604800000"
    // Plain child processes must inherit the test's choice; only a new test
    // runner starts over. Persistence fixtures use children as other writers.
    const child = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(process.env.CURSOR_PROVIDER_CACHE_TTL_MS ?? '')"], {
      env: process.env, stdout: "pipe", stderr: "pipe",
    })
    expect(child.exitCode).toBe(0)
    expect(child.stderr.toString()).toBe("")
    expect(child.stdout.toString()).toBe("604800000")
  } finally {
    if (previous === undefined) delete process.env.CURSOR_PROVIDER_CACHE_TTL_MS
    else process.env.CURSOR_PROVIDER_CACHE_TTL_MS = previous
  }
})

it("returns to default snapshot retention", () => {
  expect(process.env.CURSOR_PROVIDER_CACHE_TTL_MS).toBeUndefined()
})
