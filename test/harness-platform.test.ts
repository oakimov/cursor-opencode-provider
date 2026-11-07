import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

it("supports native and container test environments without requiring Cursor agent", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", [
    "-B", path.join(import.meta.dir, "test_harness_test.py"),
  ], { encoding: "utf8" })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
