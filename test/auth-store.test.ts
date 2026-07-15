import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { asStoredAuth, readStoredAuth } from "../src/context/auth-store.js"

const originalHome = process.env.HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const originalDebug = process.env.CURSOR_PROVIDER_DEBUG

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  if (originalDebug === undefined) delete process.env.CURSOR_PROVIDER_DEBUG
  else process.env.CURSOR_PROVIDER_DEBUG = originalDebug
})

describe("readStoredAuth", () => {
  it("reads cursor credentials from auth.json under the data dir", async () => {
    const fakeHome = path.join(os.tmpdir(), `auth-store-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    const dataDir = path.join(fakeHome, ".local", "share", "opencode")
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      path.join(dataDir, "auth.json"),
      JSON.stringify({
        cursor: { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 60_000 },
      }),
    )

    try {
      const auth = await readStoredAuth("cursor")
      expect(auth).toEqual({
        type: "oauth",
        access: "tok",
        refresh: "ref",
        expires: expect.any(Number),
      })
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it("prefers OPENCODE_AUTH_CONTENT when set", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      cursor: { type: "api", key: "from-env" },
    })
    expect(await readStoredAuth("cursor")).toEqual({ type: "api", key: "from-env" })
  })

  it("returns undefined when missing", async () => {
    const fakeHome = path.join(os.tmpdir(), `auth-store-miss-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    expect(await readStoredAuth("cursor")).toBeUndefined()
    await rm(fakeHome, { recursive: true, force: true })
  })

  it("returns undefined for invalid JSON without throwing", async () => {
    const fakeHome = path.join(os.tmpdir(), `auth-store-badjson-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    const dataDir = path.join(fakeHome, ".local", "share", "opencode")
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, "auth.json"), "{not-json")

    try {
      expect(await readStoredAuth("cursor")).toBeUndefined()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it("returns undefined for empty cursor entry", async () => {
    const fakeHome = path.join(os.tmpdir(), `auth-store-empty-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    const dataDir = path.join(fakeHome, ".local", "share", "opencode")
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, "auth.json"), JSON.stringify({ cursor: {} }))

    try {
      expect(await readStoredAuth("cursor")).toBeUndefined()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it("returns undefined for oauth missing access", async () => {
    const fakeHome = path.join(os.tmpdir(), `auth-store-noaccess-${process.pid}-${Date.now()}`)
    process.env.HOME = fakeHome
    delete process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_AUTH_CONTENT
    const dataDir = path.join(fakeHome, ".local", "share", "opencode")
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      path.join(dataDir, "auth.json"),
      JSON.stringify({
        cursor: { type: "oauth", refresh: "ref", expires: Date.now() },
      }),
    )

    try {
      expect(await readStoredAuth("cursor")).toBeUndefined()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })
})

describe("asStoredAuth", () => {
  it("rejects wellknown until it is wired through resolveAccessToken", () => {
    expect(
      asStoredAuth({ type: "wellknown", key: "k", token: "t" }),
    ).toBeUndefined()
  })
})
