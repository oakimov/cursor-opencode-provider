import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { opencodeGlobalConfigDir } from "./paths.js"
import type { OpencodeJson } from "./rules.js"

export type CollectedPlugin = {
  id: string
  source: "npm" | "local"
  path?: string
}

async function listLocalPlugins(dir: string): Promise<CollectedPlugin[]> {
  try {
    await stat(dir)
  } catch {
    return []
  }
  const out: CollectedPlugin[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  for (const name of entries) {
    if (!/\.(m?[jt]s)$/.test(name)) continue
    const full = path.join(dir, name)
    out.push({ id: name.replace(/\.(m?[jt]s)$/, ""), source: "local", path: full })
  }
  return out
}

/** OpenCode plugins from config + local plugin directories (metadata only). */
export async function collectPlugins(
  workspaceRoot: string,
  config: OpencodeJson,
): Promise<CollectedPlugin[]> {
  const out: CollectedPlugin[] = []
  const seen = new Set<string>()
  for (const id of [...(config.plugin ?? []), ...(config.plugins ?? [])]) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, source: "npm" })
  }
  for (const p of await listLocalPlugins(path.join(workspaceRoot, ".opencode", "plugins"))) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  for (const p of await listLocalPlugins(path.join(opencodeGlobalConfigDir(), "plugins"))) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}
