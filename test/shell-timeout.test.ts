import { afterEach, describe, expect, it } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"
import { createManagedTerminal } from "../src/terminal-runner.js"
import { runtimeLayout } from "../src/runtime-files.js"
import {
  CURSOR_TIMEOUT_BACKGROUND,
  armCursorShellCreate,
  buildBackgroundShellCommand,
  buildSoftBackgroundCommand,
  sanitizeCursorShellDisplayOutput,
  sanitizeRegisteredCursorShellOutput,
  captureCursorShellResult,
  consumeCursorShellResult,
  cursorShellEnvForCall,
  disarmCursorShellCreate,
  prepareCursorShellArgs,
  prepareCursorShellCreate,
  registerCursorShellCall,
  releaseCursorShellEnv,
  resetCursorShellCalls,
  resolveCursorShellKind,
  resolveCursorShellPath,
  setCursorShellPath,
  shellPolicyFromMetadata,
} from "../src/shell-timeout.js"
import { reapBackgroundSpawn } from "./background-spawn.js"

afterEach(() => resetCursorShellCalls())

async function independentShellCopy(root: string): Promise<typeof import("../src/shell-timeout.js")> {
  cpSync(path.join(import.meta.dir, "../src"), path.join(root, "src"), { recursive: true })
  symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(root, "node_modules"), "dir")
  return import(pathToFileURL(path.join(root, "src/shell-timeout.ts")).href)
}

const metadata = (overrides: Record<string, unknown> = {}) => ({
  shell_stream: true,
  command: "sleep 60",
  working_directory: "/tmp",
  timeout_ms: 30_000,
  timeout_behavior: 0,
  ...overrides,
})

describe("Cursor shell timeout translation", () => {
  it.each(["feature/cp16  \r\n\t\n\n", "no newline  ", "\r", " \t\n\n", "(no output)", ""])("preserves wrapped stdout bytes: %j", output => {
    const id = "cursor_verbatim_wrapper"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    const raw = `${output}\n__CURSOR_SHELL_EXIT__0\n`
    const clean = captureCursorShellResult(id, raw, { exit: 0 })
    expect(clean).toBe(output)
    expect(sanitizeRegisteredCursorShellOutput(id, raw)).toBe(output)
    expect(consumeCursorShellResult(id, clean)).toEqual({ output, outcome: { kind: "exit", code: 0 } })
  })

  it("preserves whitespace before a real native timeout envelope", () => {
    const id = "cursor_native_timeout_whitespace"
    const progress = "feature/cp16  \r\n\t\n\n"
    registerCursorShellCall(id, metadata())
    const raw = `${progress}\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms.\n</shell_metadata>`
    const clean = captureCursorShellResult(id, raw, { exit: null })
    expect(clean).toBe(`${progress}Timed out after 30000ms.\n`)
    expect(consumeCursorShellResult(id, clean).output).toBe(clean)
  })

  it("strips OpenCode's internal timeout envelope and preserves real stdout", () => {
    const id = "cursor_session_1"
    registerCursorShellCall(id, metadata())
    const clean = captureCursorShellResult(
      id,
      "progress\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.\n</shell_metadata>",
      { exit: null },
    )
    expect(clean).toBe("progress\nTimed out after 30000ms.\n")
    expect(consumeCursorShellResult(id, clean)).toEqual({
      output: "progress\nTimed out after 30000ms.\n",
      outcome: { kind: "timeout", timeoutMs: 30_000 },
    })
  })

  it("removes OpenCode's synthetic no-output placeholder on timeout", () => {
    const id = "cursor_session_2"
    registerCursorShellCall(id, metadata())
    const raw = "(no output)\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. Retry.\n</shell_metadata>"
    expect(captureCursorShellResult(id, raw)).toBe("Timed out after 30000ms.\n")
    expect(consumeCursorShellResult(id, "Timed out after 30000ms.\n").outcome).toEqual({
      kind: "timeout",
      timeoutMs: 30_000,
    })
  })

  it("ignores repeated timeout headers without a closing metadata tag", () => {
    const id = "cursor_session_timeout_headers"
    registerCursorShellCall(id, metadata())
    const raw = "<shell_metadata>\nshell tool terminated command after exceeding timeout 9 ms.\n".repeat(20_000)
    expect(captureCursorShellResult(id, raw)).toBe(raw)
  })

  it("strips a timeout envelope after large stdout", () => {
    const id = "cursor_session_large_timeout"
    registerCursorShellCall(id, metadata())
    const raw = `${"progress\n".repeat(20_000)}<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. Retry.\n</shell_metadata>`
    const clean = captureCursorShellResult(id, raw)
    expect(clean).toBe(`${"progress\n".repeat(20_000)}Timed out after 30000ms.\n`)
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({
      kind: "timeout",
      timeoutMs: 30_000,
    })
  })

  it("records ordinary Bash exit metadata without rewriting output", () => {
    const id = "cursor_session_3"
    registerCursorShellCall(id, metadata())
    expect(captureCursorShellResult(id, "failed\n", { exit: 23 })).toBe("failed\n")
    expect(consumeCursorShellResult(id, "failed\n")).toEqual({
      output: "failed\n",
      outcome: { kind: "exit", code: 23 },
    })
  })

  it("does not consume wrapper-like output from an ordinary foreground command", () => {
    const id = "cursor_session_foreground_marker"
    registerCursorShellCall(id, metadata())
    const output = "__CURSOR_SHELL_EXIT__23\n"
    expect(captureCursorShellResult(id, output, { exit: 0 })).toBe(output)
    expect(consumeCursorShellResult(id, output).outcome).toEqual({ kind: "exit", code: 0 })
  })

  it("uses the final wrapper outcome when command output contains an earlier sentinel", () => {
    const id = "cursor_marker_in_stdout"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    const clean = captureCursorShellResult(id, "__CURSOR_SHELL_BACKGROUND__1234:/tmp/example\nfailed\n__CURSOR_SHELL_EXIT__7\n")
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({ kind: "exit", code: 7 })
    expect(clean).toContain("failed")
  })

  it("does not turn a failed spawn into success from an earlier stdout sentinel", () => {
    const id = "cursor_spawn_marker_in_stdout"
    registerCursorShellCall(id, { background_shell_spawn: true, command: "example" })
    const clean = captureCursorShellResult(id, "__CURSOR_BACKGROUND_SHELL__1234:/tmp/example\n__CURSOR_SHELL_EXIT__1\n")
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({ kind: "exit", code: 1 })
  })

  it("keeps soft-background display command original and wraps via shell.env injectors", () => {
    setCursorShellPath("/bin/bash")
    const id = "cursor_session_4"
    const policyMetadata = metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      hard_timeout_ms: 120_000,
    })
    registerCursorShellCall(id, policyMetadata)
    const args: Record<string, unknown> = { command: "sleep 60", timeout: 30_000 }
    prepareCursorShellArgs(id, args)
    expect(args.timeout).toBe(45_000)
    // Display/storage/permissions keep the original command.
    expect(args.command).toBe("sleep 60")

    const env = cursorShellEnvForCall(id)
    expect(env?.BASH_ENV).toBeString()
    expect(env?.ZDOTDIR).toBeString()
    expect(existsSync(env!.BASH_ENV)).toBe(true)
    expect(existsSync(`${env!.ZDOTDIR}/.zshenv`)).toBe(true)
    const injector = readFileSync(env!.BASH_ENV, "utf8")
    expect(injector).toContain("exec /bin/sh")
    expect(injector).toContain("unset BASH_ENV ZDOTDIR ENV CURSOR_OPENCODE_WRAP_ACTIVE")
    // Wrapper body still contains soft-background machinery.
    const wrapperMatch = injector.match(/exec \/bin\/sh '([^']+)'/)
    expect(wrapperMatch?.[1]).toBeString()
    const wrapper = readFileSync(wrapperMatch![1]!, "utf8")
    expect(wrapper).toContain("cursor-opencode-shell")
    expect(wrapper).toContain("cursor-shell-watchdog")
    expect(wrapper).toContain('"$cursor_hard_poll" -lt "$1"')
    expect(wrapper).toContain("cursor-shell-watchdog 1200")
    expect(wrapper).toContain("__CURSOR_SHELL_BACKGROUND__")
    releaseCursorShellEnv(id)
  })

  it("turns the private background sentinel into a typed handoff", () => {
    const id = "cursor_session_5"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    const clean = captureCursorShellResult(
      id,
      "started\n\n__CURSOR_SHELL_BACKGROUND__43210:/tmp/cursor-opencode-shell.XYZ\n",
      { exit: 0 },
    )
    expect(clean).toBe("started\nStill running in the background (pid 43210) after 30000ms.\n")
    expect(consumeCursorShellResult(id, clean)).toEqual({
      output: "started\nStill running in the background (pid 43210) after 30000ms.\n",
      outcome: {
        kind: "backgrounded",
        shellId: 43210,
        pid: 43210,
        command: "sleep 60",
        workingDirectory: "/tmp",
        msToWait: 30_000,
        reason: 1,
      },
    })
  })

  it("does not expose a marker-only background wrapper as blank stdout", () => {
    const id = "cursor_session_marker_only"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    expect(captureCursorShellResult(
      id,
      "\n__CURSOR_SHELL_BACKGROUND__43210:/tmp/cursor-opencode-shell.XYZ\n",
    )).toBe("Still running in the background (pid 43210) after 30000ms.\n")
  })

  it("turns the hard-timeout sentinel into a typed timeout", () => {
    const id = "cursor_session_6"
    registerCursorShellCall(id, metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      hard_timeout_ms: 60_000,
    }))
    const clean = captureCursorShellResult(id, "some output\n__CURSOR_SHELL_TIMEOUT__60000\n")
    expect(clean).toBe("some output\nTimed out after 60000ms.\n")
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({
      kind: "timeout",
      timeoutMs: 60_000,
    })
  })

  it("strips exit markers even when bash job-control noise trails them", () => {
    const id = "cursor_session_exit_trailing_noise"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    const raw =
      "hello\n\n__CURSOR_SHELL_EXIT__0\n/bin/bash: line 31:  4676 Terminated: 15          nohup sh -c 'cursor-shell-watchdog'\n"
    const clean = captureCursorShellResult(id, raw, { exit: 0 })
    expect(clean).toBe("hello\n")
    expect(clean.includes("__CURSOR_SHELL_EXIT__")).toBe(false)
    expect(clean.includes("Terminated")).toBe(false)
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({ kind: "exit", code: 0 })
  })

  it("strips background markers when trailing host-shell diagnostics follow", () => {
    const id = "cursor_session_bg_trailing_noise"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    const raw =
      "started\n\n__CURSOR_SHELL_BACKGROUND__43210:/tmp/cursor-opencode-shell.XYZ\n/bin/bash: line 12:  99 Terminated: 15          nohup sh -c 'watchdog'\n"
    expect(captureCursorShellResult(id, raw, { exit: 0 })).toBe(
      "started\nStill running in the background (pid 43210) after 30000ms.\n",
    )
  })

  it("builds soft-background wrappers that disown/reap the watchdog before markers", () => {
    const policy = shellPolicyFromMetadata(metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      hard_timeout_ms: 120_000,
    }))!
    const wrapped = buildSoftBackgroundCommand(policy)
    expect(wrapped).toContain("set +m")
    expect(wrapped).toContain('disown "$cursor_shell_watchdog_pid"')
    expect(wrapped).toContain('wait "$cursor_shell_watchdog_pid" 2>/dev/null || true')
    const exitMarkerAt = wrapped.indexOf("__CURSOR_SHELL_EXIT__")
    const waitWatchdogAt = wrapped.lastIndexOf('wait "$cursor_shell_watchdog_pid"', exitMarkerAt)
    expect(waitWatchdogAt).toBeGreaterThan(-1)
    expect(waitWatchdogAt).toBeLessThan(exitMarkerAt)
  })

  it("builds a zero-wait background wrapper for Cursor's special timeout=0 semantics", () => {
    const policy = shellPolicyFromMetadata(metadata({
      timeout_ms: 0,
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
    }))!
    expect(policy.timeoutMs).toBe(0)
    expect(buildSoftBackgroundCommand(policy)).toContain('[ "$cursor_shell_poll" -lt 0 ]')
  })

  async function runSoftBackground(command: string, shell: string, overrides: Record<string, unknown> = {}) {
    const policy = { command, workingDirectory: tmpdir(), timeoutMs: 2000, timeoutBehavior: CURSOR_TIMEOUT_BACKGROUND, shellPath: "/bin/sh", ...overrides }
    const proc = Bun.spawn([shell, "-c", buildSoftBackgroundCommand(policy)], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { stdout, stderr, exitCode }
  }

  it.each(["/bin/sh", "/bin/bash", "/bin/dash"].flatMap(shell => [
    [shell, "printf done", "done\n__CURSOR_SHELL_EXIT__0\n", 0],
    [shell, "printf done; exit 3", "done\n__CURSOR_SHELL_EXIT__3\n", 3],
    [shell, "kill -TERM $$", "\n__CURSOR_SHELL_EXIT__143\n", 143],
  ] as const))("reports the command's own status under %s for %s, without job notices", async (shell, command, expected, exitCode) => {
    if (!existsSync(shell)) return
    expect(await runSoftBackground(command, shell)).toEqual({ stdout: expected, stderr: "", exitCode })
  })

  it("exits 0 when it hands a still-running command off to the background", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-soft-handoff-"))
    try {
      const pidFile = path.join(root, "pid")
      const { stdout, exitCode } = await runSoftBackground(`echo $$ >'${pidFile}'; printf started; exec sleep 30`, "/bin/sh", { timeoutMs: 300 })
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL")
      expect(stdout).toMatch(/^started\n__CURSOR_SHELL_BACKGROUND__\d+:/)
      expect(exitCode).toBe(0)
      rmSync(stdout.match(/__CURSOR_SHELL_BACKGROUND__\d+:([^\n]+)/)![1]!, { force: true })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 15_000)

  it.each([
    ["stops promptly", "exec sleep 30"],
    ["ignores TERM until the watchdog kills it", "trap '' TERM; exec sleep 30"],
  ])("reports a hard timeout as a timeout when the command %s", async (_, command) => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-soft-timeout-"))
    try {
      const pidFile = path.join(root, "pid")
      const result = await runSoftBackground(`echo $$ >'${pidFile}'; printf before; ${command}`, "/bin/sh", { timeoutMs: 1000, hardTimeoutMs: 300 })
      expect(result).toEqual({ stdout: "before\n__CURSOR_SHELL_TIMEOUT__300\n", stderr: "", exitCode: 124 })
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 15_000)

  it("keeps background_shell_spawn display command original and wraps via shell.env", () => {
    setCursorShellPath("/bin/bash")
    const id = "cursor_session_bg_spawn"
    registerCursorShellCall(id, {
      background_shell_spawn: true,
      command: "zig translate-c /tmp/tiny.c -lc",
      working_directory: "/tmp",
    })
    const args: Record<string, unknown> = { command: "zig translate-c /tmp/tiny.c -lc" }
    prepareCursorShellArgs(id, args)
    expect(args.command).toBe("zig translate-c /tmp/tiny.c -lc")

    const env = cursorShellEnvForCall(id)
    expect(env?.BASH_ENV).toBeString()
    const injector = readFileSync(env!.BASH_ENV, "utf8")
    const wrapperMatch = injector.match(/exec \/bin\/sh '([^']+)'/)
    expect(wrapperMatch?.[1]).toBeString()
    const wrapper = readFileSync(wrapperMatch![1]!, "utf8")
    expect(wrapper).toContain("nohup \"$cursor_payload_shell\" -c 'zig translate-c /tmp/tiny.c -lc'")
    expect(wrapper).toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(wrapper).toContain("</dev/null &")
    expect(buildBackgroundShellCommand("echo hi")).toContain("__CURSOR_BACKGROUND_SHELL__")
    releaseCursorShellEnv(id)
  })

  it("strips background spawn markers from display output and records a typed handoff", () => {
    const id = "cursor_session_bg_spawn_result"
    registerCursorShellCall(id, {
      background_shell_spawn: true,
      command: "sleep 10",
      working_directory: "/tmp",
    })
    const raw = "__CURSOR_BACKGROUND_SHELL__43210:/tmp/cursor-opencode-bg.ABC123\n"
    expect(sanitizeRegisteredCursorShellOutput(id, raw)).toBe(
      "Started in the background (pid 43210).\n",
    )
    const clean = captureCursorShellResult(id, raw, { exit: 0 })
    expect(clean).toBe("Started in the background (pid 43210).\n")
    expect(consumeCursorShellResult(id, clean)).toEqual({
      output: "Started in the background (pid 43210).\n",
      outcome: {
        kind: "backgrounded",
        shellId: 43210,
        pid: 43210,
        command: "sleep 10",
        workingDirectory: "/tmp",
        msToWait: 0,
        reason: 1,
      },
    })
  })

  it("exec-replaces bash -c original command via BASH_ENV injector", async () => {
    setCursorShellPath("/bin/bash")
    const id = "cursor_session_env_exec_bash"
    registerCursorShellCall(id, {
      background_shell_spawn: true,
      command: "echo SHOULD_NOT_RUN",
      working_directory: "/tmp",
    })
    prepareCursorShellArgs(id, { command: "echo SHOULD_NOT_RUN" })
    const env = cursorShellEnvForCall(id)!
    const result = Bun.spawnSync(["bash", "-c", "echo SHOULD_NOT_RUN"], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = result.stdout.toString()
    expect(stdout.includes("SHOULD_NOT_RUN")).toBe(false)
    expect(stdout).toContain("__CURSOR_BACKGROUND_SHELL__")
    await reapBackgroundSpawn(stdout)
    releaseCursorShellEnv(id)
  })

  it("still wraps when a parent left CURSOR_OPENCODE_WRAP_ACTIVE set", () => {
    setCursorShellPath("/bin/bash")
    const id = "cursor_session_env_exec_sticky_active"
    registerCursorShellCall(id, metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      timeout_ms: 2_000,
      command: "echo INNER_OK",
    }))
    const args: Record<string, unknown> = { command: "echo INNER_OK", timeout: 30_000 }
    prepareCursorShellArgs(id, args)
    expect(args.command).toBe("echo INNER_OK")
    const wrap = cursorShellEnvForCall(id)!
    // Soft-background children inherit ACTIVE=1 from the injector/exec'd wrapper.
    // A sticky flag must not disable later wraps.
    const result = Bun.spawnSync(["bash", "-c", "echo INNER_OK"], {
      env: { ...process.env, ...wrap, CURSOR_OPENCODE_WRAP_ACTIVE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const raw = result.stdout.toString()
    expect(raw).toContain("INNER_OK")
    expect(raw).toContain("__CURSOR_SHELL_EXIT__")
    expect(captureCursorShellResult(id, raw)).toBe("INNER_OK\n")
    releaseCursorShellEnv(id)
  })

  it("hands the host shell the wrapped command's own exit status", () => {
    setCursorShellPath("/bin/bash")
    const id = "cursor_session_env_exec_status"
    const command = "echo failing; exit 5"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND, timeout_ms: 2_000, command }))
    prepareCursorShellArgs(id, { command, timeout: 30_000 })
    const result = Bun.spawnSync(["bash", "-c", command], {
      env: { ...process.env, ...cursorShellEnvForCall(id)! },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(5)
    const raw = result.stdout.toString()
    expect(raw).toBe("failing\n\n__CURSOR_SHELL_EXIT__5\n")
    expect(captureCursorShellResult(id, raw, { exit: result.exitCode })).toBe("failing\n")
    expect(consumeCursorShellResult(id, "failing\n").outcome).toEqual({ kind: "exit", code: 5 })
  })

  it("exec-replaces the native OpenCode 1 shell tool's zsh -c command", () => {
    // Ubuntu CI images do not ship /bin/zsh by default; skip rather than ENOENT.
    if (!existsSync("/bin/zsh")) return
    setCursorShellPath("/bin/zsh")
    const id = "cursor_session_env_exec_zsh_opencode"
    const command = "echo INNER_OK"
    registerCursorShellCall(id, metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      timeout_ms: 2_000,
      command,
    }))
    prepareCursorShellArgs(id, { command, timeout: 30_000 })
    const wrap = cursorShellEnvForCall(id)!
    const result = Bun.spawnSync([
      "/bin/zsh",
      "-c",
      command,
    ], {
      env: { ...process.env, ...wrap, CURSOR_OPENCODE_WRAP_ACTIVE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const raw = result.stdout.toString()
    expect(raw).toContain("__CURSOR_SHELL_EXIT__")
    expect(captureCursorShellResult(id, raw)).toBe("INNER_OK\n")
    releaseCursorShellEnv(id)
  })

  it.each(["bash", "zsh"])("never substitutes a stale %s command after host approval changes it", name => {
    const shell = Bun.which(name)
    if (!shell) return
    setCursorShellPath(shell)
    const id = "cursor_approval_changed"
    registerCursorShellCall(id, metadata({ command: "echo unapproved", timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    prepareCursorShellArgs(id, { command: "echo unapproved" })
    const env = cursorShellEnvForCall(id)!
    const result = Bun.spawnSync([shell, "-c", "echo approved"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
    expect(result.stdout.toString()).toBe("approved\n")
    expect(result.exitCode).toBe(0)
  })

  it("uses a wrapper-file command for OpenCode sh and dash", () => {
    for (const shell of ["/bin/sh", "/bin/dash"]) {
      if (!existsSync(shell)) continue
      resetCursorShellCalls()
      setCursorShellPath(shell)
      expect(resolveCursorShellKind()).toBe(shell.endsWith("dash") ? "dash" : "sh")

      const id = `cursor_session_${shell.endsWith("dash") ? "dash" : "sh"}`
      const command = "printf ORIGINAL_OK"
      registerCursorShellCall(id, metadata({
        timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
        timeout_ms: 2_000,
        command,
      }))
      const args: Record<string, unknown> = { command, timeout: 30_000 }
      prepareCursorShellArgs(id, args)
      expect(args.command).not.toBe(command)
      expect(String(args.command)).toStartWith("exec /bin/sh '")

      const env = cursorShellEnvForCall(id)!
      const result = Bun.spawnSync([shell, "-c", String(args.command)], {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      })
      const raw = result.stdout.toString()
      expect(raw).toContain("ORIGINAL_OK")
      expect(raw).toContain("__CURSOR_SHELL_EXIT__0")
      // The payload's printf has no newline; the wrapper's separator is not stdout.
      expect(captureCursorShellResult(id, raw)).toBe("ORIGINAL_OK")
      releaseCursorShellEnv(id)
    }
  })

  it("replaces the inline background fallback with a wrapper file on sh", async () => {
    setCursorShellPath("/bin/sh")
    const id = "cursor_session_bg_spawn_sh"
    const command = "sleep 1"
    registerCursorShellCall(id, {
      background_shell_spawn: true,
      command,
      working_directory: "/tmp",
    })
    const args: Record<string, unknown> = { command: buildBackgroundShellCommand(command) }
    prepareCursorShellArgs(id, args)
    expect(String(args.command)).toStartWith("exec /bin/sh '")
    expect(String(args.command)).not.toContain("__CURSOR_BACKGROUND_SHELL__")

    const env = cursorShellEnvForCall(id)!
    const result = Bun.spawnSync(["/bin/sh", "-c", String(args.command)], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stdout.toString()).toContain("__CURSOR_BACKGROUND_SHELL__")
    await reapBackgroundSpawn(result.stdout.toString())
    releaseCursorShellEnv(id)
  })
})

describe("prepareCursorShellCreate correlation", () => {
  const createEvent = (command: string, cwd: string) => ({ command, cwd, timeout: 0, shell: "/bin/sh", env: {} as Record<string, string | undefined> })
  const hookCall = (command: string): { input: unknown } => ({ input: { command } })

  it("installs the adapter only for the pending wrap whose policy command matches", () => {
    const id = "cursor_cmd_key"
    registerCursorShellCall(id, {
      background_shell_spawn: true,
      command: "echo correlated",
      working_directory: "/tmp",
    })
    prepareCursorShellArgs(id, { command: "echo correlated" }, { deferToShellHook: true })
    const other = createEvent("echo other", "/tmp")
    prepareCursorShellCreate(other)
    expect(other.shell).toBe("/bin/sh")
    const matched = createEvent("echo correlated", "/tmp")
    prepareCursorShellCreate(matched)
    expect(matched.shell).not.toBe("/bin/sh")
    expect(path.basename(matched.shell)).toBe("sh")
    releaseCursorShellEnv(id)
  })

  it("uses the working directory to disambiguate identical commands", () => {
    const first = "cursor_cmd_first"
    const second = "cursor_cmd_second"
    registerCursorShellCall(first, { background_shell_spawn: true, command: "echo same", working_directory: "/first" })
    registerCursorShellCall(second, { background_shell_spawn: true, command: "echo same", working_directory: "/second" })
    prepareCursorShellArgs(first, { command: "echo same" }, { deferToShellHook: true })
    prepareCursorShellArgs(second, { command: "echo same" }, { deferToShellHook: true })

    const event = createEvent("echo same", "/second")
    prepareCursorShellCreate(event)
    expect(event.shell).not.toBe("/bin/sh")
    expect(cursorShellEnvForCall(second)).toBeUndefined()
    expect(cursorShellEnvForCall(first)).toBeDefined()
    releaseCursorShellEnv(first)
    releaseCursorShellEnv(second)
  })

  it("arms one create at a time so identical concurrent commands keep their own terminals", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-arm-"))
    try {
      runtimeLayout(root, true)
      const first = "cursor_arm_first"
      const second = "cursor_arm_second"
      const terminalA = createManagedTerminal({
        command: "echo same", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
      }, root)
      const terminalB = createManagedTerminal({
        command: "echo same", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
      }, root)
      registerCursorShellCall(first, {
        background_shell_spawn: true, command: "echo same", working_directory: root,
        managed_command: terminalA.command, managed_job_directory: terminalA.directory,
      })
      registerCursorShellCall(second, {
        background_shell_spawn: true, command: "echo same", working_directory: root,
        managed_command: terminalB.command, managed_job_directory: terminalB.directory,
      })

      prepareCursorShellArgs(first, { command: "echo same" }, { deferToShellHook: true })
      await armCursorShellCreate(first, hookCall("echo same"))

      prepareCursorShellArgs(second, { command: "echo same" }, { deferToShellHook: true })
      let secondArmed = false
      const armSecond = armCursorShellCreate(second, hookCall("echo same")).then(() => { secondArmed = true })
      await Bun.sleep(20)
      expect(secondArmed).toBe(false)

      const wrapperBody = (shell: string) => {
        const match = /exec \/bin\/sh '([^']+)'/.exec(readFileSync(shell, "utf8"))
        if (!match?.[1]) throw new Error(`adapter missing wrapper: ${shell}`)
        return readFileSync(match[1], "utf8")
      }
      const firstCreate = createEvent("echo same", root)
      prepareCursorShellCreate(firstCreate)
      await armSecond
      expect(secondArmed).toBe(true)
      expect(wrapperBody(firstCreate.shell)).toContain(terminalA.directory)
      expect(wrapperBody(firstCreate.shell)).not.toContain(terminalB.directory)

      // Rejecting the first call must not delete the second call's reservation
      // once creates are correctly owned; arm already transferred past the first.
      releaseCursorShellEnv(first)
      expect(existsSync(terminalB.directory)).toBe(true)

      const secondCreate = createEvent("echo same", root)
      prepareCursorShellCreate(secondCreate)
      expect(wrapperBody(secondCreate.shell)).toContain(terminalB.directory)
      expect(wrapperBody(secondCreate.shell)).not.toContain(terminalA.directory)
      releaseCursorShellEnv(second)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("releases an ordinary shell at creation without taking a wrapped call's adapter", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-ordinary-"))
    try {
      runtimeLayout(root, true)
      const ordinary = "cursor_gate_foreground"
      const managed = "cursor_gate_managed"
      const terminal = createManagedTerminal({
        command: "echo same", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
      }, root)
      registerCursorShellCall(ordinary, {
        shell_stream: true, command: "echo same", working_directory: root,
        timeout_ms: 30_000, timeout_behavior: 0,
      })
      registerCursorShellCall(managed, {
        background_shell_spawn: true, command: "echo same", working_directory: root,
        managed_command: terminal.command, managed_job_directory: terminal.directory,
      })

      prepareCursorShellArgs(ordinary, { command: "echo same" }, { deferToShellHook: true })
      await armCursorShellCreate(ordinary, hookCall("echo same"))
      prepareCursorShellArgs(managed, { command: "echo same" }, { deferToShellHook: true })
      let managedArmed = false
      const armManaged = armCursorShellCreate(managed, hookCall("echo same")).then(() => { managedArmed = true })
      await Bun.sleep(20)
      expect(managedArmed).toBe(false)

      const ordinaryCreate = { command: "echo same", cwd: root, timeout: 0, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
      prepareCursorShellCreate(ordinaryCreate)
      expect(ordinaryCreate.shell).toBe("/bin/sh")
      await armManaged
      expect(managedArmed).toBe(true)
      expect(existsSync(terminal.directory)).toBe(true)

      const managedCreate = { command: "echo same", cwd: root, timeout: 0, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
      prepareCursorShellCreate(managedCreate)
      const wrapper = /exec \/bin\/sh '([^']+)'/.exec(readFileSync(managedCreate.shell, "utf8"))
      expect(wrapper?.[1] && readFileSync(wrapper[1], "utf8")).toContain(terminal.directory)

      // The ordinary command is still running; releasing it must not delete the
      // terminal the managed call just claimed.
      releaseCursorShellEnv(ordinary)
      expect(existsSync(terminal.directory)).toBe(true)
      releaseCursorShellEnv(managed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not borrow a pending wrapper from another project after a cwd mismatch", () => {
    registerCursorShellCall("cursor_project", { background_shell_spawn: true, command: "echo same", working_directory: "/first" })
    prepareCursorShellArgs("cursor_project", { command: "echo same" }, { deferToShellHook: true })
    const event = createEvent("echo same", "/second")
    prepareCursorShellCreate(event)
    expect(event.shell).toBe("/bin/sh")
    expect(cursorShellEnvForCall("cursor_project")).toBeDefined()
    releaseCursorShellEnv("cursor_project")
  })

  it("correlates a pending wrapper when the host reports the directory through a symlink", () => {
    const base = mkdtempSync(path.join(tmpdir(), "cursor-shell-cwd-"))
    try {
      const link = path.join(base, "link")
      symlinkSync(base, link, "dir")
      registerCursorShellCall("cursor_linked", { background_shell_spawn: true, command: "echo linked", working_directory: link })
      prepareCursorShellArgs("cursor_linked", { command: "echo linked" }, { deferToShellHook: true })
      const event = createEvent("echo linked", realpathSync(base))
      prepareCursorShellCreate(event)
      expect(event.shell).not.toBe("/bin/sh")
      releaseCursorShellEnv("cursor_linked")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("releases reservations across separate plugin and SDK module copies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-copies-"))
    try {
      const other = await independentShellCopy(root)
      expect(other.releaseCursorShellEnv).not.toBe(releaseCursorShellEnv)
      const terminal = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
      registerCursorShellCall("cursor_copies_1", { background_shell_spawn: true, command: "true", working_directory: root, managed_command: terminal.command, managed_job_directory: terminal.directory })
      other.releaseCursorShellEnv("cursor_copies_1")
      expect(existsSync(terminal.directory)).toBe(false)
      expect(existsSync(terminal.file)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("shares global and per-directory configured shells with a separate module copy", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-config-copy-"))
    const shell = process.execPath
    try {
      const other = await independentShellCopy(root)
      expect(other.setCursorShellPath).not.toBe(setCursorShellPath)
      setCursorShellPath(shell)
      expect(other.resolveCursorShellPath()).toBe(shell)
      setCursorShellPath(undefined)
      setCursorShellPath(shell, root)
      expect(other.resolveCursorShellPath(undefined, root)).toBe(shell)
      other.setCursorShellPath(undefined, root)
      expect(resolveCursorShellPath(undefined, root)).not.toBe(shell)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("releases a reserved terminal when its call is evicted before the host runs it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-evict-"))
    try {
      runtimeLayout(root, true)
      const terminal = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
      registerCursorShellCall("cursor_evicted", {
        background_shell_spawn: true, command: "true", working_directory: root,
        managed_command: terminal.command, managed_job_directory: terminal.directory,
      })
      for (let index = 0; index < 512; index++) {
        registerCursorShellCall(`cursor_newer_${index}`, { background_shell_spawn: true, command: "true", working_directory: root })
      }
      expect(existsSync(terminal.file)).toBe(false)
      expect(existsSync(terminal.directory)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resolves a shell by PATH name and falls back when that name is absent", () => {
    const found = resolveCursorShellPath("sh")
    expect(found.endsWith("/sh") || found.endsWith("/zsh") || found === "/bin/sh").toBe(true)
    const missing = resolveCursorShellPath("/no/such/cursor-shell")
    expect(missing === "/bin/zsh" || missing.endsWith("/bash") || missing === "/bin/sh").toBe(true)
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-path-"))
    const withBash = path.join(root, "with-bash")
    const withoutBash = path.join(root, "without-bash")
    mkdirSync(withBash)
    mkdirSync(withoutBash)
    writeFileSync(path.join(withBash, "bash"), "")
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    const pathEnv = process.env.PATH
    Object.defineProperty(process, "platform", { ...platform, value: "linux" })
    try {
      process.env.PATH = withBash
      expect(resolveCursorShellPath("cursor-missing-shell")).toBe(path.join(withBash, "bash"))
      process.env.PATH = withoutBash
      expect(resolveCursorShellPath("cursor-missing-shell")).toBe("/bin/sh")
    } finally {
      Object.defineProperty(process, "platform", platform!)
      if (pathEnv === undefined) delete process.env.PATH
      else process.env.PATH = pathEnv
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("drops a waiting create when the gate is reset", async () => {
    await armCursorShellCreate("cursor_gate_holder", hookCall("echo gate"))
    const waiting = armCursorShellCreate("cursor_gate_waiter", hookCall("echo gate"))
    resetCursorShellCalls()
    await waiting
    expect(resolveCursorShellPath()).toBeTruthy()
  })

  it("releases a create when the pending call no longer has a wrapper", async () => {
    const id = "cursor_wrap_gone"
    registerCursorShellCall(id, { background_shell_spawn: true, command: "echo x", working_directory: "/tmp" })
    prepareCursorShellArgs(id, { command: "echo x" }, { deferToShellHook: true })
    registerCursorShellCall(id, { shell_stream: true, command: "echo x", working_directory: "/tmp", timeout_behavior: 0 })
    await armCursorShellCreate(id, hookCall("echo x"))
    const event = { command: "echo x", cwd: "/tmp", shell: "/bin/sh", env: {} as Record<string, string | undefined> }
    prepareCursorShellCreate(event)
    expect(event.shell).toBe("/bin/sh")
  })

  it("releases a call whose command a later hook rewrote at that call's own create", async () => {
    const id = "cursor_gate_rewritten"
    registerCursorShellCall(id, { background_shell_spawn: true, command: "echo original", working_directory: "/tmp" })
    prepareCursorShellArgs(id, { command: "echo original" }, { deferToShellHook: true })
    const call = hookCall("echo original")
    await armCursorShellCreate(id, call)

    let otherArmed = false
    const armOther = armCursorShellCreate("cursor_gate_other", hookCall("echo other")).then(() => { otherArmed = true })
    await Bun.sleep(0)
    expect(otherArmed).toBe(true)
    await armOther
    disarmCursorShellCreate("cursor_gate_other")

    let identicalArmed = false
    const armIdentical = armCursorShellCreate("cursor_gate_identical", hookCall("echo original")).then(() => { identicalArmed = true })
    await Bun.sleep(20)
    expect(identicalArmed).toBe(false)

    // A later execute.before hook replaces the input OpenCode creates from.
    call.input = { command: "echo rewritten" }
    const rewritten = createEvent("echo rewritten", "/tmp")
    prepareCursorShellCreate(rewritten)
    expect(rewritten.shell).toBe("/bin/sh")
    await armIdentical
    expect(identicalArmed).toBe(true)
    disarmCursorShellCreate("cursor_gate_identical")

    const later = createEvent("echo original", "/tmp")
    prepareCursorShellCreate(later)
    expect(later.shell).toBe("/bin/sh")
    releaseCursorShellEnv(id)
  })

  it("wraps no call when hooks give two lane holders the same command", async () => {
    const first = "cursor_gate_same_first"
    const second = "cursor_gate_same_second"
    registerCursorShellCall(first, { background_shell_spawn: true, command: "echo first", working_directory: "/tmp" })
    registerCursorShellCall(second, { background_shell_spawn: true, command: "echo second", working_directory: "/tmp" })
    prepareCursorShellArgs(first, { command: "echo first" }, { deferToShellHook: true })
    prepareCursorShellArgs(second, { command: "echo second" }, { deferToShellHook: true })
    const call = hookCall("echo first")
    await armCursorShellCreate(first, call)
    await armCursorShellCreate(second, hookCall("echo second"))
    call.input = { command: "echo second" }

    const create = createEvent("echo second", "/tmp")
    prepareCursorShellCreate(create)
    expect(create.shell).toBe("/bin/sh")
    let waitingArmed = false
    const armWaiting = armCursorShellCreate("cursor_gate_same_waiting", hookCall("echo second")).then(() => { waitingArmed = true })
    await Bun.sleep(20)
    expect(waitingArmed).toBe(false)

    releaseCursorShellEnv(second)
    await armWaiting
    expect(waitingArmed).toBe(true)
    disarmCursorShellCreate("cursor_gate_same_waiting")
    releaseCursorShellEnv(first)
  })

  it("keeps an armed call's adapter from a create it does not own", async () => {
    const holder = hookCall("echo same")
    await armCursorShellCreate("cursor_gate_holder_moved", holder)
    const waiting = "cursor_gate_waiter_kept"
    registerCursorShellCall(waiting, { background_shell_spawn: true, command: "echo same", working_directory: "/tmp" })
    prepareCursorShellArgs(waiting, { command: "echo same" }, { deferToShellHook: true })
    let waitingArmed = false
    const armWaiting = armCursorShellCreate(waiting, hookCall("echo same")).then(() => { waitingArmed = true })
    holder.input = { command: "echo moved" }

    const foreign = createEvent("echo same", "/tmp")
    prepareCursorShellCreate(foreign)
    expect(foreign.shell).toBe("/bin/sh")
    await Bun.sleep(20)
    expect(waitingArmed).toBe(false)

    prepareCursorShellCreate(createEvent("echo moved", "/tmp"))
    await armWaiting
    expect(waitingArmed).toBe(true)
    const own = createEvent("echo same", "/tmp")
    prepareCursorShellCreate(own)
    expect(own.shell).not.toBe("/bin/sh")
    releaseCursorShellEnv(waiting)
  })

  it("does not hand an unwrapped owner's adapter to a later create", async () => {
    const id = "cursor_gate_consumed"
    registerCursorShellCall(id, { background_shell_spawn: true, command: "echo same", working_directory: "/tmp" })
    prepareCursorShellArgs(id, { command: "echo same" }, { deferToShellHook: true })
    await armCursorShellCreate(id, hookCall("echo same"))
    const moved = createEvent("echo same", "/")
    prepareCursorShellCreate(moved)
    expect(moved.shell).toBe("/bin/sh")

    const foreign = createEvent("echo same", "/tmp")
    prepareCursorShellCreate(foreign)
    expect(foreign.shell).toBe("/bin/sh")
    releaseCursorShellEnv(id)
  })

  it("leaves a call whose input carries no command to single-match selection", async () => {
    const id = "cursor_gate_no_command"
    registerCursorShellCall(id, { background_shell_spawn: true, command: "echo x", working_directory: "/tmp" })
    prepareCursorShellArgs(id, { command: "echo x" }, { deferToShellHook: true })
    await armCursorShellCreate(id, { input: { command: 1 } })
    await armCursorShellCreate(id, { input: undefined })
    const create = createEvent("echo x", "/tmp")
    prepareCursorShellCreate(create)
    expect(create.shell).not.toBe("/bin/sh")
    releaseCursorShellEnv(id)
  })

  it("releases a call whose working directory another hook changed without taking an identical call's adapter", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cursor-shell-moved-"))
    try {
      runtimeLayout(root, true)
      const moved = "cursor_gate_moved"
      const waiting = "cursor_gate_waiting"
      const terminalA = createManagedTerminal({
        command: "echo same", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
      }, root)
      const terminalB = createManagedTerminal({
        command: "echo same", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
      }, root)
      registerCursorShellCall(moved, {
        background_shell_spawn: true, command: "echo same", working_directory: root,
        managed_command: terminalA.command, managed_job_directory: terminalA.directory,
      })
      registerCursorShellCall(waiting, {
        background_shell_spawn: true, command: "echo same", working_directory: root,
        managed_command: terminalB.command, managed_job_directory: terminalB.directory,
      })
      prepareCursorShellArgs(moved, { command: "echo same" }, { deferToShellHook: true })
      await armCursorShellCreate(moved, hookCall("echo same"))
      prepareCursorShellArgs(waiting, { command: "echo same" }, { deferToShellHook: true })
      let waitingArmed = false
      const armWaiting = armCursorShellCreate(waiting, hookCall("echo same")).then(() => { waitingArmed = true })
      await Bun.sleep(20)
      expect(waitingArmed).toBe(false)

      const movedCreate = createEvent("echo same", tmpdir())
      prepareCursorShellCreate(movedCreate)
      expect(movedCreate.shell).toBe("/bin/sh")
      await armWaiting
      expect(waitingArmed).toBe(true)

      const waitingCreate = createEvent("echo same", root)
      prepareCursorShellCreate(waitingCreate)
      const wrapper = /exec \/bin\/sh '([^']+)'/.exec(readFileSync(waitingCreate.shell, "utf8"))
      const body = wrapper?.[1] ? readFileSync(wrapper[1], "utf8") : ""
      expect(body).toContain(terminalB.directory)
      expect(body).not.toContain(terminalA.directory)
      releaseCursorShellEnv(moved)
      expect(existsSync(terminalA.directory)).toBe(false)
      expect(existsSync(terminalB.directory)).toBe(true)
      releaseCursorShellEnv(waiting)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("formats a finished background spawn that reports an exit instead of a handle", () => {
    const shown = sanitizeCursorShellDisplayOutput("done\n__CURSOR_SHELL_EXIT__0\n", {
      command: "echo x", workingDirectory: "/tmp", timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true,
    })
    expect(shown).toContain("done")
    expect(shown).not.toContain("__CURSOR_SHELL_EXIT__")
  })

  it("names the managed shell and its output file in the background notice", () => {
    registerCursorShellCall("cursor_managed", { background_shell_spawn: true, command: "serve", working_directory: "/w" })
    const clean = captureCursorShellResult("cursor_managed", "\n__CURSOR_BACKGROUND_SHELL__123456:4321:/cache/terminals/123456.txt\n")
    expect(clean).toBe("Started in the background (shell 123456, pid 4321). Output: /cache/terminals/123456.txt\n")
    expect(consumeCursorShellResult("cursor_managed", clean).outcome).toMatchObject({ kind: "backgrounded", shellId: 123456, pid: 4321, outputFile: "/cache/terminals/123456.txt" })
  })
})
