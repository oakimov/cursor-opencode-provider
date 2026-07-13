import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { collectRules } from "../src/context/rules.js"
import { collectSkills } from "../src/context/skills.js"
import { buildRequestContext } from "../src/context/build.js"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"

describe("collectRules / buildRequestContext", () => {
  let root: string

  beforeAll(async () => {
    root = path.join(os.tmpdir(), `cursor-ctx-${process.pid}-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "AGENTS.md"), "# Project rules\nUse bun.\n")
    await mkdir(path.join(root, ".opencode", "skills", "demo"), { recursive: true })
    await writeFile(
      path.join(root, ".opencode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n\nDo the demo.\n",
    )
    await mkdir(path.join(root, ".cursor", "rules"), { recursive: true })
    await writeFile(path.join(root, ".cursor", "rules", "extra.md"), "cursor instruction via opencode.json")
    await writeFile(
      path.join(root, "opencode.json"),
      JSON.stringify({ instructions: [".cursor/rules/*.md"] }),
    )
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("loads AGENTS.md and honors .cursor paths listed in instructions", async () => {
    const { rules } = await collectRules(root)
    expect(rules.some((r) => r.fullPath.endsWith("AGENTS.md"))).toBe(true)
    expect(rules.some((r) => r.fullPath.replace(/\\/g, "/").includes("/.cursor/rules/extra.md"))).toBe(true)
  })

  it("discovers .opencode skills", async () => {
    const skills = await collectSkills(root, root)
    expect(skills.some((s) => s.name === "demo")).toBe(true)
  })

  it("builds an encodable RequestContext with rules and skills", async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    })
    expect(Array.isArray(ctx.rules)).toBe(true)
    expect((ctx.rules as unknown[]).length).toBeGreaterThan(0)
    expect(ctx.rules_info_complete).toBe(true)
    expect(ctx.env_info_complete).toBe(true)
    const bytes = encodeMessage("RequestContext", ctx)
    expect(bytes.length).toBeGreaterThan(50)
    const decoded = decodeMessage("RequestContext", bytes) as Record<string, unknown>
    expect(Array.isArray(decoded.rules)).toBe(true)
  })
})
