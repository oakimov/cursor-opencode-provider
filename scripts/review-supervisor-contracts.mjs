// Run the subject's generated launcher with no host or Cursor credentials.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const label = "SUPERVISOR_CONTRACTS"
if (process.platform !== "linux") {
  console.log("SUPERVISOR_CONTRACT=platform:skipped requires Linux process-session evidence")
  console.log(`REVIEW_CONTRACT_COMPLETE=${label}:passed`)
  process.exit(0)
}

const subject = resolve(process.argv[2] ?? process.cwd())
const { createManagedTerminal } = await import(pathToFileURL(join(subject, "src/terminal-runner.ts")).href)
let failed = false
function result(scenario, problem) {
  failed ||= Boolean(problem)
  console.log(`SUPERVISOR_CONTRACT=${scenario}:${problem ? "failed " + problem : "passed"}`)
}

function processInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(" ")
    const [state, parent, group, session] = fields
    if (state === "Z" || state === "X") return
    return { pid, parent: Number(parent), group: Number(group), session: Number(session), start: fields[19] }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error
  }
}

function members(session) {
  if (!session) return []
  return readdirSync("/proc").filter(name => /^\d+$/.test(name))
    .map(name => processInfo(Number(name))).filter(info => info?.session === session)
}

function alive(process) {
  return processInfo(process.pid)?.start === process.start
}

function signal(info, name) {
  if (!alive(info)) return
  try { process.kill(info.pid, name) }
  catch (error) { if (error.code !== "ESRCH") throw error }
}

async function until(check, timeout) {
  const end = performance.now() + timeout
  do {
    const value = check()
    if (value) return value
    await delay(25)
  } while (performance.now() < end)
}

function read(file) {
  try { return readFileSync(file, "utf8") }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

async function withJob(scenarios, probe) {
  const root = mkdtempSync(join(tmpdir(), "review-supervisor-"))
  let session
  try {
    const terminal = createManagedTerminal({
      command: 'printf "%s\\n" "$$" >payload.pid; exec sleep 90',
      workingDirectory: root, shellPath: "/bin/sh", timeoutMs: 0, timeoutBehavior: 0,
      backgroundSpawn: true,
    }, root)
    const launch = spawnSync("/bin/sh", ["-c", terminal.command], {
      cwd: root, encoding: "utf8", detached: true, timeout: 12_000, killSignal: "SIGKILL",
    })
    session = launch.pid
    const marker = /^__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/m.exec(launch.stdout ?? "")
    if (launch.status !== 0 || !marker || !session || session === processInfo(process.pid)?.session) {
      throw new Error("launcher did not return an isolated supervisor")
    }
    const supervisor = processInfo(Number(marker[1]))
    const payload = await until(() => processInfo(Number(read(join(root, "payload.pid")) || 0)), 3000)
    const leader = payload && processInfo(payload.group)
    if (supervisor?.session !== session || payload?.session !== session || leader?.parent !== supervisor.pid) {
      throw new Error("could not identify the supervisor, leader and payload")
    }
    // The live command has a leader, collector and header updater. Require
    // the extra direct child before cutting the owner during its idle wait.
    if (!await until(() => members(session).filter(info => info.parent === supervisor.pid).length >= 4, 3000)) {
      throw new Error("did not observe an active supervisor wait")
    }
    await probe({ terminal, session, supervisor, leader, payload })
  } catch (error) {
    for (const scenario of scenarios) result(scenario, error.message)
  } finally {
    // The launcher and all of its process groups share a private session.
    // This also finds the reparented helpers when the behavior is broken.
    if (session !== processInfo(process.pid)?.session) {
      const stopped = await until(() => {
        const remaining = members(session)
        for (const info of remaining) signal(info, "SIGKILL")
        return remaining.length === 0
      }, 2000)
      if (!stopped) result("cleanup", "job processes survived cleanup")
    }
    rmSync(root, { recursive: true, force: true })
  }
}

await withJob(["supervisor-death"], async ({ session, supervisor }) => {
  signal(supervisor, "SIGKILL")
  const stopped = await until(() => members(session).length === 0, 7000)
  result("supervisor-death", stopped ? undefined : "job processes survived supervisor death")
})

await withJob(["leader-death-record", "leader-death-payload"], async ({ terminal, leader, payload }) => {
  signal(leader, "SIGKILL")
  // Allow the older supervisor's one-second poll and five-second drain.
  // Record finalization and payload shutdown are independent obligations.
  const [code, stopped] = await Promise.all([
    until(() => read(join(terminal.directory, "done"))?.trim(), 8000),
    until(() => !alive(payload), 8000),
  ])
  result("leader-death-record", code === "137" ? undefined
    : code ? "unexpected exit code after leader death" : "terminal record did not finalize after leader death")
  result("leader-death-payload", stopped ? undefined : "payload survived leader death")
})

console.log(`REVIEW_CONTRACT_COMPLETE=${label}:${failed ? "failed" : "passed"}`)
process.exitCode = failed ? 1 : 0
