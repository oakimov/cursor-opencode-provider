import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  CREATE_PLAN_HOST_PLAN_PENDING_REASON,
  CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON,
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
  getActiveCursorMode,
  isCursorPlanModeActive,
  resetActiveCursorModesForTests,
  setActiveCursorMode,
} from "../src/protocol/switch-mode.js"
import { deliverContinuationResults, preparePriorSessionForFreshTurn, pump } from "../src/language-model.js"
import { resetHostPlanFilesForTests, setHostPlanFile } from "../src/host-plan-file.js"
import {
  flushHostAgentModeSwitch,
  resetHostAgentModeSwitchForTests,
  setHostAgentModeSwitch,
} from "../src/host-agent-mode.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  hostGlobalDataDir,
  hostPlansDir,
  setNativePlansDir,
  HOST_PATH_BRIDGE,
  type OpenCodePathBridge,
} from "../src/context/paths.js"

let workspace: string
let sandboxHome: string
let previousHome: string | undefined
let previousXdgData: string | undefined
let previousBridge: unknown

beforeEach(() => {
  setNativePlansDir(undefined)
  resetActiveCursorModesForTests()
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
  setNativePlansDir(undefined)
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
      resolveCreatePlanBridge({ allowTools: true, canStage: true, advertised }),
    ).toEqual({ kind: "stage" })
  })

  it("emulates the approval with `question` when no stage or plan_exit tool exists", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: true, planModeActive: true, advertised }),
    ).toEqual({ kind: "approve" })
    expect(
      resolveCreatePlanBridge({ allowTools: true, hostAgent: "plan", advertised }),
    ).toEqual({ kind: "approve" })
  })

  it("acknowledges without a prompt when nothing can ask, or outside plan mode", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: true, planModeActive: true, advertised: ["read"] }),
    ).toEqual({ kind: "ack" })
    expect(resolveCreatePlanBridge({ allowTools: true, advertised })).toEqual({ kind: "ack" })
    expect(
      resolveCreatePlanBridge({ allowTools: true, hostAgent: "build", advertised: [...advertised, "plan_exit"] }),
    ).toEqual({ kind: "ack" })
  })

  it("never writes or prompts from a no-tool lifecycle turn", () => {
    expect(
      resolveCreatePlanBridge({ allowTools: false, canStage: true, advertised }),
    ).toEqual({ kind: "ack" })
    expect(
      resolveCreatePlanBridge({ allowTools: false, hostPlanEntryPending: true, advertised }),
    ).toEqual({ kind: "ack" })
  })

  it("defers while an approved switch into the host plan agent is pending", () => {
    expect(
      resolveCreatePlanBridge({
        allowTools: true,
        canStage: true,
        hostPlanEntryPending: true,
        advertised,
      }),
    ).toEqual({ kind: "defer", reason: CREATE_PLAN_HOST_PLAN_PENDING_REASON })
  })

  it("carries CreatePlan out as the host plan_exit review on the host's own plan file", () => {
    expect(
      resolveCreatePlanBridge({
        allowTools: true,
        hostAgent: "plan",
        hostPlanFile: "/repo/.opencode/plans/17-x.md",
        advertised: [...advertised, "plan_exit"],
      }),
    ).toEqual({ kind: "exit", planPath: "/repo/.opencode/plans/17-x.md" })
    // Without a host plan location the host's own workflow records the plan.
    expect(
      resolveCreatePlanBridge({
        allowTools: true,
        hostAgent: "plan",
        advertised: [...advertised, "plan_exit"],
      }),
    ).toEqual({ kind: "defer", reason: CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON })
    // A pending switch into the plan agent still comes first.
    expect(
      resolveCreatePlanBridge({
        allowTools: true,
        hostPlanEntryPending: true,
        hostAgent: "build",
        hostPlanFile: "/repo/.opencode/plans/17-x.md",
        advertised: [...advertised, "plan_exit"],
      }),
    ).toEqual({ kind: "defer", reason: CREATE_PLAN_HOST_PLAN_PENDING_REASON })
    // A host stage tool still owns the review, and without plan_exit the plan
    // agent has no host review to defer to.
    expect(
      resolveCreatePlanBridge({
        allowTools: true,
        canStage: true,
        hostAgent: "plan",
        advertised: [...advertised, "plan_exit"],
      }),
    ).toEqual({ kind: "stage" })
    // Outside the host plan agent, plan_exit is not a review of this plan.
    expect(
      resolveCreatePlanBridge({
        allowTools: true,
        hostAgent: "build",
        advertised: [...advertised, "plan_exit"],
      }),
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
    expect(createPlanApproved(
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      false,
      createPlanApprovalQuestion("/plans/99-other.md"),
    )).toBe(false)
  })

  it("approves an OpenCode 2 JSON Yes that does not echo the prompt", () => {
    expect(createPlanApproved(JSON.stringify({ answers: [["Yes"]] }), false, question)).toBe(true)
    expect(createPlanApproved(JSON.stringify({ answers: [["No"]] }), false, question)).toBe(false)
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

    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.createPlan?.toolName).toBe("question")
    expect(handled.createPlan?.bridge.kind).toBe("approve")

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

  it("writes nothing and tells the model to wait when host plan entry is pending", () => {
    setActiveCursorMode("plan-session", "plan")
    const payload = createPlanPayload({
      name: "Early Plan",
      overview: "Raised before the host plan agent took over",
      plan: "## Approach\n\nDo the work.\n",
      todos: [],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      hostPlanEntryPending: true,
      hostAgent: "build",
      advertisedTools: ["question", "read", "write"],
    })
    expect(handled.outcome).toBe("failed")
    expect(handled.createPlan).toBeUndefined()
    const result = decodeMessage<any>("AgentClientMessage", handled.reply!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(CREATE_PLAN_HOST_PLAN_PENDING_REASON)
    expect(result.plan_uri).toBe("")
    expect(fs.existsSync(hostPlansDir(workspace))).toBe(false)
  })

  it("points CreatePlan at the host plan workflow inside the host plan agent", () => {
    setActiveCursorMode("plan-session", "plan")
    const payload = createPlanPayload({
      name: "Host Plan",
      overview: "Host plan agent owns the file",
      plan: "## Approach\n\nDo the work.\n",
      todos: [],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      hostAgent: "plan",
      advertisedTools: ["question", "read", "write", "plan_exit"],
    })
    expect(handled.outcome).toBe("failed")
    const result = decodeMessage<any>("AgentClientMessage", handled.reply!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON)
    expect(fs.existsSync(hostPlansDir(workspace))).toBe(false)
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
    billing: { key: "run:test", prefixTokens: 0 },
  } as unknown as CursorSession
}

async function runCreatePlan(payloads: Uint8Array[], advertised: string[]) {
  const writes: Uint8Array[] = []
  const parts: any[] = []
  const session = planSession(payloads, writes, advertised)
  await pump(
    session,
    { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
    { textId: "text", reasoningId: "reasoning" },
  )
  return { session, writes, parts }
}

describe("CreatePlan writes the session's own plan file", () => {
  afterEach(() => resetHostPlanFilesForTests())

  it("records the plan at the known session plan file", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const hostPlanFile = path.join(workspace, ".opencode", "plans", "21-quiet-owl.md")
    setHostPlanFile("create-plan-opencode-session", hostPlanFile)
    const writes: Uint8Array[] = []
    const parts: any[] = []
    // No plan_exit advertised: emulated Yes/No review through `question`.
    const session = planSession(
      [
        createPlanPayload({ name: "Session Plan", overview: "o", plan: "## Steps\n\n1. Do it.\n", todos: [] }),
        encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } } }),
      ],
      writes,
      ["question", "read", "write"],
    )
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    expect(fs.readFileSync(hostPlanFile, "utf-8")).toContain("1. Do it.")
    const call = parts.find((part: any) => part.type === "tool-call")
    expect(call?.toolName).toBe("question")
    expect(JSON.parse(call.input).questions[0].question).toContain("Would you like to switch to the build agent")
    sessionManager.close(session, "ordinary-cleanup")
  })
})

describe("CreatePlan through the host plan agent's plan_exit review", () => {
  afterEach(() => resetHostPlanFilesForTests())

  async function startHostPlan() {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const hostPlanFile = path.join(workspace, ".opencode", "plans", "17-calm-wizard.md")
    setHostPlanFile("create-plan-opencode-session", hostPlanFile)
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = planSession(
      [createPlanPayload({ name: "Host Plan", overview: "o", plan: "## Steps\n\n1. Do it.\n", todos: [] })],
      writes,
      ["question", "read", "write", "plan_exit"],
    )
    ;(session as { hostAgent?: string }).hostAgent = "plan"
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    return { session, writes, parts, hostPlanFile }
  }

  async function deliver(session: CursorSession, toolCallId: string, hostAgent: string, output: string) {
    return deliverContinuationResults(session, [{
      toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "plan_exit",
      output,
    }] as any, { hostAgent })
  }

  it("writes the plan at the host plan file, shows it, then raises the host plan_exit", async () => {
    const { session, writes, parts, hostPlanFile } = await startHostPlan()
    expect(fs.readFileSync(hostPlanFile, "utf-8")).toContain("1. Do it.")
    const textIndex = parts.findIndex((part: any) => part.type === "text-delta")
    const callIndex = parts.findIndex((part: any) => part.type === "tool-call")
    expect(textIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeLessThan(callIndex)
    expect(parts[callIndex].toolName).toBe("plan_exit")
    expect(JSON.parse(parts[callIndex].input)).toEqual({})
    // Cursor waits on the host review.
    expect(writes).toHaveLength(0)
    expect(session.pending.size).toBe(1)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("reports approval when the host leaves its plan agent", async () => {
    const { session, writes, parts, hostPlanFile } = await startHostPlan()
    const call = parts.find((part: any) => part.type === "tool-call")
    await deliver(session, call.toolCallId, "build", "User approved switching to build agent. Wait for further instructions.")
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(decodeURIComponent(new URL(result.plan_uri).pathname)).toBe(hostPlanFile)
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("agent")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("keeps planning with the host's own words when the session stays in plan", async () => {
    const { session, writes, parts } = await startHostPlan()
    const call = parts.find((part: any) => part.type === "tool-call")
    const refine = "User chose to stay in plan mode and continue refining the plan."
    await deliver(session, call.toolCallId, "plan", refine)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(refine)
    expect(result.plan_uri).toBe("")
    expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
    sessionManager.close(session, "ordinary-cleanup")
  })
})

describe("deferred CreatePlan display", () => {
  function display(kind: "started" | "completed", callId: string): Uint8Array {
    const key = kind === "started" ? "tool_call_started" : "tool_call_completed"
    return encodeMessage("AgentServerMessage", {
      interaction_update: {
        [key]: {
          call_id: callId,
          tool_call: {
            create_plan_tool_call: {
              args: { name: "Host Plan", overview: "o", plan: "1. A", todos: [{ id: "t1", content: "A", status: 1 }] },
            },
          },
        },
      },
    })
  }

  it("does not mirror the todos of a plan the host plan agent records instead", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const payload = createPlanPayload({ name: "Host Plan", overview: "o", plan: "1. A", todos: [] })
    const session = planSession(
      [
        display("started", "tool_plan"),
        payload,
        display("completed", "tool_plan"),
        encodeMessage("AgentServerMessage", {
          interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
        }),
      ],
      writes,
      ["question", "read", "write", "todowrite", "plan_exit"],
    )
    ;(session as { hostAgent?: string }).hostAgent = "plan"
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON)
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(session.deferredCreatePlanCalls?.size ?? 0).toBe(0)
    sessionManager.close(session, "ordinary-cleanup")
  })
})

describe("CreatePlan execution approval over a held-open Run", () => {
  afterEach(() => resetHostAgentModeSwitchForTests())

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
    const { session, parts } = await startPlan()

    const text = parts
      .filter((part: any) => part.type === "text-delta")
      .map((part: any) => part.delta)
      .join("")
    expect(text).toContain("# Held Plan")
    expect(text).toContain("Implement it.")
    expect(text).toContain("Plan saved to ")

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

    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })

    await deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: `User has answered your questions: "${question}"="Yes". You can now continue.`,
    }] as any, { hostAgent: "plan" })

    await flushHostAgentModeSwitch("create-plan-opencode-session", {
      cursorSessionID: session.sessionId,
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })

    expect(writes).toHaveLength(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(result.plan_uri).toMatch(/^file:\/\//)
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("agent")
    expect(switched).toEqual(["agent"])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("honors a Yes that arrived as history under a later host note instead of cancelling it", async () => {
    const { session, writes, parts } = await startPlan()
    const toolCall = parts.find((part: any) => part.type === "tool-call")
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    session.pumpActive = false
    session.pumpOwner = null

    await preparePriorSessionForFreshTurn(session.openCodeSessionId, {
      timeoutMs: 50,
      toolResults: [{
        toolCallId: toolCall.toolCallId,
        sessionId: session.sessionId,
        execId: 900_000,
        toolName: "question",
        output: JSON.stringify({ answers: [["Yes"]] }),
      }],
      hostAgent: "plan",
    })

    expect(session.pending.size).toBe(0)
    expect(writes).toHaveLength(1)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("agent")
    await flushHostAgentModeSwitch("create-plan-opencode-session", {
      cursorSessionID: session.sessionId,
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })
    expect(switched).toEqual(["agent"])
    if (!session.closed) sessionManager.close(session, "ordinary-cleanup")
  })

  it("keeps planning when the user answers No", async () => {
    const { session, writes, parts } = await startPlan()
    const toolCall = parts.find((part: any) => part.type === "tool-call")
    const question = JSON.parse(toolCall.input).questions[0].question as string
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })

    await deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId: 900_000,
      toolName: "question",
      output: `User has answered your questions: "${question}"="No". You can now continue.`,
    }] as any, { hostAgent: "plan" })

    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(CREATE_PLAN_NOT_APPROVED_REASON)
    expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
    expect(switched).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })
})

describe("CreatePlan approval delivery failure", () => {
  afterEach(() => resetHostAgentModeSwitchForTests())

  it("keeps planning and queues no execution when delivering Yes fails", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const session = planSession([], [], ["question"])
    sessionManager.registerPending(900_000, session, "create_plan_request_response", "question", false, {
      interactionId: 42,
      createPlanBridgeKind: "approve",
      createPlanQuestion: "Approve this plan?",
      planUri: "file:///plans/review.md",
    })
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    session.stream.write = () => { throw new Error("transport closed") }
    expect(await deliverContinuationResults(session, [{
      toolCallId: "approval", sessionId: session.sessionId, execId: 900_000,
      toolName: "question", output: JSON.stringify({ answers: [["Yes"]] }),
    }])).toBeUndefined()
    expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
    return flushHostAgentModeSwitch(session.openCodeSessionId, {
      cursorSessionID: session.sessionId,
      terminal: true,
    }).then(flushed => {
      expect(flushed).toBe(false)
      expect(switched).toEqual([])
    })
  })
})

describe("CreatePlan through a host plan-stage tool", () => {
  function stageSession(writes: Uint8Array[]) {
    const session = planSession([], writes, ["cursor_plan_stage"])
    sessionManager.registerPending(900_000, session, "create_plan_request_response", "cursor_plan_stage", false, {
      interactionId: 42,
      createPlanBridgeKind: "stage",
      planUri: "local://native-plan.md",
    })
    return session
  }

  it("reports approval when the host stage succeeds", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = stageSession(writes)
    await deliverContinuationResults(session, [{
      toolCallId: "stage-call", sessionId: session.sessionId, execId: 900_000,
      toolName: "cursor_plan_stage", output: "Plan approved by host stage",
    }] as any)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(result.plan_uri).toBe("local://native-plan.md")
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("agent")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("keeps planning when delivering a successful stage reply fails", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const session = stageSession([])
    session.stream.write = () => { throw new Error("transport closed") }
    expect(await deliverContinuationResults(session, [{
      toolCallId: "stage-call", sessionId: session.sessionId, execId: 900_000,
      toolName: "cursor_plan_stage", output: "Plan approved by host stage",
    }])).toBeUndefined()
    expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
  })

  it("keeps planning with the host's reason when the stage review is declined", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = stageSession(writes)
    await deliverContinuationResults(session, [{
      toolCallId: "stage-call", sessionId: session.sessionId, execId: 900_000,
      toolName: "cursor_plan_stage", output: "", error: "Plan refinement requested.",
    }] as any)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeUndefined()
    expect(result.error.error).toBe("Plan refinement requested.")
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("plan")
    sessionManager.close(session, "ordinary-cleanup")
  })
})
