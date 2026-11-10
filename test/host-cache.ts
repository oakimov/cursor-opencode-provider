import { afterEach, beforeEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { settleRunSavesForTests } from "../src/language-model.js"
import { waitForConversationMaintenanceForTests } from "../src/protocol/conversation-persistence.js"
import { atTestEnd } from "./test-end.js"

type TempHostCache = {
  cacheDir: string
  previousOverride: string | undefined
  previousXdg: string | undefined
  restored: boolean
}

/**
 * Without a cache root of its own, a test writes project folders, model and
 * client-version caches and conversation snapshots to the native OpenCode
 * cache. Module copies a test loads keep their own override, so the native
 * root (`XDG_CACHE_HOME`) moves into the temp dir too.
 */
function enter(): TempHostCache {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-cache-"))
  const state = {
    cacheDir,
    previousOverride: getHostCacheDirOverride(),
    previousXdg: process.env.XDG_CACHE_HOME,
    restored: false,
  }
  setHostCacheDirOverride(cacheDir)
  process.env.XDG_CACHE_HOME = cacheDir
  open.add(state)
  return state
}

/** Put the previous roots back, once. */
function restore(state: TempHostCache): void {
  if (state.restored) return
  state.restored = true
  setHostCacheDirOverride(state.previousOverride)
  if (state.previousXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = state.previousXdg
}

/**
 * Saves still writing, and the conversation store a language model starts
 * preparing without waiting, finish before the previous roots are restored and
 * the dir is removed, which happens even when waiting fails.
 */
async function leave(state: TempHostCache): Promise<void> {
  try {
    await settleRunSavesForTests()
    await waitForConversationMaintenanceForTests(state.cacheDir)
  } finally {
    restore(state)
    open.delete(state)
    fs.rmSync(state.cacheDir, { recursive: true, force: true })
  }
}

/** Temp host caches entered and not yet left, oldest first. */
const open = new Set<TempHostCache>()

/**
 * One still open when its test has ended belongs to a test or hook that timed
 * out, in its body or while `leave` waits: Bun fails it and lets it keep
 * running. Its roots go back now, newest first. Restored only when it
 * finishes, they would be the roots of the tests in between, and a scope
 * entered meanwhile would later restore the removed dir as the root of every
 * test after it.
 */
atTestEnd(() => {
  for (const state of [...open].reverse()) restore(state)
  open.clear()
})

/** Run one test body with the host cache in a private temp dir. */
export async function withTempHostCache<T>(run: (cacheDir: string) => T | Promise<T>): Promise<T> {
  const state = enter()
  try {
    return await run(state.cacheDir)
  } finally {
    await leave(state)
  }
}

/** Give every test in the calling file or `describe` block its own temp host cache. */
export function useTempHostCache(): void {
  let state: TempHostCache | undefined
  beforeEach(() => {
    state = enter()
  })
  afterEach(async () => {
    const current = state
    state = undefined
    if (current) await leave(current)
  })
}
