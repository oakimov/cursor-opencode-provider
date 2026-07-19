import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { trace } from "../debug.js"

function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

/** OpenCode global config dir (`~/.config/opencode`). */
export function opencodeGlobalConfigDir(): string {
  return path.join(resolveHome(), ".config", "opencode")
}

/**
 * OpenCode global cache dir (`~/.cache/opencode`).
 * Uses `$XDG_CACHE_HOME/opencode` when set, otherwise `$HOME/.cache/opencode`.
 */
export function opencodeGlobalCacheDir(): string {
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "opencode")
  }
  return path.join(resolveHome(), ".cache", "opencode")
}

/**
 * OpenCode global data dir (`~/.local/share/opencode`).
 * Uses `$XDG_DATA_HOME/opencode` when set, otherwise `$HOME/.local/share/opencode`.
 * Auth credentials live here in `auth.json`.
 */
export function opencodeGlobalDataDir(): string {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "opencode")
  }
  return path.join(resolveHome(), ".local", "share", "opencode")
}

/**
 * Cursor-compatible path slug (`/Users/a/b` → `Users-a-b`).
 * Used for per-workspace metadata under the OpenCode cache.
 */
export function slugifyWorkspacePath(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  return resolved
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `~/.cache/opencode/projects/<slug>/` (or under `$XDG_CACHE_HOME`).
 *
 * This is what Cursor's RequestContextEnv.project_folder / MCP
 * workspace_project_dir point at — agent-tools, terminals, transcripts, etc.
 * Must NOT be the git workspace, or those dumps land in the repo.
 */
export function opencodeProjectDir(workspaceRoot: string): string {
  const projectsRoot = path.join(opencodeGlobalCacheDir(), "projects")
  const slug = slugifyWorkspacePath(workspaceRoot)
  let dir = path.join(projectsRoot, slug)
  // Mirror Cursor's long-path guard so nested agent-tools paths stay usable.
  if (dir.length > 92) {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 7)
    dir = `${dir.slice(0, Math.min(84, dir.length))}-${hash}`
  }
  return dir
}

/** Ensure {@link opencodeProjectDir} exists (mode 0o700) and return it. */
export function ensureOpencodeProjectDir(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  const dir = opencodeProjectDir(resolved)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  trace(
    `project-dir: workspace=${resolved} slug=${slugifyWorkspacePath(resolved)} ` +
      `dir=${dir} cache_root=${opencodeGlobalCacheDir()} ` +
      `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"}`,
  )
  return dir
}

export function resolveHomeRelative(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2))
  return p
}