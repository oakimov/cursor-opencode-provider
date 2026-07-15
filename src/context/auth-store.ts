import { readFile } from "node:fs/promises"
import path from "node:path"
import { opencodeGlobalDataDir } from "./paths.js"

/** Mirrors OpenCode / SDK OAuth + API auth used for Cursor. `wellknown` is not wired yet. */
export type StoredAuth =
  | {
      type: "oauth"
      access: string
      refresh: string
      expires: number
      accountId?: string
      enterpriseUrl?: string
    }
  | {
      type: "api"
      key: string
      metadata?: Record<string, string>
    }

function debugEnabled(): boolean {
  return process.env.CURSOR_PROVIDER_DEBUG === "1" || process.env.CURSOR_PROVIDER_DEBUG === "true"
}

function debugAuthStore(message: string): void {
  if (!debugEnabled()) return
  console.error(`[cursor-opencode-provider] auth-store: ${message}`)
}

/**
 * Read a provider's credentials from OpenCode's `auth.json` (XDG data dir).
 *
 * Honors `OPENCODE_AUTH_CONTENT` when set — same injection hook OpenCode core
 * uses in tests / embedded runs (not an SDK export).
 */
export async function readStoredAuth(providerId: string): Promise<StoredAuth | undefined> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      const data = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
      return asStoredAuth(data[providerId])
    } catch {
      debugAuthStore("OPENCODE_AUTH_CONTENT is not valid JSON")
      return undefined
    }
  }

  const filePath = path.join(opencodeGlobalDataDir(), "auth.json")
  try {
    const raw = await readFile(filePath, "utf-8")
    try {
      const data = JSON.parse(raw) as Record<string, unknown>
      return asStoredAuth(data[providerId])
    } catch {
      debugAuthStore("auth.json is not valid JSON")
      return undefined
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") {
      debugAuthStore(`failed to read auth.json (${code ?? "unknown"})`)
    }
    return undefined
  }
}

export function asStoredAuth(value: unknown): StoredAuth | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (
    v.type === "oauth" &&
    typeof v.access === "string" &&
    typeof v.refresh === "string" &&
    typeof v.expires === "number"
  ) {
    return value as StoredAuth
  }
  if (v.type === "api" && typeof v.key === "string") {
    return value as StoredAuth
  }
  // wellknown is intentionally rejected until resolveAccessToken supports it
  return undefined
}
