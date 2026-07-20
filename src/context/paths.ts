import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { trace } from "../debug.js"

export type HostPathEnv = NodeJS.ProcessEnv

/** Explicit host cache root (e.g. Effect v2 `Path.cache`, or `createCursor({ cacheDir })`). */
let hostCacheDirOverride: string | undefined

function resolveHome(env: HostPathEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir()
}

function xdgCacheHome(env: HostPathEnv = process.env): string {
  if (env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0) return env.XDG_CACHE_HOME
  return path.join(resolveHome(env), ".cache")
}

function xdgConfigHome(env: HostPathEnv = process.env): string {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) return env.XDG_CONFIG_HOME
  return path.join(resolveHome(env), ".config")
}

/**
 * Pin the process-wide cache root. Highest precedence for {@link opencodeGlobalCacheDir}.
 * Use for host-injected `Path.cache` or an explicit `createCursor({ cacheDir })`.
 */
export function setHostCacheDirOverride(dir: string | undefined): void {
  hostCacheDirOverride = dir && dir.length > 0 ? path.resolve(dir) : undefined
}

export function getHostCacheDirOverride(): string | undefined {
  return hostCacheDirOverride
}

/**
 * Resolve the host cache directory without an override.
 * Mirrors OCP HostProfile drafts: MiMo (`mimocode` / `$MIMOCODE_HOME`), Kilo (`kilo`),
 * then OpenCode (`opencode`). Prefer fork config dirs when several exist.
 */
export function resolveHostCacheDir(env: HostPathEnv = process.env): string {
  const mimoHome = env.MIMOCODE_HOME
  if (mimoHome && mimoHome.length > 0) {
    return path.join(mimoHome, "cache")
  }

  const configHome = xdgConfigHome(env)
  const cacheHome = xdgCacheHome(env)
  const kiloConfig = env.KILO_CONFIG_DIR

  // Prefer more specific fork dirs before OpenCode (same order as OCP detect).
  if ((kiloConfig && kiloConfig.length > 0) || existsSync(path.join(configHome, "kilo"))) {
    return path.join(cacheHome, "kilo")
  }
  if (existsSync(path.join(configHome, "mimocode"))) {
    return path.join(cacheHome, "mimocode")
  }
  return path.join(cacheHome, "opencode")
}

/**
 * Best-effort: if `@opencode-compat/profile` is installed, adopt `detect().profile.paths.cacheDir`
 * when the host is supported. No-op when OCP is absent or detection fails.
 */
export async function adoptCompatHostCacheDir(): Promise<string | undefined> {
  try {
    const { detect } = await import("@opencode-compat/profile")
    const result = detect()
    if (!result.supported || result.id === "unknown") return undefined
    const cacheDir = result.profile.paths.cacheDir
    if (!cacheDir || cacheDir.length === 0) return undefined
    setHostCacheDirOverride(cacheDir)
    trace(`host-cache: adopted OCP detect cacheDir=${cacheDir} host=${result.id}`)
    return cacheDir
  } catch {
    return undefined
  }
}

/** OpenCode / host global config dir (`~/.config/<app>`). Still OpenCode-named for rule discovery. */
export function opencodeGlobalConfigDir(): string {
  return path.join(resolveHome(), ".config", "opencode")
}

/**
 * Host global cache dir for Cursor project metadata + model/version caches.
 *
 * Precedence:
 * 1. {@link setHostCacheDirOverride} / `createCursor({ cacheDir })` (host `Path.cache`)
 * 2. OCP `detect()` when {@link adoptCompatHostCacheDir} ran successfully
 * 3. Local host heuristic ({@link resolveHostCacheDir})
 */
export function opencodeGlobalCacheDir(): string {
  if (hostCacheDirOverride) return hostCacheDirOverride
  return resolveHostCacheDir()
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
 * Used for per-workspace metadata under the host cache.
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
 * Lives at `<host-cache>/projects/<slug>/` (OpenCode / MiMo / Kilo cache root).
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
      `override=${hostCacheDirOverride ?? "(none)"} ` +
      `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"}`,
  )
  return dir
}

export function resolveHomeRelative(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2))
  return p
}
