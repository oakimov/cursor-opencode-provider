import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

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

function staticImports(text: string, modulePattern: RegExp, runtimeOnly = false): string[] {
  const parsed = ts.createSourceFile("surface.ts", text, ts.ScriptTarget.Latest, true)
  return parsed.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
    if (runtimeOnly && statement.importClause?.isTypeOnly) return []
    modulePattern.lastIndex = 0
    return modulePattern.test(statement.moduleSpecifier.text) ? [statement.moduleSpecifier.text] : []
  })
}

function importViolations(files: readonly string[], pattern: RegExp, runtimeOnly = false): string[] {
  return files.flatMap(file => staticImports(source(file), pattern, runtimeOnly)
    .map(specifier => `${relative(file)}: ${specifier}`))
}

// Cursor's own agent.v1 Pi* exec types are native wire vocabulary. Detect the
// external host family through its package/config identities, not that prefix.
const FOREIGN_VOCABULARY = /MIMOCODE(?:_[A-Z_]+)?|KILO(?:_[A-Z_]+)?|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|\bactor_id\b|\bhashline\b|xd:\/\/|\bMiMo\b|\bKilo\b|\.kilo\b|checkpoint-writer|\bOCP\b|\bocp-|\boh-my-pi\b|\bOMP\b|\bDSH\b|DeepSeek Harness|deepseek-harness|@deepseek-ai\/|@earendil-works\/|@oh-my-pi\/|mimocode|kilocode|exit_plan_mode|ask_user_question|devin-opencode-provider|\bDevin\b|\bDevinPlugin\b|\bcreateDevin\b/

const SOURCE_FILES = filesUnder("src", [".ts", ".d.ts"])
const TEST_FILES = filesUnder("test", [".ts"])
  .filter(file => path.basename(file) !== "architecture.test.ts")
const PACKAGE_FILES = ["package.json", "bun.lock"].map(name => path.join(ROOT, name))
// `package.json#files` publishes the whole directory, not only compiler output.
// Include metadata so a stale host-specific build artifact cannot cross the
// provider / compatibility-layer boundary unnoticed.
const DIST_FILES = filesUnder("dist", [".js", ".d.ts", ".json"])

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
      [...SOURCE_FILES, ...TEST_FILES, ...PACKAGE_FILES],
      FOREIGN_VOCABULARY,
    )
    expect(found).toEqual([])
  })

  test("the structural host path contract uses only the neutral symbol", () => {
    const paths = source(path.join(ROOT, "src/context/paths.ts"))
    expect(paths).toContain('Symbol.for("opencode.host.path-bridge")')
    expect(paths).not.toContain("opencode.compat.path-bridge")
    expect((paths.match(/Symbol\.for\("opencode\.host\.path-bridge"\)/g) ?? []).length).toBe(1)
  })

  test("the structural host event contract uses only a neutral symbol", () => {
    const bridge = source(path.join(ROOT, "src/host-event-bridge.ts"))
    expect(bridge).toContain('Symbol.for("opencode.host.event-bridge")')
    expect(bridge).not.toContain("opencode.compat.event-bridge")
    expect((bridge.match(/Symbol\.for\("opencode\.host\.event-bridge"\)/g) ?? []).length).toBe(1)
  })

  test("the structural host skills contract uses only the neutral symbol", () => {
    const skills = source(path.join(ROOT, "src/context/skills-bridge.ts"))
    expect(skills).toContain('Symbol.for("opencode.host.skills")')
    expect(skills).not.toContain("opencode.compat.skills")
    expect((skills.match(/Symbol\.for\("opencode\.host\.skills"\)/g) ?? []).length).toBe(1)
  })

  test("runtime modules do not statically import @opencode-ai/plugin", () => {
    const targets = [
      "src/plugin.ts",
      "src/plugin-v2.ts",
      "src/web-search-tool.ts",
      "src/image-save-tool.ts",
    ].map(file => path.join(ROOT, file))
    const found = importViolations(targets, /^@opencode-ai\/plugin(?:\/|$)/, true)
    expect(found).toEqual([])
  })

  test("OpenCode 2.0 plugin does not depend on the host SDK package", () => {
    const found = importViolations(
      [...SOURCE_FILES, ...DIST_FILES],
      /^@opencode\/plugin(?:\/|$)/,
    )
    expect(found).toEqual([])
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }
    expect(deps["@opencode/plugin"]).toBeUndefined()
    expect(pkg.scripts?.typecheck).toContain("tsconfig.test.json")
  })

  test("built output preserves the boundary after build", () => {
    if (DIST_FILES.length === 0) return
    expect(violations(
      DIST_FILES,
      FOREIGN_VOCABULARY,
    )).toEqual([])
    expect(importViolations(
      DIST_FILES.filter(file => /(?:plugin(?:-v2|-opencode2)?|web-search-tool|image-save-tool)\.js$/.test(file)),
      /^@opencode-ai\/plugin(?:\/|$)/,
    )).toEqual([])
  })

  test("static import checks inspect complete declarations and distinguish type imports", () => {
    const text = `import {\n  tool\n} from "@opencode-ai/plugin"\nimport type { Hooks } from "@opencode-ai/plugin"`
    expect(staticImports(text, /^@opencode-ai\/plugin$/, true)).toEqual(["@opencode-ai/plugin"])
    expect(staticImports(text, /^@opencode-ai\/plugin$/)).toHaveLength(2)
    expect(staticImports('const value = "import { tool } from \\\"@opencode-ai/plugin\\\""', /^@opencode-ai\/plugin$/)).toEqual([])
  })

  test("foreign identity checks cover every host family and other providers", () => {
    const names = ["mimocode", "kilocode", ".kilo/plans", "checkpoint-writer", "OCP", "ocp-token", "PI_CODING_AGENT_DIR", "OMP", "@earendil-works/pi-ai", "@oh-my-pi/pi-ai", "@deepseek-ai/dsh-llm", "DSH", "Devin", "createDevin"]
    expect(names.filter(name => !FOREIGN_VOCABULARY.test(name))).toEqual([])
  })
})
