import { afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeMessageSparse, encodeMessage } from "../src/protocol/messages.js"
import {
  cursorEditReadAnswer,
  cursorEditReadReachesHost,
  hostToolForCursorEdit,
  OPENCODE_1_TOOL_DIALECT,
  OPENCODE_2_TOOL_DIALECT,
  toolsToDescriptors,
} from "../src/protocol/tools.js"
import { noteToolRequestsListedSeen, resetToolRequestsListedSeenForTests } from "../src/parallel-step.js"
import {
  EARLY_ROW_CLOSED,
  EARLY_ROW_DEFERRED,
  earlyRowHandoff,
  UNBOUND_EXEC_ID,
  cursorEditAnnouncement,
  cursorEditOutcome,
  cursorEditFailureToolCallId,
  earlyRowToolCallId,
  parseEarlyRowToolCallId,
  shouldOpenEarlyRow,
} from "../src/early-tool-rows.js"
import { deliverContinuationResults, extractTrailingToolResults, findContinuationSession, pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"
import { discardPendingCursorImage, MAX_STAGED_IMAGE_BYTES, pendingCursorImageCount } from "../src/image-staging.js"
import { executeCursorImageSave, IMAGE_PERMISSION_DENIED_PREFIX } from "../src/image-save.js"

const tempDirs: string[] = []

afterEach(() => {
  sessionManager.dispose()
  resetToolRequestsListedSeenForTests()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-early-row-"))
  tempDirs.push(dir)
  return dir
}


function partial(callId: string, filePath: string): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      partial_tool_call: {
        call_id: callId,
        tool_call: { edit_tool_call: { args: { path: filePath } } },
      },
    },
  })
}

function started(callId: string, filePath: string): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      tool_call_started: { call_id: callId, tool_call: { edit_tool_call: { args: { path: filePath } } } },
    },
  })
}

/** Cursor finishing an edit itself, with its outcome when given. */
function completedEdit(callId: string, filePath: string, result?: Record<string, unknown>): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      tool_call_completed: {
        call_id: callId,
        tool_call: { edit_tool_call: { args: { path: filePath }, ...(result ? { result } : {}) } },
      },
    },
  })
}

/** Cursor's edit as it arrives: announced, started, then its private read under the edit's call id. */
function editHandshake(callId: string, target: string, readExecId: number, writeText?: string): Uint8Array[] {
  const frames = [
    partial(callId, target),
    encodeMessage("AgentServerMessage", {
      interaction_update: {
        tool_call_started: { call_id: callId, tool_call: { edit_tool_call: { args: { path: target } } } },
      },
    }),
    encodeMessage("AgentServerMessage", {
      exec_server_message: { id: readExecId, read_args: { path: target, tool_call_id: callId } },
    }),
  ]
  if (writeText !== undefined) {
    frames.push(encodeMessage("AgentServerMessage", {
      exec_server_message: {
        id: readExecId + 1,
        write_args: { path: target, file_text: writeText, tool_call_id: callId },
      },
    }))
  }
  return frames
}

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0

/**
 * Bun's realpath needs read access to the file and Node's does not, so on Bun
 * an unreadable file's containment is unproven and it is treated as external.
 * Either way OpenCode's `read` answers it.
 */
function lockedFileAnswer(locked: string): "host-complete" | "external" {
  try {
    fs.realpathSync(locked)
    return "host-complete"
  } catch {
    return "external"
  }
}

function turnEnded(): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
  })
}

function pumpSession(
  payloads: Uint8Array[],
  tools: Array<{ name: string; description: string }>,
): { session: CursorSession; parts: any[] } {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
      : { done: true, value: undefined },
  }
  const descriptors = toolsToDescriptors(tools, "opencode", [])
  const session = sessionFixture({
    sessionId: `early-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-early-${Math.random().toString(16).slice(2)}`,
    stream: {
      write() {},
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as never,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: tools,
    toolDescriptors: descriptors,
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    heartbeatCancel: null,
    closed: false,
  })
  const parts: any[] = []
  return {
    session,
    parts,
  }
}

async function run(session: CursorSession, parts: any[]): Promise<void> {
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
}

/** Authorize the exact read through the host before the provider upgrades capped content. */
async function authorizeEditRead(session: CursorSession, parts: any[], execId: number): Promise<void> {
  const read = parts.find(part => part.type === "tool-call" && part.toolName === "read")
  expect(read).toBeDefined()
  expect(parts.some(part => part.type === "tool-input-start")).toBe(false)
  expect(await deliverContinuationResults(session, [{
    sessionId: session.sessionId, execId, toolCallId: read.toolCallId,
    toolName: "read", output: "[Partial read: host-capped content]",
  }])).toBe(session)
  parts.length = 0
}

describe("Cursor edit outcomes", () => {
  // Independent bytes from agent.v1.EditToolCall.result=2 and EditResult's
  // oneof in the decompiled Cursor CLI descriptors (2026.10.22), cross-checked
  // against the extracted agent.v1 proto. These never use the local encoder.
  it.each([
    ["12080a064204646f6e65", "done", false],
    ["12021200", "Cursor's edit of file.txt failed: file not found.", true],
    ["12021a00", "Cursor's edit of file.txt failed: permission denied reading the file.", true],
    ["120a2208120664656e696564", "Cursor's edit of file.txt failed: denied", true],
    ["1206320412026e6f", "Cursor's edit of file.txt failed: no", true],
    ["120b3a0912037261772a027569", "Cursor's edit of file.txt failed: ui", true],
  ] as const)("decodes independent EditToolCall bytes %s", (hex, text, isError) => {
    const edit = decodeMessageSparse("EditToolCall", Buffer.from(hex, "hex"))
    expect(cursorEditOutcome({ edit_tool_call: edit }, "file.txt")).toEqual({ text, isError })
  })

  it.each([
    [{ write_permission_denied: {} }, "permission denied writing the file."],
    [{ rejected: {} }, "rejected."],
    [{ error: {} }, "unknown error."],
    [{ error: { error: " raw ", model_visible_error: "  " } }, "raw"],
  ])("retains a failure without optional detail: %p", (result, detail) => {
    expect(cursorEditOutcome({ edit_tool_call: { result } }, "file.txt"))
      .toEqual({ text: `Cursor's edit of file.txt failed: ${detail}`, isError: true })
  })

  it.each([null, [], {}, { edit_tool_call: { result: {} } }, { edit_tool_call: { result: { success: [] } } }].map(value => [value]))
    ("does not invent an outcome from %p", value => {
      expect(cursorEditOutcome(value, "file.txt")).toBeUndefined()
    })
})

describe("hostToolForCursorEdit", () => {
  it("predicts edit for an existing file, write for a new or empty one, and withholds a patch that would change CRLF", () => {
    const dir = tempDir()
    const crlf = path.join(dir, "crlf.txt")
    const lf = path.join(dir, "lf.txt")
    fs.writeFileSync(crlf, "a\r\nb\r\n")
    fs.writeFileSync(lf, "a\nb\n")
    const empty = path.join(dir, "empty.txt")
    fs.writeFileSync(empty, "")
    // An empty file has no text for an edit to replace: like a creation, it stays a write.
    expect(hostToolForCursorEdit(empty, new Set(["edit", "write"]))).toBe("write")
    expect(hostToolForCursorEdit(empty, new Set(["edit"]))).toBeUndefined()
    expect(hostToolForCursorEdit(empty, new Set(["write", "patch"]))).toBe("write")
    expect(hostToolForCursorEdit(empty, new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(empty, new Set(["apply_patch"]))).toBe("apply_patch")
    // A missing file is a creation: it stays a write, else becomes the patch tool's Add File.
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["edit", "write"]))).toBe("write")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["edit"]))).toBeUndefined()
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["write", "patch"]))).toBe("write")
    expect(hostToolForCursorEdit(lf, new Set(["edit", "write"]))).toBe("edit")
    expect(hostToolForCursorEdit(crlf, new Set(["edit", "patch"]))).toBe("edit")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["apply_patch"]))).toBe("apply_patch")
    expect(hostToolForCursorEdit(crlf, new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit(crlf, new Set(["apply_patch"]))).toBe("apply_patch")
    expect(hostToolForCursorEdit(lf, new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(dir, new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit("relative.txt", new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit(lf, new Set(["write"]))).toBeUndefined()
  })
})

describe("cursorEditReadAnswer", () => {
  it("requires host authorization for existing files and answers missing targets itself", () => {
    const workspace = tempDir()
    const inside = path.join(workspace, "inside.txt")
    const empty = path.join(workspace, "empty.txt")
    const subdir = path.join(workspace, "dir")
    const huge = path.join(workspace, "huge.bin")
    fs.writeFileSync(inside, "one\n")
    fs.writeFileSync(empty, "")
    fs.mkdirSync(subdir)
    // Sparse: one byte over Cursor's 50 MB edit limit without writing it.
    fs.writeFileSync(huge, "")
    fs.truncateSync(huge, 50 * 1024 * 1024 + 1)
    const outsideDir = tempDir()
    const outside = path.join(outsideDir, "outside.txt")
    fs.writeFileSync(outside, "one\n")
    const linkOut = path.join(workspace, "link-out.txt")
    const linkIn = path.join(outsideDir, "link-in.txt")
    const dangling = path.join(workspace, "dangling.txt")
    fs.symlinkSync(outside, linkOut)
    fs.symlinkSync(inside, linkIn)
    fs.symlinkSync(path.join(outsideDir, "gone.txt"), dangling)
    const rootLink = path.join(tempDir(), "workspace-link")
    fs.symlinkSync(workspace, rootLink)

    const cases: Array<[string, string, string, ReturnType<typeof cursorEditReadAnswer>, boolean]> = [
      ["regular workspace file", inside, workspace, "host-complete", true],
      ["empty workspace file", empty, workspace, "host-complete", true],
      ["workspace file through a symlinked root", path.join(rootLink, "inside.txt"), rootLink, "host-complete", true],
      ["outside symlink into the workspace", linkIn, workspace, "host-complete", true],
      ["missing workspace file", path.join(workspace, "new.txt"), workspace, "empty", false],
      ["missing outside file", path.join(outsideDir, "new.txt"), workspace, "empty", false],
      ["existing outside file", outside, workspace, "external", true],
      ["the workspace's parent", path.dirname(workspace), workspace, "external", false],
      ["workspace symlink to an outside file", linkOut, workspace, "external", true],
      // The handshake leaves it to the host; missing-target validation answers it first.
      ["dangling workspace symlink", dangling, workspace, "external", false],
      ["workspace directory", subdir, workspace, "host", false],
      ["file over the edit limit", huge, workspace, "host", true],
      ["path through a file", path.join(inside, "child"), workspace, "host", false],
    ]
    expect(cases.map(([label, target, root, answer, reachesHost]) => ({
      label,
      answer: cursorEditReadAnswer(target, root),
      reachesHost: cursorEditReadReachesHost(target, root),
      expectedAnswer: answer,
      expectedHost: reachesHost,
    }))).toEqual(cases.map(([label, , , answer, reachesHost]) => ({
      label,
      answer,
      reachesHost,
      expectedAnswer: answer,
      expectedHost: reachesHost,
    })))
  })

  it.skipIf(!canChmod)("leaves a workspace file the provider cannot read to the host", () => {
    const workspace = tempDir()
    const locked = path.join(workspace, "locked.txt")
    fs.writeFileSync(locked, "secret\n")
    fs.chmodSync(locked, 0o000)
    expect(cursorEditReadAnswer(locked, workspace)).toBe(lockedFileAnswer(locked))
    expect(cursorEditReadReachesHost(locked, workspace)).toBe(true)
  })
})

describe("early edit rows", () => {
  it("opens only while the step can wait for the exec", () => {
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(true)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: true,
      emittedHostTools: 2,
      owedPending: 1,
    })).toBe(true)
    expect(shouldOpenEarlyRow({
      allowTools: false,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(false)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: true,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(false)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 1,
      owedPending: 0,
    })).toBe(false)
    expect(cursorEditAnnouncement({
      call_id: "task-1",
      tool_call: { task_tool_call: { args: { description: "look" } } },
    })).toBeUndefined()
    // Cursor call ids can hold a newline (seen live with grok-4.7); the row id stays opaque and bounded.
    const liveCallId = "call-4e1f2d3b-b444-4c6f-8ee9-02b61bd2da60-0\nfc_05d8d1a5-117d-961c-95f3-ed00349cd3e3_0"
    const id = earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", liveCallId)
    expect(id).toMatch(/^cursor-early_2e64e80f-746e-413e-a3f2-27a0b7645ad8_[0-9a-f]{12}$/)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", liveCallId)).toBe(id)
    expect(earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", "other")).not.toBe(id)
    expect(parseEarlyRowToolCallId(earlyRowToolCallId("sess", "toolu_01_x")))
      .toEqual({ sessionId: "sess", execId: UNBOUND_EXEC_ID })
    expect(parseEarlyRowToolCallId("cursor_sess_4")).toBeUndefined()
    expect(parseEarlyRowToolCallId("cursor-early_sess")).toBeUndefined()
    expect(parseEarlyRowToolCallId("cursor-early_sess_")).toBeUndefined()
  })

  it("binds the announced row to the exec and routes its result", async () => {
    const dir = tempDir()
    const target = path.join(dir, "notes.txt")
    const callId = "edit-1"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        interaction_update: {
          tool_call_started: {
            call_id: callId,
            tool_call: { edit_tool_call: { args: { path: target } } },
          },
        },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 17, read_args: { path: target, tool_call_id: callId } },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: {
          id: 18,
          write_args: {
            path: target,
            file_text: "edited one\nline two\n",
            tool_call_id: callId,
          },
        },
      }),
    ], [
      { name: "read", description: "Read" },
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const call = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
    expect(start?.toolName).toBe("write")
    expect(call?.toolCallId).toBe(start?.id)
    expect(call?.toolCallId.startsWith("cursor-early_")).toBe(true)
    expect(parts.filter((part) => part.type === "tool-call" && !part.providerExecuted)).toHaveLength(1)
    expect(parts.findIndex((part) => part.type === "tool-input-start"))
      .toBeLessThan(parts.findIndex((part) => part.type === "tool-input-end"))
    const prompt = [
      { role: "assistant", content: [{ type: "text", text: "editing" }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "write",
          output: { type: "text", value: "ok" },
        }],
      },
    ] as never
    const continued = extractTrailingToolResults(prompt)
    expect(continued).toMatchObject([{ sessionId: session.sessionId, execId: 18 }])

    // A result that arrives after the Run closed still names its exec, so the
    // turn rebuilds from host history instead of dropping the completed edit.
    sessionManager.close(session, "hard-cap-expired")
    const late = extractTrailingToolResults(prompt)
    expect(late).toMatchObject([{ sessionId: session.sessionId, execId: 18 }])
    expect(findContinuationSession(late)).toBeUndefined()
    expect(sessionManager.classify(session.sessionId, 18)).toEqual({ kind: "terminal", reason: "hard-cap-expired" })

    // After a restart the route is gone; the id is still recognized as this provider's.
    sessionManager.dispose()
    expect(extractTrailingToolResults(prompt)).toMatchObject([{ sessionId: session.sessionId, execId: UNBOUND_EXEC_ID }])
  })

  it("binds a new file's announced row to its write instead of showing a failed edit", async () => {
    const dir = tempDir()
    const target = path.join(dir, "big.txt")
    const callId = "edit-new"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        exec_server_message: {
          id: 5,
          write_args: { path: target, file_text: "line 1\n", tool_call_id: callId },
        },
      }),
    ], [
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const calls = parts.filter((part) => part.type === "tool-call")
    expect(start?.toolName).toBe("write")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolCallId: start?.id, toolName: "write" })
    expect(calls[0].providerExecuted).toBeUndefined()
    sessionManager.resolve(session.sessionId, 5)
  })

  // File tools per host: native edit/write, or the patch tool that replaces
  // them for eligible GPT models. After a model switch the epoch catalog keeps
  // every tool it has seen; only this turn's permitted set names the file tool.
  type FileTool = "native" | "apply_patch" | "patch"
  const catalogs: Array<{
    label: string
    advertised: string[]
    permitted?: string[]
    dialect: CursorSession["hostToolDialect"]
    fileTool: FileTool
  }> = [
    { label: "OpenCode 1.x native", advertised: ["read", "edit", "write"], dialect: OPENCODE_1_TOOL_DIALECT, fileTool: "native" },
    { label: "OpenCode 1.x GPT", advertised: ["read", "apply_patch"], dialect: OPENCODE_1_TOOL_DIALECT, fileTool: "apply_patch" },
    {
      label: "OpenCode 1.x native then GPT",
      advertised: ["read", "edit", "write", "apply_patch"],
      permitted: ["read", "apply_patch"],
      dialect: OPENCODE_1_TOOL_DIALECT,
      fileTool: "apply_patch",
    },
    {
      label: "OpenCode 1.x GPT then native",
      advertised: ["read", "apply_patch", "edit", "write"],
      permitted: ["read", "edit", "write"],
      dialect: OPENCODE_1_TOOL_DIALECT,
      fileTool: "native",
    },
    { label: "OpenCode 2 native", advertised: ["read", "edit", "write"], dialect: OPENCODE_2_TOOL_DIALECT, fileTool: "native" },
    { label: "OpenCode 2 GPT", advertised: ["read", "patch"], dialect: OPENCODE_2_TOOL_DIALECT, fileTool: "patch" },
    {
      label: "OpenCode 2 native then GPT",
      advertised: ["read", "edit", "write", "patch"],
      permitted: ["read", "patch"],
      dialect: OPENCODE_2_TOOL_DIALECT,
      fileTool: "patch",
    },
    {
      label: "OpenCode 2 GPT then native",
      advertised: ["read", "patch", "edit", "write"],
      permitted: ["read", "edit", "write"],
      dialect: OPENCODE_2_TOOL_DIALECT,
      fileTool: "native",
    },
  ]
  function catalogSession(payloads: Uint8Array[], catalog: (typeof catalogs)[number], root: string) {
    const pumped = pumpSession(payloads, catalog.advertised.map((name) => ({ name, description: name })))
    if (catalog.permitted) pumped.session.permittedToolNames = new Set(catalog.permitted)
    pumped.session.hostToolDialect = catalog.dialect
    pumped.session.requestContext.env = { workspace_paths: [root] }
    return pumped
  }
  /** The host tool the edit's mutation becomes; `null` when the provider refuses it before any call. */
  type ExpectedTool = Record<FileTool, string | null>
  const replacesText: ExpectedTool = { native: "edit", apply_patch: "apply_patch", patch: "patch" }
  const createsFile: ExpectedTool = { native: "write", apply_patch: "apply_patch", patch: "patch" }

  function expectNoFailedRow(parts: any[]): void {
    expect(parts.filter((part) => part.type === "tool-call" && part.providerExecuted)).toEqual([])
    expect(parts.filter((part) => part.type === "tool-result" && part.isError)).toEqual([])
  }

  function expectBoundRow(parts: any[], toolName: string | null, authorizedRead = false): void {
    expectNoFailedRow(parts)
    const starts = parts.filter((part) => part.type === "tool-input-start")
    const calls = parts.filter((part) => part.type === "tool-call")
    if (toolName === null) {
      expect(starts).toEqual([])
      expect(calls).toEqual([])
      return
    }
    if (authorizedRead) {
      expect(starts).toEqual([])
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ toolName })
      expect(calls[0].toolCallId.startsWith("cursor_")).toBe(true)
      return
    }
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ toolName })
    expect(starts[0].id.startsWith("cursor-early_")).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolCallId: starts[0].id, toolName })
  }

  // #106: these reads go to OpenCode's permission-aware `read` and end the
  // step, so a row opened for the edit could only close as a failed edit.
  const hostReadTargets: Array<{
    label: string
    skip?: boolean
    setup(workspace: string): string
    /** Eligible correlated reads are upgraded only after the host authorizes them. */
    authorizes(file: string): boolean
  }> = [
    {
      label: "an existing file outside the workspace",
      setup() {
        const outside = path.join(tempDir(), "outside.txt")
        fs.writeFileSync(outside, "one\n")
        return outside
      },
      authorizes: () => true,
    },
    {
      label: "a workspace symlink to an outside file",
      setup(workspace) {
        const outside = path.join(tempDir(), "outside.txt")
        fs.writeFileSync(outside, "one\n")
        const link = path.join(workspace, "link.txt")
        fs.symlinkSync(outside, link)
        return link
      },
      authorizes: () => true,
    },
    {
      label: "a workspace file the provider cannot read",
      skip: !canChmod,
      setup(workspace) {
        const locked = path.join(workspace, "locked.txt")
        fs.writeFileSync(locked, "secret\n")
        fs.chmodSync(locked, 0o000)
        return locked
      },
      authorizes: () => true,
    },
  ]
  for (const target of hostReadTargets) {
    for (const catalog of catalogs) {
      it.skipIf(!!target.skip)(`opens no row before the host read of ${target.label} (${catalog.label})`, async () => {
        const workspace = tempDir()
        const file = target.setup(workspace)
        const callId = "edit-host-read"
        const { session, parts } = catalogSession(editHandshake(callId, file, 3), catalog, workspace)
        await run(session, parts)

        expect(parts.filter((part) => part.type === "tool-input-start")).toEqual([])
        expectNoFailedRow(parts)
        const calls = parts.filter((part) => part.type === "tool-call")
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ toolName: "read" })
        expect(calls[0].toolCallId.startsWith("cursor_")).toBe(true)
        // The exec handler made the same decision from the same predicate.
        expect(session.pending.get(3)?.resultMetadata?.correlatedEditCallId)
          .toBe(target.authorizes(file) ? callId : undefined)
        sessionManager.resolve(session.sessionId, 3)
      })
    }
  }

  // Existing files require a host read; missing targets retain the early mutation row.
  const providerReadTargets: Array<{
    label: string
    setup(workspace: string): { root: string; file: string }
    text?: string
    tool: ExpectedTool
  }> = [
    {
      label: "a regular workspace file",
      setup(workspace) {
        const file = path.join(workspace, "notes.txt")
        fs.writeFileSync(file, "one\n")
        return { root: workspace, file }
      },
      tool: replacesText,
    },
    {
      label: "a workspace file without a final newline",
      setup(workspace) {
        const file = path.join(workspace, "no-newline.txt")
        fs.writeFileSync(file, "one")
        return { root: workspace, file }
      },
      tool: replacesText,
    },
    {
      // `patch` strips carriage returns, so that conversion refuses the edit
      // before any call; the prediction withholds its row (#81).
      label: "a CRLF workspace file",
      setup(workspace) {
        const file = path.join(workspace, "crlf.txt")
        fs.writeFileSync(file, "one\r\ntwo\r\n")
        return { root: workspace, file }
      },
      text: "one\r\nTWO\r\n",
      tool: { native: "edit", apply_patch: "apply_patch", patch: null },
    },
    {
      label: "a workspace file through a symlinked workspace root",
      setup(workspace) {
        fs.writeFileSync(path.join(workspace, "notes.txt"), "one\n")
        const root = path.join(tempDir(), "workspace-link")
        fs.symlinkSync(workspace, root)
        return { root, file: path.join(root, "notes.txt") }
      },
      tool: replacesText,
    },
    {
      // An empty file has no text to replace, so its whole-file write stays a write.
      label: "an empty workspace file",
      setup(workspace) {
        const file = path.join(workspace, "empty.txt")
        fs.writeFileSync(file, "")
        return { root: workspace, file }
      },
      tool: createsFile,
    },
    {
      label: "a new file outside the workspace",
      setup(workspace) {
        return { root: workspace, file: path.join(tempDir(), "new.txt") }
      },
      tool: createsFile,
    },
    {
      // Missing-target validation answers its read; Cursor then creates the file.
      label: "a dangling workspace symlink",
      setup(workspace) {
        const file = path.join(workspace, "dangling.txt")
        fs.symlinkSync(path.join(tempDir(), "gone.txt"), file)
        return { root: workspace, file }
      },
      tool: createsFile,
    },
  ]
  for (const target of providerReadTargets) {
    for (const catalog of catalogs) {
      it(`routes the read and mutation of ${target.label} (${catalog.label})`, async () => {
        const { root, file } = target.setup(tempDir())
        // A refused edit keeps the step open until Cursor ends its turn.
        const { session, parts } = catalogSession(
          [...editHandshake("edit-provider-read", file, 17, target.text ?? "edited\n"), turnEnded()],
          catalog,
          root,
        )
        await run(session, parts)
        const authorizedRead = session.pending.has(17)
        if (authorizedRead) {
          await authorizeEditRead(session, parts, 17)
          await run(session, parts)
        }

        expectBoundRow(parts, target.tool[catalog.fileTool], authorizedRead)
        if (target.tool[catalog.fileTool] === null) {
          expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
        }
        sessionManager.resolve(session.sessionId, 18)
      })
    }
  }

  // A creation can skip the private read: Cursor sends the write at once.
  const creationTargets: Array<{ label: string; setup(workspace: string): string }> = [
    { label: "a new workspace file", setup: (workspace) => path.join(workspace, "created.txt") },
    { label: "a new file outside the workspace", setup: () => path.join(tempDir(), "created.txt") },
  ]
  for (const target of creationTargets) {
    for (const catalog of catalogs) {
      it(`binds the row for ${target.label} written without a read (${catalog.label})`, async () => {
        const workspace = tempDir()
        const file = target.setup(workspace)
        const callId = "edit-create"
        const { session, parts } = catalogSession([
          partial(callId, file),
          encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 5, write_args: { path: file, file_text: "created\n", tool_call_id: callId } },
          }),
        ], catalog, workspace)
        await run(session, parts)

        expectBoundRow(parts, createsFile[catalog.fileTool])
        sessionManager.resolve(session.sessionId, 5)
      })
    }
  }

  // A held parallel step keeps pumping after the host read, and a later
  // announcement may open a row while the step waits for its other calls.
  // The second edit follows a file change, so it waits for the first.
  for (const order of ["outside first", "inside first"] as const) {
    for (const catalog of catalogs) {
      it(`opens no edit rows before either authorized read in a parallel step, ${order} (${catalog.label})`, async () => {
        noteToolRequestsListedSeen()
        const workspace = tempDir()
        const inside = path.join(workspace, "inside.txt")
        fs.writeFileSync(inside, "one\n")
        const outside = path.join(tempDir(), "outside.txt")
        fs.writeFileSync(outside, "one\n")
        const outsideEdit = editHandshake("edit-outside", outside, 3)
        const insideEdit = editHandshake("edit-inside", inside, 5, "edited\n")
        const listed = encodeMessage("AgentServerMessage", {
          interaction_update: { tool_requests_listed: { call_count: 2 } },
        })
        const { session, parts } = catalogSession(
          order === "outside first" ? [listed, ...outsideEdit, ...insideEdit] : [listed, ...insideEdit, ...outsideEdit],
          catalog,
          workspace,
        )
        await run(session, parts)

        expectNoFailedRow(parts)
        expect(parts.filter(part => part.type === "tool-input-start")).toEqual([])
        const calls = parts.filter(part => part.type === "tool-call")
        if (order === "outside first") {
          // The inside edit follows a file change: its read is held, still owed to Cursor.
          expect(calls.map(call => call.toolName)).toEqual(["read"])
          expect(calls[0]!.toolCallId).toBe(`cursor_${session.sessionId}_3`)
          expect(session.stepOrder?.held.map(held => held.execId)).toEqual([5])
        } else {
          // The inside edit's early write is refused, which ends that edit; the outside edit runs.
          expect(calls.map(call => call.toolName)).toEqual(["read", "read"])
          expect(session.stepOrder?.held).toEqual([])
        }
        expect(session.pending.has(3)).toBe(true)
        expect(session.pending.has(5)).toBe(true)
        expect(parts.filter(part => part.type === "finish").map(part => part.finishReason.unified))
          .toEqual(["tool-calls"])
        sessionManager.resolve(session.sessionId, 3)
        sessionManager.resolve(session.sessionId, 5)
      })
    }
  }

  // A rewrite with unchanged content has no text to replace, so it stays a
  // `write` on native catalogs; the patch tool takes it as an Add File.
  for (const catalog of catalogs) {
    it(`completes the row for an unchanged rewrite (${catalog.label})`, async () => {
      const workspace = tempDir()
      const file = path.join(workspace, "same.txt")
      fs.writeFileSync(file, "one\n")
      const { session, parts } = catalogSession(
        [...editHandshake("edit-same", file, 17, "one\n"), turnEnded()],
        catalog,
        workspace,
      )
      await run(session, parts)
      await authorizeEditRead(session, parts, 17)
      await run(session, parts)
      expectBoundRow(parts, catalog.fileTool === "native" ? "write" : catalog.fileTool, true)
      const write = parts.find(part => part.type === "tool-call")
      if (catalog.fileTool === "native") expect(JSON.parse(write.input)).toMatchObject({ content: "one\n" })
      sessionManager.resolve(session.sessionId, 18)
    })
  }

  it("hands the row off to a host read the prediction did not expect", async () => {
    const workspace = tempDir()
    const announced = path.join(workspace, "announced.txt")
    const other = path.join(workspace, "other.txt")
    fs.writeFileSync(other, "two\n")
    const callId = "edit-other-read"
    // A read of another file under the edit's call id is not the edit's private read, so the host answers it.
    const { session, parts } = catalogSession([
      partial(callId, announced),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 3, read_args: { path: other, tool_call_id: callId } },
      }),
    ], catalogs[0]!, workspace)
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const read = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
    expect(start).toMatchObject({ toolName: "write" })
    expect(parts.find(part => part.type === "tool-result" && part.toolCallId === start?.id))
      .toMatchObject({ result: earlyRowHandoff("read"), isError: false })
    expect(read).toMatchObject({ toolName: "read" })
    expect(read.toolCallId.startsWith("cursor_")).toBe(true)
    sessionManager.resolve(session.sessionId, 3)
  })

  it("leaves the row unfailed when another call's exec ends the step", async () => {
    const file = path.join(tempDir(), "announced.txt")
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 4, shell_args: { command: "pwd", tool_call_id: "shell-1" } },
      }),
    ], [
      { name: "write", description: "Write" },
      { name: "bash", description: "Shell" },
    ])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)
    const start = parts.find((part) => part.type === "tool-input-start")
    const closed = parts.find((part) => part.type === "tool-call" && part.providerExecuted)
    const shell = parts.find((part) => part.type === "tool-call" && part.toolName === "bash")
    expect(start?.toolName).toBe("write")
    expect(closed?.toolCallId).toBe(start?.id)
    // Cursor still runs edit-1; its exec comes in a later step under its own id.
    expect(parts.find(part => part.type === "tool-result" && part.toolCallId === start?.id))
      .toMatchObject({ result: EARLY_ROW_DEFERRED, isError: false })
    expect(parts.findIndex(part => part === closed)).toBeLessThan(parts.findIndex(part => part === shell))
    expect(shell?.toolCallId.startsWith("cursor_")).toBe(true)
    expect(parts.at(-1)?.type).toBe("finish")
    sessionManager.resolve(session.sessionId, 4)
  })

  it("stays open across later text and closes before the step finishes", async () => {
    const file = path.join(tempDir(), "announced.txt")
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "still writing" } } }),
      turnEnded(),
    ], [{ name: "write", description: "Write" }])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)
    const startAt = parts.findIndex((part) => part.type === "tool-input-start")
    const textAt = parts.findIndex((part) => part.type === "text-delta")
    const textEndAt = parts.findIndex((part) => part.type === "text-end")
    const closedAt = parts.findIndex((part) => part.type === "tool-call" && part.providerExecuted)
    const finishAt = parts.findIndex((part) => part.type === "finish")
    expect(startAt).toBeGreaterThanOrEqual(0)
    expect(textAt).toBeGreaterThan(startAt)
    expect(textEndAt).toBeGreaterThan(textAt)
    expect(closedAt).toBeGreaterThan(textEndAt)
    expect(finishAt).toBeGreaterThan(closedAt)
    expect(parts.find((part) => part.type === "tool-result" && part.toolCallId === parts[startAt].id))
      .toMatchObject({ result: EARLY_ROW_CLOSED, isError: true })
  })

  it("does not open a row a patch conversion would refuse, or on a tool-less turn", async () => {
    const dir = tempDir()
    const crlf = path.join(dir, "crlf.txt")
    fs.writeFileSync(crlf, "a\r\nb\r\n")
    const refused = pumpSession([
      partial("edit-1", crlf),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "no row" } } }),
      turnEnded(),
    ], [{ name: "patch", description: "Patch" }])
    refused.session.requestContext.env = { workspace_paths: [dir] }
    await run(refused.session, refused.parts)
    expect(refused.parts.some((part) => part.type === "tool-input-start")).toBe(false)

    const lifecycle = pumpSession([
      partial("edit-1", crlf),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "title" } } }),
      turnEnded(),
    ], [{ name: "edit", description: "Edit" }])
    lifecycle.session.requestContext.env = { workspace_paths: [dir] }
    lifecycle.session.allowTools = false
    await run(lifecycle.session, lifecycle.parts)
    expect(lifecycle.parts.some((part) => part.type === "tool-input-start")).toBe(false)
  })

  it.each(["unsupported", "not permitted", "too large"])("fails a binary write row refused as %s before another call ends the step", async refusal => {
    const workspace = tempDir()
    const file = path.join(workspace, "image.png")
    const { session, parts } = pumpSession([
      partial("edit-refused-binary", file),
      started("edit-refused-binary", file),
      encodeMessage("AgentServerMessage", { exec_server_message: {
        id: 2, write_args: { path: file, file_bytes: Buffer.alloc(refusal === "too large" ? MAX_STAGED_IMAGE_BYTES + 1 : 3), tool_call_id: "edit-refused-binary" },
      } }),
      encodeMessage("AgentServerMessage", { exec_server_message: {
        id: 3, shell_args: { command: "echo ok", tool_call_id: "shell-other" },
      } }),
      turnEnded(),
    ], [
      { name: "write", description: "Write" }, { name: "bash", description: "Shell" },
      ...(refusal === "unsupported" ? [] : [{ name: "cursor_image_save", description: "Save an image" }]),
    ])
    if (refusal === "not permitted") session.permittedToolNames = new Set(["write", "bash"])
    session.requestContext.env = { workspace_paths: [workspace] }
    const previousCache = getHostCacheDirOverride()
    setHostCacheDirOverride(tempDir())
    try {
      await run(session, parts)
      const detail = refusal === "too large"
        ? `Generated image is ${MAX_STAGED_IMAGE_BYTES + 1} bytes, above the ${MAX_STAGED_IMAGE_BYTES} byte limit`
        : refusal === "not permitted"
          ? "This OpenCode agent cannot write binary file content on this turn. Do not retry this write with the same bytes."
          : "This OpenCode agent cannot write binary file content. Do not retry this write with the same bytes."
      expect(parts.filter(part => part.type === "tool-result"))
        .toEqual([expect.objectContaining({ result: `Cursor's edit of ${file} failed: ${detail}`, isError: true })])
      expect(fs.existsSync(file)).toBe(false)
      sessionManager.resolve(session.sessionId, 3)
    } finally {
      setHostCacheDirOverride(previousCache)
    }
  })

  it("keeps the refusal reason when Cursor later reports a different failure", async () => {
    const workspace = tempDir()
    const file = path.join(workspace, "image.png")
    const { session, parts } = pumpSession([
      partial("edit-refused-completed", file),
      started("edit-refused-completed", file),
      encodeMessage("AgentServerMessage", { exec_server_message: {
        id: 2, write_args: { path: file, file_bytes: Buffer.alloc(3), tool_call_id: "edit-refused-completed" },
      } }),
      completedEdit("edit-refused-completed", file, {
        error: { error: "later", model_visible_error: "The string to replace was not found in the file." },
      }),
      turnEnded(),
    ], [{ name: "write", description: "Write" }])
    session.requestContext.env = { workspace_paths: [workspace] }
    await run(session, parts)
    expect(parts.filter(part => part.type === "tool-result")).toEqual([expect.objectContaining({
      result: `Cursor's edit of ${file} failed: This OpenCode agent cannot write binary file content. Do not retry this write with the same bytes.`,
      isError: true,
    })])
    expect(fs.existsSync(file)).toBe(false)
  })

  it("fails an unexecuted parallel row when Cursor ends the Run before another call returns", async () => {
    noteToolRequestsListedSeen()
    const workspace = tempDir()
    const file = path.join(workspace, "never-written.txt")
    const { session, parts } = pumpSession([
      encodeMessage("AgentServerMessage", { interaction_update: { tool_requests_listed: { call_count: 2 } } }),
      // The shell comes first in the model's order, so it does not wait for the edit.
      encodeMessage("AgentServerMessage", { interaction_update: { tool_call_started: {
        call_id: "shell-other", tool_call: { shell_tool_call: { args: { command: "echo ok" } } },
      } } }),
      partial("edit-terminal", file),
      started("edit-terminal", file),
      encodeMessage("AgentServerMessage", { exec_server_message: {
        id: 3, shell_args: { command: "echo ok", tool_call_id: "shell-other" },
      } }),
      turnEnded(),
    ], [{ name: "write", description: "Write" }, { name: "bash", description: "Shell" }])
    session.requestContext.env = { workspace_paths: [workspace] }
    await run(session, parts)
    expect(parts.find(part => part.type === "tool-result"))
      .toMatchObject({ result: EARLY_ROW_CLOSED, isError: true })
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } })
    sessionManager.resolve(session.sessionId, 3)
  })

  it("shows Cursor's own failure on the row of an edit it finished without a write", async () => {
    const file = path.join(tempDir(), "created.txt")
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      started("edit-1", file),
      completedEdit("edit-1", file, {
        error: { path: file, error: "internal", model_visible_error: "The string to replace was not found in the file." },
      }),
      turnEnded(),
    ], [{ name: "edit", description: "Edit" }, { name: "write", description: "Write" }])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    expect(start?.toolName).toBe("write")
    expect(parts.filter((part) => part.type === "tool-result")).toEqual([expect.objectContaining({
      toolCallId: start.id,
      result: `Cursor's edit of ${file} failed: The string to replace was not found in the file.`,
      isError: true,
    })])
  })


  it("closes each internally failed edit with Cursor's outcome and binds the one that writes", async () => {
    const dir = tempDir()
    const file = path.join(dir, "created.txt")
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      started("edit-1", file),
      completedEdit("edit-1", file, { error: { path: file, error: "no match" } }),
      partial("edit-2", file),
      started("edit-2", file),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 5, write_args: { path: file, file_text: "created\n", tool_call_id: "edit-2" } },
      }),
    ], [{ name: "edit", description: "Edit" }, { name: "write", description: "Write" }])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const [first, second] = parts.filter((part) => part.type === "tool-input-start")
    expect(first.id).toBe(earlyRowToolCallId(session.sessionId, "edit-1"))
    expect(second.id).toBe(earlyRowToolCallId(session.sessionId, "edit-2"))
    expect(parts.find((part) => part.type === "tool-result" && part.toolCallId === first.id))
      .toMatchObject({ result: `Cursor's edit of ${file} failed: no match`, isError: true })
    const write = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
    expect(write).toMatchObject({ toolCallId: second.id, toolName: "write" })
    expect(parts.some((part) => part.type === "tool-result" && part.result === EARLY_ROW_CLOSED)).toBe(false)
    sessionManager.resolve(session.sessionId, 5)
  })


  it("completes the row of an edit Cursor finished without changing the file", async () => {
    const file = path.join(tempDir(), "created.txt")
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      started("edit-1", file),
      completedEdit("edit-1", file, { success: { path: file } }),
      turnEnded(),
    ], [{ name: "write", description: "Write" }])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)

    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
      result: `Cursor finished this edit of ${file} without changing the file.`,
      isError: false,
    })
  })


  it("still fails the row when Cursor finishes the call without an outcome", async () => {
    const file = path.join(tempDir(), "created.txt")
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      started("edit-1", file),
      completedEdit("edit-1", file),
      turnEnded(),
    ], [{ name: "write", description: "Write" }])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)

    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({ result: EARLY_ROW_CLOSED, isError: true })
  })


  it("shows a failed edit Cursor finished after the host read, with no row open", async () => {
    const workspace = tempDir()
    const file = path.join(workspace, "notes.txt")
    fs.writeFileSync(file, "one\n")
    const { session, parts } = catalogSession([
      ...editHandshake("edit-missing", file, 17),
      completedEdit("edit-missing", file, {
        error: { path: file, error: "x", model_visible_error: "String not found." },
      }),
      turnEnded(),
    ], catalogs[0]!, workspace)
    await run(session, parts)
    await authorizeEditRead(session, parts, 17)
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    expect(start).toMatchObject({ toolName: "edit", id: cursorEditFailureToolCallId(session.sessionId, "edit-missing") })
    expect(start.id).not.toBe(earlyRowToolCallId(session.sessionId, "edit-missing"))
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ toolCallId: start.id, providerExecuted: true, input: "{}" })
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
      toolCallId: start.id,
      result: `Cursor's edit of ${file} failed: String not found.`,
      isError: true,
    })
  })


  it("does not read file contents just to label an edit Cursor failed before host authorization", async () => {
    const workspace = tempDir()
    const file = path.join(tempDir(), "outside.txt")
    fs.writeFileSync(file, "private\r\n")
    const patchOnly = catalogs.find(catalog => catalog.label === "OpenCode 2 GPT")!
    const { session, parts } = catalogSession([
      started("edit-no-read", file),
      completedEdit("edit-no-read", file, { error: { error: "failed before read" } }),
      turnEnded(),
    ], patchOnly, workspace)
    const reads = spyOn(fs, "readFileSync")
    try {
      await run(session, parts)
      expect(parts.find(part => part.type === "tool-result")).toMatchObject({ isError: true })
      expect(reads.mock.calls.filter(([target]) => target === file)).toHaveLength(0)
    } finally {
      reads.mockRestore()
    }
  })

  it("names the patch tool on the failed row of a CRLF file the patch tool would refuse", async () => {
    const workspace = tempDir()
    const file = path.join(workspace, "crlf.txt")
    fs.writeFileSync(file, "one\r\ntwo\r\n")
    const patchOnly = catalogs.find((catalog) => catalog.label === "OpenCode 2 GPT")!
    const { session, parts } = catalogSession([
      ...editHandshake("edit-crlf", file, 17),
      completedEdit("edit-crlf", file, { error: { path: file, error: "x", model_visible_error: "String not found." } }),
      turnEnded(),
    ], patchOnly, workspace)
    await run(session, parts)
    await authorizeEditRead(session, parts, 17)
    await run(session, parts)

    expect(parts.find((part) => part.type === "tool-input-start")).toMatchObject({ toolName: "patch" })
    expect(parts.find((part) => part.type === "tool-result"))
      .toMatchObject({ result: `Cursor's edit of ${file} failed: String not found.`, isError: true })
  })


  it("shows the failure of an edit whose write the provider refused before the host ran it", async () => {
    const workspace = tempDir()
    const file = path.join(workspace, "crlf.txt")
    fs.writeFileSync(file, "one\r\ntwo\r\n")
    const patchOnly = catalogs.find((catalog) => catalog.label === "OpenCode 2 GPT")!
    const { session, parts } = catalogSession([
      ...editHandshake("edit-refused", file, 17, "one\r\nTWO\r\n"),
      completedEdit("edit-refused", file, { error: { path: file, error: "refused", model_visible_error: "The write was refused." } }),
      turnEnded(),
    ], patchOnly, workspace)
    await run(session, parts)
    await authorizeEditRead(session, parts, 17)
    await run(session, parts)

    expect(parts.filter((part) => part.type === "tool-call" && !part.providerExecuted)).toEqual([])
    expect(parts.filter((part) => part.type === "tool-result")).toEqual([expect.objectContaining({
      result: `Cursor's edit of ${file} failed: The write was refused.`,
      isError: true,
    })])
  })


  it("adds no row when the host already ran the edit Cursor reports as failed", async () => {
    const workspace = tempDir()
    const file = path.join(workspace, "notes.txt")
    fs.writeFileSync(file, "one\n")
    const { session, parts } = catalogSession([
      ...editHandshake("edit-host", file, 17, "two\n"),
      completedEdit("edit-host", file, { write_permission_denied: { path: file, error: "denied" } }),
      turnEnded(),
    ], catalogs[0]!, workspace)
    await run(session, parts)
    await authorizeEditRead(session, parts, 17)
    await run(session, parts)
    const edit = parts.find((part) => part.type === "tool-call")
    expect(edit).toMatchObject({ toolName: "edit" })
    parts.length = 0
    expect(await deliverContinuationResults(session, [{
      sessionId: session.sessionId, execId: 18, toolCallId: edit.toolCallId, toolName: "edit", output: "denied", error: "denied",
    }])).toBe(session)
    await run(session, parts)

    expect(parts.filter((part) => part.type === "tool-input-start" || part.type === "tool-call")).toEqual([])
  })

  it("hands a binary edit write to the image save tool and adds no row when its save is refused", async () => {
    const pendingBefore = pendingCursorImageCount()
    let imageId: string | undefined
    const workspace = tempDir()
    const file = path.join(workspace, "image.png")
    const { session, parts } = pumpSession([
      partial("edit-binary", file),
      started("edit-binary", file),
      encodeMessage("AgentServerMessage", { exec_server_message: {
        id: 2, write_args: { path: file, file_bytes: Buffer.alloc(3), tool_call_id: "edit-binary" },
      } }),
      completedEdit("edit-binary", file, { write_permission_denied: { path: file, error: "denied" } }),
      turnEnded(),
    ], [{ name: "write", description: "Write" }, { name: "cursor_image_save", description: "Save an image" }])
    session.requestContext.env = { workspace_paths: [workspace] }
    const previousCache = getHostCacheDirOverride()
    setHostCacheDirOverride(tempDir())
    try {
      await run(session, parts)
      const start = parts.find((part) => part.type === "tool-input-start")
      expect(parts.find((part) => part.type === "tool-result" && part.toolCallId === start?.id))
        .toMatchObject({ result: earlyRowHandoff("cursor_image_save"), isError: false })
      const save = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
      expect(save).toMatchObject({ toolName: "cursor_image_save" })
      const args = JSON.parse(save.input)
      imageId = args.image_id
      const denial = IMAGE_PERMISSION_DENIED_PREFIX + " denied"
      await expect(executeCursorImageSave(args, {
        worktree: workspace, directory: workspace,
        ask: async () => { throw new Error("denied") },
      })).rejects.toThrow(denial)
      expect(pendingCursorImageCount()).toBe(pendingBefore)
      expect(fs.existsSync(file)).toBe(false)
      parts.length = 0
      expect(await deliverContinuationResults(session, [{
        sessionId: session.sessionId, execId: 2, toolCallId: save.toolCallId, toolName: "cursor_image_save", output: denial, error: denial,
      }])).toBe(session)
      await run(session, parts)

      expect(parts.filter((part) => part.type === "tool-input-start" || part.type === "tool-call")).toEqual([])
    } finally {
      if (imageId) discardPendingCursorImage(imageId)
      setHostCacheDirOverride(previousCache)
    }
  })
})
