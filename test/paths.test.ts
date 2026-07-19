import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import {
  ensureOpencodeProjectDir,
  opencodeGlobalCacheDir,
  opencodeGlobalConfigDir,
  opencodeGlobalDataDir,
  opencodeProjectDir,
  slugifyWorkspacePath,
} from "../src/context/paths.js"

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalXdgCache = process.env.XDG_CACHE_HOME
const originalXdgData = process.env.XDG_DATA_HOME

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCache
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
})

describe("opencodeGlobalCacheDir", () => {
  it("defaults to $HOME/.cache/opencode", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/fake-home", ".cache", "opencode"))
  })

  it("uses $XDG_CACHE_HOME/opencode when set", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/xdg-cache", "opencode"))
  })

  it("falls back to USERPROFILE when HOME is unset", () => {
    delete process.env.HOME
    process.env.USERPROFILE = "/tmp/win-home"
    delete process.env.XDG_CACHE_HOME
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/win-home", ".cache", "opencode"))
  })
})

describe("opencodeGlobalConfigDir", () => {
  it("stays under $HOME/.config/opencode", () => {
    process.env.HOME = "/tmp/fake-home"
    expect(opencodeGlobalConfigDir()).toBe(path.join("/tmp/fake-home", ".config", "opencode"))
  })
})

describe("opencodeGlobalDataDir", () => {
  it("defaults to $HOME/.local/share/opencode", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_DATA_HOME
    expect(opencodeGlobalDataDir()).toBe(path.join("/tmp/fake-home", ".local", "share", "opencode"))
  })

  it("uses $XDG_DATA_HOME/opencode when set", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_DATA_HOME = "/tmp/xdg-data"
    expect(opencodeGlobalDataDir()).toBe(path.join("/tmp/xdg-data", "opencode"))
  })
})

describe("opencodeProjectDir", () => {
  it("slugifies workspace paths like Cursor", () => {
    expect(slugifyWorkspacePath("/Users/a/b")).toBe("Users-a-b")
    expect(slugifyWorkspacePath("/tmp/foo_bar/baz")).toBe("tmp-foo-bar-baz")
  })

  it("lives under ~/.cache/opencode/projects/<slug>", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    expect(opencodeProjectDir("/Users/mitra/Projects/demo")).toBe(
      path.join("/tmp/fake-home", ".cache", "opencode", "projects", "Users-mitra-Projects-demo"),
    )
  })

  it("honors $XDG_CACHE_HOME for project metadata", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
    expect(opencodeProjectDir("/Users/a/b")).toBe(
      path.join("/tmp/xdg-cache", "opencode", "projects", "Users-a-b"),
    )
  })

  it("shortens long project dirs with a hash suffix", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    const longRoot = `/Users/${"x".repeat(120)}/project`
    const dir = opencodeProjectDir(longRoot)
    expect(dir.length).toBeLessThanOrEqual(92)
    expect(dir).toMatch(/-[0-9a-f]{7}$/)
    expect(dir.startsWith(path.join("/tmp/fake-home", ".cache", "opencode", "projects"))).toBe(true)
  })

  it("ensureOpencodeProjectDir creates the metadata root", () => {
    const cacheRoot = path.join("/tmp", `cursor-project-cache-${process.pid}-${Date.now()}`)
    process.env.XDG_CACHE_HOME = cacheRoot
    const dir = ensureOpencodeProjectDir("/Users/a/b")
    expect(dir).toBe(path.join(cacheRoot, "opencode", "projects", "Users-a-b"))
    expect(existsSync(dir)).toBe(true)
    rmSync(cacheRoot, { recursive: true, force: true })
  })
})