// Run by test/test-isolation.test.ts in a child `bun test`; only the first test must fail.
import { expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { getHostCacheDirOverride, opencodeGlobalCacheDir } from "../../../src/context/paths.js"
import { withTempHostCache } from "../../host-cache.js"

const runRoot = process.env.XDG_CACHE_HOME
let release!: () => void
const held = new Promise<void>((resolve) => { release = resolve })
let abandonedDir = ""
let abandonedBody: Promise<void> | undefined

it("times out inside a temp host cache", () => {
  abandonedBody = withTempHostCache(async (cacheDir) => {
    abandonedDir = cacheDir
    await held
  })
  return abandonedBody
}, 30)

it("starts on the run's own cache root", () => {
  expect(existsSync(abandonedDir)).toBe(true)
  expect(getHostCacheDirOverride()).toBeUndefined()
  expect(process.env.XDG_CACHE_HOME).toBe(runRoot)
})

it("keeps its own root while the abandoned body finishes", () => withTempHostCache(async (cacheDir) => {
  release()
  await abandonedBody
  expect(existsSync(abandonedDir)).toBe(false)
  expect(opencodeGlobalCacheDir()).toBe(cacheDir)
  expect(process.env.XDG_CACHE_HOME).toBe(cacheDir)
}))

it("is back on the run's own cache root afterwards", () => {
  expect(getHostCacheDirOverride()).toBeUndefined()
  expect(process.env.XDG_CACHE_HOME).toBe(runRoot)
})
