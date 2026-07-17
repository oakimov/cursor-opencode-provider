import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { opencodeGlobalConfigDir, resolveHomeRelative } from "./paths.js"

export type CollectedRule = {
  fullPath: string
  content: string
}

export type OpencodeJson = {
  instructions?: string[]
  permission?: unknown
  plugin?: string[]
  plugins?: string[]
  mcp?: Record<string, unknown>
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function readJsonConfig(dir: string): Promise<OpencodeJson> {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(dir, name)
    if (!(await exists(file))) continue
    try {
      const raw = await readFile(file, "utf-8")
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      return JSON.parse(stripped) as OpencodeJson
    } catch {
      return {}
    }
  }
  return {}
}

async function findGitWorktree(start: string): Promise<string> {
  let dir = path.resolve(start)
  for (;;) {
    if (await exists(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(start)
    dir = parent
  }
}

async function findUp(name: string, start: string, stop: string): Promise<string | undefined> {
  let dir = path.resolve(start)
  const root = path.resolve(stop)
  for (;;) {
    const candidate = path.join(dir, name)
    if (await exists(candidate)) return candidate
    if (dir === root) return undefined
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function readRule(file: string): Promise<CollectedRule | undefined> {
  if (!(await exists(file))) return undefined
  try {
    const content = await readFile(file, "utf-8")
    if (!content.trim()) return undefined
    return { fullPath: path.resolve(file), content }
  } catch {
    return undefined
  }
}

function globToRegExp(glob: string): RegExp {
  const norm = glob.replace(/\\/g, "/")
  let re = "^"
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i]!
    if (c === "*") {
      if (norm[i + 1] === "*") {
        re += ".*"
        i++
        if (norm[i + 1] === "/") i++
      } else {
        re += "[^/]*"
      }
    } else if (".$^+?()[]{}|".includes(c) || c === "\\") {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp(re + "$")
}

async function expandGlob(pattern: string, workspaceRoot: string): Promise<string[]> {
  const abs = path.isAbsolute(pattern) ? pattern : path.join(workspaceRoot, pattern)
  if (!abs.includes("*")) return (await exists(abs)) ? [abs] : []

  const out: string[] = []
  const base = abs.split("*")[0] || workspaceRoot
  const startDir = path.dirname(base.endsWith("/") ? base : base)
  const regex = globToRegExp(abs)

  async function walk(dir: string, depth: number) {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue
      const full = path.join(dir, name)
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (st.isDirectory()) await walk(full, depth + 1)
      else if (regex.test(full.replace(/\\/g, "/"))) out.push(full)
    }
  }

  await walk(startDir, 0)
  return out
}

export async function loadMergedConfig(workspaceRoot: string): Promise<OpencodeJson> {
  const globalConfig = await readJsonConfig(opencodeGlobalConfigDir())
  const projectConfig = await readJsonConfig(workspaceRoot)
  return {
    ...globalConfig,
    ...projectConfig,
    instructions: [...(globalConfig.instructions ?? []), ...(projectConfig.instructions ?? [])],
    plugin: [...new Set([...(globalConfig.plugin ?? []), ...(projectConfig.plugin ?? [])])],
    plugins: [...new Set([...(globalConfig.plugins ?? []), ...(projectConfig.plugins ?? [])])],
    mcp: { ...(globalConfig.mcp ?? {}), ...(projectConfig.mcp ?? {}) },
    permission: projectConfig.permission ?? globalConfig.permission,
  }
}

/**
 * Collect OpenCode instruction files.
 */
export async function collectRules(workspaceRoot: string): Promise<{
  rules: CollectedRule[]
  config: OpencodeJson
  worktree: string
}> {
  const worktree = await findGitWorktree(workspaceRoot)
  const rules: CollectedRule[] = []
  const seen = new Set<string>()
  const config = await loadMergedConfig(workspaceRoot)

  const add = async (file: string | undefined) => {
    if (!file) return
    const resolved = path.resolve(file)
    if (seen.has(resolved)) return
    const rule = await readRule(resolved)
    if (!rule) return
    seen.add(resolved)
    rules.push(rule)
  }

  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    const hit = await findUp(name, workspaceRoot, worktree)
    if (hit) {
      await add(hit)
      break
    }
  }

  await add(path.join(opencodeGlobalConfigDir(), "AGENTS.md"))
  await add(path.join(homedir(), ".claude", "CLAUDE.md"))

  for (const raw of config.instructions ?? []) {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 5000)
        const res = await fetch(raw, { signal: ctrl.signal })
        clearTimeout(t)
        if (!res.ok) continue
        const content = await res.text()
        if (!content.trim() || seen.has(raw)) continue
        seen.add(raw)
        rules.push({ fullPath: raw, content })
      } catch {
        /* ignore */
      }
      continue
    }
    const expanded = resolveHomeRelative(raw)
    for (const m of await expandGlob(expanded, workspaceRoot)) await add(m)
  }

  return { rules, config, worktree }
}
