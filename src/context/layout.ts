import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo"])

export type LayoutNode = {
  abs_path: string
  children_dirs: LayoutNode[]
  children_files: Array<{ name: string }>
  children_were_processed: boolean
  num_files: number
}

/**
 * Shallow project layout for RequestContext.project_layouts.
 * Caps depth and entries to keep the payload small.
 */
export async function collectProjectLayout(
  workspaceRoot: string,
  opts: { maxDepth?: number; maxEntries?: number } = {},
): Promise<LayoutNode> {
  const maxDepth = opts.maxDepth ?? 2
  const maxEntries = opts.maxEntries ?? 80
  return walk(path.resolve(workspaceRoot), 0, maxDepth, maxEntries)
}

async function walk(dir: string, depth: number, maxDepth: number, maxEntries: number): Promise<LayoutNode> {
  const node: LayoutNode = {
    abs_path: dir,
    children_dirs: [],
    children_files: [],
    children_were_processed: depth < maxDepth,
    num_files: 0,
  }
  if (depth >= maxDepth) return node
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    node.children_were_processed = false
    return node
  }
  names.sort()
  let count = 0
  for (const name of names) {
    if (count >= maxEntries) break
    if (name.startsWith(".") && name !== ".opencode" && name !== ".claude" && name !== ".agents") continue
    if (SKIP.has(name)) continue
    const full = path.join(dir, name)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    count++
    if (st.isDirectory()) {
      node.children_dirs.push(await walk(full, depth + 1, maxDepth, maxEntries))
    } else {
      node.children_files.push({ name })
      node.num_files++
    }
  }
  return node
}
