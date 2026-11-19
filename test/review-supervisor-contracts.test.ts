import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { processTable } from "./process-cleanup.js"

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

function sessionFor(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const [state, , , session] = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")
    return state === "Z" || state === "X" ? undefined : Number(session)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function waitFor(check: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout
  while (!check() && Date.now() < end) await Bun.sleep(20)
  return check()
}

test.skipIf(process.platform !== "linux").each([
  { startup: true, signal: "SIGTERM", exit: 143 },
  { startup: false, signal: "SIGINT", exit: 130 },
] as const)("cancellation cleans the owned session and probe files (%j)", async ({ startup, signal, exit }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-supervisor-cancel-"))
  const subject = path.join(temp, "subject")
  const scratch = path.join(temp, "scratch")
  fs.mkdirSync(scratch)
  fs.cpSync(path.join(root, "src"), path.join(subject, "src"), { recursive: true })
  fs.symlinkSync(path.join(root, "node_modules"), path.join(subject, "node_modules"), "dir")
  const file = path.join(subject, "src/terminal-runner.ts")
  const source = fs.readFileSync(file, "utf8")
  // Hold execution on either side of publishing readiness, before the probe
  // can observe an active wait and kill the supervisor itself.
  const hold = startup ? 'printf \'%s\\n\' "$supervisor" >"$job/ready"'
    : '(\n  while [ ! -f "$job/finishing" ] && tick'
  expect(source.split(hold)).toHaveLength(2)
  fs.writeFileSync(file, source.replace(hold, `sleep 30\n${hold}`))
  const child = Bun.spawn([process.execPath, script, subject], {
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    stdout: "pipe", stderr: "pipe",
  })
  let session: number | undefined
  const jobMembers = () => session
    ? processTable().filter(({ pid }) => sessionFor(pid) === session)
    : []
  try {
    expect(await waitFor(() => {
      for (const entry of fs.readdirSync(scratch)) {
        const file = path.join(scratch, entry, "payload.pid")
        if (!fs.existsSync(file)) continue
        session = sessionFor(Number(fs.readFileSync(file, "utf8")))
        if (session && Boolean(sessionFor(session)) === startup) return true
      }
      return false
    })).toBe(true)
    expect(jobMembers().length).toBeGreaterThan(0)
    child.kill(signal)
    expect(await waitFor(() => child.exitCode !== null || child.signalCode !== null)).toBe(true)
    expect(jobMembers()).toHaveLength(0)
    expect(fs.readdirSync(scratch)).toEqual([])
    expect(await child.exited).toBe(exit)
    expect(await new Response(child.stdout).text()).not.toContain("REVIEW_CONTRACT_COMPLETE")
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await child.exited
    for (const { pid } of jobMembers()) {
      try { process.kill(pid, "SIGKILL") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    expect(await waitFor(() => jobMembers().length === 0)).toBe(true)
    fs.rmSync(temp, { recursive: true, force: true })
  }
}, 15_000)

test.skipIf(process.platform !== "linux")("the supervisor probe rejects an orphan wait and delayed leader recovery", () => {
  const subject = fs.mkdtempSync(path.join(os.tmpdir(), "review-supervisor-mutations-"))
  try {
    fs.cpSync(path.join(root, "src"), path.join(subject, "src"), { recursive: true })
    fs.symlinkSync(path.join(root, "node_modules"), path.join(subject, "node_modules"), "dir")
    const file = path.join(subject, "src/terminal-runner.ts")
    const source = fs.readFileSync(file, "utf8")
    const wait = '(read -r -t "$1" -u 6 unused || :) 6<"$idle_pipe" 4>&- 7>&- &'
    const wakeLostLeader = 'if ! kill -0 "$command_pid" 2>/dev/null; then'
    expect(source.split(wait)).toHaveLength(2)
    expect(source.split(wakeLostLeader)).toHaveLength(2)
    fs.writeFileSync(file, source.replace(wait, 'sleep "$1" 4>&- 7>&- &').replace(wakeLostLeader, "if false; then"))

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
