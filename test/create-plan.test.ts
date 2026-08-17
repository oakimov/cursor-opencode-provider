import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  CREATE_PLAN_NOT_APPROVED_REASON,
  createPlanApprovalQuestion,
  createPlanApproved,
  createPlanStageInput,
  decodeCreatePlanQuery,
  renderOpencodePlanMarkdown,
  resolveCreatePlanBridge,
  resolveHostPlanPath,
  slugifyPlanName,
  writeOpencodePlanFile,
} from "../src/protocol/create-plan.js"
import {
  isCursorPlanModeActive,
  resetActiveCursorModesForTests,
  setActiveCursorMode,
} from "../src/protocol/switch-mode.js"
import { deliverContinuationResults, pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  hostGlobalDataDir,
  hostPlansDir,
  HOST_PATH_BRIDGE,
  type OpenCodePathBridge,
} from "../src/context/paths.js"
import {
  createPlanExecutionKickoffText,
  formatPlanKickoffPath,
  flushPlanExecutionKickoff,
  planExecutionKickoffState,
  planPathFromUri,
  queuePlanExecutionKickoff,
  resetPlanExecutionKickoffForTests,
  setPlanExecutionKickoff,
  takePlanExecutionKickoffWarning,
} from "../src/plan-execution-kickoff.js"

let workspace: string
let sandboxHome: string
let previousHome: string | undefined
let previousXdgData: string | undefined
let previousBridge: unknown

beforeEach(() => {
  resetActiveCursorModesForTests()
  resetPlanExecutionKickoffForTests()
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plan-ws-"))
  previousHome = process.env.HOME
  previousXdgData = process.env.XDG_DATA_HOME
  previousBridge = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  delete process.env.XDG_DATA_HOME
  // Plans now resolve off the host data dir, so every test must be sandboxed
  // away from the real ~/.local/share or it writes into the developer's home.
  // Deliberately OUTSIDE `workspace`, so "nothing lands in the repo" assertions
  // are not silently satisfied by the sandbox itself living inside it.
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plan-home-"))
  process.env.HOME = sandboxHome
})

afterEach(() => {
  resetPlanExecutionKickoffForTests()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(sandboxHome, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousXdgData
  if (previousBridge === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  } else {
    ;(globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = previousBridge
  }
})

function installBridge(projectConfigDir: string, globalConfigDirs?: string[]): void {
  const bridge: OpenCodePathBridge = {
    projectConfigDirs: () => [projectConfigDir],
    globalConfigDirs: () => globalConfigDirs ?? [path.join(os.tmpdir(), "fake-config")],
  }
  ;(globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = bridge
}

function createPlanPayload(args: Record<string, unknown>, id = 42): Uint8Array {
  const query = encodeMessage("CreatePlanRequestQuery", {
    args,
    tool_call_id: "tool_plan",
  })
  return encodeMessage("AgentServerMessage", {
    interaction_query: { id, create_plan_request_query: query },
  })
}

describe("renderOpencodePlanMarkdown", () => {
  it("writes plain markdown without Cursor YAML frontmatter", () => {
    const body = renderOpencodePlanMarkdown({
      name: "Ship feature",
      overview: "Short overview",
      plan: "## Steps\n\n1. Do the thing\n",
      isProject: false,
      todos: [
        { id: "a", content: "First", status: "pending" },
        { id: "b", content: "Done item", status: "completed" },
      ],
    })
    expect(body.startsWith("---")).toBe(false)
    expect(body).not.toContain("isProject:")
    expect(body).toContain("# Ship feature")
    expect(body).toContain("Short overview")
    expect(body).toContain("## Steps")
    expect(body).toContain("- [ ] First")
    expect(body).toContain("- [x] Done item")
  })

  it("does not repeat a title the plan body already leads with", () => {
    // Live shape: Cursor sends `name` and repeats it as the body's own H1, so
    // every written plan opened with the same heading twice.
    const body = renderOpencodePlanMarkdown({
      name: "Sample Test Plan",
      overview: "A minimal test plan with a couple of sample actions.",
      plan: "# Sample Test Plan\n\nThis is a lightweight test plan.\n\n## Sample actions\n\n1. Read a file\n",
      isProject: false,
      todos: [],
    })
    expect(body.match(/^# Sample Test Plan$/gm)).toHaveLength(1)
    expect(body.startsWith("# Sample Test Plan\n")).toBe(true)
    expect(body).toContain("A minimal test plan with a couple of sample actions.")
    expect(body).toContain("## Sample actions")
  })

  it("drops the overview when the body repeats it after its own heading", () => {
    const body = renderOpencodePlanMarkdown({
      name: "Sample Test Plan",
      overview: "Shared overview line.",
      plan: "# Sample Test Plan\n\nShared overview line.\n\n## Steps\n\n1. Go\n",
      isProject: false,
      todos: [],
    })
    expect(body.match(/Shared overview line\./g)).toHaveLength(1)
  })

  it("still emits the title when the body leads with a different heading", () => {
    const body = renderOpencodePlanMarkdown({
      name: "Ship feature",
      overview: "",
      plan: "# Implementation notes\n\nDetails.\n",
      isProject: false,
      todos: [],
    })
    expect(body).toContain("# Ship feature")
    expect(body).toContain("# Implementation notes")
  })
})

describe("slugifyPlanName", () => {
  it("slugifies titles", () => {
    expect(slugifyPlanName("Hello World!")).toBe("hello-world")
  })
})

describe("hostPlansDir", () => {
  it("uses host global data/plans with no git worktree", () => {
    process.env.HOME = path.join(workspace, "home")
    delete process.env.XDG_DATA_HOME
    expect(hostPlansDir(workspace)).toBe(path.join(hostGlobalDataDir(), "plans"))
  })

  it("still stays outside the repository inside a git worktree", () => {
    // The provider deliberately does NOT mirror OpenCode's in-worktree branch:
    // a plan in the user's tree is untracked-but-unignored, and creating
    // `.opencode/` also makes OpenCode install a project-local node_modules.
    fs.mkdirSync(path.join(workspace, ".git"))
    process.env.HOME = path.join(workspace, "home")
    delete process.env.XDG_DATA_HOME
    expect(hostPlansDir(workspace)).toBe(path.join(hostGlobalDataDir(), "plans"))
    expect(hostPlansDir(workspace).startsWith(path.join(workspace, ".git"))).toBe(false)
  })

  it("ignores an in-worktree bridge directory for plan storage", () => {
    // Project config discovery and plan storage are separate concerns: even an
    // installed host bridge cannot move the ordinary plan into the repository.
    fs.mkdirSync(path.join(workspace, ".git"))
    installBridge(path.join(workspace, ".host-config"))
    process.env.HOME = path.join(workspace, "home")
    delete process.env.XDG_DATA_HOME
    expect(hostPlansDir(workspace)).toBe(path.join(hostGlobalDataDir(), "plans"))
  })

})

describe("resolveCreatePlanBridge", () => {
  const advertised = ["question", "read", "write"]

  it("prefers a host plan-stage tool, which owns write and approval together", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: true, canStage: true, planModeActive: true, advertised }),
    ).toEqual({ kind: "stage" })
  })

  it("emulates the approval with `question` when no stage tool exists", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: true, planModeActive: true, advertised }),
    ).toEqual({ kind: "approve" })
  })

  it("acknowledges without a prompt when nothing can ask, or outside plan mode", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: true, planModeActive: true, advertised: ["read"] }),
    ).toEqual({ kind: "ack" })
    expect(
      resolveCreatePlanBridge({ allowTools: true, planModeActive: false, advertised }),
    ).toEqual({ kind: "ack" })
  })

  it("never writes or prompts from a no-tool lifecycle turn", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: false, canStage: true, planModeActive: true, advertised }),
    ).toEqual({ kind: "ack" })
  })
})

describe("createPlanApproved", () => {
  const question = createPlanApprovalQuestion("/plans/42-demo.md")

  it("approves only on an explicit Yes", () => {
    expect(createPlanApproved(
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      false,
      question,
    )).toBe(true)
  })

  it("keeps planning on No, on a dismissed prompt, and on a failed one", () => {
    expect(createPlanApproved(
      `User has answered your questions: "${question}"="No". You can now continue.`,
      false,
      question,
    )).toBe(false)
    expect(createPlanApproved("", false, question)).toBe(false)
    expect(createPlanApproved("permission denied", true, question)).toBe(false)
  })

  it("does not approve when the echoed prompt is not the one that was asked", () => {
    // The answer is anchored on the exact prompt text; a mismatch must read as
    // unanswered, never as approval.
    expect(createPlanApproved(
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      false,
      createPlanApprovalQuestion("/plans/99-other.md"),
    )).toBe(false)
  })
})

describe("native plan stage payload", () => {
  it("renders a host stage URI and markdown", () => {
    const staged = createPlanStageInput({
      name: "Native Review",
      overview: "Review this",
      plan: "## Steps\n\n- Inspect\n",
      isProject: false,
      todos: [],
    })
    expect(staged.plan_uri).toBe("local://native-review-plan.md")
    expect(staged.title).toBe("native-review")
    expect(staged.content).toContain("# Native Review")
    expect(staged.content).toContain("## Steps")
  })
})

describe("resolveHostPlanPath / writeOpencodePlanFile", () => {
  it("writes under the host plans dir and returns a file:// URI", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    const created = 1_700_000_000_000
    const written = writeOpencodePlanFile(
      {
        name: "Demo Plan",
        overview: "Overview text",
        plan: "Body of the plan.",
        isProject: false,
        todos: [],
      },
      workspace,
      created,
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.planPath).toBe(
      path.join(hostGlobalDataDir(), "plans", `${created}-demo-plan.md`),
    )
    expect(written.planUri).toBe(pathToFileURL(written.planPath).href)
    const onDisk = fs.readFileSync(written.planPath, "utf-8")
    expect(onDisk.startsWith("---")).toBe(false)
    expect(onDisk).toContain("# Demo Plan")
    expect(onDisk).toContain("Body of the plan.")
  })

  it("writes nothing into the repository, even with a bridged project-config dir", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    installBridge(path.join(workspace, ".host-config"))
    const planPath = resolveHostPlanPath(workspace, "Bridge Plan", 42)
    expect(planPath).toBe(path.join(hostGlobalDataDir(), "plans", "42-bridge-plan.md"))
    expect(planPath.startsWith(workspace + path.sep)).toBe(false)
  })
})

describe("CreatePlan interaction #7", () => {
  it("does not write a plan file from a no-tool lifecycle turn", () => {
    // OpenCode's title-generation Run replays the same turn with allowTools
    // false; writing there produced a second, throwaway plan file per request.
    fs.mkdirSync(path.join(workspace, ".git"))
    const payload = createPlanPayload({
      name: "Lifecycle Plan",
      overview: "Should not persist",
      plan: "## Approach\n\nNothing.\n",
      todos: [],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: false,
    })
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.create_plan_request_response.result.success).toBeDefined()
    expect(response.create_plan_request_response.result.plan_uri).toBe("")
    expect(fs.existsSync(path.join(workspace, ".opencode", "plans"))).toBe(false)
  })

  it("acks empty args with an empty plan_uri", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_query: { id: 7, create_plan_request_query: new Uint8Array() },
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, { workspaceRoot: workspace })
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.create_plan_request_response.result.success).toBeDefined()
    expect(response.create_plan_request_response.result.plan_uri).toBe("")
  })

  it("bridges non-empty args when native plan staging is advertised", () => {
    const payload = createPlanPayload({
      name: "Native Plan",
      overview: "Do it natively",
      plan: "## Approach\n\nUse the host plan stage.\n",
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      canBridgeCreatePlan: true,
    })
    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.createPlan?.toolName).toBe("cursor_plan_stage")
    expect(handled.createPlan?.args.name).toBe("Native Plan")
  })

  it("persists args under hostPlansDir and returns file:// plan_uri", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    const payload = createPlanPayload({
      name: "Live Plan",
      overview: "Do it",
      plan: "## Approach\n\nWrite the code.\n",
      todos: [{ id: "1", content: "Implement", status: 1 }],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
    })
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    const result = response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(result.plan_uri).toMatch(/^file:\/\//)
    const planPath = decodeURIComponent(new URL(result.plan_uri).pathname)
    expect(planPath.startsWith(path.join(hostGlobalDataDir(), "plans"))).toBe(true)
    expect(fs.existsSync(planPath)).toBe(true)
    const body = fs.readFileSync(planPath, "utf-8")
    expect(body.startsWith("---")).toBe(false)
    expect(body).toContain("# Live Plan")
    expect(body).toContain("- [ ] Implement")
  })

  it("adds nothing whatsoever to the project directory", () => {
    // The invariant behind this whole change: writing a plan must not create
    // `.opencode/` in the user's repo. That directory is also what makes
    // OpenCode install a project-local `node_modules` on its next startup.
    fs.mkdirSync(path.join(workspace, ".git"))
    const payload = createPlanPayload({
      name: "Contained Plan",
      overview: "Stays out of the tree",
      plan: "## Approach\n\nWrite it elsewhere.\n",
      todos: [{ id: "1", content: "Verify", status: 1 }],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
    })
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    const planUri = response.create_plan_request_response.result.plan_uri as string
    const planPath = decodeURIComponent(new URL(planUri).pathname)

    expect(fs.existsSync(path.join(workspace, ".opencode"))).toBe(false)
    expect(planPath.startsWith(workspace + path.sep)).toBe(false)
    // `home` is the sandboxed HOME this suite sets; `.git` is the fixture.
    expect(fs.readdirSync(workspace)).toEqual([".git"])
    expect(fs.existsSync(planPath)).toBe(true)
    expect(fs.readFileSync(planPath, "utf-8")).toContain("# Contained Plan")
  })

  it("asks the user to approve execution once the plan is written", () => {
    // The live failure: plan mode was entered and the plan file was written,
    // but nothing ever asked whether to start implementing it, so the turn
    // simply ended. Writing needs no approval; executing does.
    fs.mkdirSync(path.join(workspace, ".git"))
    setActiveCursorMode("plan-session", "plan")
    const payload = createPlanPayload({
      name: "Gated Plan",
      overview: "Needs approval before execution",
      plan: "## Approach\n\nDo the work.\n",
      todos: [],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      planModeActive: true,
      advertisedTools: ["question", "read", "write"],
    })

    // Cursor stays blocked while the host asks, exactly as its own CLI does.
    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.createPlan?.toolName).toBe("question")
    expect(handled.createPlan?.bridge.kind).toBe("approve")

    // The plan is already on disk — the prompt is about running it, not saving it.
    const planPath = decodeURIComponent(new URL(handled.createPlan!.planUri!).pathname)
    expect(fs.existsSync(planPath)).toBe(true)
    expect(fs.readFileSync(planPath, "utf-8")).toContain("# Gated Plan")
    expect(handled.createPlan?.questionInput?.questions[0]?.question)
      .toBe(createPlanApprovalQuestion(planPath))
  })

  it("writes and acknowledges without asking when no plan mode is active", () => {
    // The approval gates the transition out of planning. A CreatePlan raised
    // outside plan mode has no such transition to guard.
    fs.mkdirSync(path.join(workspace, ".git"))
    const payload = createPlanPayload({
      name: "Ungated Plan",
      overview: "No plan mode",
      plan: "## Approach\n\nJust record it.\n",
      todos: [],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      planModeActive: false,
      advertisedTools: ["question", "read", "write"],
    })
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    expect(response.create_plan_request_response.result.success).toBeDefined()
    expect(response.create_plan_request_response.result.plan_uri).toMatch(/^file:\/\//)
  })

  it("decodes CreatePlanRequestQuery args", () => {
    const bytes = encodeMessage("CreatePlanRequestQuery", {
      args: { name: "n", overview: "o", plan: "p" },
      tool_call_id: "tc",
    })
    const decoded = decodeCreatePlanQuery(bytes)
    expect(decoded?.args.name).toBe("n")
    expect(decoded?.args.overview).toBe("o")
    expect(decoded?.args.plan).toBe("p")
    expect(decoded?.toolCallId).toBe("tc")
  })
})

// ── end-to-end through the held-open Run ─────────────────────────────────────

function planSession(payloads: Uint8Array[], writes: Uint8Array[], advertised: string[]): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++] } }
      : { done: true, value: undefined },
  }
  return {
    sessionId: "create-plan-session",
    conversationId: "create-plan-conversation",
    openCodeSessionId: "create-plan-opencode-session",
    stream: {
      write(data: Uint8Array) { writes.push(data); return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    blobs: new Map(),
    displayToolCalls: new Map(),
    toolDescriptors: advertised.map((name) => ({
      name: `opencode-${name}`,
      tool_name: name,
      provider_identifier: "opencode",
    })),
    requestContext: { env: { workspace_paths: [workspace] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    nextBridgedExecId: 900_000,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}

async function runCreatePlan(payloads: Uint8Array[], advertised: string[]) {
  const writes: Uint8Array[] = []
  const parts: any[] = []
  const session = planSession(payloads, writes, advertised)
  await pump(
    session,
    { enqueue(part: unknown) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<any>,
    { textId: "text", reasoningId: "reasoning" },
  )
  return { session, writes, parts }
}

describe("plan execution kickoff helpers", () => {
  it("keeps PlanExitTool wording verbatim", () => {
    expect(createPlanExecutionKickoffText("/tmp/plans/demo.md")).toBe(
      "The plan at /tmp/plans/demo.md has been approved, you can now edit files. Execute the plan",
    )
  })

  it("prefers a worktree-relative label when the plan is under the workspace", () => {
    const absolute = path.join(workspace, "plans", "demo.md")
    expect(formatPlanKickoffPath(absolute, workspace)).toBe(path.join("plans", "demo.md"))
  })

  it("keeps absolute paths outside the workspace", () => {
    const absolute = path.join(sandboxHome, ".local", "share", "opencode", "plans", "demo.md")
    expect(formatPlanKickoffPath(absolute, workspace)).toBe(absolute)
  })

  it("decodes file:// plan URIs", () => {
    const absolute = path.join(sandboxHome, "plans", "demo.md")
    expect(planPathFromUri(pathToFileURL(absolute).href)).toBe(absolute)
    expect(planPathFromUri(absolute)).toBe(absolute)
  })

  it("does not flush before the owning Run is terminal and idle", async () => {
    const calls: string[] = []
    setPlanExecutionKickoff(async input => { calls.push(input.planPath) })
    expect(queuePlanExecutionKickoff({
      sessionID: "settle-session",
      planPath: "/tmp/settle.md",
      cursorSessionID: "cursor-run-1",
    })).toBe(true)

    expect(await flushPlanExecutionKickoff("settle-session", {
      cursorSessionID: "cursor-run-1",
      terminal: false,
      pumpActive: true,
      pendingExecs: 0,
    })).toBe(false)
    expect(await flushPlanExecutionKickoff("settle-session", {
      cursorSessionID: "cursor-run-1",
      terminal: true,
      pumpActive: false,
      pendingExecs: 1,
    })).toBe(false)
    expect(calls).toEqual([])
    expect(planExecutionKickoffState("settle-session")?.status).toBe("pending")

    expect(await flushPlanExecutionKickoff("settle-session", {
      cursorSessionID: "cursor-run-1",
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })).toBe(true)
    expect(calls).toEqual(["/tmp/settle.md"])
    expect(await flushPlanExecutionKickoff("settle-session", {
      cursorSessionID: "cursor-run-1",
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("keeps a failed kickoff retryable and exposes one warning", async () => {
    let attempts = 0
    setPlanExecutionKickoff(async () => {
      attempts += 1
      if (attempts === 1) throw new Error("host queue failed")
    })
    queuePlanExecutionKickoff({
      sessionID: "retry-session",
      planPath: "/tmp/retry.md",
      cursorSessionID: "cursor-run-failed",
    })

    expect(await flushPlanExecutionKickoff("retry-session", {
      cursorSessionID: "cursor-run-failed",
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })).toBe(false)
    expect(planExecutionKickoffState("retry-session")).toMatchObject({
      status: "failed",
      attempts: 1,
      planPath: "/tmp/retry.md",
    })
    const warning = takePlanExecutionKickoffWarning("retry-session")
    expect(warning).toContain("host queue failed")
    expect(warning).toContain("remains active")
    expect(takePlanExecutionKickoffWarning("retry-session")).toBeUndefined()

    // A later explicit provider turn may retry after its own terminal boundary.
    expect(await flushPlanExecutionKickoff("retry-session", {
      cursorSessionID: "cursor-run-next",
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })).toBe(true)
    expect(attempts).toBe(2)
    expect(planExecutionKickoffState("retry-session")).toBeUndefined()
  })
})

describe("CreatePlan execution approval over a held-open Run", () => {
  function startPlan() {
    fs.mkdirSync(path.join(workspace, ".git"))
    setActiveCursorMode("create-plan-opencode-session", "plan")
    return runCreatePlan(
      [createPlanPayload({
        name: "Held Plan",
        overview: "Approve before executing",
        plan: "## Approach\n\nImplement it.\n",
        todos: [],
      })],
      ["question", "read", "write", "todowrite"],
    )
  }

  it("shows the plan in the transcript before asking to approve it", async () => {
    // Cursor routes the plan body through the interaction query, never the text
    // stream, so the first version asked the user to approve a plan they had
    // not been shown. It goes in the assistant message, not the question: the
    // host renders the question dock outside its scrollbox.
    const { session, parts } = await startPlan()

    const text = parts
      .filter((part: any) => part.type === "text-delta")
      .map((part: any) => part.delta)
      .join("")
    expect(text).toContain("# Held Plan")
    expect(text).toContain("Implement it.")
    expect(text).toContain("Plan saved to ")

    // The plan is visible before the prompt, and the prompt itself stays short.
    const textIndex = parts.findIndex((part: any) => part.type === "text-delta")
    const callIndex = parts.findIndex((part: any) => part.type === "tool-call")
    expect(textIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeLessThan(callIndex)
    const question = JSON.parse(parts[callIndex].input).questions[0].question as string
    expect(question).not.toContain("Implement it.")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("holds Cursor open on the approval prompt, then reports success on Yes", async () => {
    const { session, writes, parts } = await startPlan()

    expect(writes).toHaveLength(0)
    const toolCall = parts.find((part: any) => part.type === "tool-call")
    expect(toolCall.toolName).toBe("question")
    expect(session.pending.size).toBe(1)
    const question = JSON.parse(toolCall.input).questions[0].question as string
    expect(question).toContain("Would you like to switch to the build agent")

    const kickoffs: Array<{ sessionID: string; planPath: string }> = []
    setPlanExecutionKickoff((input) => {
      kickoffs.push(input)
    })

    let delivering = true
    deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: `User has answered your questions: "${question}"="Yes". You can now continue.`,
    }] as any)

    // Continuation delivery only records the kickoff. The host prompt cannot run
    // until doStream has returned and its outer boundary flushes the request.
    expect(kickoffs).toEqual([])
    delivering = false
    await flushPlanExecutionKickoff("create-plan-opencode-session", {
      cursorSessionID: session.sessionId,
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })
    expect(delivering).toBe(false)

    expect(writes).toHaveLength(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(result.plan_uri).toMatch(/^file:\/\//)
    const absolute = decodeURIComponent(new URL(result.plan_uri).pathname)
    expect(fs.existsSync(absolute)).toBe(true)
    expect(kickoffs).toEqual([{
      sessionID: "create-plan-opencode-session",
      planPath: absolute,
      cursorSessionID: session.sessionId,
    }])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("does not queue a provider kickoff for a successful host stage", async () => {
    const writes: Uint8Array[] = []
    const session = planSession([], writes, ["cursor_plan_stage"])
    sessionManager.registerPending(
      900_000,
      session,
      "create_plan_request_response",
      "cursor_plan_stage",
      false,
      {
        interactionId: 42,
        createPlanBridgeKind: "stage",
        planUri: "local://native-plan.md",
        planPath: "/tmp/native-plan.md",
        workspaceRoot: workspace,
      },
    )
    const kickoffs: Array<{ sessionID: string; planPath: string }> = []
    setPlanExecutionKickoff(input => { kickoffs.push(input) })

    deliverContinuationResults(session, [{
      toolCallId: "stage-call",
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "cursor_plan_stage",
      output: "Plan approved by host stage",
    }] as any)
    await flushPlanExecutionKickoff("create-plan-opencode-session", {
      cursorSessionID: session.sessionId,
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })

    expect(writes).toHaveLength(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(result.plan_uri).toBe("local://native-plan.md")
    expect(kickoffs).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("fails closed when no host kickoff exists and retains plan mode", async () => {
    const { session, writes, parts } = await startPlan()
    const toolCall = parts.find((part: any) => part.type === "tool-call")
    const question = JSON.parse(toolCall.input).questions[0].question as string
    // No handler models OpenCode 2.0, whose public SessionDomain cannot select
    // the build agent for a faithful plan_exit-shaped prompt.
    setPlanExecutionKickoff(undefined)

    deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: `User has answered your questions: "${question}"="Yes". You can now continue.`,
    }] as any)

    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeUndefined()
    expect(result.error.error).toContain("cannot start its execution turn")
    expect(result.plan_uri).toMatch(/^file:\/\//)
    expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
    expect(planExecutionKickoffState("create-plan-opencode-session")).toBeUndefined()
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("reports the plan as not accepted on No, so the model keeps planning", async () => {
    const { session, writes, parts } = await startPlan()
    const toolCall = parts.find((part: any) => part.type === "tool-call")
    const question = JSON.parse(toolCall.input).questions[0].question as string

    const kickoffs: Array<{ sessionID: string; planPath: string }> = []
    setPlanExecutionKickoff((input) => {
      kickoffs.push(input)
    })

    deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: `User has answered your questions: "${question}"="No". You can now continue.`,
    }] as any)

    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeUndefined()
    expect(result.error.error).toBe(CREATE_PLAN_NOT_APPROVED_REASON)
    expect(result.plan_uri).toBe("")
    await flushPlanExecutionKickoff("create-plan-opencode-session", {
      cursorSessionID: session.sessionId,
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })
    expect(kickoffs).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })
})
