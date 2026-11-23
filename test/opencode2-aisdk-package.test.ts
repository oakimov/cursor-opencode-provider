import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  CURSOR_AISDK_REGISTRY_PACKAGE,
  resolveAiSdkPackageSpec,
} from "../src/opencode2/catalog.js"

/** The repository's own manifest, so the fixtures follow its declared entry. */
const repoRoot = path.join(import.meta.dir, "..")
const repoManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aisdk-spec-"))
  roots.push(root)
  return root
}

type Layout = { root: string; module: string; entry: string }

/** A package as `bun run build` leaves it: manifest, `dist/index.js`, and the module resolving the spec. */
function builtPackage(root: string, manifest: unknown = repoManifest): Layout {
  fs.mkdirSync(path.join(root, "dist", "opencode2"), { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export function createCursor() {}\n")
  fs.writeFileSync(path.join(root, "dist", "opencode2", "catalog.js"), "")
  return { root, module: path.join(root, "dist", "opencode2", "catalog.js"), entry: path.join(root, "dist", "index.js") }
}

/** Symlink a directory; a junction keeps this working without privileges on Windows. */
function linkDirectory(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, "junction")
}

const url = (file: string) => pathToFileURL(file).href
const localSpec = (entry: string) => `aisdk:${pathToFileURL(fs.realpathSync(entry)).href}`

describe("resolveAiSdkPackageSpec", () => {
  it("publishes a built checkout's own dist/index.js, including a path with spaces", () => {
    const built = builtPackage(path.join(scratch(), "local build", "cursor opencode provider"))
    const spec = resolveAiSdkPackageSpec(url(built.module), {})
    expect(spec).toBe(localSpec(built.entry))
    expect(spec).toContain("%20")
    // The host strips `aisdk:` and imports this URL; it must name the entry itself.
    expect(fileURLToPath(spec.slice("aisdk:".length))).toBe(fs.realpathSync(built.entry))
  })

  it("publishes the real entry of a checkout reached through a symlink", () => {
    const base = scratch()
    const built = builtPackage(path.join(base, "real checkout"))
    linkDirectory(built.root, path.join(base, "linked checkout"))
    const viaLink = path.join(base, "linked checkout", "dist", "opencode2", "catalog.js")
    expect(resolveAiSdkPackageSpec(url(viaLink), {})).toBe(localSpec(built.entry))

    // A local checkout linked into an app's node_modules (`bun link`) is still that checkout.
    linkDirectory(built.root, path.join(base, "app", "node_modules", "cursor-opencode-provider"))
    const viaNodeModules = path.join(base, "app", "node_modules", "cursor-opencode-provider", "dist", "opencode2", "catalog.js")
    expect(resolveAiSdkPackageSpec(url(viaNodeModules), {})).toBe(localSpec(built.entry))
  })

  it("keeps the published package for registry installs", () => {
    const base = scratch()
    // OpenCode's npm cache layout.
    const npm = builtPackage(path.join(base, "cache", "npm", "cursor-opencode-provider@latest", "a1", "node_modules", "cursor-opencode-provider"))
    expect(resolveAiSdkPackageSpec(url(npm.module), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)

    // A store layout: the package's real path stays under node_modules behind its link.
    const store = builtPackage(path.join(base, "project", "node_modules", ".pnpm", "cursor-opencode-provider@0.8.7", "node_modules", "cursor-opencode-provider"))
    const linked = path.join(base, "project", "node_modules", "cursor-opencode-provider")
    linkDirectory(store.root, linked)
    expect(resolveAiSdkPackageSpec(url(store.module), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
    expect(resolveAiSdkPackageSpec(url(path.join(linked, "dist", "opencode2", "catalog.js")), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
  })

  it("keeps the published package for a source run, even next to a build", () => {
    const built = builtPackage(path.join(scratch(), "checkout"))
    const source = path.join(built.root, "src", "opencode2", "catalog.ts")
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, "")
    expect(resolveAiSdkPackageSpec(url(source), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)

    // This test run loads the module from `src/`.
    expect(resolveAiSdkPackageSpec(url(path.join(repoRoot, "src", "opencode2", "catalog.ts")), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
    expect(resolveAiSdkPackageSpec(undefined, {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
  })

  it("requires the catalog and its root entry to belong to the same build", () => {
    const base = scratch()
    const built = builtPackage(path.join(base, "checkout"))
    fs.writeFileSync(path.join(built.root, "dist", "opencode2", "package.json"), JSON.stringify({ name: "another-package" }))
    expect(resolveAiSdkPackageSpec(url(built.module), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)

    const source = builtPackage(path.join(base, "source checkout"), {
      name: "cursor-opencode-provider",
      main: "./src/index.js",
    })
    fs.renameSync(path.join(source.root, "dist"), path.join(source.root, "src"))
    expect(resolveAiSdkPackageSpec(url(path.join(source.root, "src", "opencode2", "catalog.js")), {}))
      .toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
  })

  it.skipIf(process.platform === "win32")("refuses a dist entry symlink into another checkout", () => {
    const base = scratch()
    const plugin = builtPackage(path.join(base, "plugin checkout"))
    const other = builtPackage(path.join(base, "other checkout"))
    fs.unlinkSync(plugin.entry)
    fs.symlinkSync(other.entry, plugin.entry)
    expect(resolveAiSdkPackageSpec(url(plugin.module), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
  })

  it("accepts the root entry however the manifest declares it", () => {
    const declarations: unknown[] = [
      { name: "cursor-opencode-provider", exports: "./dist/index.js" },
      { name: "cursor-opencode-provider", exports: { import: "./dist/index.js" } },
      { name: "cursor-opencode-provider", exports: { ".": "./dist/index.js", "./plugin": "./dist/plugin.js" } },
      { name: "cursor-opencode-provider", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
      { name: "cursor-opencode-provider", main: "dist/index.js" },
    ]
    for (const manifest of declarations) {
      const built = builtPackage(path.join(scratch(), "checkout"), manifest)
      expect(resolveAiSdkPackageSpec(url(built.module), {}), JSON.stringify(manifest)).toBe(localSpec(built.entry))
    }
  })

  it("keeps the published package for missing or unverified local entries", () => {
    const published = (module: string) => expect(resolveAiSdkPackageSpec(url(module), {})).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)

    const missing = builtPackage(path.join(scratch(), "missing entry"))
    fs.rmSync(missing.entry)
    published(missing.module)

    const directory = builtPackage(path.join(scratch(), "entry directory"))
    fs.rmSync(directory.entry)
    fs.mkdirSync(directory.entry)
    published(directory.module)

    const noManifest = builtPackage(path.join(scratch(), "no manifest"))
    fs.rmSync(path.join(noManifest.root, "package.json"))
    published(noManifest.module)

    const unverified: unknown[] = [
      "{ not json",
      { ...repoManifest, name: "another-package" },
      { name: "cursor-opencode-provider", exports: { ".": "./lib/index.js" } },
      // A defined `exports` replaces `main`, so this one exports no root entry.
      { name: "cursor-opencode-provider", main: "./dist/index.js", exports: { "./plugin": "./dist/plugin.js" } },
      { name: "cursor-opencode-provider", exports: { ".": { require: "./dist/index.js" } } },
      { name: "cursor-opencode-provider", exports: { ".": { default: "./lib/index.js", import: "./dist/index.js" } } },
      { name: "cursor-opencode-provider", exports: { ".": { bun: "./lib/index.js", import: "./dist/index.js" } } },
      { name: "cursor-opencode-provider", exports: { ".": { import: "./dist/index.js" }, default: "./dist/index.js" } },
      { name: "cursor-opencode-provider" },
    ]
    for (const manifest of unverified) {
      const built = builtPackage(path.join(scratch(), "unverified"), manifest)
      fs.mkdirSync(path.join(built.root, "lib"))
      fs.writeFileSync(path.join(built.root, "lib", "index.js"), "")
      expect(resolveAiSdkPackageSpec(url(built.module), {}), JSON.stringify(manifest)).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
    }

    for (const moduleUrl of ["https://example.com/dist/opencode2/catalog.js", "not a url", ""]) {
      expect(resolveAiSdkPackageSpec(moduleUrl, {}), moduleUrl).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
    }
  })

  it("selects the published package with CURSOR_OPENCODE2_USE_LOCAL_DIST=0", () => {
    const built = builtPackage(path.join(scratch(), "checkout"))
    for (const value of ["0", " 0 "]) {
      expect(resolveAiSdkPackageSpec(url(built.module), { CURSOR_OPENCODE2_USE_LOCAL_DIST: value })).toBe(CURSOR_AISDK_REGISTRY_PACKAGE)
    }
    for (const value of ["1", "", "yes"]) {
      expect(resolveAiSdkPackageSpec(url(built.module), { CURSOR_OPENCODE2_USE_LOCAL_DIST: value })).toBe(localSpec(built.entry))
    }
  })

  it("lets CURSOR_OPENCODE2_DEV_ENTRY override every layout and the opt-out", () => {
    const base = scratch()
    const devEntry = path.join(base, "dev build", "dist", "index.js")
    const expected = `aisdk:${pathToFileURL(devEntry).href}`
    const built = builtPackage(path.join(base, "checkout"))
    const npm = builtPackage(path.join(base, "cache", "node_modules", "cursor-opencode-provider"))
    for (const module of [built.module, npm.module, path.join(repoRoot, "src", "opencode2", "catalog.ts")]) {
      expect(resolveAiSdkPackageSpec(url(module), { CURSOR_OPENCODE2_DEV_ENTRY: devEntry })).toBe(expected)
      expect(resolveAiSdkPackageSpec(url(module), {
        CURSOR_OPENCODE2_DEV_ENTRY: devEntry,
        CURSOR_OPENCODE2_USE_LOCAL_DIST: "0",
      })).toBe(expected)
    }
  })
})
