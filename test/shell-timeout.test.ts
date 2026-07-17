import { afterEach, describe, expect, it } from "bun:test"
import {
  CURSOR_TIMEOUT_BACKGROUND,
  buildSoftBackgroundCommand,
  captureCursorShellResult,
  consumeCursorShellResult,
  prepareCursorShellArgs,
  registerCursorShellCall,
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
    expect(clean).toBe("progress\n")
    expect(consumeCursorShellResult(id, clean)).toEqual({
      output: "progress\n",
      outcome: { kind: "timeout", timeoutMs: 30_000 },
    })
  })

  it("removes OpenCode's synthetic no-output placeholder on timeout", () => {
    const id = "cursor_session_2"
    registerCursorShellCall(id, metadata())
    const raw = "(no output)\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 30000 ms. Retry.\n</shell_metadata>"
    expect(captureCursorShellResult(id, raw)).toBe("")
    expect(consumeCursorShellResult(id, "").outcome).toEqual({
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

  it("rewrites soft-background calls with a foreground wait and hard watchdog", () => {
    const id = "cursor_session_4"
    const policyMetadata = metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      hard_timeout_ms: 120_000,
    })
    registerCursorShellCall(id, policyMetadata)
    const args: Record<string, unknown> = { command: "sleep 60", timeout: 30_000 }
    prepareCursorShellArgs(id, args)
    expect(args.timeout).toBe(45_000)
    expect(args.command).toContain("cursor-opencode-shell")
    expect(args.command).toContain("cursor-shell-watchdog")
    expect(args.command).toContain('"$cursor_hard_poll" -lt "$1"')
    expect(args.command).toContain("cursor-shell-watchdog 1200")
    expect(args.command).toContain("__CURSOR_SHELL_BACKGROUND__")
  })

  it("turns the private background sentinel into a typed handoff", () => {
    const id = "cursor_session_5"
    registerCursorShellCall(id, metadata({ timeout_behavior: CURSOR_TIMEOUT_BACKGROUND }))
    const clean = captureCursorShellResult(
      id,
      "started\n\n__CURSOR_SHELL_BACKGROUND__43210:/tmp/cursor-opencode-shell.XYZ\n",
      { exit: 0 },
    )
    expect(clean).toBe("started\n")
    expect(consumeCursorShellResult(id, clean)).toEqual({
      output: "started\n",
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
    )).toBe("")
  })

  it("turns the hard-timeout sentinel into a typed timeout", () => {
    const id = "cursor_session_6"
    registerCursorShellCall(id, metadata({
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      hard_timeout_ms: 60_000,
    }))
    const clean = captureCursorShellResult(id, "some output\n__CURSOR_SHELL_TIMEOUT__60000\n")
    expect(clean).toBe("some output\n")
    expect(consumeCursorShellResult(id, clean).outcome).toEqual({
      kind: "timeout",
      timeoutMs: 60_000,
    })
  })

  it("builds a zero-wait background wrapper for Cursor's special timeout=0 semantics", () => {
    const policy = shellPolicyFromMetadata(metadata({
      timeout_ms: 0,
      timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
    }))!
    expect(policy.timeoutMs).toBe(0)
    expect(buildSoftBackgroundCommand(policy)).toContain('[ "$cursor_shell_poll" -lt 0 ]')
  })
})
