import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { opencodeGlobalConfigDir } from "./paths.js"

export type CollectedSkill = {
  fullPath: string
  name: string
  description: string
  content: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  if (!raw.startsWith("---")) return { body: raw }
  const end = raw.indexOf("\n---", 3)
  if (end < 0) return { body: raw }
  const fm = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, "")
  let name: string | undefined
  let description: string | undefined
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let val = m[2]!.trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key === "name") name = val
    if (key === "description") description = val
  }
  return { name, description, body }
}

async function loadSkillFile(file: string): Promise<CollectedSkill | undefined> {
  try {
    const raw = await readFile(file, "utf-8")
    const { name, description, body } = parseFrontmatter(raw)
    const dirName = path.basename(path.dirname(file))
    return {
      fullPath: path.resolve(file),
      name: name || dirName,
      description: description || "",
      content: body.slice(0, 20_000),
    }
  } catch {
    return undefined
  }
}

async function scanSkillsRoot(root: string, out: Map<string, CollectedSkill>): Promise<void> {
  if (!(await exists(root))) return
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  for (const name of entries) {
    const skillMd = path.join(root, name, "SKILL.md")
    if (!(await exists(skillMd))) continue
    const skill = await loadSkillFile(skillMd)
    if (!skill) continue
    if (!out.has(skill.name)) out.set(skill.name, skill)
  }
}

async function walkAncestorsFor(dir: string, rel: string, stop: string, out: Map<string, CollectedSkill>) {
  let cur = path.resolve(dir)
  const root = path.resolve(stop)
  for (;;) {
    await scanSkillsRoot(path.join(cur, rel), out)
    if (cur === root) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
}

/**
 * Discover skills the way OpenCode does: `.opencode/skills`, global opencode,
 * plus `.claude/skills` and `.agents/skills` (project + home).
 */
export async function collectSkills(workspaceRoot: string, worktree: string): Promise<CollectedSkill[]> {
  const out = new Map<string, CollectedSkill>()
  const home = homedir()

  await walkAncestorsFor(workspaceRoot, path.join(".opencode", "skills"), worktree, out)
  await scanSkillsRoot(path.join(opencodeGlobalConfigDir(), "skills"), out)

  await walkAncestorsFor(workspaceRoot, path.join(".claude", "skills"), worktree, out)
  await scanSkillsRoot(path.join(home, ".claude", "skills"), out)

  await walkAncestorsFor(workspaceRoot, path.join(".agents", "skills"), worktree, out)
  await scanSkillsRoot(path.join(home, ".agents", "skills"), out)

  return [...out.values()]
}
