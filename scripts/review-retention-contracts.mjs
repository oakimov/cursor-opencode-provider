// Synthetic persistence probes and inherited-environment regressions. Runs
// inside isolate-run.sh against the subject; no host or Cursor credential.
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
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

for (const setting of [undefined, "604800000", "5000", "not-a-number", "0"]) {
  if (setting === undefined) delete process.env[variable]
  else process.env[variable] = setting
  const ttl = typeof shared.resolveConversationCacheTtlMs === "function" && (setting === "604800000" || setting === "5000")
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
process.exitCode = failed ? 1 : 0
