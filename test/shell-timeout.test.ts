import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  CURSOR_TIMEOUT_BACKGROUND,
  buildBackgroundShellCommand,
  buildSoftBackgroundCommand,
  sanitizeRegisteredCursorShellOutput,
  captureCursorShellResult,
  consumeCursorShellResult,
  cursorShellEnvForCall,
  prepareCursorShellArgs,
  registerCursorShellCall,
  releaseCursorShellEnv,
  resetCursorShellCalls,
  shellPolicyFromMetadata,
} from "../src/shell-timeout.js"

afterEach(() => resetCursorShellCalls())

const metadata = (overrides: Record<string, unknown> = {}) => ({
  shell_stream: true,
  command: "sleep 60",
  working_directory: "/tmp",
  timeout_ms: 30_000,
  timeout_behavior: 0,
  ...overrides,
})

describe("Cursor shell timeout translation", () => {
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

  it("keeps soft-background display command original and wraps via shell.env injectors", () => {
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

  it("keeps background_shell_spawn display command original and wraps via shell.env", () => {
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
    expect(wrapper).toContain("nohup sh -c 'zig translate-c /tmp/tiny.c -lc'")
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

  it("exec-replaces bash -c original command via BASH_ENV injector", () => {
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
    releaseCursorShellEnv(id)
  })

  it("still wraps when a parent left CURSOR_OPENCODE_WRAP_ACTIVE set", () => {
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

  it("exec-replaces OpenCode-style zsh -l -c via ZDOTDIR injector", () => {
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
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${JSON.stringify(command)}
      `,
      "opencode",
      process.cwd(),
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
})
