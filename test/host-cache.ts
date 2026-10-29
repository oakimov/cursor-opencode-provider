import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { settleRunSavesForTests } from "../src/language-model.js"
import { waitForConversationMaintenanceForTests } from "../src/protocol/conversation-persistence.js"

/**
 * Run a test body with the provider's host cache root in a private temp dir.
 * Without one, project folders, model caches and conversation snapshots go to
 * the native OpenCode cache. Saves still writing, and the conversation store
 * a language model starts preparing without waiting, are awaited before the
 * previous root is restored and the dir is removed.
 */
export async function withTempHostCache<T>(run: (cacheDir: string) => T | Promise<T>): Promise<T> {
  const previous = getHostCacheDirOverride()
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-cache-"))
  setHostCacheDirOverride(cacheDir)
  try {
    return await run(cacheDir)
  } finally {
    await settleRunSavesForTests()
    await waitForConversationMaintenanceForTests(cacheDir)
    setHostCacheDirOverride(previous)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
}
