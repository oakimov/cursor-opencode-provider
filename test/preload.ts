import { afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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

afterAll(() => {
  const left = fs.readdirSync(runTmp)
    .filter((entry) => entry !== HOST_CACHE_HOME || hostCacheLeftovers().length > 0)
  const files = leftoverFiles()
  removeRunTmp()
  if (left.length > 0) {
    throw new Error(
      `Tests left ${left.length} entr${left.length === 1 ? "y" : "ies"} in TMPDIR; remove them in the test that `
        + `creates them: ${left.slice(0, 20).join(", ")}\n${files.join("\n")}`,
    )
  }
})
