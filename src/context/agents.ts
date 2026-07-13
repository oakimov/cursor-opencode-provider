import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { opencodeGlobalConfigDir } from "./paths.js"

export type CollectedAgent = {
  fullPath: string
  name: string
  description: string
  prompt: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function parseAgentMarkdown(raw: string, fallbackName: string): {
  name: string
  description: string
  prompt: string
} {
  let name = fallbackName
  let description = ""
  let body = raw
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3)
    if (end >= 0) {
      const fm = raw.slice(3, end).trim()
      body = raw.slice(end + 4).replace(/^\n/, "")
      for (const line of fm.split("\n")) {
        const m = line.match(/^(\w+):\s*(.*)$/)
        if (!m) continue
        let val = m[2]!.trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (m[1] === "name") name = val
        if (m[1] === "description") description = val
      }
    }
  }
  return { name, description, prompt: body.slice(0, 20_000) }
}

async function scanAgentDir(dir: string, out: Map<string, CollectedAgent>): Promise<void> {
  if (!(await exists(dir))) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue
    const full = path.join(dir, name)
    try {
      const raw = await readFile(full, "utf-8")
      const parsed = parseAgentMarkdown(raw, name.replace(/\.md$/, ""))
      if (!out.has(parsed.name)) {
        out.set(parsed.name, {
          fullPath: path.resolve(full),
          name: parsed.name,
          description: parsed.description,
          prompt: parsed.prompt,
        })
      }
    } catch {
      /* skip */
    }
  }
}

/** Custom OpenCode agents from `.opencode/agents` and global config. */
export async function collectAgents(workspaceRoot: string): Promise<CollectedAgent[]> {
  const out = new Map<string, CollectedAgent>()
  await scanAgentDir(path.join(workspaceRoot, ".opencode", "agents"), out)
  await scanAgentDir(path.join(opencodeGlobalConfigDir(), "agents"), out)
  return [...out.values()]
}
