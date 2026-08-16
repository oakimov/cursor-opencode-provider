import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
  createPlanStageInput,
  decodeCreatePlanQuery,
  renderOpencodePlanMarkdown,
  resolveHostPlanPath,
  slugifyPlanName,
  writeOpencodePlanFile,
} from "../src/protocol/create-plan.js"
import {
  hostGlobalDataDir,
  hostPlansDir,
  OPENCODE_PATH_BRIDGE,
  type OpenCodePathBridge,
} from "../src/context/paths.js"

let workspace: string
let sandboxHome: string
let previousHome: string | undefined
let previousXdgData: string | undefined
let previousBridge: unknown

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plan-ws-"))
  previousHome = process.env.HOME
  previousXdgData = process.env.XDG_DATA_HOME
  previousBridge = (globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE]
  delete (globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE]
  delete process.env.MIMOCODE_HOME
  delete process.env.KILO_CONFIG_DIR
  delete process.env.XDG_DATA_HOME
  delete process.env.PI_CODING_AGENT_DIR
  // Plans now resolve off the host data dir, so every test must be sandboxed
  // away from the real ~/.local/share or it writes into the developer's home.
  // Deliberately OUTSIDE `workspace`, so "nothing lands in the repo" assertions
  // are not silently satisfied by the sandbox itself living inside it.
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plan-home-"))
  process.env.HOME = sandboxHome
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(sandboxHome, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousXdgData
  if (previousBridge === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE]
  } else {
    ;(globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE] = previousBridge
  }
  delete process.env.MIMOCODE_HOME
  delete process.env.KILO_CONFIG_DIR
  delete process.env.PI_CODING_AGENT_DIR
})

function installBridge(projectConfigDir: string, globalConfigDirs?: string[]): void {
  const bridge: OpenCodePathBridge = {
    projectConfigDirs: () => [projectConfigDir],
    globalConfigDirs: () => globalConfigDirs ?? [path.join(os.tmpdir(), "fake-config")],
  }
  ;(globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE] = bridge
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

  it("ignores the path bridge project-config dir entirely", () => {
    // A bridged `.mimocode` is still inside the repo, so it must not be used.
    fs.mkdirSync(path.join(workspace, ".git"))
    installBridge(path.join(workspace, ".mimocode"))
    process.env.HOME = path.join(workspace, "home")
    delete process.env.XDG_DATA_HOME
    expect(hostPlansDir(workspace)).toBe(path.join(hostGlobalDataDir(), "plans"))
  })

  it("follows the host data dir for MiMo / Kilo / Pi", () => {
    const xdg = path.join(workspace, "xdg-data")
    process.env.HOME = path.join(workspace, "home")
    process.env.XDG_DATA_HOME = xdg
    process.env.MIMOCODE_HOME = path.join(workspace, "mimo-home")
    expect(hostPlansDir(workspace)).toBe(
      path.join(path.join(workspace, "mimo-home"), "plans"),
    )
    delete process.env.MIMOCODE_HOME

    process.env.KILO_CONFIG_DIR = path.join(workspace, "kilo-config")
    expect(hostPlansDir(workspace)).toBe(path.join(xdg, "kilo", "plans"))
    delete process.env.KILO_CONFIG_DIR

    process.env.PI_CODING_AGENT_DIR = path.join(workspace, "omp-agent")
    installBridge(path.join(workspace, ".omp"), [path.join(workspace, "home", ".omp")])
    expect(hostPlansDir(workspace)).toBe(path.join(workspace, "omp-agent", "plans"))
    delete process.env.PI_CODING_AGENT_DIR
  })
})

describe("native plan stage payload", () => {
  it("renders omp's canonical local plan URI and markdown", () => {
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
    installBridge(path.join(workspace, ".mimocode"))
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
      plan: "## Approach\n\nUse omp plan mode.\n",
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
