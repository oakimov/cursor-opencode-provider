import { expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const script = path.join(root, "scripts/review-retention-contracts.mjs")
setDefaultTimeout(30_000)

function run(subject: string) {
  return spawnSync(process.execPath, [script, subject], { cwd: root, encoding: "utf8", timeout: 25_000 })
}

test("retention contracts exercise real load, maintenance, provenance, temps and inherited test entrypoints", () => {
  const result = run(root)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.match(/RETENTION_CONTRACT=.*:passed/g)).toHaveLength(45)
  expect(result.stdout.match(/RETENTION_TEMP=.*:passed/g)).toHaveLength(5)
  expect(result.stdout.match(/RETENTION_ENV=.*:passed/g)).toHaveLength(3)
})

test("retention checks reject boundary and cleanup mutations and a filter that ran no test", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "retention-mutations-"))
  try {
    for (const item of ["src", "test", "bunfig.toml"]) {
      fs.cpSync(path.join(root, item), path.join(directory, item), { recursive: true })
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    const file = path.join(directory, "src/protocol/conversation-persistence.ts")
    const source = fs.readFileSync(file, "utf8")
    const inclusive = /now - value\.updatedAt <= [A-Za-z0-9_]+/
    expect(inclusive.test(source)).toBe(true)
    fs.writeFileSync(file, source.replace(inclusive, (expression) => expression.replace("<=", "<")))
    const boundary = run(directory)
    expect(boundary.status, boundary.stderr).toBe(1)
    expect(boundary.stderr).toContain("RETENTION_CONTRACT=unset/load/0:failed")
    expect(boundary.stdout).toContain("RETENTION_CONTRACT=unset/load/1:passed")

    const temp = /expired = header\.status === "metadata" && !isFresh\(header\.value, now(?:, CONVERSATION_CACHE_TTL_MS)?\)/
    expect(temp.test(source)).toBe(true)
    fs.writeFileSync(file, source.replace(temp, "expired = false"))
    const cleanup = run(directory)
    expect(cleanup.status, cleanup.stderr).toBe(1)
    expect(cleanup.stderr).toContain("RETENTION_TEMP=unset:failed")
    expect(cleanup.stdout).toContain("RETENTION_CONTRACT=unset/load/0:passed")

    fs.writeFileSync(file, source)
    const testFile = path.join(directory, "test/conversation-maintenance.test.ts")
    const tests = fs.readFileSync(testFile, "utf8")
    const title = "preserves a fresh atomic replacement made before quarantine"
    expect(tests.includes(title)).toBe(true)
    fs.writeFileSync(testFile, tests.replace(title, "renamed atomic replacement probe"))
    const absent = run(directory)
    expect(absent.status, absent.stderr).toBe(1)
    expect(absent.stderr).toMatch(/RETENTION_ENV=604800000:failed exit=[01] matched=false/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
