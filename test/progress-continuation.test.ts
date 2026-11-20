import { describe, expect, it } from "bun:test"
import {
  isProgressOnlyAssistantText,
  PROGRESS_CONTINUATION_ENV,
  progressContinuationEnabled,
  progressOnlyContinuationPrompt,
  shouldContinueProgressOnlyTurn,
} from "../src/protocol/progress-continuation.js"
import { appendCheckpointUserGrounding, appendWorkspaceRootGrounding } from "../src/protocol/workspace-grounding.js"

const CONTINUE = true
const STOP = false

describe("isProgressOnlyAssistantText", () => {
  it("accepts short inspection fragments and rejects complete answers", () => {
    const rows: Array<[string, boolean]> = [
      ["Checking the workspace", CONTINUE],
      ["Checking the workspace...", CONTINUE],
      ["Looking into it now", CONTINUE],
      ["Looking at this file", CONTINUE],
      ["Let me check the logs", CONTINUE],
      ["Reviewing this PR", CONTINUE],
      ["Checking is disabled for this repo.", STOP],
      ["Checking is disabled", STOP],
      ["Reviewing this PR: LGTM", STOP],
      ["Verifying the fix works as expected.", STOP],
      ["Investigating is not needed; use grep.", STOP],
      ["Investigating is not needed", STOP],
      ["Looking at the code, the bug is in session.ts", STOP],
      ["Looking at the code, the bug is in session.ts.", STOP],
      ["Looking at the code the bug is in session.ts", STOP],
      ["The tests pass", STOP],
      ["", STOP],
      ["Checking the workspace\n\nAnd here is the answer", STOP],
    ]
    for (const [text, expected] of rows) {
      expect(isProgressOnlyAssistantText(text), JSON.stringify(text)).toBe(expected)
    }
  })
})

describe("shouldContinueProgressOnlyTurn", () => {
  const ready = {
    allowTools: true,
    advertisedToolCount: 3,
    assistantText: "Checking the workspace",
    emittedHostTools: 0,
    continuationAttempts: 0,
    pendingExecs: 0,
  }

  it("continues a tool-enabled progress fragment once", () => {
    expect(shouldContinueProgressOnlyTurn(ready)).toBe(true)
  })

  it("never continues title/compaction turns", () => {
    expect(shouldContinueProgressOnlyTurn({ ...ready, allowTools: false })).toBe(false)
  })

  it("does not continue without advertised tools, pending execs, host tools, or a second attempt", () => {
    expect(shouldContinueProgressOnlyTurn({ ...ready, advertisedToolCount: 0 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, pendingExecs: 1 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, emittedHostTools: 1 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, continuationAttempts: 1 })).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, assistantText: "Reviewing this PR: LGTM" })).toBe(false)
  })

  it("is on by default and only the documented opt-out values turn it off", () => {
    for (const value of [undefined, "", "  ", "1", "true", "on", "yes", "2", "disabled", "0n", "nope"]) {
      const env = value === undefined ? {} : { [PROGRESS_CONTINUATION_ENV]: value }
      expect(progressContinuationEnabled(env), JSON.stringify(value)).toBe(true)
      expect(shouldContinueProgressOnlyTurn(ready, env), JSON.stringify(value)).toBe(true)
    }
    for (const value of ["0", "false", "off", "no", "FALSE", "Off", "NO", " 0 ", "\tfalse\n", "  oFf "]) {
      const env = { [PROGRESS_CONTINUATION_ENV]: value }
      expect(progressContinuationEnabled(env), JSON.stringify(value)).toBe(false)
      expect(shouldContinueProgressOnlyTurn(ready, env), JSON.stringify(value)).toBe(false)
    }
  })

  it("reads the process environment when no environment is passed", () => {
    const saved = process.env[PROGRESS_CONTINUATION_ENV]
    try {
      delete process.env[PROGRESS_CONTINUATION_ENV]
      expect(shouldContinueProgressOnlyTurn(ready)).toBe(true)
      process.env[PROGRESS_CONTINUATION_ENV] = "off"
      expect(shouldContinueProgressOnlyTurn(ready)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env[PROGRESS_CONTINUATION_ENV]
      else process.env[PROGRESS_CONTINUATION_ENV] = saved
    }
  })

  it("leaves every other refusal in place when the continuation is on", () => {
    const on = { [PROGRESS_CONTINUATION_ENV]: "1" }
    expect(shouldContinueProgressOnlyTurn({ ...ready, allowTools: false }, on)).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, pendingExecs: 1 }, on)).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, emittedHostTools: 1 }, on)).toBe(false)
    expect(shouldContinueProgressOnlyTurn({ ...ready, continuationAttempts: 1 }, on)).toBe(false)
  })
})

describe("progressOnlyContinuationPrompt", () => {
  it("grounds the nudge with the workspace root when one is known", () => {
    const prompt = progressOnlyContinuationPrompt("/tmp/project")
    expect(prompt).toContain("call an available listed tool immediately")
    expect(prompt).toContain("Workspace root:")
    expect(prompt).toContain("/tmp/project")
  })

  it("omits grounding when no workspace root is supplied", () => {
    expect(progressOnlyContinuationPrompt()).not.toContain("Workspace root:")
  })
})

describe("appendWorkspaceRootGrounding", () => {
  it("appends the root once and leaves the original reason when none is known", () => {
    expect(appendWorkspaceRootGrounding("denied", undefined)).toBe("denied")
    expect(appendWorkspaceRootGrounding("denied", "  ")).toBe("denied")
    const grounded = appendWorkspaceRootGrounding("denied", "/tmp/project")
    expect(grounded).toContain("Workspace root: \"/tmp/project\"")
    expect(appendWorkspaceRootGrounding(grounded, "/other")).toBe(grounded)
  })

  it("adds the absolute-path sentence only when requested, and only once", () => {
    const grounded = appendWorkspaceRootGrounding("denied", "/tmp/project", {
      requireAbsolutePathArg: true,
    })
    expect(grounded).toContain("take `path` as an absolute path")
    expect(appendWorkspaceRootGrounding(grounded, "/tmp/project", { requireAbsolutePathArg: true })).toBe(grounded)

    const later = appendWorkspaceRootGrounding(
      appendWorkspaceRootGrounding("denied", "/tmp/project"),
      "/tmp/project",
      { requireAbsolutePathArg: true },
    )
    expect(later.startsWith("denied\nWorkspace root:")).toBe(true)
    expect(later).toContain("take `path` as an absolute path")
    expect(appendWorkspaceRootGrounding("denied", undefined, { requireAbsolutePathArg: true })).toBe("denied")
  })
})

describe("appendCheckpointUserGrounding", () => {
  it("appends the root to a later user turn and stays idempotent", () => {
    expect(appendCheckpointUserGrounding("fix it", undefined)).toBe("fix it")
    expect(appendCheckpointUserGrounding("", "  ")).toBe("")

    const note = appendCheckpointUserGrounding("", "/tmp/project")
    expect(note.startsWith("Workspace root:")).toBe(true)
    expect(note.startsWith("\n")).toBe(false)

    const grounded = appendCheckpointUserGrounding("fix it", "/tmp/project", {
      requireAbsolutePathArg: true,
    })
    expect(grounded.startsWith("fix it\n\nWorkspace root:")).toBe(true)
    expect(grounded).toContain(JSON.stringify("/tmp/project"))
    expect(grounded).toContain("take `path` as an absolute path")
    expect(appendCheckpointUserGrounding(grounded, "/other", { requireAbsolutePathArg: true })).toBe(grounded)
  })
})
