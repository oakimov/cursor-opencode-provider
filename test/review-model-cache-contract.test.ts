import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

test("the trusted Run check detects cache-root and file-generation mutants", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-cache-contract-"))
  try {
    const env = { ...process.env, NODE_COMPILE_CACHE: path.join(directory, "node-cache"), XDG_CACHE_HOME: path.join(directory, "cache") }
    // Build this trusted source separately: CI runs tests before building dist.
    fs.cpSync(path.join(root, "src"), path.join(directory, "src"), { recursive: true })
    for (const file of ["tsconfig.json", "package.json"]) fs.copyFileSync(path.join(root, file), path.join(directory, file))
    fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir")
    const built = spawnSync(process.execPath, ["run", "build"], { cwd: directory, encoding: "utf8", timeout: 20_000, env })
    expect(built.status, built.stderr).toBe(0)
    const file = path.join(directory, "dist/language-model.js")
    const original = fs.readFileSync(file, "utf8")
    const condition = "availableModelsCache?.filePath === filePath && availableModelsCache.generation === generation"
    expect(original).toContain(condition)
    const snapshot = "const modelInfo = availableModels?.find"
    expect(original).toContain(snapshot)
    for (const [target, replacement, diagnostic] of [
      [condition, condition, ""],
      [condition, 'availableModelsCache?.generation.split(":")[3] === generation.split(":")[3]', "equal-time-other-root:failed"],
      [condition, 'availableModelsCache?.filePath === filePath && availableModelsCache.generation.split(":")[3] === generation.split(":")[3]', "equal-time-replacement:failed"],
      [snapshot, "const modelInfo = availableModelsCache?.models?.find", "inflight-snapshot:failed"],
    ]) {
      fs.writeFileSync(file, original.replace(target!, replacement!))
      const result = spawnSync("node", [path.join(root, "scripts/review-model-cache-contract.mjs"), directory], {
        encoding: "utf8", timeout: 15_000, env,
      })
      expect(result.signal, result.stderr).toBeNull()
      expect(result.status, result.stderr).toBe(diagnostic ? 1 : 0)
      if (diagnostic) expect(result.stderr).toContain(diagnostic)
      else expect(result.stdout.match(/MODEL_CACHE_CONTRACT=.*:passed/g)).toHaveLength(7)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
