import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { buildRequestContext, resetWorkspaceFactsForTests } from "../src/context/build.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"

const execFileAsync = promisify(execFile)
const roots: string[] = []
let previousCache: string | undefined

async function repo(): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-workspace-facts-")))
  roots.push(root)
  await execFileAsync("git", ["init", "-q"], { cwd: root })
  fs.writeFileSync(path.join(root, "a.txt"), "a\n")
  return root
}

const status = (context: Record<string, unknown>) =>
  (context.git_repos as Array<{ status: string }>)[0]!.status

// A built request context creates the workspace's project folder under the host cache.
beforeEach(() => {
  previousCache = getHostCacheDirOverride()
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-workspace-facts-cache-"))
  roots.push(cache)
  setHostCacheDirOverride(cache)
})

afterEach(() => {
  setSystemTime()
  resetWorkspaceFactsForTests()
  setHostCacheDirOverride(previousCache)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("workspace facts", () => {
  it("serves one workspace's git and layout discovery to builds moments apart", async () => {
    const root = await repo()
    const first = await buildRequestContext({ workspaceRoot: root, mergedConfig: {} })
    fs.writeFileSync(path.join(root, "b.txt"), "b\n")
    const second = await buildRequestContext({ workspaceRoot: root, mergedConfig: {} })
    expect(status(second)).toBe(status(first))
    expect(status(second)).not.toContain("b.txt")

    setSystemTime(new Date(Date.now() + 30_000))
    const later = await buildRequestContext({ workspaceRoot: root, mergedConfig: {} })
    expect(status(later)).toContain("b.txt")
  })

  it("reports git status incomplete when git status fails", async () => {
    const root = await repo()
    await execFileAsync("git", ["add", "a.txt"], { cwd: root })
    fs.writeFileSync(path.join(root, ".git", "index"), "corrupt index")
    const context = await buildRequestContext({ workspaceRoot: root, mergedConfig: {} })
    expect(context.git_status_info_complete).toBe(false)
    expect(status(context)).toBe("")
  })

  it("reports git status complete when it succeeds", async () => {
    const root = await repo()
    const context = await buildRequestContext({ workspaceRoot: root, mergedConfig: {} })
    expect(context.git_status_info_complete).toBe(true)
    expect(status(context)).toContain("a.txt")
  })
})
