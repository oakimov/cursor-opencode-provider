import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { trace } from "../debug.js"

export type HostPathEnv = NodeJS.ProcessEnv

/** Structural host-path capability installed before an unchanged provider loads. */
export const HOST_PATH_BRIDGE = Symbol.for("opencode.host.path-bridge")
export type OpenCodePathBridge = {
  projectConfigDirs: (workspaceRoot: string) => string[]
  globalConfigDirs: () => string[]
  /** Optional host-owned durable data root; absent means native OpenCode defaults. */
  globalDataDir?: () => string
  /** Optional host-owned cache root; absent means native OpenCode defaults. */
  globalCacheDir?: () => string
  configFileNames?: string[]
}

function pathBridge(): OpenCodePathBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  if (!value || typeof value !== "object") return undefined
  const bridge = value as Partial<OpenCodePathBridge>
  return typeof bridge.projectConfigDirs === "function" && typeof bridge.globalConfigDirs === "function"
    ? bridge as OpenCodePathBridge
    : undefined
}

function openCodeGlobalDataDir(env: HostPathEnv = process.env): string {
  if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0) {
    return path.join(env.XDG_DATA_HOME, "opencode")
  }
  return path.join(resolveHome(env), ".local", "share", "opencode")
}

function openCodeGlobalCacheDir(env: HostPathEnv = process.env): string {
  return path.join(xdgCacheHome(env), "opencode")
}

function bridgeGlobalDataDir(): string | undefined {
  const value = pathBridge()?.globalDataDir?.()
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
}

function bridgeGlobalCacheDir(): string | undefined {
  const value = pathBridge()?.globalCacheDir?.()
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
}

export function opencodeProjectConfigDirs(workspaceRoot: string): string[] {
  return pathBridge()?.projectConfigDirs(path.resolve(workspaceRoot)) ?? [
    path.join(path.resolve(workspaceRoot), ".opencode"),
  ]
}

export function opencodeGlobalConfigDirs(): string[] {
  return pathBridge()?.globalConfigDirs() ?? [opencodeGlobalConfigDir()]
}

export function opencodeConfigFileNames(): string[] {
  return pathBridge()?.configFileNames?.length
    ? [...pathBridge()!.configFileNames!]
    : ["opencode.json", "opencode.jsonc"]
}


/** Explicit host cache root (e.g. Effect v2 `Path.cache`, or `createCursor({ cacheDir })`). */
let hostCacheDirOverride: string | undefined

function resolveHome(env: HostPathEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir()
}

function xdgCacheHome(env: HostPathEnv = process.env): string {
  if (env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0) return env.XDG_CACHE_HOME
  return path.join(resolveHome(env), ".cache")
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

/** Resolve the native OpenCode cache root when no host bridge is installed. */
export function resolveHostCacheDir(env: HostPathEnv = process.env): string {
  return bridgeGlobalCacheDir() ?? openCodeGlobalCacheDir(env)
}

/** Native OpenCode global config dir. */
export function opencodeGlobalConfigDir(): string {
  return path.join(resolveHome(), ".config", "opencode")
}

/**
 * Host global cache dir for Cursor project metadata + model/version caches.
 *
 * Precedence:
 * 1. {@link setHostCacheDirOverride} / `createCursor({ cacheDir })` (host `Path.cache`)
 * 2. An injected structural host path bridge
 * 3. Native OpenCode XDG defaults ({@link resolveHostCacheDir})
 */
export function opencodeGlobalCacheDir(): string {
  if (hostCacheDirOverride) return hostCacheDirOverride
  return resolveHostCacheDir()
}

/** Native OpenCode global data root. */
export function opencodeGlobalDataDir(env: HostPathEnv = process.env): string {
  return openCodeGlobalDataDir(env)
}

/** Host-portable durable data root; falls back to native OpenCode. */
export function hostGlobalDataDir(env: HostPathEnv = process.env): string {
  return bridgeGlobalDataDir() ?? openCodeGlobalDataDir(env)
}

/**
 * Directory for host plan files — always `<hostGlobalDataDir()>/plans`, and
 * never inside the user's repository.
 *
 * OpenCode's own `Session.plan` branches on VCS and puts plans in the worktree
 * (`<worktree>/.opencode/plans`) for a git project. The provider deliberately
 * does *not* mirror that branch. Writing there means a throwaway plan lands in
 * the user's tree untracked-but-unignored, and — because OpenCode installs
 * `@opencode-ai/plugin` into every `.opencode` directory it discovers walking up
 * from the cwd — creating that directory also bootstraps a project-local
 * `node_modules`. The provider must add nothing to a repository it did not
 * already contain.
 *
 * The global-data location is not a degraded fallback: it is the branch OpenCode
 * itself uses when there is no VCS, and its plan agent allow-lists that path for
 * `edit` / `external_directory` alongside the in-worktree one. {@link
 * hostGlobalDataDir} carries an optional injected host translation; without a
 * bridge it is the native OpenCode data root.
 */
export function hostPlansDir(_workspaceRoot?: string): string {
  return path.join(hostGlobalDataDir(), "plans")
}

/**
 * Cursor-compatible path slug (`/Users/a/b` → `Users-a-b`).
 * Used for per-workspace metadata under the host cache.
 */
export function slugifyWorkspacePath(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  return resolved
    .replace(/[^a-zA-Z0-9]/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-")
}

/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `<host-cache>/projects/<slug>/` under the resolved OpenCode/host cache root.
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
