import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { trace } from "../debug.js"

export type HostPathEnv = NodeJS.ProcessEnv

/** Host-neutral bridge installed by OCP before an unchanged provider is loaded. */
export const OPENCODE_PATH_BRIDGE = Symbol.for("opencode.compat.path-bridge")
export type OpenCodePathBridge = {
  projectConfigDirs: (workspaceRoot: string) => string[]
  globalConfigDirs: () => string[]
  configFileNames?: string[]
}

function pathBridge(): OpenCodePathBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[OPENCODE_PATH_BRIDGE]
  if (!value || typeof value !== "object") return undefined
  const bridge = value as Partial<OpenCodePathBridge>
  return typeof bridge.projectConfigDirs === "function" && typeof bridge.globalConfigDirs === "function"
    ? bridge as OpenCodePathBridge
    : undefined
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

type CompatDetectResult = {
  id: string
  supported: boolean
  source?: string
  profile: { paths: { cacheDir: string } }
}

type CompatDetector = () => CompatDetectResult

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

const HOST_CACHE_DIRS = ["mimocode", "kilo", "opencode", "pi", "omp"] as const
export type HostCacheDir = (typeof HOST_CACHE_DIRS)[number]

const PI_FAMILY_CACHE_NAMESPACE = "cursor-opencode"

function configuredPath(value: string, env: HostPathEnv): string {
  const home = resolveHome(env)
  if (value === "~") return home
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return path.resolve(value)
}

/**
 * Pi-family plugins do not have an OpenCode cache root. Keep the provider's
 * private model/conversation state beside the host's own agent state instead
 * of silently creating ~/.cache/opencode on machines without OpenCode.
 *
 * OMP's XDG migration makes $XDG_CACHE_HOME/omp the cache root once that
 * directory exists; otherwise its portable/default root remains ~/.omp/agent.
 * Pi's durable agent root is ~/.pi/agent (or PI_CODING_AGENT_DIR).
 */
function piFamilyCacheDir(host: "pi" | "omp", env: HostPathEnv): string {
  if (host === "omp" && env.XDG_CACHE_HOME) {
    const xdgRoot = path.join(env.XDG_CACHE_HOME, "omp")
    if (existsSync(xdgRoot)) return path.join(xdgRoot, PI_FAMILY_CACHE_NAMESPACE)
  }

  const agentDir = env.PI_CODING_AGENT_DIR
    ? configuredPath(env.PI_CODING_AGENT_DIR, env)
    : path.join(resolveHome(env), env.PI_CONFIG_DIR || (host === "pi" ? ".pi" : ".omp"), "agent")
  return path.join(agentDir, "cache", PI_FAMILY_CACHE_NAMESPACE)
}

/**
 * Host cache-dir name inferred from the running binary (`argv[0]` /
 * `process.execPath`). A source-checkout provider can't be located by install
 * path, but the binary that loaded it is authoritative: when this process IS
 * `mimo` / `kilocode`, the cache root is that host's, not OpenCode's. Mirrors
 * OCP `detect()` binaryHint semantics and tolerates the leading-dot Kilo binary
 * (`.kilo`). Only `argv[0]` is inspected — later argv entries are arguments,
 * not binary identity, and could otherwise cause false positives (e.g. an
 * `--opencode-config=…` flag under a fork).
 */
export function hostCacheDirFromProcess(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): HostCacheDir | undefined {
  for (const raw of [argv[0], execPath]) {
    if (!raw) continue
    const name = path.basename(String(raw)).toLowerCase().replace(/^\.+/, "")
    if (
      name === "mimo" ||
      name === "mimocode" ||
      name.startsWith("mimo-") ||
      name.includes("mimocode")
    ) {
      return "mimocode"
    }
    if (
      name === "kilo" ||
      name === "kilocode" ||
      name.startsWith("kilo-") ||
      name.includes("kilocode")
    ) {
      return "kilo"
    }
    if (
      name === "opencode" ||
      name.startsWith("opencode-") ||
      name.includes("opencode")
    ) {
      return "opencode"
    }
    if (name === "pi" || name.startsWith("pi-")) return "pi"
    if (name === "omp" || name.startsWith("omp-")) return "omp"
  }
  return undefined
}

/**
 * Resolve the host cache directory without an override.
 *
 * Explicit host environment wins. Otherwise, an installed provider inherits
 * the host-named cache containing its module; a source checkout is attributed
 * by the running binary identity (see {@link hostCacheDirFromProcess}). Merely
 * having another host's config directory installed is not evidence that it
 * owns this process.
 */
export function resolveHostCacheDir(
  env: HostPathEnv = process.env,
  moduleUrl: string = import.meta.url,
  processIdentity: { argv?: readonly string[]; execPath?: string } = {},
): string {
  const mimoHome = env.MIMOCODE_HOME
  if (mimoHome && mimoHome.length > 0) {
    return path.join(mimoHome, "cache")
  }

  const cacheHome = xdgCacheHome(env)
  const kiloConfig = env.KILO_CONFIG_DIR
  if (kiloConfig && kiloConfig.length > 0) {
    return path.join(cacheHome, "kilo")
  }

  const processHost = hostCacheDirFromProcess(
    processIdentity.argv ?? process.argv,
    processIdentity.execPath ?? process.execPath,
  )
  if (processHost === "pi" || processHost === "omp") return piFamilyCacheDir(processHost, env)

  let modulePath: string | undefined
  try {
    modulePath = moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : path.resolve(moduleUrl)
  } catch {
    modulePath = undefined
  }
  if (modulePath) {
    for (const host of HOST_CACHE_DIRS) {
      const root = path.resolve(cacheHome, host)
      if (modulePath === root || modulePath.startsWith(`${root}${path.sep}`)) return root
    }
  }

  // Source checkout: the module path can't name the host, but the binary that
  // loaded us can (running as `mimo` / `kilocode` / `opencode`).
  const host = processHost
  if (host) return path.join(cacheHome, host)

  return path.join(cacheHome, "opencode")
}

/**
 * Best-effort: if `@opencode-compat/profile` is installed, adopt `detect().profile.paths.cacheDir`
 * when the host is supported. No-op when OCP is absent or detection fails.
 */
export async function adoptCompatHostCacheDir(
  detector?: CompatDetector,
): Promise<string | undefined> {
  if (hostCacheDirOverride) return hostCacheDirOverride

  // The optional OCP detector predates Pi-family hosts and can see generic
  // OpenCode compatibility environment variables while a Pi/OMP process is
  // actually running. The active binary is stronger evidence: never let an
  // installed compatibility package redirect a Pi-only installation into an
  // OpenCode cache.
  const processHost = hostCacheDirFromProcess()
  if (processHost === "pi" || processHost === "omp") {
    const cacheDir = piFamilyCacheDir(processHost, process.env)
    setHostCacheDirOverride(cacheDir)
    trace(`host-cache: selected Pi-family cacheDir=${cacheDir} host=${processHost}`)
    return cacheDir
  }

  try {
    const detect = detector ?? (await import("@opencode-compat/profile")).detect
    const result = detect()
    if (!result.supported || result.id === "unknown") return undefined
    if (!result.source || !["env", "binary", "package"].includes(result.source)) {
      trace(`host-cache: ignored weak OCP detect host=${result.id} source=${result.source ?? "unknown"}`)
      return undefined
    }
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
 * 2. Strong OCP `detect()` identity when {@link adoptCompatHostCacheDir} ran successfully
 * 3. Explicit host environment / provider install path ({@link resolveHostCacheDir})
 */
export function opencodeGlobalCacheDir(): string {
  if (hostCacheDirOverride) return hostCacheDirOverride
  return resolveHostCacheDir()
}

/**
 * OpenCode global data dir (`~/.local/share/opencode`).
 * Uses `$XDG_DATA_HOME/opencode` when set, otherwise `$HOME/.local/share/opencode`.
 * Auth credentials live here in `auth.json`.
 *
 * Prefer {@link hostGlobalDataDir} for host-portable artifacts (plans, etc.).
 */
export function opencodeGlobalDataDir(): string {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "opencode")
  }
  return path.join(resolveHome(), ".local", "share", "opencode")
}

/**
 * XDG-style app name for the active host (`opencode` / `mimocode` / `kilo` / …).
 * Used when placing durable host artifacts outside a git worktree.
 */
export function hostDataAppName(env: HostPathEnv = process.env): string {
  if (env.MIMOCODE_HOME && env.MIMOCODE_HOME.length > 0) return "mimocode"
  if (env.KILO_CONFIG_DIR && env.KILO_CONFIG_DIR.length > 0) return "kilo"
  const processHost = hostCacheDirFromProcess()
  if (processHost === "mimocode" || processHost === "kilo" || processHost === "opencode") {
    return processHost
  }
  if (processHost === "pi" || processHost === "omp") return processHost
  // Path bridge global config is authoritative when OCP installed the host dirs.
  const [globalConfig] = opencodeGlobalConfigDirs()
  if (globalConfig) {
    const base = path.basename(path.resolve(globalConfig))
    if (base && base !== "." && base !== "..") return base
  }
  return "opencode"
}

/**
 * Host global data root (OpenCode `Global.Path.data` equivalent).
 * - MiMo / Kilo / OpenCode → `$XDG_DATA_HOME/<app>` or `~/.local/share/<app>`
 * - Pi / OMP → `<agent-root>/` (same durable root as their agent state)
 */
export function hostGlobalDataDir(env: HostPathEnv = process.env): string {
  const app = hostDataAppName(env)
  if (app === "pi" || app === "omp") {
    if (env.PI_CODING_AGENT_DIR) return configuredPath(env.PI_CODING_AGENT_DIR, env)
    return path.join(resolveHome(env), env.PI_CONFIG_DIR || (app === "pi" ? ".pi" : ".omp"), "agent")
  }
  if (env.MIMOCODE_HOME && env.MIMOCODE_HOME.length > 0 && app === "mimocode") {
    return path.resolve(env.MIMOCODE_HOME)
  }
  if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0) {
    return path.join(env.XDG_DATA_HOME, app)
  }
  return path.join(resolveHome(env), ".local", "share", app)
}

/**
 * Directory for host plan files — same shape as OpenCode `Session.plan`, but
 * the project-config segment comes from {@link opencodeProjectConfigDirs}
 * (`.opencode` / `.mimocode` / `.kilo` / …) rather than a hardcoded name.
 *
 * - git worktree → `<primary-project-config-dir>/plans`
 * - otherwise → `<hostGlobalDataDir()>/plans`
 */
export function hostPlansDir(workspaceRoot: string): string {
  let dir = path.resolve(workspaceRoot)
  let worktree: string | undefined
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      worktree = dir
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (worktree) {
    // Primary project-config dir from the path bridge (OpenCode → `.opencode`,
    // MiMo → `.mimocode`, Kilo → `.kilo`/`.kilocode`, …). Never hardcode a host
    // name here — the bridge / default list already encodes it.
    const [projectConfigDir] = opencodeProjectConfigDirs(worktree)
    if (!projectConfigDir) {
      throw new Error("hostPlansDir: opencodeProjectConfigDirs returned no project config dir")
    }
    return path.join(projectConfigDir, "plans")
  }
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
