// Run by test/test-isolation.test.ts in a child `bun test`; only the first test must fail.
import { expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { getHostCacheDirOverride, opencodeGlobalCacheDir } from "../../../src/context/paths.js"
import { setConversationPersistenceHookForTests } from "../../../src/protocol/conversation-persistence.js"
import { withTempHostCache } from "../../host-cache.js"

const runRoot = process.env.XDG_CACHE_HOME
let release!: () => void
const held = new Promise<void>((resolve) => { release = resolve })
let cleanupStarted = false
let abandonedDir = ""
let abandonedCleanup: Promise<void> | undefined

it("times out while its temp host cache is cleaned up", () => {
  // The body returns at once; leaving the cache then waits for its maintenance.
  setConversationPersistenceHookForTests((phase) => {
    if (phase !== "maintenance-start") return
    cleanupStarted = true
    return held
  })
  abandonedCleanup = withTempHostCache((cacheDir) => { abandonedDir = cacheDir })
  return abandonedCleanup
}, 200)

it("starts on the run's own cache root", () => {
  expect(cleanupStarted).toBe(true)
  expect(existsSync(abandonedDir)).toBe(true)
  expect(getHostCacheDirOverride()).toBeUndefined()
  expect(process.env.XDG_CACHE_HOME).toBe(runRoot)
})

it("keeps its own root while the abandoned cleanup finishes", () => withTempHostCache(async (cacheDir) => {
  setConversationPersistenceHookForTests(undefined)
  release()
  await abandonedCleanup
  expect(existsSync(abandonedDir)).toBe(false)
  expect(opencodeGlobalCacheDir()).toBe(cacheDir)
  expect(process.env.XDG_CACHE_HOME).toBe(cacheDir)
}))

it("is back on the run's own cache root afterwards", () => {
  expect(getHostCacheDirOverride()).toBeUndefined()
  expect(process.env.XDG_CACHE_HOME).toBe(runRoot)
})
