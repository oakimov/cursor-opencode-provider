import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createManagedTerminal, releaseUnstartedTerminal, type ManagedTerminal } from "../src/terminal-runner.js"
import { runtimeExecMessages, runtimeLayout } from "../src/runtime-files.js"
import { decodeMessageSparse } from "../src/protocol/messages.js"
import { processTable, stopProcessesUsing } from "./process-cleanup.js"
import { CURSOR_TIMEOUT_BACKGROUND, captureCursorShellResult, consumeCursorShellResult, registerCursorShellCall, resetCursorShellCalls } from "../src/shell-timeout.js"

let root: string
const jobs: ManagedTerminal[] = []
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-terminal-test-")); runtimeLayout(root, true) })
afterEach(async () => {
  // A cleanup that outlives its hook timeout must not remove the next test's root.
  const dir = root
  for (const job of jobs.splice(0)) {
    if (fs.existsSync(path.join(job.directory, "done"))) continue
    let supervisor: number
    try { supervisor = Number(fs.readFileSync(path.join(job.directory, "ready"), "utf8")) } catch { continue /* never started: no record will finish */ }
    try { process.kill(supervisor, "SIGTERM") } catch { continue /* already stopped */ }
    await waitDone(job).catch(() => {})
  }
  // A launcher that had not written `ready` yet, or a collector finishing after
  // `done`, still writes into the job directory: removing the root first lets
  // it recreate the files.
  const jobsDir = path.join(dir, "terminals", ".jobs")
  if (fs.existsSync(jobsDir) && fs.readdirSync(jobsDir, { withFileTypes: true }).some(entry => entry.isDirectory())) {
    await stopProcessesUsing(dir)
  }
  resetCursorShellCalls()
  fs.rmSync(dir, { recursive: true, force: true })
})

function job(command: string, overrides: Record<string, unknown> = {}) {
  const terminal = createManagedTerminal({ command, workingDirectory: root, timeoutMs: 2000, timeoutBehavior: CURSOR_TIMEOUT_BACKGROUND, ...overrides }, root)
  jobs.push(terminal)
  return terminal
}
async function launch(terminal: ManagedTerminal, shell = "/bin/sh", env = process.env) {
  const proc = Bun.spawn([shell, "-c", terminal.command], { env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}
async function waitFor(predicate: () => boolean, ms = 6000) {
  const end = Date.now() + ms
  while (!predicate() && Date.now() < end) await Bun.sleep(25)
  return predicate()
}
const processesFor = (terminal: ManagedTerminal) =>
  processTable().filter(entry => entry.command.includes(terminal.directory)).map(entry => `${entry.pid} ${entry.command}`)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function waitDone(terminal: ManagedTerminal) {
  const end = Date.now() + 7000
  while (!fs.existsSync(path.join(terminal.directory, "done")) && Date.now() < end) await Bun.sleep(25)
  if (!fs.existsSync(path.join(terminal.directory, "done"))) throw new Error("terminal did not finish: " + fs.readFileSync(path.join(terminal.directory, "launcher.log"), "utf8"))
  return fs.readFileSync(terminal.file, "utf8")
}

describe("managed terminal supervisor", () => {
  it("reaps a deadline sleep when TERM arrives before its PID assignment", async () => {
    const terminal = job("true", { timeoutMs: 30_000 })
    // Force the signal into the actual generated deadline's fork/assignment
    // gap. The extra shell targets its real parent, including under dash.
    terminal.command = terminal.command.replace('sleep "$1" &',
      'sleep "$1" &\n    printf "%s\\n" "$!" >"$cursor_job/timer-child-$1"\n    sh -c \'kill -TERM "$PPID"\'\n')
      .replace('cursor_timer=$!', 'cursor_timer=$!\n  while [ ! -f "$cursor_job/timer-child-$1" ]; do sleep 0.01; done')
    const timerPids: number[] = []
    try {
      await launch(terminal)
      for (const seconds of [10, 30]) {
        const file = path.join(terminal.directory, `timer-child-${seconds}`)
        expect(fs.existsSync(file)).toBe(true)
        timerPids.push(Number(fs.readFileSync(file, "utf8")))
      }
      expect(await waitFor(() => timerPids.every(pid => !alive(pid)), 1000)).toBe(true)
    } finally {
      for (const pid of timerPids) if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  })

  it("stops deadline sleeps at once even when TERM cannot reach them", async () => {
    // A TERM that reaches a just-forked sleep before it execs is swallowed by
    // the trap it inherited, exactly as if the sleep ignored TERM.
    const bin = fs.mkdtempSync(path.join(root, "bin-"))
    fs.writeFileSync(path.join(bin, "sleep"), `#!/bin/sh\ntrap '' TERM\nexec ${JSON.stringify(Bun.which("sleep"))} "$@"\n`, { mode: 0o755 })
    const deadlines = () => processTable().filter(entry => /sleep (10|30|60)$/.test(entry.command)).map(entry => entry.pid)
    const before = new Set(deadlines())
    const terminal = job("true", { timeoutMs: 30_000, hardTimeoutMs: 60_000 })
    const started = Date.now()
    const launched = await launch(terminal, "/bin/sh", { ...process.env, PATH: `${bin}:${process.env.PATH}` })
    expect(launched.stdout).toBe("\n__CURSOR_SHELL_EXIT__0\n")
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await waitDone(terminal)).toContain("exit_code: 0")
    expect(await waitFor(() => deadlines().every(pid => before.has(pid)), 2000)).toBe(true)
  }, 15_000)

  it("releases an unstarted job even when its terminal record or index is already missing", () => {
    for (const missing of ["record", "index", "both"] as const) {
      const terminal = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
      const index = path.join(root, "terminals", ".jobs", `${terminal.shellId}.json`)
      if (missing !== "index") fs.unlinkSync(terminal.file)
      if (missing !== "record") fs.unlinkSync(index)
      releaseUnstartedTerminal(terminal.directory)
      expect(fs.existsSync(terminal.file)).toBe(false)
      expect(fs.existsSync(index)).toBe(false)
      expect(fs.existsSync(terminal.directory)).toBe(false)
      releaseUnstartedTerminal(terminal.directory)
    }
  })

  it.each(["cancel", "timeout"])("uses setsid without bash for prompt %s cancellation", async kind => {
    if (!Bun.which("setsid")) return
    const bin = path.join(root, "bin")
    fs.mkdirSync(bin)
    for (const name of ["sh", "setsid", "date", "mkdir", "rmdir", "mkfifo", "nohup", "cat", "wc", "sleep", "tr", "rm", "tail", "head"]) {
      const executable = Bun.which(name)
      if (executable) fs.symlinkSync(executable, path.join(bin, name))
    }
    const terminal = job("sleep 30 & echo $! > child.pid; wait", {
      backgroundSpawn: true, shellPath: "/bin/sh", ...(kind === "timeout" ? { hardTimeoutMs: 250 } : {}),
    })
    const launched = await launch(terminal, "/bin/sh", { ...process.env, PATH: bin })
    const supervisor = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec(launched.stdout)![1])
    expect(await waitFor(() => fs.existsSync(path.join(root, "child.pid")))).toBe(true)
    if (kind === "cancel") process.kill(supervisor, "SIGTERM")
    expect(await waitFor(() => fs.existsSync(path.join(terminal.directory, "done")), 4000)).toBe(true)
    expect(await waitDone(terminal)).toContain("status: aborted")
    expect(alive(Number(fs.readFileSync(path.join(root, "child.pid"), "utf8")))).toBe(false)
  }, 15_000)

  it("retries a terminal id when reserving the file collides", () => {
    const openSync = fs.openSync
    let collided = false
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const target = String(args[0])
      if (!collided && target.includes(`${path.sep}terminals${path.sep}`) && target.endsWith(".txt")) {
        collided = true
        const error = new Error("exists") as NodeJS.ErrnoException
        error.code = "EEXIST"
        throw error
      }
      return openSync(...args)
    }) as typeof fs.openSync
    try {
      const terminal = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
      releaseUnstartedTerminal(terminal.directory)
      expect(collided).toBe(true)
      expect(fs.existsSync(terminal.file)).toBe(false)
    } finally { fs.openSync = openSync }
  })

  it("removes the reservation when terminal setup fails", () => {
    const writeFileSync = fs.writeFileSync
    fs.writeFileSync = ((file, data, options) => {
      if (String(file).endsWith(`${path.sep}owner.json`)) throw new Error("owner failed")
      return writeFileSync(file, data, options)
    }) as typeof fs.writeFileSync
    try {
      expect(() => createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)).toThrow("owner failed")
    } finally { fs.writeFileSync = writeFileSync }
    expect(fs.readdirSync(path.join(root, "terminals")).filter(file => file.endsWith(".txt"))).toHaveLength(0)
    expect(fs.readdirSync(path.join(root, "terminals", ".jobs"))).toHaveLength(0)
  })

  it("reaps the hard-timeout sleep when the watchdog shell is signaled", async () => {
    const seconds = 47
    const terminal = createManagedTerminal({
      command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0,
      backgroundSpawn: true, hardTimeoutMs: seconds * 1000,
    }, root)
    const runner = fs.readFileSync(path.join(terminal.directory, "runner.sh"), "utf8")
    const open = runner.indexOf('(\n    cursor_nap=""')
    const close = runner.indexOf("watchdog=$!", open)
    expect(open).toBeGreaterThan(-1)
    const block = runner.slice(open, close)
    const before = new Set(processTable().filter(entry => entry.command.includes(`sleep ${seconds}`)).map(entry => entry.pid))
    const proc = Bun.spawn(["/bin/sh", "-c", [
      `job=${JSON.stringify(terminal.directory)}`,
      "hard_seconds=47",
      "supervisor=1",
      "exec 4>/dev/null",
      block,
      "watchdog=$!",
      "sleep 0.3",
      'kill -TERM "$watchdog" 2>/dev/null || true',
      'wait "$watchdog" 2>/dev/null || true',
    ].join("\n")], { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(proc.stderr).text()
    expect(await proc.exited).toBe(0)
    expect(stderr).toBe("")
    const leaked = () => processTable().filter(entry => entry.command.includes(`sleep ${seconds}`) && !before.has(entry.pid))
    expect(await waitFor(() => leaked().length === 0, 2000)).toBe(true)
    expect(fs.existsSync(path.join(terminal.directory, "timedout"))).toBe(false)
    releaseUnstartedTerminal(terminal.directory)
  })

  // A helper forked moments before the supervisor stops it can receive that
  // TERM before resetting the supervisor's trap, which discards it.
  it.each([
    ["header updater", "(\n  while ", "(\n  trap '' TERM\n  while "],
    ["hard-timeout watchdog", '(\n    cursor_nap=""', "(\n    trap '' TERM; sleep 1\n    cursor_nap=\"\""],
  ])("finishes the record when the %s misses its stop signal", async (_name, start, missed) => {
    const terminal = job("true", { timeoutMs: 5000, hardTimeoutMs: 30_000 })
    const runner = path.join(terminal.directory, "runner.sh")
    const script = fs.readFileSync(runner, "utf8")
    expect(script.split(start)).toHaveLength(2)
    fs.writeFileSync(runner, script.replace(start, missed))
    expect((await launch(terminal)).stdout).toBe("\n__CURSOR_SHELL_EXIT__0\n")
    expect(await waitDone(terminal)).toContain("exit_code: 0")
  }, 15_000)
  it("leaves an explicitly detached daemon alive after an ordinary Shell exits", async () => {
    const terminal = job("nohup sleep 30 >daemon.log 2>&1 & echo $! > daemon.pid; printf started")
    let daemon = 0
    try {
      expect((await launch(terminal)).stdout).toContain("started")
      daemon = Number(fs.readFileSync(path.join(root, "daemon.pid"), "utf8"))
      await waitDone(terminal)
      await Bun.sleep(3500)
      expect(alive(daemon)).toBe(true)
      expect(await waitFor(() => processesFor(terminal).length === 0)).toBe(true)
    } finally { if (daemon && alive(daemon)) process.kill(daemon, "SIGKILL") }
  }, 15_000)

  it.each(["bash", "zsh"])("runs shell-specific syntax in the selected %s payload shell", async name => {
    const shellPath = Bun.which(name)
    if (!shellPath) return
    const command = name === "bash" ? 'items=(one two); printf "%s" "${items[1]}"' : 'items=(one two); print -r -- ${items[2]}'
    const terminal = job(command, { shellPath })
    expect((await launch(terminal)).stdout).toContain("two")
    expect(await waitDone(terminal)).toContain("exit_code: 0")
  })

  it("keeps aborted output readable when the collector and supervisor are terminated together", async () => {
    const terminal = job("printf preserved; sleep 30", { backgroundSpawn: true })
    const launched = await launch(terminal)
    const supervisor = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec(launched.stdout)![1])
    expect(await waitFor(() => fs.readFileSync(terminal.file, "utf8").includes("---\npreserved"))).toBe(true)
    const collector = processesFor(terminal).find(line => line.includes("collector.cjs"))
    expect(collector).toBeDefined()
    process.kill(Number(collector!.trim().split(/\s+/)[0]), "SIGTERM")
    process.kill(supervisor, "SIGTERM")
    expect(await waitDone(terminal)).toContain("exit_code: 143")
    const frames = await runtimeExecMessages({ id: 2, read_args: { path: terminal.file } }, { env: { project_folder: root } }, true)
    const read = decodeMessageSparse<any>("AgentClientMessage", frames![0]!).exec_client_message.read_result.success
    expect(read.content).toContain("preserved")
    expect(read.content).toContain("status: aborted")
  }, 15_000)

  it("does not infer storage failure from a collector exiting 1 during native cancellation", async () => {
    const terminal = job("printf preserved; sleep 30", { backgroundSpawn: true })
    // A native runtime can report teardown as a low nonzero exit. Exercise
    // that real exit without introducing an I/O error or printing metadata.
    fs.writeFileSync(path.join(terminal.directory, "collector.cjs"), `
const fs = require("node:fs")
const [job, terminal] = process.argv.slice(2)
process.on("SIGTERM", () => process.exit(1))
const fd = fs.openSync(terminal, "a")
fs.createReadStream(job + "/pipe").on("data", chunk => fs.writeSync(fd, chunk))
`)
    const launched = await launch(terminal)
    const supervisor = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec(launched.stdout)![1])
    expect(await waitFor(() => fs.readFileSync(terminal.file, "utf8").includes("---\npreserved"))).toBe(true)
    const collector = processesFor(terminal).find(line => line.includes("collector.cjs"))
    expect(collector).toBeDefined()
    process.kill(Number(collector!.trim().split(/\s+/)[0]), "SIGTERM")
    process.kill(supervisor, "SIGTERM")
    const record = await waitDone(terminal)
    expect(record).toContain("exit_code: 143")
    expect(record).toContain("preserved")
    expect(record).not.toContain("output_storage_failed: true")
  }, 15_000)

  it("reports lost output when the collector dies while the command still runs", async () => {
    const terminal = job("printf before; sleep 1; printf %s%s af ter", { backgroundSpawn: true })
    await launch(terminal)
    expect(await waitFor(() => fs.readFileSync(terminal.file, "utf8").includes("---\nbefore"))).toBe(true)
    const collector = processesFor(terminal).find(line => line.includes("collector.cjs"))
    expect(collector).toBeDefined()
    process.kill(Number(collector!.trim().split(/\s+/)[0]), "SIGKILL")
    const record = await waitDone(terminal)
    expect(record).toContain("output_storage_failed: true")
    expect(record).not.toContain("after")
  }, 15_000)

  it.each(["/bin/sh", "/bin/bash", "/bin/zsh"])("preserves a nonzero foreground-window exit under %s", async shell => {
    if (!fs.existsSync(shell)) return
    const terminal = job("printf done; exit 7")
    const launched = await launch(terminal, shell)
    expect(launched.stdout).toBe("done\n__CURSOR_SHELL_EXIT__7\n")
    expect(launched.code).toBe(7)
    const record = await waitDone(terminal)
    expect(record).toContain('status: failed')
    expect(record).toContain('exit_code: 7')
    expect(record).toContain('cwd: ' + JSON.stringify(root))
    expect(record).toContain('command: "printf done; exit 7"')
  })

  it.each([
    ["true", 0],
    ["false", 1],
    ["cursor-no-such-command-xyz", 127],
  ] as const)("exits the launcher with the status of %s so the host records it", async (command, code) => {
    const terminal = job(command)
    const launched = await launch(terminal)
    expect(launched.code).toBe(code)
    expect(launched.stdout).toEndWith(`\n__CURSOR_SHELL_EXIT__${code}\n`)
    const id = `cursor_exit_${code}`
    registerCursorShellCall(id, { shell_stream: true, command, working_directory: root, timeout_ms: 2000, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND })
    const clean = captureCursorShellResult(id, launched.stdout, { exit: launched.code })
    expect(clean).not.toContain("__CURSOR_SHELL_EXIT__")
    if (code === 127) expect(clean).toContain("cursor-no-such-command-xyz")
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({ kind: "exit", code })
    expect(await waitDone(terminal)).toContain(`exit_code: ${code}`)
  })

  const publish = `printf '%s\\n' "$code" >"$job/done"`
  const invalid = "done\nTerminal record has no valid exit status\n\n__CURSOR_SHELL_EXIT__1\n"
  it.each([
    ["filled late", `: >"$job/done"; sleep 1; ${publish}`, "done\n__CURSOR_SHELL_EXIT__7\n", 7],
    ["malformed", `printf 'lost\\n' >"$job/done"`, invalid, 1],
    ["never filled", `: >"$job/done"; exit 0`, invalid, 1],
  ] as const)("reads a %s exit status only once it is complete and valid", async (_, replacement, stdout, code) => {
    const terminal = job("printf done; exit 7")
    const runner = path.join(terminal.directory, "runner.sh")
    const script = fs.readFileSync(runner, "utf8")
    expect(script.split(publish)).toHaveLength(2)
    fs.writeFileSync(runner, script.replace(publish, replacement))
    expect(await launch(terminal)).toMatchObject({ stdout, code })
  }, 15_000)

  it("initializes explicit background records before returning a distinct shell id and pid", async () => {
    const terminal = job("sleep 0.5; printf later", { backgroundSpawn: true })
    const launched = await launch(terminal)
    const marker = /__CURSOR_BACKGROUND_SHELL__(\d+):(\d+):/.exec(launched.stdout)!
    expect(Number(marker[1])).toBe(terminal.shellId)
    expect(Number(marker[2])).toBeGreaterThan(0)
    expect(fs.readFileSync(terminal.file, "utf8")).toContain("status: running")
    const record = await waitDone(terminal)
    expect(record).toContain("later")
    expect(record).toContain("exit_code: 0")
    registerCursorShellCall("cursor_bg", { background_shell_spawn: true, command: "sleep 0.5; printf later", working_directory: root })
    const clean = captureCursorShellResult("cursor_bg", launched.stdout)
    expect(consumeCursorShellResult("cursor_bg", clean).outcome).toMatchObject({ kind: "backgrounded", shellId: terminal.shellId, pid: Number(marker[2]) })
  })

  it("reports a spawn that finished before the launcher looked as a running handle, not an exit", async () => {
    const terminal = job("printf quick", { backgroundSpawn: true })
    const launched = await launch(terminal)
    expect(launched.code).toBe(0)
    expect(launched.stdout).toMatch(new RegExp(`__CURSOR_BACKGROUND_SHELL__${terminal.shellId}:\\d+:`))
    expect(launched.stdout).not.toContain("__CURSOR_SHELL_EXIT__")
    registerCursorShellCall("cursor_quick", { background_shell_spawn: true, command: "printf quick", working_directory: root })
    captureCursorShellResult("cursor_quick", launched.stdout)
    expect(consumeCursorShellResult("cursor_quick", launched.stdout).outcome).toMatchObject({ kind: "backgrounded", shellId: terminal.shellId })
    expect(await waitDone(terminal)).toContain("quick")
  })

  it("ends the soft-background window on its own clock, not a poll count", async () => {
    const terminal = job("sleep 5", { timeoutMs: 1500 })
    const started = Date.now()
    const launched = await launch(terminal)
    const elapsed = Date.now() - started
    expect(launched.stdout).toContain("__CURSOR_SHELL_BACKGROUND__")
    expect(elapsed).toBeGreaterThanOrEqual(1500)
    expect(elapsed).toBeLessThan(2500)
  }, 15_000)

  it("reports a hard timeout as a timeout when its command is still being stopped at the window's end", async () => {
    const terminal = job("printf before; trap '' TERM; exec sleep 30", { timeoutMs: 1000, hardTimeoutMs: 300 })
    const started = Date.now()
    const { stdout, code } = await launch(terminal)
    expect(stdout).toBe("before\n__CURSOR_SHELL_TIMEOUT__300\n")
    expect(code).toBe(124)
    // One TERM grace and the cancellation drain fit the settle bound, so the
    // result comes from the finished record.
    expect(fs.existsSync(path.join(terminal.directory, "settle-expired"))).toBe(false)
    expect(Date.now() - started).toBeLessThan(6500)
    registerCursorShellCall("cursor_stubborn", { shell_stream: true, command: "stubborn", working_directory: root, timeout_ms: 1000, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND, hard_timeout_ms: 300 })
    captureCursorShellResult("cursor_stubborn", stdout)
    expect(consumeCursorShellResult("cursor_stubborn", stdout).outcome).toEqual({ kind: "timeout", timeoutMs: 300 })
    expect(await waitDone(terminal)).toContain("status: aborted")
  }, 15_000)

  it("reports a timeout when the supervisor dies after the hard deadline", async () => {
    const terminal = job("trap '' TERM; exec sleep 30", { timeoutMs: 10_000, hardTimeoutMs: 200 })
    const launched = launch(terminal)
    expect(await waitFor(() => fs.existsSync(path.join(terminal.directory, "timedout")), 4000)).toBe(true)
    process.kill(Number(fs.readFileSync(path.join(terminal.directory, "ready"), "utf8")), "SIGKILL")
    expect(await launched).toMatchObject({ stdout: "\n__CURSOR_SHELL_TIMEOUT__200\n", code: 124 })
    jobs.pop()
  }, 15_000)

  it.each(["sh", "dash"])("keeps the group shell's job notices out of a signalled command's output when sh is %s", async name => {
    const groupShell = Bun.which(name)
    const payloadShell = Bun.which("bash")
    if (!groupShell || !payloadShell) return
    const bin = fs.mkdtempSync(path.join(root, "bin-"))
    fs.symlinkSync(groupShell, path.join(bin, "sh"))
    const terminal = job("printf before; kill -TERM $$", { shellPath: payloadShell })
    const launched = await launch(terminal, "/bin/sh", { ...process.env, PATH: `${bin}:${process.env.PATH}` })
    expect(launched.stdout).toBe("before\n__CURSOR_SHELL_EXIT__143\n")
    expect(launched.code).toBe(143)
    expect(fs.readFileSync(terminal.file, "utf8")).not.toContain("Terminated")
  })

  it("waits for the record of a command that stops promptly at its hard timeout", async () => {
    const terminal = job("printf before; exec sleep 30", { timeoutMs: 5000, hardTimeoutMs: 300 })
    const started = Date.now()
    expect((await launch(terminal)).stdout).toBe("before\n__CURSOR_SHELL_TIMEOUT__300\n")
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await waitDone(terminal)).toContain("exit_code: 143")
  })

  it("waits for a long-running command without forking a sleep many times per second", async () => {
    const terminal = job("sleep 4", { backgroundSpawn: true })
    const supervisor = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec((await launch(terminal)).stdout)![1])
    const naps = new Set<string>()
    const end = Date.now() + 2000
    while (Date.now() < end) {
      for (const entry of processTable()) {
        if (entry.ppid === supervisor && entry.command.split(" ")[0]!.endsWith("sleep")) naps.add(String(entry.pid))
      }
      await Bun.sleep(20)
    }
    expect(naps.size).toBeLessThanOrEqual(4)
    expect(await waitDone(terminal)).toContain("exit_code: 0")
  }, 15_000)

  it("soft-hands off to the same terminal and captures descendant output without losing the exit code", async () => {
    const terminal = job("(sleep 0.5; printf tail) & printf front; exit 3", { timeoutMs: 100 })
    expect((await launch(terminal)).stdout).toContain("__CURSOR_SHELL_BACKGROUND__")
    const record = await waitDone(terminal)
    expect(record).toContain("fronttail")
    expect(record).toContain("exit_code: 3")
  })

  it("stops the compound command and descendants on a hard timeout", async () => {
    const terminal = job("sleep 30 & echo $! > child.pid; wait", { hardTimeoutMs: 250 })
    const launched = await launch(terminal)
    expect(launched.stdout).toContain("__CURSOR_SHELL_TIMEOUT__250")
    const record = await waitDone(terminal)
    expect(record).toContain("status: aborted")
    const child = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"))
    expect(() => process.kill(child, 0)).toThrow()
  })

  it("finalizes cancellation by supervisor pid", async () => {
    const terminal = job("sleep 30", { backgroundSpawn: true })
    const launched = await launch(terminal)
    const pid = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec(launched.stdout)![1])
    process.kill(pid, "SIGTERM")
    const record = await waitDone(terminal)
    expect(record).toContain("status: aborted")
    expect(record).toContain("exit_code: 143")
  })

  it("retains live jobs when provider wrapper state is released", async () => {
    const terminal = job("sleep 0.5; printf survived", { backgroundSpawn: true })
    await launch(terminal)
    releaseUnstartedTerminal(terminal.directory)
    resetCursorShellCalls()
    expect(await waitDone(terminal)).toContain("survived")
  })

  it("keeps a job whose reservation is released after its command started but before it is ready", async () => {
    const terminal = job("printf started; sleep 0.2; printf finished", { backgroundSpawn: true })
    const runner = path.join(terminal.directory, "runner.sh")
    const original = fs.readFileSync(runner, "utf8")
    // Hold the supervisor between starting the command and reporting ready.
    const held = original.replace(`printf '%s\\n' "$supervisor" >"$job/ready"`,
      `while [ ! -f "$job/go" ]; do sleep 0.01; done\nprintf '%s\\n' "$supervisor" >"$job/ready"`)
    expect(held).not.toBe(original)
    fs.writeFileSync(runner, held)
    const launched = launch(terminal)
    expect(await waitFor(() => fs.existsSync(path.join(terminal.directory, "group-ready")))).toBe(true)
    releaseUnstartedTerminal(terminal.directory)
    expect(fs.existsSync(terminal.file)).toBe(true)
    fs.writeFileSync(path.join(terminal.directory, "go"), "")
    expect((await launched).stdout).toContain("__CURSOR_BACKGROUND_SHELL__")
    const record = await waitDone(terminal)
    expect(record).toContain("startedfinished")
    expect(record).toContain("status: succeeded")
  })

  it("runs nothing from a reservation released before its launcher started", async () => {
    const terminal = job("touch should-not-exist", { backgroundSpawn: true })
    jobs.pop()
    releaseUnstartedTerminal(terminal.directory)
    expect(fs.existsSync(terminal.directory)).toBe(false)
    const launched = await launch(terminal)
    expect(launched.code).toBe(1)
    expect(launched.stdout).toBe("Background terminal was released before it started\n\n__CURSOR_SHELL_EXIT__1\n")
    expect(fs.existsSync(path.join(root, "should-not-exist"))).toBe(false)
    expect(fs.existsSync(terminal.file)).toBe(false)
  })

  it("hands its reservation back when the launcher cannot write the command", async () => {
    const terminal = job("touch should-not-exist", { backgroundSpawn: true })
    jobs.pop()
    fs.mkdirSync(path.join(terminal.directory, "command.sh"))
    const launched = await launch(terminal)
    expect(launched.code).toBe(1)
    expect(fs.existsSync(path.join(root, "should-not-exist"))).toBe(false)
    releaseUnstartedTerminal(terminal.directory)
    expect(fs.existsSync(terminal.directory)).toBe(false)
    expect(fs.existsSync(terminal.file)).toBe(false)
  })

  it("does not report a background success when initialization fails", async () => {
    const terminal = job("touch should-not-exist", { backgroundSpawn: true, workingDirectory: path.join(root, "missing") })
    const launched = await launch(terminal)
    expect(launched.code).toBe(1)
    expect(launched.stdout).not.toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(fs.existsSync(path.join(root, "should-not-exist"))).toBe(false)
    jobs.pop()
    releaseUnstartedTerminal(terminal.directory)
    expect(fs.existsSync(terminal.file)).toBe(false)
  })

  it("shows output in the record while the command is still running", async () => {
    // The header repeats the command, so the expected output is computed.
    const terminal = job("printf 'listening on %s\\n' 3000; sleep 3", { backgroundSpawn: true })
    await launch(terminal)
    expect(await waitFor(() => fs.readFileSync(terminal.file, "utf8").includes("listening on 3000"), 2000)).toBe(true)
    expect(fs.readFileSync(terminal.file, "utf8")).toContain("status: running")
  })

  it("hands off a command that printed nothing in its window without a head error", async () => {
    const terminal = job("sleep 3", { timeoutMs: 500 })
    const { stdout, stderr, code } = await launch(terminal)
    expect(stdout).toMatch(/^\n__CURSOR_SHELL_BACKGROUND__\d+:\d+:/)
    expect(stderr).toBe("")
    expect(code).toBe(0)
  })

  it("returns the foreground window's output with a soft handoff", async () => {
    const terminal = job("printf 'front\\n'; sleep 3", { timeoutMs: 500 })
    const { stdout } = await launch(terminal)
    expect(stdout).toMatch(/front\n\n__CURSOR_SHELL_BACKGROUND__\d+:\d+:/)
    registerCursorShellCall("cursor_soft", { shell_stream: true, command: "printf front", working_directory: root, timeout_ms: 500, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND })
    const clean = captureCursorShellResult("cursor_soft", stdout)
    expect(clean).toBe(`front\nStill running in the background (shell ${terminal.shellId}, pid ${/:(\d+):/.exec(stdout)![1]}) after 500ms. Output: ${terminal.file}\n`)
  })

  it("stops the command group and its watchdog when the supervisor is killed, and reports the record as aborted", async () => {
    const deadlines = () => processTable().filter(entry => /sleep 86400$/.test(entry.command)).map(entry => entry.pid)
    const before = new Set(deadlines())
    const terminal = job("sleep 30 & echo $! > child.pid; wait", { backgroundSpawn: true, hardTimeoutMs: 86_400_000 })
    const launched = await launch(terminal)
    const supervisor = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec(launched.stdout)![1])
    expect(await waitFor(() => fs.existsSync(path.join(root, "child.pid")))).toBe(true)
    expect(await waitFor(() => deadlines().some(pid => !before.has(pid)))).toBe(true)
    const child = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"))
    process.kill(supervisor, "SIGKILL")
    expect(await waitFor(() => !alive(child))).toBe(true)
    expect(await waitFor(() => processesFor(terminal).length === 0)).toBe(true)
    expect(await waitFor(() => deadlines().every(pid => before.has(pid)))).toBe(true)
    const stale = new Date(Date.now() - 60_000)
    fs.utimesSync(terminal.file, stale, stale)
    const frames = await runtimeExecMessages({ id: 1, read_args: { path: terminal.file } }, { env: { project_folder: root } }, true)
    const read = decodeMessageSparse<any>("AgentClientMessage", frames![0]!).exec_client_message.read_result.success
    expect(read.content).toContain("status: aborted")
    expect(read.content).toContain("exit_code: unknown")
    jobs.pop()
  })

  it("stops a killed supervisor's collector while a detached descendant holds the output open", async () => {
    const terminal = job("bash -c 'set -m; sleep 30 & echo $! > daemon.pid'; sleep 30", { backgroundSpawn: true })
    const launched = await launch(terminal)
    const supervisor = Number(/__CURSOR_BACKGROUND_SHELL__\d+:(\d+):/.exec(launched.stdout)![1])
    expect(await waitFor(() => fs.existsSync(path.join(root, "daemon.pid")))).toBe(true)
    const daemon = Number(fs.readFileSync(path.join(root, "daemon.pid"), "utf8"))
    try {
      process.kill(supervisor, "SIGKILL")
      expect(await waitFor(() => processesFor(terminal).length === 0, 12_000)).toBe(true)
      // Deliberately detached work outlives its record, as on normal completion.
      expect(alive(daemon)).toBe(true)
    } finally {
      if (alive(daemon)) process.kill(daemon, "SIGKILL")
    }
    jobs.pop()
  }, 20_000)

  it("reads a completed record whose job directory was swept before its index", async () => {
    const terminal = job("printf swept", { backgroundSpawn: true })
    await launch(terminal)
    await waitDone(terminal)
    fs.rmSync(terminal.directory, { recursive: true, force: true })
    expect(fs.existsSync(path.join(root, "terminals", ".jobs", `${terminal.shellId}.json`))).toBe(true)
    const frames = await runtimeExecMessages({ id: 1, read_args: { path: terminal.file } }, { env: { project_folder: root } }, true)
    const read = decodeMessageSparse<any>("AgentClientMessage", frames![0]!).exec_client_message.read_result.success
    expect(read.content).toContain("---\nswept\n---\nexit_code: 0\n")
    jobs.pop()
  })

  it("updates the record header in place instead of rewriting the output", async () => {
    const terminal = job("printf payload; sleep 2.5", { backgroundSpawn: true })
    await launch(terminal)
    expect(await waitFor(() => fs.readFileSync(terminal.file, "utf8").includes("---\npayload"), 4000)).toBe(true)
    const before = fs.statSync(terminal.file)
    const header = fs.readFileSync(terminal.file, "utf8").indexOf("---\npayload")
    await Bun.sleep(1500)
    const after = fs.statSync(terminal.file)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs)
    expect(fs.readFileSync(terminal.file, "utf8").indexOf("---\npayload")).toBe(header)
    const record = await waitDone(terminal)
    expect(record).toMatch(/status: succeeded\nstarted_at: [^\n]+\nrunning_for_ms: \d+ *\n---\npayload\n---\nexit_code: 0\n/)
  }, 10_000)

  it("embeds the command verbatim in the launcher, materialized only when the launcher runs", async () => {
    const command = "printf 'it'\\''s visible\\n'\nprintf second"
    const terminal = job(command, { backgroundSpawn: true })
    expect(terminal.command).toContain("\n" + command + "\n")
    expect(fs.existsSync(path.join(terminal.directory, "command.sh"))).toBe(false)
    await launch(terminal)
    expect(await waitDone(terminal)).toContain("it's visible\nsecond")
  }, 15_000)

  it("gives the command group a grace period between TERM and KILL", async () => {
    const terminal = job("trap 'sleep 1; echo graceful > graceful.txt; exit 0' TERM; sleep 30 & wait", { hardTimeoutMs: 300 })
    expect((await launch(terminal)).stdout).toContain("__CURSOR_SHELL_TIMEOUT__300")
    await waitDone(terminal)
    expect(fs.readFileSync(path.join(root, "graceful.txt"), "utf8")).toBe("graceful\n")
  })

  it("caps stored output at 8 MiB without blocking the command", async () => {
    const terminal = job("head -c 9437184 /dev/zero | tr '\\000' x; printf done > finished.txt", { backgroundSpawn: true })
    await launch(terminal)
    const record = await waitDone(terminal)
    expect(fs.readFileSync(path.join(root, "finished.txt"), "utf8")).toBe("done")
    expect(record).toContain("[Partial output: terminal output reached the 8 MiB storage limit]")
    expect(record).toContain("exit_code: 0")
    expect(Math.max(...record.match(/x+/g)!.map(run => run.length))).toBe(8 * 1024 * 1024)
  }, 20_000)

  it("never overshoots the storage budget while draining a fast binary producer", async () => {
    const terminal = job("head -c 134217728 /dev/zero; printf finished > finished.txt", { backgroundSpawn: true })
    await launch(terminal)
    let peak = 0
    expect(await waitFor(() => {
      peak = Math.max(peak, fs.statSync(terminal.file).size)
      return fs.existsSync(path.join(terminal.directory, "done"))
    })).toBe(true)
    const record = await waitDone(terminal)
    expect(peak).toBeLessThan(8 * 1024 * 1024 + 4096)
    expect(record).toContain("exit_code: 0")
    expect(fs.readFileSync(path.join(root, "finished.txt"), "utf8")).toBe("finished")
  }, 20_000)
})
