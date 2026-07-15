import { homedir } from "node:os"
import path from "node:path"

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

export function resolveHomeRelative(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2))
  return p
}
