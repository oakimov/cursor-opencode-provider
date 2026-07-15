import { afterEach, describe, expect, it } from "bun:test"
import path from "node:path"
import {
  opencodeGlobalCacheDir,
  opencodeGlobalConfigDir,
  opencodeGlobalDataDir,
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
