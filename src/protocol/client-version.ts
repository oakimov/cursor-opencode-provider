import fs from "node:fs"
import path from "node:path"
import {
  FALLBACK_CLIENT_VERSION,
  MODEL_CACHE_TTL_MS,
  VERSION_CACHE_FILE,
} from "../shared.js"
import { opencodeGlobalCacheDir } from "../context/paths.js"
import { withAbortDeadline } from "../deadline.js"

const INSTALL_URL = "https://cursor.com/install"
const REMOTE_TIMEOUT_MS = 5_000
const BUILD_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9A-Za-z][0-9A-Za-z.-]*$/
const CLIENT_VERSION_RE = /^cli-[0-9A-Za-z][0-9A-Za-z._-]*$/

type VersionCache = { version: string; fetchedAt: number }

let cachedResolution: Promise<string> | undefined

export function resetClientVersionCache(): void {
  cachedResolution = undefined
}

export function resolveClientVersion(): Promise<string> {
  cachedResolution ??= resolve()
  return cachedResolution
}

async function resolve(): Promise<string> {
  const env = process.env.CURSOR_CLIENT_VERSION?.trim()
  if (isClientVersion(env)) return env

  const local = discoverLocalVersion()
  if (local) return local

  return (await resolveRemoteVersion()) ?? FALLBACK_CLIENT_VERSION
}

function isClientVersion(value: unknown): value is string {
  return typeof value === "string" && CLIENT_VERSION_RE.test(value)
}

export function cursorAgentVersionsDir(): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return undefined

  switch (process.platform) {
    case "linux":
    case "darwin":
      return path.join(home, ".local", "share", "cursor-agent", "versions")
    default:
      return undefined
  }
}

export function discoverLocalVersion(
  dir = cursorAgentVersionsDir(),
): string | undefined {
  if (!dir) return undefined

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }

  let newest: { name: string; mtimeMs: number } | undefined
  for (const entry of entries) {
    if (!entry.isDirectory() || !BUILD_RE.test(entry.name)) continue
    try {
      const mtimeMs = fs.statSync(path.join(dir, entry.name)).mtimeMs
      if (
        !newest ||
        mtimeMs > newest.mtimeMs ||
        (mtimeMs === newest.mtimeMs && entry.name > newest.name)
      ) {
        newest = { name: entry.name, mtimeMs }
      }
    } catch {
      // Directory disappeared during discovery.
    }
  }

  return newest ? `cli-${newest.name}` : undefined
}

export function extractVersionFromInstaller(script: string): string | undefined {
  const match = script.match(/downloads\.cursor\.com\/lab\/([^/"'\s]+)\//)
  return match && BUILD_RE.test(match[1]) ? match[1] : undefined
}

function versionCachePath(): string {
  return path.join(opencodeGlobalCacheDir(), VERSION_CACHE_FILE)
}

function readVersionCache(): VersionCache | undefined {
  const file = versionCachePath()

  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    if (
      !isClientVersion(value.version) ||
      typeof value.fetchedAt !== "number" ||
      !Number.isFinite(value.fetchedAt)
    ) {
      return undefined
    }
    return { version: value.version, fetchedAt: value.fetchedAt }
  } catch {
    return undefined
  }
}

function writeVersionCache(cache: VersionCache): void {
  const file = versionCachePath()

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cache, null, 2))
  } catch {
    // Cache writes are optional.
  }
}

function isCacheFresh(cache: VersionCache, now = Date.now()): boolean {
  const age = now - cache.fetchedAt
  return age >= 0 && age < MODEL_CACHE_TTL_MS
}

async function fetchInstallerVersion(): Promise<string | undefined> {
  return withAbortDeadline(
    REMOTE_TIMEOUT_MS,
    () => new Error("Cursor installer version request timed out"),
    async (signal) => {
      const response = await fetch(INSTALL_URL, { signal })
      if (!response.ok) return undefined

      const build = extractVersionFromInstaller(await response.text())
      return build ? `cli-${build}` : undefined
    },
  )
}

async function refreshVersionCache(): Promise<void> {
  const version = await fetchInstallerVersion()
  if (version) writeVersionCache({ version, fetchedAt: Date.now() })
}

async function resolveRemoteVersion(): Promise<string | undefined> {
  const cached = readVersionCache()
  if (cached && isCacheFresh(cached)) {
    void refreshVersionCache().catch(() => {})
    return cached.version
  }

  try {
    const version = await fetchInstallerVersion()
    if (version) {
      writeVersionCache({ version, fetchedAt: Date.now() })
      return version
    }
  } catch {
    // Use stale cache or the fallback below.
  }

  return cached?.version
}