import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const script = path.join(root, "scripts/review-supervisor-contracts.mjs")

function run(subject: string) {
  return spawnSync(process.execPath, [script, subject], { encoding: "utf8", timeout: 30_000 })
}

test.skipIf(process.platform !== "linux")("the trusted supervisor probe exercises both owner deaths", () => {
  const result = run(root)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain("SUPERVISOR_CONTRACT=supervisor-death:passed")
  expect(result.stdout).toContain("SUPERVISOR_CONTRACT=leader-death-record:passed")
  expect(result.stdout).toContain("SUPERVISOR_CONTRACT=leader-death-payload:passed")
  expect(result.stdout.trimEnd()).toEndWith("REVIEW_CONTRACT_COMPLETE=SUPERVISOR_CONTRACTS:passed")
}, 35_000)

test.skipIf(process.platform !== "linux")("the supervisor probe rejects an orphan wait and delayed leader recovery", () => {
  const subject = fs.mkdtempSync(path.join(os.tmpdir(), "review-supervisor-mutations-"))
  try {
    fs.cpSync(path.join(root, "src"), path.join(subject, "src"), { recursive: true })
    fs.symlinkSync(path.join(root, "node_modules"), path.join(subject, "node_modules"), "dir")
    const file = path.join(subject, "src/terminal-runner.ts")
    const source = fs.readFileSync(file, "utf8")
    const wait = '(read -r -t "$1" -u 6 unused || :) 6<"$job/lifeline" 4>&- &'
    const wakeLostLeader = 'if ! kill -0 "$command_pid" 2>/dev/null; then'
    expect(source.split(wait)).toHaveLength(2)
    expect(source.split(wakeLostLeader)).toHaveLength(2)
    fs.writeFileSync(file, source.replace(wait, 'sleep "$1" 4>&- &').replace(wakeLostLeader, "if false; then"))

    const result = run(subject)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain("SUPERVISOR_CONTRACT=supervisor-death:failed job processes survived supervisor death")
    expect(result.stdout).toContain("SUPERVISOR_CONTRACT=leader-death-record:failed terminal record did not finalize")
    expect(result.stdout).not.toContain("SUPERVISOR_CONTRACT=cleanup:failed")
    expect(result.stdout.trimEnd()).toEndWith("REVIEW_CONTRACT_COMPLETE=SUPERVISOR_CONTRACTS:failed")
  } finally {
    fs.rmSync(subject, { recursive: true, force: true })
  }
}, 35_000)
