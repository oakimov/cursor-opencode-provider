// Synthetic persistence probes and inherited-environment regressions. Runs
// inside isolate-run.sh against the subject; no host or Cursor credential.
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve, join } from "node:path"
import { pathToFileURL } from "node:url"

const subject = resolve(process.argv[2] ?? process.cwd())
const load = (name) => import(pathToFileURL(resolve(subject, name)).href)
const persistence = await load("src/protocol/conversation-persistence.ts")
const shared = await load("src/shared.ts")
const variable = "CURSOR_PROVIDER_CACHE_TTL_MS"
const previous = process.env[variable]
const baseline = 86_400_000
const writtenAt = 1_900_000_000_000
let failed = false
const configurable = typeof shared.resolveConversationCacheTtlMs === "function"
console.log(`RETENTION_FEATURE=${configurable ? "configurable" : "fixed"}`)

for (const setting of [undefined, "604800000", "5000", "not-a-number", "0"]) {
  if (setting === undefined) delete process.env[variable]
  else process.env[variable] = setting
  const ttl = configurable && (setting === "604800000" || setting === "5000")
    ? Number(setting) : baseline
  for (const mode of ["load", "maintenance", "provenance"]) {
    for (const delta of [-1, 0, 1]) {
      const root = await mkdtemp(join(tmpdir(), "review-retention-"))
      const now = writtenAt + ttl + delta
      const expected = delta <= 0
      try {
        await persistence.persistConversation(root, {
          sessionKey: "review-retention", conversationId: "retained", blobs: [], requestContext: { rules_info_complete: true }, turnProvenance: "review-provenance",
        }, writtenAt)
        await persistence.waitForConversationMaintenanceForTests(root, writtenAt)
        persistence.resetConversationPersistenceForTests()
        if (mode === "maintenance") await persistence.waitForConversationMaintenanceForTests(root, now)
        const value = mode === "provenance"
          ? await persistence.getPersistedTurnProvenance(root, "review-retention", now)
          : (await persistence.loadPersistedConversation(root, "review-retention", now)).value
        if (Boolean(value) !== expected || (value && value.conversationId !== "retained")) {
          throw new Error(`expected retained=${expected}, observed retained=${Boolean(value)}`)
        }
        console.log(`RETENTION_CONTRACT=${setting ?? "unset"}/${mode}/${delta}:passed`)
      } catch (error) {
        failed = true
        console.error(`RETENTION_CONTRACT=${setting ?? "unset"}/${mode}/${delta}:failed ${error.message}`)
      } finally {
        // Settle the scheduled sweep before removing its root or resetting the
        // module. A reset alone requests cancellation but does not await it.
        try { await persistence.waitForConversationMaintenanceForTests(root, now) }
        catch (error) { failed = true; console.error(`RETENTION_CLEANUP=failed ${error.message}`) }
        finally {
          persistence.resetConversationPersistenceForTests()
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  }
  const root = await mkdtemp(join(tmpdir(), "review-retention-temp-"))
  try {
    await persistence.persistConversation(root, {
      sessionKey: "review-retention", conversationId: "retained", blobs: [], requestContext: { rules_info_complete: true },
    }, writtenAt)
    await persistence.waitForConversationMaintenanceForTests(root, writtenAt)
    const file = persistence.conversationCacheFilePath(root, "review-retention")
    const bytes = await readFile(file)
    const temp = join(persistence.conversationCacheDirectoryPath(root), ".review.pb.gz.1.abandoned.tmp")
    await writeFile(temp, bytes)
    await persistence.waitForConversationMaintenanceForTests(root, writtenAt + baseline + 1)
    const present = await readFile(temp).then(() => true, (error) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (present) throw new Error("abandoned writer temp survived the fixed 24 h window")
    console.log(`RETENTION_TEMP=${setting ?? "unset"}:passed`)
  } catch (error) {
    failed = true
    console.error(`RETENTION_TEMP=${setting ?? "unset"}:failed ${error.message}`)
  } finally {
    try { await persistence.waitForConversationMaintenanceForTests(root, writtenAt + baseline + 1) }
    catch (error) { failed = true; console.error(`RETENTION_CLEANUP=failed ${error.message}`) }
    finally {
      persistence.resetConversationPersistenceForTests()
      await rm(root, { recursive: true, force: true })
    }
  }
}
// Exercise recovery with more than one generation left by interrupted GC.
// The old generation is only eligible once the operator extends retention.
process.env[variable] = "604800000"
for (const scenario of ["newest", "live-wins", "retry-promotion"]) {
  if (scenario === "retry-promotion" && (process.platform === "win32" || process.getuid?.() === 0)) {
    console.log("RETENTION_QUARANTINE=retry-promotion:skipped permissions-unavailable")
    continue
  }
  const root = await mkdtemp(join(tmpdir(), "review-quarantine-"))
  const sessionKey = "review-quarantine"
  const cache = persistence.conversationCacheDirectoryPath(root)
  const live = persistence.conversationCacheFilePath(root, sessionKey)
  const quarantine = join(cache, ".gc", basename(live))
  const replacementAt = writtenAt + 2 * baseline
  const now = replacementAt + 1
  const save = async (conversationId, timestamp) => {
    await persistence.persistConversation(root, {
      sessionKey, conversationId, blobs: [], requestContext: { rules_info_complete: true },
    }, timestamp)
    await persistence.waitForConversationMaintenanceForTests(root, timestamp)
    return readFile(live)
  }
  const exists = async file => stat(file).then(() => true, error => {
    if (error.code === "ENOENT") return false
    throw error
  })
  try {
    const older = await save("older", writtenAt)
    const replacement = await save("replacement", replacementAt)
    if (scenario === "live-wins") await save("live", now)
    else await rm(live)
    await mkdir(quarantine, { recursive: true })
    await writeFile(join(quarantine, "one.snapshot"), "")
    await writeFile(join(quarantine, "two.snapshot"), "")
    // Place the old bytes first in directory order, independent of filename sort.
    const slots = []
    for await (const entry of await opendir(quarantine)) slots.push(join(quarantine, entry.name))
    const [olderPath, replacementPath] = slots
    await writeFile(olderPath, older)
    await writeFile(replacementPath, replacement)
    if (scenario === "retry-promotion") {
      await chmod(cache, 0o500)
      try {
        await persistence.waitForConversationMaintenanceForTests(root, now)
        if (await exists(live) || !await exists(replacementPath)) throw new Error("lost replacement after failed promotion")
      } finally {
        await chmod(cache, 0o700)
      }
    }
    persistence.resetConversationPersistenceForTests()
    await persistence.waitForConversationMaintenanceForTests(root, now)
    const loaded = await persistence.loadPersistedConversation(root, sessionKey, now)
    const expected = scenario === "live-wins" ? "live" : "replacement"
    if (loaded.value?.conversationId !== expected) {
      throw new Error(`expected ${expected}, observed ${loaded.value?.conversationId ?? loaded.status}`)
    }
    if (await exists(quarantine)) throw new Error("quarantine survived successful recovery")
    console.log(`RETENTION_QUARANTINE=${scenario}:passed`)
  } catch (error) {
    failed = true
    console.error(`RETENTION_QUARANTINE=${scenario}:failed ${error.message}`)
  } finally {
    try { await persistence.waitForConversationMaintenanceForTests(root, now) }
    catch (error) { failed = true; console.error(`RETENTION_CLEANUP=failed ${error.message}`) }
    finally {
      persistence.resetConversationPersistenceForTests()
      await rm(root, { recursive: true, force: true })
    }
  }
}
if (previous === undefined) delete process.env[variable]
else process.env[variable] = previous

// Run the existing default-policy entrypoint with supported settings inherited
// by Bun itself. Setting an override only inside a new feature test misses this.
const file = "./test/conversation-maintenance.test.ts"
const pattern = "preserves a fresh atomic replacement made before quarantine"
for (const setting of ["604800000", "5000", "not-a-number"]) {
  const result = spawnSync(process.execPath, ["test", file, "--test-name-pattern", pattern], {
    cwd: subject, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, [variable]: setting, NO_COLOR: "1" },
  })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  // Require evidence that the selected assertion ran as well as a zero exit.
  const ran = /^\s*1 pass\s*$/m.test(output)
  if (result.error || result.status !== 0 || !ran) {
    failed = true
    console.error(`RETENTION_ENV=${setting}:failed exit=${result.status} matched=${ran}`)
    console.error(output)
    if (result.error) console.error(result.error.message)
  } else console.log(`RETENTION_ENV=${setting}:passed`)
}
console.log(`REVIEW_CONTRACT_COMPLETE=RETENTION_CONTRACTS:${failed ? "failed" : "passed"}`)
process.exitCode = failed ? 1 : 0
