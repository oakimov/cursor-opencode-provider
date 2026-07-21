import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import {
  ensureOpencodeProjectDir,
  adoptCompatHostCacheDir,
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
const originalMimoHome = process.env.MIMOCODE_HOME
const originalKiloConfig = process.env.KILO_CONFIG_DIR

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
  if (originalMimoHome === undefined) delete process.env.MIMOCODE_HOME
  else process.env.MIMOCODE_HOME = originalMimoHome
  if (originalKiloConfig === undefined) delete process.env.KILO_CONFIG_DIR
  else process.env.KILO_CONFIG_DIR = originalKiloConfig
})

describe("opencodeGlobalCacheDir", () => {
  it("defaults to $HOME/.cache/opencode", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/fake-home", ".cache", "opencode"))
  })

  it("uses $XDG_CACHE_HOME/opencode when set", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config-empty"
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
    expect(opencodeGlobalCacheDir()).toBe(path.join("/tmp/xdg-cache", "opencode"))
  })

  it("falls back to USERPROFILE when HOME is unset", () => {
    delete process.env.HOME
    process.env.USERPROFILE = "/tmp/win-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
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
  it("uses $MIMOCODE_HOME/cache when set", () => {
    const dir = resolveHostCacheDir({
      HOME: "/tmp/fake-home",
      MIMOCODE_HOME: "/tmp/mimo-home",
    })
    expect(dir).toBe(path.join("/tmp/mimo-home", "cache"))
  })

  it("uses kilo cache when KILO_CONFIG_DIR is set", () => {
    const dir = resolveHostCacheDir({
      HOME: "/tmp/fake-home",
      KILO_CONFIG_DIR: "/tmp/kilo-config",
      XDG_CACHE_HOME: "/tmp/xdg-cache",
    })
    expect(dir).toBe(path.join("/tmp/xdg-cache", "kilo"))
  })

  it("uses the MiMo cache when the provider module is installed there", () => {
    const dir = resolveHostCacheDir(
      { HOME: "/tmp/fake-home", XDG_CACHE_HOME: "/tmp/xdg-cache" },
      "file:///tmp/xdg-cache/mimocode/packages/provider/dist/context/paths.js",
    )
    expect(dir).toBe(path.join("/tmp/xdg-cache", "mimocode"))
  })

  it("uses the Kilo cache when the provider module is installed there", () => {
    const dir = resolveHostCacheDir(
      { HOME: "/tmp/fake-home", XDG_CACHE_HOME: "/tmp/xdg-cache" },
      "/tmp/xdg-cache/kilo/packages/provider/dist/context/paths.js",
    )
    expect(dir).toBe(path.join("/tmp/xdg-cache", "kilo"))
  })

  it("defaults a native source checkout to OpenCode even when forks are co-installed", () => {
    const dir = resolveHostCacheDir(
      {
        HOME: "/tmp/fake-home",
        XDG_CACHE_HOME: "/tmp/xdg-cache",
        XDG_CONFIG_HOME: "/tmp/config-with-kilo-and-mimo",
      },
      "/Users/dev/Projects/cursor-opencode-provider/dist/context/paths.js",
    )
    expect(dir).toBe(path.join("/tmp/xdg-cache", "opencode"))
  })
})

describe("adoptCompatHostCacheDir", () => {
  it("ignores config-only detection from a co-installed host", async () => {
    const adopted = await adoptCompatHostCacheDir(() => ({
      id: "kilo",
      supported: true,
      source: "config",
      profile: { paths: { cacheDir: "/tmp/xdg-cache/kilo" } },
    }))
    expect(adopted).toBeUndefined()
    expect(getHostCacheDirOverride()).toBeUndefined()
  })

  it("adopts strong binary identity", async () => {
    const adopted = await adoptCompatHostCacheDir(() => ({
      id: "mimo",
      supported: true,
      source: "binary",
      profile: { paths: { cacheDir: "/tmp/xdg-cache/mimocode" } },
    }))
    expect(adopted).toBe("/tmp/xdg-cache/mimocode")
    expect(getHostCacheDirOverride()).toBe("/tmp/xdg-cache/mimocode")
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
    delete process.env.XDG_CONFIG_HOME
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
    expect(opencodeProjectDir("/Users/a/b")).toBe(
      path.join("/tmp/fake-home", ".cache", "opencode", "projects", "Users-a-b"),
    )
  })

  it("honors $XDG_CACHE_HOME for project metadata", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache"
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config-empty"
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
    expect(opencodeProjectDir("/Users/a/b")).toBe(
      path.join("/tmp/xdg-cache", "opencode", "projects", "Users-a-b"),
    )
  })

  it("places project metadata under mimo cache when MIMOCODE_HOME is set", () => {
    process.env.HOME = "/tmp/fake-home"
    process.env.MIMOCODE_HOME = "/tmp/mimo-home"
    expect(opencodeProjectDir("/Users/a/b")).toBe(
      path.join("/tmp/mimo-home", "cache", "projects", "Users-a-b"),
    )
  })

  it("shortens long project dirs with a hash suffix", () => {
    process.env.HOME = "/tmp/fake-home"
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_CONFIG_HOME
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
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
    delete process.env.MIMOCODE_HOME
    delete process.env.KILO_CONFIG_DIR
    const dir = ensureOpencodeProjectDir("/Users/a/b")
    expect(dir).toBe(path.join(cacheRoot, "opencode", "projects", "Users-a-b"))
    expect(existsSync(dir)).toBe(true)
    rmSync(cacheRoot, { recursive: true, force: true })
  })
})
