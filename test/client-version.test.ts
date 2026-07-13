import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FALLBACK_CLIENT_VERSION } from "../src/shared.js"
import {
  cursorAgentVersionsDir,
  discoverLocalVersion,
  extractVersionFromInstaller,
  resetClientVersionCache,
  resolveClientVersion,
} from "../src/protocol/client-version.js"

const INSTALLER_FIXTURE = `
DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.07.09-a3815c0/\${OS}/\${ARCH}/agent-cli-package.tar.gz"
FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.07.09-a3815c0"
`

const ENV_KEYS = [
  "CURSOR_CLIENT_VERSION",
  "CURSOR_CONFIG_DIR",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const

let tmp: string
let realFetch: typeof globalThis.fetch
let savedEnv: Map<string, string | undefined>

function writeVersionCache(version: unknown, fetchedAt: unknown): void {
  fs.writeFileSync(
    path.join(tmp, "cursor-client-version.json"),
    JSON.stringify({ version, fetchedAt }),
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "client-version-test-"))
  realFetch = globalThis.fetch
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CURSOR_CONFIG_DIR = tmp
  process.env.HOME = tmp
  process.env.USERPROFILE = tmp
  resetClientVersionCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetClientVersionCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("extractVersionFromInstaller", () => {
  it("extracts the build from the official download URL", () => {
    expect(extractVersionFromInstaller(INSTALLER_FIXTURE)).toBe("2026.07.09-a3815c0")
  })

  it("accepts the irregular timestamp build form", () => {
    const script = "https://downloads.cursor.com/lab/2026.06.24-00-45-58-9f61de7/linux/x64/file"
    expect(extractVersionFromInstaller(script)).toBe("2026.06.24-00-45-58-9f61de7")
  })

  it("rejects a malformed build segment", () => {
    const script = "https://downloads.cursor.com/lab/not-a-build/linux/x64/file"
    expect(extractVersionFromInstaller(script)).toBeUndefined()
  })
})

describe("discoverLocalVersion", () => {
  it("returns the newest valid build directory by mtime", () => {
    const older = path.join(tmp, "2026.06.26-7079533")
    const newer = path.join(tmp, "2026.07.09-a3815c0")
    fs.mkdirSync(older)
    fs.mkdirSync(newer)
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(older, past, past)
    expect(discoverLocalVersion(tmp)).toBe("cli-2026.07.09-a3815c0")
  })

  it("ignores files, hidden directories, and invalid build names", () => {
    fs.writeFileSync(path.join(tmp, "2026.07.10-not-a-directory"), "")
    fs.mkdirSync(path.join(tmp, ".tmp-2026.07.10-deadbeef"))
    fs.mkdirSync(path.join(tmp, "garbage"))
    expect(discoverLocalVersion(tmp)).toBeUndefined()
  })

  it("returns undefined for a missing directory", () => {
    expect(discoverLocalVersion(path.join(tmp, "missing"))).toBeUndefined()
  })
})

describe("resolveClientVersion", () => {
  it("prefers a valid environment override without touching lower sources", async () => {
    process.env.CURSOR_CLIENT_VERSION = "  cli-override-123  "
    const versionsDir = cursorAgentVersionsDir()
    if (versionsDir) fs.mkdirSync(path.join(versionsDir, "2026.07.09-local"), { recursive: true })
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    expect(await resolveClientVersion()).toBe("cli-override-123")
    expect(fetchCalls).toBe(0)
  })

  it("ignores an invalid environment override", async () => {
    process.env.CURSOR_CLIENT_VERSION = "bad\r\nheader"
    globalThis.fetch = (async () =>
      new Response(INSTALLER_FIXTURE, { status: 200 })) as typeof fetch
    expect(await resolveClientVersion()).toBe("cli-2026.07.09-a3815c0")
  })

  it("uses the remote installer with no environment or local build", async () => {
    globalThis.fetch = (async () =>
      new Response(INSTALLER_FIXTURE, { status: 200 })) as typeof fetch
    expect(await resolveClientVersion()).toBe("cli-2026.07.09-a3815c0")
  })

  it("returns a fresh cache entry and starts background refresh", async () => {
    writeVersionCache("cli-cached-123", Date.now())
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    expect(await resolveClientVersion()).toBe("cli-cached-123")
    expect(fetchCalls).toBe(1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })

  it("serves an expired cache entry when refresh fails", async () => {
    writeVersionCache("cli-cached-999", 0)
    globalThis.fetch = (async () => { throw new Error("offline") }) as typeof fetch
    expect(await resolveClientVersion()).toBe("cli-cached-999")
  })

  it("ignores malformed cache data and uses the fallback offline", async () => {
    writeVersionCache("not-a-client-version", "yesterday")
    globalThis.fetch = (async () => { throw new Error("offline") }) as typeof fetch
    expect(await resolveClientVersion()).toBe(FALLBACK_CLIENT_VERSION)
  })

  it("memoizes the full chain for the process lifetime", async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(INSTALLER_FIXTURE, { status: 200 })
    }) as typeof fetch

    expect(await resolveClientVersion()).toBe("cli-2026.07.09-a3815c0")
    expect(await resolveClientVersion()).toBe("cli-2026.07.09-a3815c0")
    expect(fetchCalls).toBe(1)
  })
})
