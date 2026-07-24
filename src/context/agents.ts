import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { opencodeGlobalConfigDirs, opencodeProjectConfigDirs } from "./paths.js"

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

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((value) => {
    const normalized = path.resolve(value)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

/**
 * Read one host config root's `agent/` and `agents/` trees. Host loaders use
 * both spellings and recurse through nested markdown files. Directory symlinks
 * are followed with realpath cycle detection, matching host behavior without
 * allowing a symlink loop to hang context construction.
 */
async function scanAgentRoot(
  root: string,
  out: Map<string, CollectedAgent>,
): Promise<void> {
  if (!(await exists(root))) return
  const visitedDirs = new Set<string>()
  const scanDir = async (dir: string, relativePrefix: string): Promise<void> => {
    let canonical: string
    try {
      canonical = await realpath(dir)
    } catch {
      return
    }
    if (visitedDirs.has(canonical)) return
    visitedDirs.add(canonical)

    let entries: Array<import("node:fs").Dirent>
    try {
      entries = await readdir(dir, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const relative = path.join(relativePrefix, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(full)
          isDirectory = target.isDirectory()
          isFile = target.isFile()
        } catch {
          continue
        }
      }
      if (isDirectory) {
        await scanDir(full, relative)
        continue
      }
      if (!isFile || !entry.name.endsWith(".md")) continue

      try {
        const raw = await readFile(full, "utf-8")
        const fallbackName = relative.replace(/\\/g, "/").replace(/\.md$/, "")
        const parsed = parseAgentMarkdown(raw, fallbackName)
        if (!out.has(parsed.name)) {
          out.set(parsed.name, {
            fullPath: path.resolve(full),
            name: parsed.name,
            description: parsed.description,
            prompt: parsed.prompt,
          })
        }
      } catch {
        /* skip unreadable or malformed files without failing context build */
      }
    }
  }

  // Scan singular before plural, then let root ordering establish host
  // precedence. This is deterministic and mirrors the hosts' brace glob.
  await scanDir(path.join(root, "agent"), "agent")
  await scanDir(path.join(root, "agents"), "agents")
}

/**
 * Custom agents from the active OpenCode-compatible config roots. OCP may
 * install a host-neutral bridge before loading this module; without one this
 * remains the direct OpenCode discovery path.
 */
export async function collectAgents(workspaceRoot: string): Promise<CollectedAgent[]> {
  const out = new Map<string, CollectedAgent>()
  const roots = uniquePaths([
    ...opencodeProjectConfigDirs(workspaceRoot),
    ...opencodeGlobalConfigDirs(),
  ])
  for (const root of roots) await scanAgentRoot(root, out)
  return [...out.values()]
}
