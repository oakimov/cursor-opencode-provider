import { afterAll, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installNetworkGuard, takeNetworkAttempts } from "./network-guard.js"
import { runTestEnd } from "./test-end.js"

/**
 * Every test run gets a private TMPDIR. Whatever a test leaves in it fails the
 * run, and the directory is removed either way, so a run never leaves anything
 * in the caller's TMPDIR. Child processes inherit it through the environment.
 */
const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-"))
process.env.TMPDIR = runTmp
process.env.TMP = runTmp
process.env.TEMP = runTmp

/**
 * The native host cache root (`$XDG_CACHE_HOME/opencode`) lives in it too, so a
 * test that does not set its own cache root never writes to the operator's
 * real cache. Anything left there fails the run like any other leftover,
 * except the transpiler cache of the `bun` processes tests spawn.
 */
const HOST_CACHE_HOME = "xdg-cache"
const hostCacheHome = path.join(runTmp, HOST_CACHE_HOME)
fs.mkdirSync(hostCacheHome)
process.env.XDG_CACHE_HOME = hostCacheHome
const hostCacheLeftovers = () => fs.readdirSync(hostCacheHome).filter((entry) => entry !== "bun")

/**
 * So does the native data root (`$XDG_DATA_HOME/opencode`), which holds the
 * credential store `auth.json`; it starts empty and `OPENCODE_AUTH_CONTENT` is
 * cleared. No test reads the operator's Cursor login or renews its session: a
 * test that needs a credential writes a fake one. A test that points the store
 * elsewhere puts it back, and anything left in the root fails the run.
 */
const HOST_DATA_HOME = "xdg-data"
const hostDataHome = path.join(runTmp, HOST_DATA_HOME)
fs.mkdirSync(hostDataHome)
process.env.XDG_DATA_HOME = hostDataHome
delete process.env.OPENCODE_AUTH_CONTENT

/** Nothing a test does reaches Cursor or any other host (`test/network-guard.ts`). */
installNetworkGuard()

const removeRunTmp = () => fs.rmSync(runTmp, { recursive: true, force: true })
process.on("exit", removeRunTmp)

/** Files under the leftover entries, so a CI failure shows what wrote them. */
function leftoverFiles(): string[] {
  try {
    return (fs.readdirSync(runTmp, { recursive: true }) as string[]).sort().slice(0, 40)
  } catch {
    return []
  }
}

/** Refused network attempts since the last check, as one failure message. */
function networkFailure(): string | undefined {
  const attempts = [...new Set(takeNetworkAttempts())]
  return attempts.length > 0
    ? `tried to reach the network (${attempts.join(", ")}); stub fetch or use a local server`
    : undefined
}

/**
 * These hooks run after the test's own, also when it timed out. A test that
 * tried the network fails even when the code under test swallowed the refusal,
 * and so does one that leaves the credential store pointing elsewhere, which
 * is put back so the tests after it stay isolated.
 */
afterEach(() => {
  runTestEnd()
  const failures = [networkFailure()]
  if (process.env.XDG_DATA_HOME !== hostDataHome || process.env.OPENCODE_AUTH_CONTENT !== undefined) {
    process.env.XDG_DATA_HOME = hostDataHome
    delete process.env.OPENCODE_AUTH_CONTENT
    failures.push("left XDG_DATA_HOME or OPENCODE_AUTH_CONTENT changed; restore what the test sets")
  }
  const failed = failures.filter((failure) => failure !== undefined)
  if (failed.length > 0) throw new Error(`This test ${failed.join(", and ")}.`)
})

afterAll(() => {
  const network = networkFailure()
  const left = fs.readdirSync(runTmp).filter((entry) => {
    if (entry === HOST_CACHE_HOME) return hostCacheLeftovers().length > 0
    if (entry === HOST_DATA_HOME) return fs.readdirSync(hostDataHome).length > 0
    return true
  })
  const files = leftoverFiles()
  removeRunTmp()
  const failures = network ? [`After the last test ended, code ${network}.`] : []
  if (left.length > 0) {
    failures.push(
      `Tests left ${left.length} entr${left.length === 1 ? "y" : "ies"} in TMPDIR; remove them in the test that `
        + `creates them: ${left.slice(0, 20).join(", ")}\n${files.join("\n")}`,
    )
  }
  if (failures.length > 0) throw new Error(failures.join("\n"))
})
