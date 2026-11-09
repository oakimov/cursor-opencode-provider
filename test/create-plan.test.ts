import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as debug from "../src/debug.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createCursor } from "../src/index.js"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { pathToFileURL } from "node:url"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { readAllFields } from "../src/protocol/struct.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import { OPENCODE_1_TOOL_DIALECT, OPENCODE_2_TOOL_DIALECT } from "../src/protocol/tools.js"
import {
  CREATE_PLAN_HOST_PLAN_PENDING_REASON,
  CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON,
  CREATE_PLAN_NOT_APPROVED_REASON,
  createPlanSessionEditsDeniedReason,
  createPlanApprovalOutcome,
  createPlanApprovalQuestion,
  createPlanApproved,
  createPlanRefineReason,
  createPlanStageInput,
  buildPlanPersistenceCall,
  decodeCreatePlanQuery,
  prepareCreatePlanFile,
  renderOpencodePlanMarkdown,
  resolveCreatePlanBridge,
  resolveHostPlanPath,
  resolvePlanPersistence,
  slugifyPlanName,
  writeOpencodePlanFile,
} from "../src/protocol/create-plan.js"
import {
  clearPlanOperations,
  incompletePlanOperations,
  planOperationsFor,
  recordPlanOperation,
  resetPlanOperationsForTests,
  restorePlanOperations,
  serializePlanOperations,
  updatePlanOperationConsumed,
} from "../src/protocol/plan-operations.js"
import {
  getActiveCursorMode,
  isCursorPlanModeActive,
  resetActiveCursorModesForTests,
  setActiveCursorMode,
} from "../src/protocol/switch-mode.js"
import {
  deliverContinuationResults,
  extractTrailingToolResults,
  preparePriorSessionForFreshTurn,
  pump,
  releaseHostNoteInjectionsForTests,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { resetHostPlanFilesForTests, setHostPlanFile } from "../src/host-plan-file.js"
import {
  flushHostAgentModeSwitch,
  resetHostAgentModeSwitchForTests,
  setHostAgentModeSwitch,
} from "../src/host-agent-mode.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"
import { restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { setConversationPersistenceHookForTests, waitForConversationMaintenanceForTests } from "../src/protocol/conversation-persistence.js"
import {
  hostGlobalDataDir,
  getHostCacheDirOverride,
  hostPlansDir,
  setNativePlansDir,
  setHostCacheDirOverride,
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

function createPlanPayload(args: Record<string, unknown>, id = 42, toolCallId = "tool_plan"): Uint8Array {
  const query = encodeMessage("CreatePlanRequestQuery", {
    args,
    tool_call_id: toolCallId,
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

  it("holds execution when a session edit deny would otherwise approve, exit, or ack", () => {
    const denied = { allowTools: true, sessionEditsDenied: true, advertised }
    expect(resolveCreatePlanBridge({ ...denied, planModeActive: true })).toEqual({ kind: "hold" })
    expect(resolveCreatePlanBridge({ ...denied, hostAgent: "plan" })).toEqual({ kind: "hold" })
    expect(resolveCreatePlanBridge({
      ...denied,
      hostAgent: "plan",
      hostPlanFile: "/repo/.opencode/plans/17-x.md",
      advertised: [...advertised, "plan_exit"],
    })).toEqual({ kind: "hold" })
    expect(resolveCreatePlanBridge(denied)).toEqual({ kind: "hold" })
    // A host stage still reviews. A pending plan handoff and a lifecycle turn do not write.
    expect(resolveCreatePlanBridge({ ...denied, canStage: true })).toEqual({ kind: "stage" })
    expect(resolveCreatePlanBridge({ ...denied, hostPlanEntryPending: true })).toEqual({
      kind: "defer",
      reason: CREATE_PLAN_HOST_PLAN_PENDING_REASON,
    })
    expect(resolveCreatePlanBridge({ ...denied, allowTools: false })).toEqual({ kind: "ack" })
  })
})

describe("createPlanApprovalOutcome", () => {
  const question = createPlanApprovalQuestion("/plans/42-demo.md")

  it("approves only on an explicit Yes", () => {
    expect(createPlanApprovalOutcome(
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      false,
      question,
    )).toEqual({ kind: "approved" })
    expect(createPlanApproved(
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      false,
      question,
    )).toBe(true)
  })

  it("declines No, unanswered, dismissed, failed, and bare Other", () => {
    expect(createPlanApprovalOutcome(
      `User has answered your questions: "${question}"="No". You can now continue.`,
      false,
      question,
    )).toEqual({ kind: "declined" })
    expect(createPlanApprovalOutcome("", false, question)).toEqual({ kind: "declined" })
    expect(createPlanApprovalOutcome("permission denied", true, question)).toEqual({ kind: "declined" })
    expect(createPlanApprovalOutcome(
      `User has answered your questions: "${question}"="Other". You can now continue.`,
      false,
      question,
    )).toEqual({ kind: "declined" })
    expect(createPlanApproved(
      `User has answered your questions: "${question}"="No". You can now continue.`,
      false,
      question,
    )).toBe(false)
  })

  it("treats typed freeform text as refine feedback", () => {
    expect(createPlanApprovalOutcome(
      `User has answered your questions: "${question}"="Add a rollback step". You can now continue.`,
      false,
      question,
    )).toEqual({ kind: "refine", feedback: "Add a rollback step" })
    expect(createPlanApprovalOutcome(
      JSON.stringify({ answers: [["Please cover error handling too"]] }),
      false,
      question,
    )).toEqual({ kind: "refine", feedback: "Please cover error handling too" })
    expect(createPlanRefineReason("Add a rollback step")).toContain("Add a rollback step")
    expect(createPlanRefineReason("Add a rollback step")).not.toContain("End this turn")
  })

  it("preserves an echoed review question inside feedback instead of approving its prefix", () => {
    const feedback = `Yes", "${question}"="No, add rollback coverage`
    const output = `User has answered your questions: "${question}"="${feedback}". You can now continue with the user's answers in mind.`
    expect(createPlanApprovalOutcome(output, false, question)).toEqual({ kind: "refine", feedback })
  })

  it("fails closed on malformed or ambiguous single-choice JSON answers", () => {
    for (const answers of [
      [["Yes", null]], [["Yes", "No"]], [["No", "Revise"]],
      [true], [123], [["Yes"], ["No"]], [[{ value: "Yes" }]],
    ]) {
      expect(createPlanApprovalOutcome(JSON.stringify({ answers }), false, question))
        .toEqual({ kind: "declined" })
    }
    for (const output of ['{"answers":', JSON.stringify({ other: "feedback" }), "[null]"]) {
      expect(createPlanApprovalOutcome(output, false, question)).toEqual({ kind: "declined" })
    }
  })

  it("does not approve when the echoed prompt is not the one that was asked", () => {
    expect(createPlanApprovalOutcome(
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      false,
      createPlanApprovalQuestion("/plans/99-other.md"),
    )).toEqual({ kind: "declined" })
  })

  it("approves an OpenCode 2 JSON Yes that does not echo the prompt", () => {
    expect(createPlanApprovalOutcome(JSON.stringify({ answers: [["Yes"]] }), false, question))
      .toEqual({ kind: "approved" })
    expect(createPlanApprovalOutcome(JSON.stringify({ answers: [["No"]] }), false, question))
      .toEqual({ kind: "declined" })
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
  it("returns a typed failure without a review when a denied plan cannot be prepared", () => {
    const payload = createPlanPayload({ name: "Denied Plan", plan: "Keep this plan" })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    // Empty workspace root fails before any host write is emitted.
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: "",
      allowTools: true,
      sessionEditsDenied: true,
      advertisedTools: ["write"],
    })
    const result = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response.create_plan_request_response.result
    expect(handled.outcome).toBe("failed")
    expect(handled.endTurn).toBe(true)
    expect(handled.planReview).toBeUndefined()
    expect(handled.createPlan).toBeUndefined()
    expect(result.success).toBeUndefined()
    expect(result.error.error).toContain("requires a workspace root")
  })

  it("refuses CreatePlan when no write or patch tool is advertised", () => {
    const payload = createPlanPayload({ name: "No Writer", plan: "Cannot save" })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      advertisedTools: ["read", "question"],
    })
    const result = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response.create_plan_request_response.result
    expect(handled.outcome).toBe("failed")
    expect(handled.createPlan).toBeUndefined()
    expect(result.error.error).toContain("write or patch tool")
    expect(fs.existsSync(hostPlansDir(workspace))).toBe(false)
  })

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

  it("bridges a host write under hostPlansDir without touching the filesystem yet", () => {
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
      advertisedTools: ["write", "read"],
    })
    expect(handled.outcome).toBe("bridged")
    expect(handled.reply).toBeUndefined()
    expect(handled.createPlan?.toolName).toBe("write")
    expect(handled.createPlan?.persistence?.afterWrite.kind).toBe("ack")
    expect(handled.createPlan?.planUri).toMatch(/^file:\/\//)
    const planPath = decodeURIComponent(new URL(handled.createPlan!.planUri!).pathname)
    expect(planPath.startsWith(path.join(hostGlobalDataDir(), "plans"))).toBe(true)
    expect(fs.existsSync(planPath)).toBe(false)
    expect(handled.createPlan!.persistence!.input.content).toContain("# Live Plan")
    expect(handled.createPlan!.persistence!.input.content).toContain("- [ ] Implement")
    expect(fs.existsSync(path.join(workspace, ".opencode"))).toBe(false)
    expect(fs.readdirSync(workspace)).toEqual([".git"])
  })

  it("targets a path outside the project directory for host persistence", () => {
    // The invariant behind this whole change: planning must not create
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
      advertisedTools: ["write"],
    })
    expect(handled.outcome).toBe("bridged")
    const planPath = decodeURIComponent(new URL(handled.createPlan!.planUri!).pathname)
    expect(planPath.startsWith(workspace + path.sep)).toBe(false)
    expect(fs.existsSync(path.join(workspace, ".opencode"))).toBe(false)
    expect(fs.readdirSync(workspace)).toEqual([".git"])
  })

  it("queues an approval review after the host write when plan mode is active", () => {
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
    expect(handled.createPlan?.toolName).toBe("write")
    expect(handled.createPlan?.bridge.kind).toBe("approve")
    expect(handled.createPlan?.persistence?.afterWrite).toEqual({ kind: "review", toolName: "question" })

    const planPath = decodeURIComponent(new URL(handled.createPlan!.planUri!).pathname)
    expect(fs.existsSync(planPath)).toBe(false)
    expect(handled.createPlan?.questionInput?.questions[0]?.question)
      .toBe(createPlanApprovalQuestion(planPath))
  })

  it("queues a host write acknowledgment when no plan mode is active", () => {
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
    expect(handled.outcome).toBe("bridged")
    expect(handled.createPlan?.toolName).toBe("write")
    expect(handled.createPlan?.persistence?.afterWrite.kind).toBe("ack")
    expect(handled.createPlan?.planUri).toMatch(/^file:\/\//)
  })

  it("prefers apply_patch when write is absent from the catalog", () => {
    const payload = createPlanPayload({
      name: "Patch Plan",
      overview: "GPT catalog",
      plan: "## Approach\n\nUse patch.\n",
      todos: [],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, {
      workspaceRoot: workspace,
      allowTools: true,
      planModeActive: true,
      advertisedTools: ["question", "read", "apply_patch"],
    })
    expect(handled.outcome).toBe("bridged")
    expect(handled.createPlan?.toolName).toBe("apply_patch")
    expect(handled.createPlan?.persistence?.input.patchText).toContain("*** Add File:")
  })

  it("writes nothing and tells the model to wait when host plan entry is pending", () => {
    setActiveCursorMode("plan-session", "plan")
    for (const sessionPermissionsUnavailable of [false, true]) {
      const payload = createPlanPayload({
        name: "Early Plan",
        overview: "Raised before the host plan agent took over",
        plan: "## Approach\n\nDo the work.\n",
        todos: [],
        tool_call_id: "early-plan-call",
      })
      const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
      const handled = handleInteractionQuery(query, payload, {
        workspaceRoot: workspace,
        allowTools: true,
        hostPlanEntryPending: true,
        hostAgent: "build",
        sessionPermissionsUnavailable,
        advertisedTools: ["question", "read", "write"],
      })
      expect(handled.outcome).toBe("failed")
      expect(handled.endTurn).toBeUndefined()
      expect(handled.deferredCreatePlanToolCallId).toBe("tool_plan")
      expect(handled.createPlan).toBeUndefined()
      const result = decodeMessage<any>("AgentClientMessage", handled.reply!)
        .interaction_response.create_plan_request_response.result
      expect(result.error.error).toBe(CREATE_PLAN_HOST_PLAN_PENDING_REASON)
      expect(result.plan_uri).toBe("")
      expect(fs.existsSync(hostPlansDir(workspace))).toBe(false)
    }
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
  return sessionFixture({
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
  })
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

/** Apply a bridged CreatePlan write/patch tool locally, deliver success, then pump the queued review. */
async function completePlanWrite(
  session: CursorSession,
  _writes: Uint8Array[],
  parts: any[],
  writeCall: { toolCallId: string; toolName: string; input: string },
): Promise<void> {
  const input = JSON.parse(writeCall.input) as Record<string, unknown>
  let filePath = typeof input.filePath === "string" ? input.filePath
    : typeof input.path === "string" ? input.path : undefined
  const content = typeof input.content === "string" ? input.content : undefined
  if (filePath && content !== undefined) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  } else if (typeof input.patchText === "string") {
    const patchText = input.patchText
    const add = patchText.match(/^\*\*\* Add File: (.+)$/m)
    filePath = add?.[1]?.trim() || filePath
    if (!filePath) throw new Error("CreatePlan patch is missing *** Add File: path")
    const lines = patchText.split("\n")
      .filter((line: string) => line.startsWith("+"))
      .map((line: string) => line.slice(1))
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, lines.join("\n"))
  }
  const execId = Number(writeCall.toolCallId.split("_").pop())
  await deliverContinuationResults(session, [{
    toolCallId: writeCall.toolCallId,
    sessionId: session.sessionId,
    execId,
    toolName: writeCall.toolName,
    output: filePath ? `Wrote ${filePath}` : "ok",
  }] as any)
  await pump(
    session,
    { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
    { textId: "text", reasoningId: "reasoning" },
  )
}

describe("CreatePlan host persistence routing", () => {
  afterEach(() => {
    resetHostPlanFilesForTests()
    resetPlanOperationsForTests()
  })

  it.each([
    { catalog: ["write", "apply_patch", "patch"], tool: "write" },
    { catalog: ["apply_patch", "patch", "read"], tool: "apply_patch" },
    { catalog: ["patch", "read", "question"], tool: "patch" },
  ] as const)("prefers $tool from $catalog", ({ catalog, tool }) => {
    const route = resolvePlanPersistence(catalog)
    expect(route.kind === "unsupported" ? null : route.toolName).toBe(tool)
  })

  it("builds write input and Add File patches without touching disk", () => {
    const prepared = prepareCreatePlanFile(
      { name: "Routing", overview: "o", plan: "## Steps\n\n1. Go.\n", todos: [], isProject: true },
      workspace,
      1,
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(fs.existsSync(prepared.planPath)).toBe(false)

    const write = buildPlanPersistenceCall(
      { kind: "write", toolName: "write", filePathKey: "filePath" },
      prepared.planPath,
      prepared.markdown,
    )
    expect(write.ok && write.input).toEqual({ filePath: prepared.planPath, content: prepared.markdown })

    for (const tool of ["apply_patch", "patch"] as const) {
      const call = buildPlanPersistenceCall(
        { kind: "patch", toolName: tool },
        prepared.planPath,
        prepared.markdown,
      )
      expect(call.ok).toBe(true)
      if (!call.ok) continue
      expect(call.input.patchText).toContain(`*** Add File: ${prepared.planPath}`)
      expect(String(call.input.patchText)).toContain("+## Steps")
    }
    expect(fs.existsSync(prepared.planPath)).toBe(false)
  })

  it("refuses lossy plan patches and reports a filesystem failure in the test writer", () => {
    const call = buildPlanPersistenceCall({ kind: "patch", toolName: "patch" }, "/workspace/plan.md", "CRLF\r\n")
    expect(call.ok).toBe(false)
    if (call.ok) throw new Error("Expected an unrepresentable patch")
    expect(call.error).toContain("carriage returns")
    const parent = path.join(workspace, "blocked")
    fs.writeFileSync(parent, "keep")
    const result = writeOpencodePlanFile({ name: "Blocked", overview: "", plan: "Steps.", todos: [], isProject: false }, workspace, 1, path.join(parent, "plan.md"))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected a filesystem error")
    expect(result.error).toContain("Failed to write plan file")
    expect(fs.readFileSync(parent, "utf8")).toBe("keep")
  })

  it.each([false, true])("refuses empty content and an unrepresentable plan destination before mutation (deny=%s)", sessionEditsDenied => {
    for (const invalid of ["empty", "path"] as const) {
      const payload = createPlanPayload(invalid === "empty" ? { name: " ", plan: " " } : { name: "Plan", plan: "Steps." })
      const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
      const handled = handleInteractionQuery(query, payload, {
        workspaceRoot: workspace, allowTools: true, planModeActive: true, sessionEditsDenied,
        advertisedTools: ["patch", "question"], hostPlanFile: path.join(workspace, "invalid\nplan.md"),
      })
      expect(handled.outcome).toBe("failed")
      expect(handled.createPlan).toBeUndefined()
      const result = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response.create_plan_request_response.result
      expect(result.error.error).toContain(invalid === "empty" ? "no plan content" : "patch header")
      expect(handled.endTurn === true).toBe(sessionEditsDenied)
      expect(fs.readdirSync(workspace)).toEqual([])
    }
  })

  it("refuses incomplete restored plan operations without replaying mutation", () => {
    const key = "plan-ops-session"
    expect(recordPlanOperation(key, {
      interactionId: 1,
      hostCallId: "cursor_s_1",
      planPath: "/tmp/example/plan.md",
      planUri: "file:///tmp/example/plan.md",
      markdown: "# Plan\n",
      phase: "write",
      bridgeKind: "approve",
      afterWrite: "review",
      reviewToolName: "question",
    }).ok).toBe(true)
    const encoded = serializePlanOperations(key)
    clearPlanOperations(key)
    restorePlanOperations(key, encoded)
    expect(incompletePlanOperations(key)).toHaveLength(1)
    updatePlanOperationConsumed(key, "cursor_s_1", "s:1")
    expect(incompletePlanOperations(key)).toHaveLength(0)
  })
})

describe("CreatePlan full-pump host write and patch matrix", () => {
  afterEach(() => resetHostPlanFilesForTests())

  it.each([false, true])("refuses a writer before mutation when durable receipt admission is full (deny=%s)", async denied => {
    resetPlanOperationsForTests()
    const key = "create-plan-opencode-session"
    expect(Array.from({ length: 8 }, (_, i) => recordPlanOperation(key, {
      interactionId: i, hostCallId: `other-${i}`, planPath: "/workspace/plan.md", planUri: "file:///workspace/plan.md",
      markdown: "# Pending\n", phase: "write", bridgeKind: "approve",
    }).ok)).toEqual(Array(8).fill(true))
    setActiveCursorMode(key, "plan")
    const writes: Uint8Array[] = []
    const parts: LanguageModelV3StreamPart[] = []
    const session = planSession([
      createPlanPayload({ name: "Budget", plan: "Do not write." }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], writes, ["write", "question"])
    session.sessionEditsDenied = denied || undefined
    try {
      await pump(session, { enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        { textId: "budget", reasoningId: "r" })
      expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
      const reply = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes)).find(message => message.interaction_response)
      expect(reply.interaction_response.create_plan_request_response.result.error.error).toContain("operation budget is full")
      expect(planOperationsFor(key)).toHaveLength(8)
      expect(fs.readdirSync(workspace)).toEqual([])
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it.each(["budget", "review"] as const)("retains fail-closed state when the %s refusal cannot be delivered", async phase => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const parts: LanguageModelV3StreamPart[] = []
    const session = planSession([createPlanPayload({ name: "Reply failure", plan: "No implementation." })], writes, ["write", "question"])
    const controller = { enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error() {} }
    try {
      if (phase === "budget") {
        expect(Array.from({ length: 8 }, (_, i) => recordPlanOperation(session.openCodeSessionId, {
          interactionId: i, hostCallId: `call-${i}`, planPath: "/workspace/plan.md", planUri: "file:///workspace/plan.md",
          markdown: "# Pending\n", phase: "write", bridgeKind: "approve",
        }).ok)).toEqual(Array(8).fill(true))
      } else {
        await pump(session, controller as ReadableStreamDefaultController<LanguageModelV3StreamPart>, { textId: "write", reasoningId: "r" })
        const call = parts.find(part => part.type === "tool-call")
        if (!call || call.type !== "tool-call") throw new Error("Expected a host writer")
        await deliverContinuationResults(session, [{
          toolCallId: call.toolCallId, sessionId: session.sessionId, execId: Number(call.toolCallId.split("_").pop()), toolName: "write", output: "Saved",
        }])
        session.permittedToolNames = new Set(["write"])
      }
      session.stream.write = () => { throw new Error("transport closed") }
      await expect(pump(session, controller as ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        { textId: "refusal", reasoningId: "r" })).rejects.toThrow()
      expect(parts.filter(part => part.type === "tool-call" && part.toolName === "question")).toHaveLength(0)
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(phase === "budget" ? 8 : 1)
      expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it("acknowledges a saved plan outside plan mode without approving implementation", async () => {
    resetPlanOperationsForTests()
    const { session, writes, parts } = await runCreatePlan([
      createPlanPayload({ name: "Record", plan: "Just save this." }),
    ], ["write", "question"])
    const call = parts.find(part => part.type === "tool-call")
    try {
      await deliverContinuationResults(session, [{
        toolCallId: call.toolCallId, sessionId: session.sessionId, execId: Number(call.toolCallId.split("_").pop()),
        toolName: "write", output: "Saved",
      }])
      const reply = decodeMessage<any>("AgentClientMessage", writes.at(-1)!).interaction_response.create_plan_request_response.result
      expect(reply.success).toBeDefined()
      expect(reply.plan_uri).toStartWith("file://")
      expect(session.queuedCreatePlanAction).toBeUndefined()
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(0)
      expect(getActiveCursorMode(session.openCodeSessionId)).toBeUndefined()
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it.each(["write", "review"] as const)("fails closed when the %s continuation loses its interaction identity", async phase => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const { session, writes, parts } = await runCreatePlan([
      createPlanPayload({ name: "Corruption", plan: "Do not approve an uncorrelated plan." }),
    ], ["write", "question"])
    try {
      if (phase === "review") {
        const writer = parts.find(part => part.type === "tool-call")
        await completePlanWrite(session, writes, parts, writer)
      }
      const call = parts.filter(part => part.type === "tool-call").at(-1)
      const execId = Number(call.toolCallId.split("_").pop())
      const pending = session.pending.get(execId)!
      delete pending.resultMetadata!.interactionId
      expect(await deliverContinuationResults(session, [{
        toolCallId: call.toolCallId, sessionId: session.sessionId, execId, toolName: call.toolName, output: "Yes",
      }])).toBeUndefined()
      expect(session.closed).toBe(true)
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(1)
      expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it("stops a failed live plan continuation before rebasing or resolving credentials", async () => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const previousCache = getHostCacheDirOverride()
    const { session, parts } = await runCreatePlan([createPlanPayload({ name: "Lost identity", plan: "Wait." })], ["write", "question"])
    const call = parts.find(part => part.type === "tool-call")
    delete session.pending.get(Number(call.toolCallId.split("_").pop()))!.resultMetadata!.interactionId
    let credentials = 0
    try {
      const model = createCursor({ name: "cursor", cacheDir: workspace, getAccessToken: async () => {
        credentials++
        throw new Error("A failed plan continuation must not open a Run")
      } }).languageModel("gpt-5")
      const { stream } = await model.doStream({
        headers: { "x-opencode-session-id": session.openCodeSessionId! },
        tools: [{ type: "function", name: "write", inputSchema: { type: "object" } }],
        prompt: [
          { role: "user", content: [{ type: "text", text: "Make a plan." }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "write", input: JSON.parse(call.input) }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "write", output: { type: "text", value: "Saved" } }] },
        ],
      })
      const output: LanguageModelV3StreamPart[] = []
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        output.push(value)
      }
      expect(output.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join("")).toContain("No implementation was approved")
      expect(credentials).toBe(0)
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(1)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
      setHostCacheDirOverride(previousCache)
      // The held Run skips hydration, so nothing else awaits the model's background cache setup.
      await waitForConversationMaintenanceForTests(workspace)
    }
  })

  it.each(["refusal", "interrupted"] as const)("reports a %s writer without offering implementation review", async failure => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const { session, writes, parts } = await runCreatePlan([createPlanPayload({ name: "Refused", plan: "Wait." })], ["write", "question"])
    const call = parts.find(part => part.type === "tool-call")
    try {
      await deliverContinuationResults(session, [{
        toolCallId: call.toolCallId, sessionId: session.sessionId, execId: Number(call.toolCallId.split("_").pop()), toolName: "write", output: "",
        ...(failure === "refusal" ? { refusal: "permission_denied" as const } : { interrupted: true }),
      }])
      const reply = decodeMessage<any>("AgentClientMessage", writes.at(-1)!).interaction_response.create_plan_request_response.result
      expect(reply.error.error).toBe(failure === "refusal" ? "permission_denied" : "Failed to write plan file")
      expect(session.queuedCreatePlanAction).toBeUndefined()
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(0)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it.each(["saved", "denied", "abandoned"] as const)("settles an owed plan writer before a fresh user turn: %s", async outcome => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const { session, writes, parts } = await runCreatePlan([
      createPlanPayload({ name: "History", plan: "Review the saved plan." }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], ["write", "question"])
    const call = parts.find(part => part.type === "tool-call")
    session.pumpActive = false
    session.pumpOwner = null
    try {
      const results = outcome === "abandoned" ? [] : [{
        toolCallId: call.toolCallId, sessionId: session.sessionId,
        execId: Number(call.toolCallId.split("_").pop()), toolName: "write", output: "Saved",
        ...(outcome === "denied" ? { error: "permission denied" } : {}),
      }]
      expect(await preparePriorSessionForFreshTurn(session.openCodeSessionId, { timeoutMs: 50, toolResults: results })).toBe("drained")
      const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes))
        .flatMap(message => message.interaction_response?.create_plan_request_response ? [message.interaction_response] : [])
      expect(replies).toHaveLength(1)
      expect(replies[0].id).toBe(42)
      expect(replies[0].create_plan_request_response.result.error.error)
        .toContain(outcome === "denied" ? "permission denied" : "new user turn")
      expect(session.queuedCreatePlanAction).toBeUndefined()
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(0)
      expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it("keeps a plan writer result under a native host note on its review continuation", async () => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const { session, writes, parts } = await runCreatePlan([
      createPlanPayload({ name: "Host note", plan: "Review after save." }),
    ], ["write", "question"])
    const call = parts.find(part => part.type === "tool-call")
    try {
      const results = extractTrailingToolResults([
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "write", output: { type: "text", value: "Saved" } }] },
        { role: "user", content: [{ type: "text", text: "<system-update>\nThe available skills changed.\n</system-update>" }] },
      ])
      expect(results).toHaveLength(1)
      await deliverContinuationResults(session, results)
      await pump(session, { enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        { textId: "review", reasoningId: "r" })
      expect(parts.filter(part => part.type === "tool-call" && part.toolName === "question")).toHaveLength(1)
      expect(writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes)).some(message => message.interaction_response)).toBe(false)
      expect(planOperationsFor(session.openCodeSessionId)[0]?.phase).toBe("review")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it("refuses a second parallel CreatePlan instead of losing its pending review", async () => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const parts: LanguageModelV3StreamPart[] = []
    const first = createPlanPayload({ name: "First", plan: "First plan." }, 41, "first-plan")
    const second = createPlanPayload({ name: "Second", plan: "Second plan." }, 42, "second-plan")
    const session = planSession([
      encodeMessage("AgentServerMessage", { interaction_update: { tool_requests_listed: { call_count: 2 } } }), first, second,
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], writes, ["write", "question"])
    const controller = { enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error() {} }
    try {
      await pump(session, controller as ReadableStreamDefaultController<LanguageModelV3StreamPart>, { textId: "parallel", reasoningId: "r" })
      expect(parts.filter(part => part.type === "tool-call" && part.toolName === "write")).toHaveLength(1)
      const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes))
        .flatMap(message => message.interaction_response?.create_plan_request_response ? [message.interaction_response] : [])
      expect(replies).toHaveLength(1)
      expect(replies[0].id).toBe(42)
      expect(replies[0].create_plan_request_response.result.error.error).toContain("pending CreatePlan")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it.each([
    { label: "write", tools: ["question", "read", "write"] as string[], hostTool: "write" },
    { label: "apply_patch", tools: ["question", "read", "apply_patch"] as string[], hostTool: "apply_patch" },
    { label: "patch", tools: ["question", "read", "patch"] as string[], hostTool: "patch" },
  ])("persists through $label then asks to implement", async ({ tools, hostTool }) => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const hostPlanFile = path.join(workspace, ".opencode", "plans", `matrix-${hostTool}.md`)
    setHostPlanFile("create-plan-opencode-session", hostPlanFile)
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = planSession(
      [createPlanPayload({
        name: `Matrix ${hostTool}`,
        overview: "o",
        plan: "## Steps\n\n1. Persist via host.\n",
        todos: [],
      })],
      writes,
      tools,
    )
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    expect(fs.existsSync(hostPlanFile)).toBe(false)
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe(hostTool)
    await completePlanWrite(session, writes, parts, writeCall)
    expect(fs.readFileSync(hostPlanFile, "utf-8")).toContain("Persist via host.")
    const review = parts.filter((part: any) => part.type === "tool-call").at(-1)
    expect(review?.toolName).toBe("question")
    expect(JSON.parse(review.input).questions[0].question).toContain(hostPlanFile)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it.each(["question", "plan_exit"] as const)("rechecks %s availability and edit denial after saving", async reviewTool => {
    for (const policy of ["removed", "deny", "declined"] as const) {
      resetPlanOperationsForTests()
      setActiveCursorMode("create-plan-opencode-session", "plan")
      setHostPlanFile("create-plan-opencode-session", path.join(workspace, "review-check.md"))
      const writes: Uint8Array[] = []
      const parts: LanguageModelV3StreamPart[] = []
      const session = planSession([
        createPlanPayload({ name: "Recheck", plan: "Wait for approval." }),
        encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
      ], writes, ["write", "read", reviewTool])
      session.hostAgent = "plan"
      const controller = { enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error() {} }
      try {
        await pump(session, controller as ReadableStreamDefaultController<LanguageModelV3StreamPart>, { textId: "first", reasoningId: "r" })
        const call = parts.find(part => part.type === "tool-call")
        if (!call || call.type !== "tool-call") throw new Error("Missing plan writer")
        if (policy === "removed") session.permittedToolNames = new Set(["write", "read"])
        if (policy === "deny") session.sessionEditsDenied = true
        if (policy === "declined") session.planReviewDeclined = true
        await deliverContinuationResults(session, [{
          toolCallId: call.toolCallId, sessionId: session.sessionId,
          execId: Number(call.toolCallId.split("_").pop()), toolName: call.toolName, output: "Saved",
        }], { sessionEditsDenied: policy === "deny" })
        await pump(session, controller as ReadableStreamDefaultController<LanguageModelV3StreamPart>, { textId: "second", reasoningId: "r2" })
        expect(parts.filter(part => part.type === "tool-call" && part.toolName === reviewTool)).toHaveLength(0)
        const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes))
          .flatMap(message => message.interaction_response?.create_plan_request_response ? [message.interaction_response.create_plan_request_response.result] : [])
        expect(replies).toHaveLength(1)
        expect(replies[0].error).toBeDefined()
        expect(replies[0].success).toBeUndefined()
        expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
      } finally {
        sessionManager.close(session, "ordinary-cleanup")
      }
    }
  })

  it.each(["tool_plan", ""])("retains the receipt and revokes the old checkpoint through write-to-review (display=%s)", async displayCallId => {
    resetPlanOperationsForTests()
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const { session, parts } = await runCreatePlan([
      createPlanPayload({ name: "Receipt", plan: "Review after save." }, 42, displayCallId),
    ], ["write", "question"])
    try {
      const call = parts.find(part => part.type === "tool-call")
      session.resumeCheckpoint = Uint8Array.of(1, 2, 3)
      await deliverContinuationResults(session, [{
        toolCallId: call.toolCallId, sessionId: session.sessionId,
        execId: Number(call.toolCallId.split("_").pop()), toolName: "write", output: "Saved",
      }])
      expect(planOperationsFor(session.openCodeSessionId)).toHaveLength(1)
      expect(planOperationsFor(session.openCodeSessionId)[0]?.phase).toBe("review")
      expect(session.resumeCheckpoint).toBeUndefined()
      expect(session.checkpointRevokedByHostResult).toBe(true)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it.each(["cancel", "supersede"] as const)("does not emit a plan writer after %s during receipt persistence", async outcome => {
    resetPlanOperationsForTests()
    const writes: Uint8Array[] = []
    const parts: LanguageModelV3StreamPart[] = []
    const session = planSession([createPlanPayload({ name: "Cancel", plan: "Save only while active." })], writes, ["write"])
    session.cacheDir = path.join(workspace, "cache")
    restoreConversationBinding(session.openCodeSessionId!, session.conversationId)
    const abort = new AbortController()
    setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") {
        if (outcome === "cancel") abort.abort()
        else restoreConversationBinding(session.openCodeSessionId!, "replacement-conversation")
      }
    })
    try {
      const pumping = pump(session, { enqueue(part: LanguageModelV3StreamPart) { parts.push(part) }, error() {} } as ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        { textId: "cancel", reasoningId: "r" }, abort.signal)
      if (outcome === "cancel") await pumping
      else await expect(pumping).rejects.toThrow("CreatePlan conversation was superseded")
      expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
    } finally {
      setConversationPersistenceHookForTests(undefined)
      sessionManager.close(session, "ordinary-cleanup")
      resetPlanOperationsForTests()
    }
  })

  it.each(["denied", "blocked parent"])("does not ask to implement when the host writer fails: %s", async failure => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const blockedParent = path.join(workspace, "not-a-directory")
    if (failure === "blocked parent") fs.writeFileSync(blockedParent, "unchanged")
    const hostPlanFile = failure === "blocked parent" ? path.join(blockedParent, "plan.md")
      : path.join(workspace, ".opencode", "plans", "writer-fail.md")
    setHostPlanFile("create-plan-opencode-session", hostPlanFile)
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = planSession(
      [createPlanPayload({ name: "Fail Write", plan: "## Steps\n\n1. No.\n", todos: [] })],
      writes,
      ["question", "read", "write"],
    )
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    const execId = Number(writeCall.toolCallId.split("_").pop())
    let writeError = "permission denied"
    if (failure === "blocked parent") {
      try { fs.mkdirSync(path.dirname(hostPlanFile), { recursive: true }) }
      catch (error) { writeError = String(error) }
      expect(writeError).not.toBe("permission denied")
    }
    await deliverContinuationResults(session, [{
      toolCallId: writeCall.toolCallId,
      sessionId: session.sessionId,
      execId,
      toolName: "write",
      output: "",
      error: writeError,
    }] as any)
    expect(parts.some((part: any) => part.type === "tool-call" && part.toolName === "question")).toBe(false)
    const reply = decodeMessage<any>("AgentClientMessage", writes.at(-1)!)
      .interaction_response.create_plan_request_response.result
    expect(reply.error.error).toContain(writeError)
    expect(fs.existsSync(hostPlanFile)).toBe(false)
    if (failure === "blocked parent") expect(fs.readFileSync(blockedParent, "utf8")).toBe("unchanged")
    sessionManager.close(session, "ordinary-cleanup")
  })
})

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
      ],
      writes,
      ["question", "read", "write"],
    )
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    await completePlanWrite(session, writes, parts, writeCall)
    expect(fs.readFileSync(hostPlanFile, "utf-8")).toContain("1. Do it.")
    const call = parts.filter((part: any) => part.type === "tool-call").at(-1)
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
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    await completePlanWrite(session, writes, parts, writeCall)
    return { session, writes, parts, hostPlanFile }
  }

  async function deliver(session: CursorSession, toolCallId: string, hostAgent: string, output: string) {
    const execId = Number(toolCallId.split("_").pop())
    return deliverContinuationResults(session, [{
      toolCallId,
      sessionId: session.sessionId,
      execId,
      toolName: "plan_exit",
      output,
    }] as any, { hostAgent })
  }

  it("writes the plan at the host plan file, shows it, then raises the host plan_exit", async () => {
    const { session, writes, parts, hostPlanFile } = await startHostPlan()
    expect(fs.readFileSync(hostPlanFile, "utf-8")).toContain("1. Do it.")
    const textIndex = parts.findIndex((part: any) => part.type === "text-delta")
    const reviewCall = parts.filter((part: any) => part.type === "tool-call").at(-1)
    const callIndex = parts.lastIndexOf(reviewCall)
    expect(textIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeLessThan(callIndex)
    expect(reviewCall.toolName).toBe("plan_exit")
    expect(JSON.parse(reviewCall.input)).toEqual({})
    // Cursor waits on the host review (write success sent no interaction reply).
    expect(writes).toHaveLength(0)
    expect(session.pending.size).toBe(1)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("reports approval when the host leaves its plan agent", async () => {
    const { session, writes, parts, hostPlanFile } = await startHostPlan()
    const call = parts.filter((part: any) => part.type === "tool-call").at(-1)
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
    const call = parts.filter((part: any) => part.type === "tool-call").at(-1)
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
  afterEach(() => {
    resetHostAgentModeSwitchForTests()
    resetTurnStateForTests()
  })

  async function startPlan() {
    fs.mkdirSync(path.join(workspace, ".git"))
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const started = await runCreatePlan(
      [createPlanPayload({
        name: "Held Plan",
        overview: "Approve before executing",
        plan: "## Approach\n\nImplement it.\n",
        todos: [],
      })],
      ["question", "read", "write", "todowrite"],
    )
    const writeCall = started.parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    await completePlanWrite(started.session, started.writes, started.parts, writeCall)
    return started
  }

  function reviewCall(parts: any[]) {
    return parts.filter((part: any) => part.type === "tool-call" && part.toolName === "question").at(-1)
  }

  async function deliverReview(
    session: CursorSession,
    toolCall: { toolCallId: string; toolName: string },
    output: string,
    delivery: { hostAgent?: string; sessionEditsDenied?: boolean; sessionPermissionsUnavailable?: boolean } = { hostAgent: "plan" },
  ) {
    const execId = Number(toolCall.toolCallId.split("_").pop())
    return deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId,
      toolName: toolCall.toolName,
      output,
    }] as any, delivery)
  }

  it("shows the plan in the transcript before asking to approve it", async () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = planSession(
      [
        encodeMessage("AgentServerMessage", {
          interaction_update: { text_delta: { text: "Plan mode is active." } },
        }),
        encodeMessage("AgentServerMessage", {
          interaction_update: { thinking_delta: { text: "CreatePlan is available." } },
        }),
        createPlanPayload({
          name: "Held Plan",
          overview: "Approve before executing",
          plan: "## Approach\n\nImplement it.\n",
          todos: [],
        }),
      ],
      writes,
      ["question", "read", "write", "todowrite"],
    )
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    await completePlanWrite(session, writes, parts, writeCall)

    const text = parts
      .filter((part: any) => part.type === "text-delta")
      .map((part: any) => part.delta)
      .join("")
    expect(text).toContain("# Held Plan")
    expect(text).toContain("Implement it.")
    expect(text).toContain("Plan saved to ")

    const reasoningEnd = parts.findIndex((part: any) => part.type === "reasoning-end")
    const planStart = parts.findIndex((part: any) => part.type === "text-start" && part.id !== "text")
    expect(reasoningEnd).toBeGreaterThanOrEqual(0)
    expect(planStart).toBeGreaterThan(reasoningEnd)
    const planId = parts[planStart].id as string
    const planDelta = parts
      .filter((part: any) => part.type === "text-delta" && part.id === planId)
      .map((part: any) => part.delta)
      .join("")
    expect(planDelta).toContain("# Held Plan")
    expect(planDelta).toContain("Implement it.")
    expect(planDelta).not.toContain("Plan mode is active.")
    const planEnd = parts.findIndex((part: any) => part.type === "text-end" && part.id === planId)
    const call = reviewCall(parts)
    const callIndex = parts.lastIndexOf(call)
    expect(planEnd).toBeGreaterThan(planStart)
    expect(planEnd).toBeLessThan(callIndex)
    const question = JSON.parse(call.input).questions[0].question as string
    expect(question).not.toContain("Implement it.")
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("holds Cursor open on the approval prompt, then reports success on Yes", async () => {
    const { session, writes, parts } = await startPlan()

    expect(writes).toHaveLength(0)
    const toolCall = reviewCall(parts)
    expect(toolCall.toolName).toBe("question")
    expect(session.pending.size).toBe(1)
    const question = JSON.parse(toolCall.input).questions[0].question as string
    expect(question).toContain("Would you like to switch to the build agent")

    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })

    const execId = Number(toolCall.toolCallId.split("_").pop())
    await deliverContinuationResults(session, [{
      toolCallId: toolCall.toolCallId,
      sessionId: session.sessionId,
      execId,
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
    const toolCall = reviewCall(parts)
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    session.pumpActive = false
    session.pumpOwner = null

    await preparePriorSessionForFreshTurn(session.openCodeSessionId, {
      timeoutMs: 50,
      toolResults: [{
        toolCallId: toolCall.toolCallId,
        sessionId: session.sessionId,
        execId: Number(toolCall.toolCallId.split("_").pop()),
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

  it.each([false, true])("ends the approved plan Run before the resuming build turn (canceled=%s)", async canceled => {
    const writes: Uint8Array[] = []
    const session = planSession([], writes, ["question", "write", "todowrite"])
    session.hostAgent = "plan"
    sessionManager.registerPending(900_000, session, "create_plan_request_response", "question", false, {
      interactionId: 42, createPlanBridgeKind: "approve",
      createPlanQuestion: "Approve this plan?", planUri: "file:///plans/review.md",
    })
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) }, { resumesTurn: true })
    await deliverContinuationResults(session, [{
      toolCallId: "approval", sessionId: session.sessionId, execId: 900_000,
      toolName: "question", output: JSON.stringify({ answers: [["Yes"]] }),
    }], { hostAgent: "plan" })
    const frames: Frame[] = [
      // Work generated before cancellation arrives must never reach the host.
      ...["tool_call_started", "tool_call_completed"].map(kind => ({ flags: 0, payload: encodeMessage("AgentServerMessage", {
        interaction_update: { [kind]: {
          call_id: "late-plan-display",
          tool_call: { create_plan_tool_call: { args: {
            name: "Late plan", plan: "Work under the next agent.",
            todos: [{ id: "late", content: "Must not mirror", status: 1 }],
          } } },
        } },
      }) })),
      { flags: 0, payload: encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 7, write_args: { path: "proof.txt", file_text: "too early" } },
      }) },
      canceled
        ? { flags: 2, payload: new TextEncoder().encode('{"error":{"code":"canceled"}}') }
        : { flags: 0, payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }) },
    ]
    session.frames = { next: async () => frames.length ? { done: false, value: frames.shift()! } : { done: true, value: undefined } }
    const parts: any[] = []
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) }, error() {},
    } as ReadableStreamDefaultController<never>, { textId: "text", reasoningId: "reasoning" })
    expect(decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
      .create_plan_request_response.result.success).toBeDefined()
    expect(decodeMessage<any>("AgentClientMessage", writes[1]!).conversation_action
      .cancel_action.reason).toBe("host_plan_agent_handoff")
    expect(parts.some(part => part.type === "tool-call")).toBe(false)
    expect(session.pending.size).toBe(0)
    expect(session.closed).toBe(true)
    expect(parts.at(-1)?.finishReason.unified).toBe("stop")
    expect(switched).toEqual([])
    expect(await flushHostAgentModeSwitch(session.openCodeSessionId, {
      cursorSessionID: session.sessionId, terminal: session.closed, pendingExecs: session.pending.size,
    })).toBe(true)
    expect(switched).toEqual(["agent"])
  })

  for (const bridge of ["approve", "exit", "stage"] as const) {
    for (const canceled of [false, true]) {
      it(`stops the turn after a declined ${bridge} review (canceled=${canceled})`, async () => {
        setActiveCursorMode("create-plan-opencode-session", "plan")
        const writes: Uint8Array[] = []
        const session = planSession([], writes, ["question", "write", "shell", "cursor_image_save"])
        session.hostAgent = "plan"
        sessionManager.registerPending(900_000, session, "create_plan_request_response", "question", false, {
          interactionId: 42, createPlanBridgeKind: bridge,
          createPlanQuestion: "Approve this plan?", planUri: "file:///plans/review.md",
        })
        await deliverContinuationResults(session, [{
          toolCallId: "declined-review", sessionId: session.sessionId, execId: 900_000,
          toolName: "question", output: JSON.stringify({ answers: [["No"]] }),
          ...(bridge === "stage" ? { error: "Plan refinement requested." } : {}),
        }], { hostAgent: "plan" })
        const projectDir = path.join(workspace, "runtime")
        const spill = path.join(projectDir, "agent-tools", "12345678-1234-1234-1234-123456789abc.txt")
        session.requestContext.env = { workspace_paths: [workspace], project_folder: projectDir }
        const frames: Frame[] = [
          { flags: 0, payload: encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 9, write_args: { path: spill, file_text: "must-not-spill" } },
          }) },
          { flags: 0, payload: encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 10, git_diff_request: { cwd: workspace } },
          }) },
          { flags: 0, payload: encodeMessage("AgentServerMessage", {
            interaction_update: { text_delta: { text: "Continuing the self-test" } },
          }) },
          { flags: 0, payload: encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 7, shell_args: { command: "echo must-not-run" } },
          }) },
          { flags: 0, payload: encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 8, write_args: { path: "after-decline.txt", file_text: "must-not-write" } },
          }) },
          canceled
            ? { flags: 2, payload: new TextEncoder().encode('{"error":{"code":"canceled"}}') }
            : { flags: 0, payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }) },
        ]
        session.frames = { next: async () => frames.length ? { done: false, value: frames.shift()! } : { done: true, value: undefined } }
        session.reopenWithUserMessage = async () => { throw new Error("A declined turn must not continue itself") }
        const parts: Array<{ type: string; delta?: string; finishReason?: { unified: string } }> = []
        try {
          await pump(session, {
            enqueue(part: unknown) { parts.push(part as typeof parts[number]) }, error() {},
          } as ReadableStreamDefaultController<never>, { textId: "text", reasoningId: "reasoning" })
          expect(decodeMessage<any>("AgentClientMessage", writes[0]!).interaction_response
            .create_plan_request_response.result.error).toBeDefined()
          expect(decodeMessage<any>("AgentClientMessage", writes[1]!).conversation_action
            .cancel_action.reason).toBe("plan_execution_declined")
          expect(parts.some(part => part.type === "tool-call" || part.type === "text-delta")).toBe(false)
          expect(parts.at(-1)?.finishReason?.unified).toBe("stop")
          expect(session.closed).toBe(true)
          expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
          expect(fs.existsSync(path.join(workspace, "after-decline.txt"))).toBe(false)
          expect(fs.existsSync(spill)).toBe(false)
          const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes))
          expect(replies.find(reply => reply.exec_client_message?.id === 9)
            ?.exec_client_message.write_result.error.error).toContain("End this turn")
          expect(replies.find(reply => reply.exec_client_control_message?.throw?.id === 10)
            ?.exec_client_control_message.throw.error).toContain("End this turn")
        } finally {
          sessionManager.close(session, "ordinary-cleanup")
        }
      })
    }
  }

  it("keeps the plan agent selected when the user answers No", async () => {
    const { session, writes, parts } = await startPlan()
    const toolCall = reviewCall(parts)
    const question = JSON.parse(toolCall.input).questions[0].question as string
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })

    await deliverReview(
      session,
      toolCall,
      `User has answered your questions: "${question}"="No". You can now continue.`,
    )

    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(CREATE_PLAN_NOT_APPROVED_REASON)
    expect(session.planReviewDeclined).toBe(true)
    expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
    expect(switched).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("leaves native continuation to the host when an approval has no switch callback", async () => {
    resetHostAgentModeSwitchForTests()
    const { session, parts } = await startPlan()
    const call = reviewCall(parts)
    using trace = spyOn(debug, "trace").mockImplementation(() => {})
    try {
      await deliverReview(session, call, JSON.stringify({ answers: [["Yes"]] }))
      expect(getActiveCursorMode(session.openCodeSessionId)).toBe("agent")
      expect(session.planReviewDeclined).toBeFalsy()
      expect(await flushHostAgentModeSwitch(session.openCodeSessionId, {
        cursorSessionID: session.sessionId, terminal: true, pendingExecs: 0,
      })).toBe(false)
      expect(trace.mock.calls.some(([line]) => line.includes("the host must start the build turn"))).toBe(true)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it.each([
    ["plan", false], ["mode", false], ["stage", false],
    ["plan", true], ["mode", true], ["stage", true],
  ] as const)("does not let a %s approval in the same batch override No (approval first=%s)", async (late, reverse) => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = planSession([], writes, ["question", "write"])
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) }, { resumesTurn: true })
    for (const id of [900_000, 900_001]) {
      const second = id === 900_001
      sessionManager.registerPending(id, session,
        second && late === "mode" ? "switch_mode_request_response"
          : second && late === "stage" ? "mcp_result" : "create_plan_request_response",
        second && late === "stage" ? "cursor_plan_stage" : "question", false, {
        interactionId: id, createPlanBridgeKind: "approve", createPlanQuestion: "Approve?", planUri: "file:///plans/review.md",
        switchModeTarget: "agent", switchModeBridgeKind: "native",
      })
    }
    try {
      const results = ["No", "Yes"].map((answer, index) => ({
        toolCallId: `review-${index}`, sessionId: session.sessionId, execId: 900_000 + index,
        toolName: index === 1 && late === "stage" ? "cursor_plan_stage" : "question",
        output: JSON.stringify({ answers: [[answer]] }),
      }))
      await deliverContinuationResults(session, reverse ? results.reverse() : results, { hostAgent: "plan" })
      expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
      expect(await flushHostAgentModeSwitch(session.openCodeSessionId, {
        cursorSessionID: session.sessionId, terminal: true, pendingExecs: 0,
      })).toBe(false)
      expect(switched).toEqual([])
      let declined = false
      for (const frame of writes) {
        const reply = decodeMessage<{ interaction_response: {
          create_plan_request_response?: { result: { success?: unknown; error?: unknown } }
          switch_mode_request_response?: { rejected?: unknown }
        } }>("AgentClientMessage", frame).interaction_response
        if (reply?.create_plan_request_response) {
          if (!reverse) expect(reply.create_plan_request_response.result.success).toBeUndefined()
          declined ||= reply.create_plan_request_response.result.error !== undefined
        } else if (reply?.switch_mode_request_response && !reverse) {
          expect(reply.switch_mode_request_response.rejected).toBeDefined()
        }
      }
      expect(declined).toBe(true)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it.each(["prose", "json", "quoted-prose"])("continues freeform refinement in plan mode (%s)", async format => {
    const { session, writes, parts } = await startPlan()
    const toolCall = reviewCall(parts)
    const question = JSON.parse(toolCall.input).questions[0].question as string
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    const feedback = format === "quoted-prose"
      ? `Yes", "${question}"="No, add rollback coverage`
      : "Add a rollback step and cover error handling"
    using trace = spyOn(debug, "trace").mockImplementation(() => {})

    await deliverReview(
      session,
      toolCall,
      format === "json" ? JSON.stringify({ answers: [[feedback]] })
        : `User has answered your questions: "${question}"="${feedback}". You can now continue.`,
    )

    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.error.error).toBe(createPlanRefineReason(feedback))
    expect(result.error.error).toContain(feedback)
    expect(result.error.error).not.toContain("End this turn")
    expect(trace.mock.calls.some(([line]) => line.includes("create_plan: emulated approval=no outcome=refine"))).toBe(true)
    expect(session.planReviewDeclined).toBeFalsy()
    expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
    expect(switched).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("keeps a declined review's host notes for the next user turn instead of injecting them", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = planSession([], writes, ["question", "write"])
    session.hostAgent = "plan"
    sessionManager.registerPending(900_000, session, "create_plan_request_response", "question", false, {
      interactionId: 42, createPlanBridgeKind: "approve",
      createPlanQuestion: "Approve this plan?", planUri: "file:///plans/review.md",
    })
    try {
      await deliverContinuationResults(session, [{
        toolCallId: "declined-review", sessionId: session.sessionId, execId: 900_000,
        toolName: "question", output: JSON.stringify({ answers: [["No"]] }),
        notes: ["Background job finished."],
      }], { hostAgent: "plan" })
      expect(session.planReviewDeclined).toBe(true)
      // Only the CreatePlan reply: no context injection into the declined Run.
      expect(writes).toHaveLength(1)
      expect(releaseHostNoteInjectionsForTests("create-plan-opencode-session").undelivered)
        .toEqual(["Background job finished."])
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
      resetTurnStateForTests()
    }
  })

  it("saves the plan and does not ask or switch when session edits stay denied", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = planSession(
      [
        createPlanPayload({
          name: "Denied Plan",
          overview: "Stay blocked",
          plan: "## Approach\n\nImplement it.\n",
          todos: [],
        }),
      ],
      writes,
      ["question", "read", "edit", "write", "apply_patch"],
    )
    session.sessionEditsDenied = true
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text", reasoningId: "reasoning" },
    )
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    expect(parts.filter((part: any) => part.type === "tool-call" && part.toolName === "question")).toHaveLength(0)
    // Deliver the host write; hold acknowledgment is written without a further pump.
    const input = JSON.parse(writeCall.input) as { filePath?: string; path?: string; content?: string }
    const filePath = input.filePath ?? input.path!
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, input.content ?? "")
    await deliverContinuationResults(session, [{
      toolCallId: writeCall.toolCallId,
      sessionId: session.sessionId,
      execId: Number(writeCall.toolCallId.split("_").pop()),
      toolName: "write",
      output: `Wrote ${filePath}`,
    }] as any)
    expect(session.queuedCreatePlanAction?.kind).toBe("hold")
    session.heldFrames = [...(session.heldFrames ?? []), {
      flags: 0, payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    }]
    await pump(
      session,
      { enqueue(part: unknown) { parts.push(part) }, error() {} } as unknown as ReadableStreamDefaultController<any>,
      { textId: "text-2", reasoningId: "reasoning-2" },
    )
    const text = parts.filter((part: any) => part.type === "text-delta").map((part: any) => part.delta).join("")
    expect(text).toContain("# Denied Plan")
    expect(text).toContain("Plan saved to ")
    expect(parts.filter((part: any) => part.type === "tool-call" && part.toolName === "question")).toHaveLength(0)
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeUndefined()
    expect(result.plan_uri).toBe("")
    expect(result.error.error).toContain("session's edit rule")
    expect(result.error.error).toContain("do not write files through the shell")
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("plan")
    expect(switched).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })

  for (const host of ["classic", "opencode2"] as const) {
    for (const policy of ["deny", "unavailable"] as const) {
      it(`ends an immediate held plan (${policy}) before a queued ${host} shell can write`, async () => {
        setActiveCursorMode("create-plan-opencode-session", "plan")
        const writes: Uint8Array[] = []
        const session = planSession([
          createPlanPayload({ name: "Held plan", plan: "Do not implement yet." }),
          encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "Continuing anyway" } } }),
          encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 71, shell_args: { command: "printf escaped > hold-proof.txt" } },
          }),
          // A known unsupported request still needs its typed refusal while
          // cancellation drains; it must not escape as a host tool either.
          // Independent agent.v1 fields: ASM #2, exec id #1=72,
          // FetchArgs #20. Unsupported bodies are intentionally opaque.
          Uint8Array.from([0x12, 0x05, 0x08, 0x48, 0xa2, 0x01, 0x00]),
          encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
        ], writes, [host === "classic" ? "bash" : "shell", "question", "read", "write"])
        session.hostToolDialect = host === "classic" ? OPENCODE_1_TOOL_DIALECT : OPENCODE_2_TOOL_DIALECT
        session.hostAgent = "plan"
        session.sessionEditsDenied = policy === "deny"
        session.sessionPermissionsUnavailable = policy === "unavailable"
        const parts: LanguageModelV3StreamPart[] = []
        const enqueue = (part: LanguageModelV3StreamPart) => {
          parts.push(part)
          // A host that permits shell commands can execute this even while
          // its edit permission denies workspace mutations.
          if (part.type === "tool-call" && (part.toolName === "bash" || part.toolName === "shell")) {
            const input = JSON.parse(part.input) as { command: string }
            execFileSync("/bin/sh", ["-c", input.command], { cwd: workspace })
          }
        }
        try {
          await pump(session, {
            desiredSize: null, close() {}, enqueue, error() {},
          }, { textId: "text", reasoningId: "reasoning" })
          if (policy === "unavailable") {
            // Unavailable permissions refuse before emitting a host write.
            expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
          } else {
            const writeCall = parts.find(part => part.type === "tool-call") as
              | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
              | undefined
            expect(writeCall?.toolName).toBe("write")
            // Write success + remaining frames (shell / cancel) in one continuation pump.
            await completePlanWrite(session, writes, parts, writeCall!)
          }
          expect(fs.existsSync(path.join(workspace, "hold-proof.txt"))).toBe(false)
          expect(parts.filter(part => part.type === "tool-call" && (part.toolName === "bash" || part.toolName === "shell")))
            .toHaveLength(0)
          expect(parts.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join(""))
            .not.toContain("Continuing anyway")
          expect(fs.existsSync(hostPlansDir(workspace)) ? fs.readdirSync(hostPlansDir(workspace)) : [])
            .toHaveLength(policy === "deny" ? 1 : 0)
          expect(session.closed).toBe(true)
          expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
          const replies = writes.map(bytes => decodeMessage<{
            interaction_response?: { create_plan_request_response: { result: { error: { error: string } } } }
            conversation_action?: { cancel_action: { reason: string } }
          }>("AgentClientMessage", bytes))
          const planReply = replies.find(reply => reply.interaction_response?.create_plan_request_response)
          expect(planReply?.interaction_response?.create_plan_request_response.result.error.error)
            .toContain(policy === "deny" ? "session's edit rule" : "permissions could not be read")
          expect(replies.some(reply => reply.conversation_action?.cancel_action?.reason === "plan_execution_declined"))
            .toBe(true)
          if (policy === "deny") {
            const fetchReply = writes.flatMap(bytes => {
              const exec = readAllFields(bytes).find(field => field.fn === 2)?.bytes
              return exec && readAllFields(exec).some(field => field.fn === 1 && field.varint === 72) ? [exec] : []
            })[0]
            const fetchResult = fetchReply && readAllFields(fetchReply).find(field => field.fn === 20)?.bytes
            expect(fetchResult && readAllFields(fetchResult).find(field => field.fn === 2)?.wt).toBe(2)
          }
        } finally {
          sessionManager.close(session, "ordinary-cleanup")
        }
      })
    }
  }

  it("keeps a saved denied plan behind the stateful replay barrier after a stream drop", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    const session = planSession([
      encodeMessage("AgentServerMessage", {
        conversation_checkpoint_update: encodeMessage("ConversationStateStructure", {
          root_prompt_messages_json: ["initial"],
        }),
      }),
      createPlanPayload({ name: "Denied before EOF", plan: "Plan content" }),
    ], writes, ["read", "write"])
    session.sessionEditsDenied = true
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) }, error() {},
    } as ReadableStreamDefaultController<never>, { textId: "text", reasoningId: "reasoning" })
    const writeCall = parts.find((part: any) => part.type === "tool-call")
    expect(writeCall?.toolName).toBe("write")
    await expect(completePlanWrite(session, writes, parts, writeCall).then(async () => {
      await pump(session, {
        enqueue() { throw new Error("stream dropped") }, error() {},
      } as unknown as ReadableStreamDefaultController<never>, { textId: "text-2", reasoningId: "reasoning-2" })
    })).rejects.toBeTruthy()
    expect(session.replaySafety?.statefulBarrier).toBe("stateful-interaction")
    expect(session.resumeCheckpoint).toBeUndefined()
    expect(session.checkpointRevoked).toBe(true)
    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(fs.readdirSync(hostPlansDir(workspace))).toHaveLength(1)
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("finishes an already-emitted parallel read before cancelling a held plan and refuses trailing shells", async () => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "hello\n")
    const writes: Uint8Array[] = []
    const session = planSession([
      encodeMessage("AgentServerMessage", { interaction_update: { tool_requests_listed: { call_count: 3 } } }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 11, call_id: "c-read", read_args: { path: "notes.txt" } },
      }),
      createPlanPayload({ name: "Parallel held plan", plan: "Read then hold.", tool_call_id: "c-plan" }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 12, call_id: "c-shell", shell_args: { command: "printf escaped > parallel-hold.txt" } },
      }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], writes, ["read", "shell", "question", "todowrite"])
    session.permittedToolNames = new Set(["read", "shell", "question"])
    session.sessionEditsDenied = true
    const firstParts: LanguageModelV3StreamPart[] = []
    try {
      await pump(session, {
        desiredSize: null, close() {}, error() {},
        enqueue(part: LanguageModelV3StreamPart) { firstParts.push(part) },
      }, { textId: "text", reasoningId: "reasoning" })
      const calls = firstParts.filter(part => part.type === "tool-call")
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ toolName: "read" })
      expect(firstParts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } })
      expect(session.closed).toBe(false)
      expect(session.pending.size).toBe(1)

      await deliverContinuationResults(session, [{
        toolCallId: (calls[0] as { toolCallId: string }).toolCallId,
        sessionId: session.sessionId,
        execId: 11,
        toolName: "read",
        output: "hello\n",
      }], { hostAgent: "plan", sessionEditsDenied: true })

      const secondParts: LanguageModelV3StreamPart[] = []
      await pump(session, {
        desiredSize: null, close() {}, error() {},
        enqueue(part: LanguageModelV3StreamPart) { secondParts.push(part) },
      }, { textId: "text-2", reasoningId: "reasoning-2" })
      expect(secondParts.filter(part => part.type === "tool-call")).toHaveLength(0)
      expect(secondParts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
      expect(session.closed).toBe(true)
      expect(fs.existsSync(path.join(workspace, "parallel-hold.txt"))).toBe(false)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it("blocks direct plan_exit execs and omits unpermitted display todo mirrors", async () => {
    const writes: Uint8Array[] = []
    const session = planSession([
      encodeMessage("AgentServerMessage", {
        interaction_update: {
          tool_call_completed: {
            call_id: "todo-display",
            tool_call: {
              update_todos_tool_call: {
                args: { todos: [{ id: "1", content: " item ", status: 1 }] },
              },
            },
          },
        },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 81, mcp_args: { name: "opencode-plan_exit", tool_name: "plan_exit", provider_identifier: "opencode" } },
      }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], writes, ["plan_exit", "todowrite", "read"])
    session.permittedToolNames = new Set(["plan_exit", "read"])
    session.sessionEditsDenied = true
    const parts: LanguageModelV3StreamPart[] = []
    try {
      await pump(session, {
        desiredSize: null, close() {}, error() {},
        enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
      }, { textId: "text", reasoningId: "reasoning" })
      expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
      expect(session.planReviewDeclined).toBe(true)
      expect(session.closed).toBe(true)
      const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes))
      expect(replies[0]?.exec_client_message?.mcp_result?.error?.error).toContain("session's edit rule")
      expect(replies.some(reply => reply.conversation_action?.cancel_action?.reason === "plan_execution_declined")).toBe(true)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it("refuses a direct plan_exit exec when session permissions cannot be read", async () => {
    const writes: Uint8Array[] = []
    const session = planSession([
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 82, mcp_args: { name: "opencode-plan_exit", tool_name: "plan_exit", provider_identifier: "opencode" } },
      }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], writes, ["plan_exit", "read"])
    session.sessionPermissionsUnavailable = true
    const parts: LanguageModelV3StreamPart[] = []
    try {
      await pump(session, {
        desiredSize: null, close() {}, error() {},
        enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
      }, { textId: "text", reasoningId: "reasoning" })
      expect(parts.filter(part => part.type === "tool-call")).toHaveLength(0)
      expect(session.planReviewDeclined).toBe(true)
      expect(session.closed).toBe(true)
      const replies = writes.map(bytes => decodeMessage<any>("AgentClientMessage", bytes))
      expect(replies[0]?.exec_client_message?.mcp_result?.error?.error).toContain("permissions could not be read")
      expect(replies.some(reply => reply.conversation_action?.cancel_action?.reason === "plan_execution_declined")).toBe(true)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it("bridges CreatePlan through the host plan-stage tool under bridged plan mode", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan", { bridgedPlanEntered: true })
    const writes: Uint8Array[] = []
    const parts: LanguageModelV3StreamPart[] = []
    const session = planSession([
      createPlanPayload({ name: "Staged Plan", overview: "o", plan: "## Steps\n\n1. Stage it.\n", todos: [] }),
      encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
    ], writes, ["cursor_plan_stage", "write", "read"])
    try {
      await pump(session, {
        desiredSize: null, close() {}, error() {},
        enqueue(part: LanguageModelV3StreamPart) { parts.push(part) },
      }, { textId: "text", reasoningId: "reasoning" })
      const call = parts.find(part => part.type === "tool-call")
      expect(call).toMatchObject({ toolName: "cursor_plan_stage" })
      const input = JSON.parse((call as { input: string }).input) as {
        title: string; plan_uri: string; content: string
      }
      expect(input.title).toBe("staged-plan")
      expect(input.plan_uri).toBe("local://staged-plan-plan.md")
      expect(input.content).toContain("1. Stage it.")
      expect(session.pending.size).toBe(1)
      expect(writes).toHaveLength(0)
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it("does not treat a Yes as permission to implement while session edits stay denied", async () => {
    const { session, writes, parts } = await startPlan()
    const toolCall = reviewCall(parts)
    const question = JSON.parse(toolCall.input).questions[0].question as string
    const switched: string[] = []
    setHostAgentModeSwitch(({ targetModeID }) => { switched.push(targetModeID) })
    await deliverReview(
      session,
      toolCall,
      `User has answered your questions: "${question}"="Yes". You can now continue.`,
      { hostAgent: "plan", sessionEditsDenied: true },
    )
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeUndefined()
    expect(result.plan_uri).toBe("")
    expect(result.error.error).toContain("session's edit rule")
    expect(isCursorPlanModeActive("create-plan-opencode-session")).toBe(true)
    await flushHostAgentModeSwitch("create-plan-opencode-session", {
      cursorSessionID: session.sessionId,
      terminal: true,
      pumpActive: false,
      pendingExecs: 0,
    })
    expect(switched).toEqual([])
    sessionManager.close(session, "ordinary-cleanup")
  })

  it("does not accept a pending review's Yes when permission lookup becomes unavailable", async () => {
    const { session, writes, parts } = await startPlan()
    const call = reviewCall(parts)
    try {
      await deliverReview(
        session,
        call,
        JSON.stringify({ answers: [["Yes"]] }),
        { hostAgent: "plan", sessionPermissionsUnavailable: true },
      )
      const reply = decodeMessage<{ interaction_response: {
        create_plan_request_response: { result: { error: { error: string }; success?: unknown } }
      } }>("AgentClientMessage", writes[0]!).interaction_response.create_plan_request_response.result
      expect(reply.success).toBeUndefined()
      expect(reply.error.error).toContain("permissions could not be read")
      expect(session.planReviewDeclined).toBe(true)
      expect(getActiveCursorMode(session.openCodeSessionId)).toBe("plan")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
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

  it("keeps plan mode when stage success arrives under a session edit deny", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = stageSession(writes)
    await deliverContinuationResults(session, [{
      toolCallId: "stage-call", sessionId: session.sessionId, execId: 900_000,
      toolName: "cursor_plan_stage", output: "Plan approved by host stage",
    }] as any, { sessionEditsDenied: true })
    const result = decodeMessage<any>("AgentClientMessage", writes[0]!)
      .interaction_response.create_plan_request_response.result
    expect(result.success).toBeUndefined()
    expect(result.error.error).toBe(createPlanSessionEditsDeniedReason(""))
    expect(getActiveCursorMode("create-plan-opencode-session")).toBe("plan")
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

  it.each([
    ["cursor_plan_stage", "deny"],
    ["cursor_plan_stage", "unavailable"],
    ["plan_exit", "deny"],
    ["plan_exit", "unavailable"],
    ["plan_exit", "declined"],
  ] as const)("ends the turn when a direct %s exec returns under %s", async (toolName, policy) => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = planSession([], writes, [toolName])
    sessionManager.registerPending(44, session, "mcp_result", toolName, false)
    try {
      await deliverContinuationResults(session, [{
        toolCallId: `cursor_${session.sessionId}_44`,
        sessionId: session.sessionId,
        execId: 44,
        toolName,
        output: policy === "declined" ? "User dismissed the prompt" : "approved",
        ...(policy === "declined" ? { error: "User dismissed the prompt" } : {}),
      }], {
        hostAgent: policy === "declined" ? "plan" : "build",
        sessionEditsDenied: policy === "deny",
        sessionPermissionsUnavailable: policy === "unavailable",
      })
      const reply = decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.mcp_result
      expect(reply.error.error).toContain(
        policy === "unavailable"
          ? "permissions could not be read"
          : policy === "deny"
            ? "session's edit rule"
            : "User dismissed",
      )
      expect(session.planReviewDeclined).toBe(true)
      expect(getActiveCursorMode("create-plan-opencode-session")).toBe("plan")
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it("ends the turn when a successful plan_exit still leaves the host on its plan agent", async () => {
    setActiveCursorMode("create-plan-opencode-session", "plan")
    const writes: Uint8Array[] = []
    const session = planSession([], writes, ["plan_exit"])
    sessionManager.registerPending(45, session, "mcp_result", "plan_exit", false)
    try {
      await deliverContinuationResults(session, [{
        toolCallId: `cursor_${session.sessionId}_45`,
        sessionId: session.sessionId,
        execId: 45,
        toolName: "plan_exit",
        output: "User approved switching to build agent.",
      }], { hostAgent: "plan" })
      expect(session.planReviewDeclined).toBe(true)
      expect(getActiveCursorMode("create-plan-opencode-session")).toBe("plan")
      expect(decodeMessage<any>("AgentClientMessage", writes[0]!).exec_client_message.mcp_result.error).toBeUndefined()
    } finally {
      sessionManager.close(session, "ordinary-cleanup")
    }
  })
})
