import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")

function filesUnder(relative: string, extensions: readonly string[]): string[] {
  const root = path.join(ROOT, relative)
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      const stat = statSync(file)
      if (stat.isDirectory()) walk(file)
      else if (extensions.some(ext => file.endsWith(ext))) out.push(file)
    }
  }
  walk(root)
  return out
}

function source(file: string): string {
  return readFileSync(file, "utf8")
}

function relative(file: string): string {
  return path.relative(ROOT, file)
}

function violations(files: readonly string[], pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of files) {
    source(file).split(/\r?\n/).forEach((line, index) => {
      pattern.lastIndex = 0
      if (pattern.test(line)) found.push(`${relative(file)}:${index + 1}: ${line.trim()}`)
    })
  }
  return found
}

const SOURCE_FILES = filesUnder("src", [".ts", ".d.ts"])
const TEST_FILES = filesUnder("test", [".ts"])
  .filter(file => path.basename(file) !== "architecture.test.ts")
const PACKAGE_FILES = ["package.json", "bun.lock"].map(name => path.join(ROOT, name))
const DIST_FILES = filesUnder("dist", [".js", ".d.ts"])

describe("provider / compatibility-layer architecture", () => {
  test("provider package and executable surfaces never depend on compatibility packages", () => {
    const found = violations(
      [...SOURCE_FILES, ...TEST_FILES, ...PACKAGE_FILES, ...DIST_FILES],
      /@opencode-compat\/|opencode-plugin-compat/,
    )
    expect(found).toEqual([])
  })

  test("provider executable source and tests contain no fork identities or fork-only vocabulary", () => {
    const found = violations(
      [...SOURCE_FILES, ...TEST_FILES],
      /MIMOCODE(?:_[A-Z_]+)?|KILO(?:_[A-Z_]+)?|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|\bactor_id\b|\bhashline\b|xd:\/\/|\bMiMo\b|\bKilo\b|\boh-my-pi\b|\bOMP\b/,
    )
    expect(found).toEqual([])
  })

  test("the structural host path contract uses only the neutral symbol", () => {
    const paths = source(path.join(ROOT, "src/context/paths.ts"))
    expect(paths).toContain('Symbol.for("opencode.host.path-bridge")')
    expect(paths).not.toContain("opencode.compat.path-bridge")
    expect((paths.match(/Symbol\.for\("opencode\.host\.path-bridge"\)/g) ?? []).length).toBe(1)
  })

  test("runtime modules do not statically import @opencode-ai/plugin", () => {
    const targets = [
      "src/plugin.ts",
      "src/plugin-v2.ts",
      "src/web-search-tool.ts",
      "src/image-save-tool.ts",
    ].map(file => path.join(ROOT, file))
    const found = violations(targets, /^\s*import(?!\s+type\b)[^\n]*["']@opencode-ai\/plugin(?:\/[^"']*)?["']/)
    expect(found).toEqual([])
  })

  test("built output preserves the boundary after build", () => {
    if (DIST_FILES.length === 0) return
    expect(violations(
      DIST_FILES,
      /@opencode-compat\/|MIMOCODE(?:_[A-Z_]+)?|KILO(?:_[A-Z_]+)?|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|\bactor_id\b|\bhashline\b|xd:\/\/|\bMiMo\b|\bKilo\b|\boh-my-pi\b|\bOMP\b/,
    )).toEqual([])
    expect(violations(
      DIST_FILES.filter(file => /(?:plugin(?:-v2)?|web-search-tool|image-save-tool)\.js$/.test(file)),
      /^\s*import[^\n]*["']@opencode-ai\/plugin(?:\/[^"']*)?["']/,
    )).toEqual([])
  })
})
