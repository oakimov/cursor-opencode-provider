import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import {
  ensureOpencodeProjectDir,
  getHostCacheDirOverride,
  opencodeGlobalCacheDir,
  opencodeGlobalConfigDir,
  opencodeGlobalDataDir,
  opencodeProjectDir,
  resolveHostCacheDir,
  setHostCacheDirOverride,
  slugifyWorkspacePath,
} from "../src/context/paths.js"

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalXdgCache = process.env.XDG_CACHE_HOME
const originalXdgData = process.env.XDG_DATA_HOME
const originalXdgConfig = process.env.XDG_CONFIG_HOME

afterEach(() => {
  setHostCacheDirOverride(undefined)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCache
  if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgData
  if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfig
})

describe("opencodeGlobalCacheDir", () => {
  it("defaults to $HOME/.cache/opencode", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/fake-home", ".cache", "opencode"))
  })

  it("uses $XDG_CACHE_HOME/opencode when set", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config-empty"
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/xdg-cache", "opencode"))
  })

  it("falls back to USERPROFILE when HOME is unset", () => {
    delete process.env.HOME
    process.env.USERPROFILE = "/tmp/win-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/win-home", ".cache", "opencode"))
  })

  it("honors setHostCacheDirOverride over XDG heuristics", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    setHostCacheDirOverride("/tmp/host-path-cache")
    expect(opencodeGlobalCacheDir()).toBe("/tmp/host-path-cache")
    expect(getHostCacheDirOverride()).toBe("/tmp/host-path-cache")
  })
})

describe("resolveHostCacheDir", () => {
  it("uses the native OpenCode XDG cache root", () => {
    expect(resolveHostCacheDir({ HOME: "/tmp/fake-home", XDG_CACHE_HOME: "/tmp/xdg-cache" }))
      .toBe(path.join("/tmp/xdg-cache", "opencode"))
  })

  it("falls back to HOME when XDG_CACHE_HOME is absent", () => {
    expect(resolveHostCacheDir({ HOME: "/tmp/fake-home" }))
      .toBe(path.join("/tmp/fake-home", ".cache", "opencode"))
  })

  it("adopts an optional bridge cache without knowing its host", () => {
    const key = Symbol.for("opencode.host.path-bridge")
    const previous = (globalThis as Record<PropertyKey, unknown>)[key]
    ;(globalThis as Record<PropertyKey, unknown>)[key] = {
      projectConfigDirs: () => [],
      globalConfigDirs: () => [],
      globalCacheDir: () => "/tmp/bridge-cache",
    }
    try {
      expect(resolveHostCacheDir({ HOME: "/tmp/fake-home" })).toBe("/tmp/bridge-cache")
    } finally {
      if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[key]
      else (globalThis as Record<PropertyKey, unknown>)[key] = previous
    }
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
    expect(slugifyWorkspacePath("/Users/foo_bar//baz--qux")).toBe("Users-foo-bar-baz-qux")
  })

  it("collapses long separator runs without backtracking", () => {
    expect(slugifyWorkspacePath(`/${"-".repeat(50_000)}`)).toBe("")
  })

  it("lives under ~/.cache/opencode/projects/<slug>", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(opencodeProjectDir("/Users/a/b")).toBe(
      path.join("/tmp/fake-home", ".cache", "opencode", "projects", "Users-a-b"),
    )
  })

  it("honors $XDG_CACHE_HOME for project metadata", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config-empty"
    expect(opencodeProjectDir("/Users/a/b")).toBe(
      path.join("/tmp/xdg-cache", "opencode", "projects", "Users-a-b"),
    )
  })

  it("shortens long project dirs with a hash suffix", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    const longRoot = `/Users/${"x".repeat(120)}/project`
    const dir = opencodeProjectDir(longRoot)
    expect(dir.length).toBeLessThanOrEqual(92)
    expect(dir).toMatch(/-[0-9a-f]{7}$/)
    expect(dir.startsWith(path.join("/tmp/fake-home", ".cache", "opencode", "projects"))).toBe(true)
  })

  it("ensureOpencodeProjectDir creates the metadata root", () => {
    const cacheRoot = path.join("/tmp", `cursor-project-cache-${process.pid}-${Date.now()}`)
    process.env.XDG_CACHE_HOME = cacheRoot
    process.env.XDG_CONFIG_HOME = path.join(cacheRoot, "config")
    const dir = ensureOpencodeProjectDir("/Users/a/b")
    expect(dir).toBe(path.join(cacheRoot, "opencode", "projects", "Users-a-b"))
    expect(existsSync(dir)).toBe(true)
    rmSync(cacheRoot, { recursive: true, force: true })
  })
})
