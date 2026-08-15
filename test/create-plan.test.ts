import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { handleInteractionQuery } from "../src/protocol/interactions.js"
import {
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
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousXdgData
  if (previousBridge === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE]
  } else {
    ;(globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE] = previousBridge
  }
})

function installBridge(projectConfigDir: string): void {
  const bridge: OpenCodePathBridge = {
    projectConfigDirs: () => [projectConfigDir],
    globalConfigDirs: () => [path.join(os.tmpdir(), "fake-config")],
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
})

describe("slugifyPlanName", () => {
  it("slugifies titles", () => {
    expect(slugifyPlanName("Hello World!")).toBe("hello-world")
  })
})

describe("hostPlansDir", () => {
  it("uses the path-bridge project config dir under a git worktree", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    const mimocode = path.join(workspace, ".mimocode")
    installBridge(mimocode)
    expect(hostPlansDir(workspace)).toBe(path.join(mimocode, "plans"))
  })

  it("defaults to <worktree>/.opencode/plans when no bridge is installed", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    expect(hostPlansDir(workspace)).toBe(path.join(workspace, ".opencode", "plans"))
  })

  it("falls back to host global data/plans without a git worktree", () => {
    process.env.HOME = path.join(workspace, "home")
    delete process.env.XDG_DATA_HOME
    expect(hostPlansDir(workspace)).toBe(path.join(hostGlobalDataDir(), "plans"))
  })
})

describe("resolveHostPlanPath / writeOpencodePlanFile", () => {
  it("writes under the calculated host plans dir and returns a file:// URI", () => {
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
      path.join(workspace, ".opencode", "plans", `${created}-demo-plan.md`),
    )
    expect(written.planUri).toBe(pathToFileURL(written.planPath).href)
    const onDisk = fs.readFileSync(written.planPath, "utf-8")
    expect(onDisk.startsWith("---")).toBe(false)
    expect(onDisk).toContain("# Demo Plan")
    expect(onDisk).toContain("Body of the plan.")
  })

  it("honors a bridged MiMo project-config dir", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    const mimocode = path.join(workspace, ".mimocode")
    installBridge(mimocode)
    const planPath = resolveHostPlanPath(workspace, "Bridge Plan", 42)
    expect(planPath).toBe(path.join(mimocode, "plans", "42-bridge-plan.md"))
  })
})

describe("CreatePlan interaction #7", () => {
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

  it("persists args under hostPlansDir and returns file:// plan_uri", () => {
    fs.mkdirSync(path.join(workspace, ".git"))
    const payload = createPlanPayload({
      name: "Live Plan",
      overview: "Do it",
      plan: "## Approach\n\nWrite the code.\n",
      todos: [{ id: "1", content: "Implement", status: 1 }],
    })
    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload, { workspaceRoot: workspace })
    expect(handled.outcome).toBe("acknowledged")
    const response = decodeMessage<any>("AgentClientMessage", handled.reply!).interaction_response
    const result = response.create_plan_request_response.result
    expect(result.success).toBeDefined()
    expect(result.plan_uri).toMatch(/^file:\/\//)
    const planPath = decodeURIComponent(new URL(result.plan_uri).pathname)
    expect(planPath.startsWith(path.join(workspace, ".opencode", "plans"))).toBe(true)
    expect(fs.existsSync(planPath)).toBe(true)
    const body = fs.readFileSync(planPath, "utf-8")
    expect(body.startsWith("---")).toBe(false)
    expect(body).toContain("# Live Plan")
    expect(body).toContain("- [ ] Implement")
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
