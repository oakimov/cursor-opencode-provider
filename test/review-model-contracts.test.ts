import { expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const script = path.join(root, "scripts/review-model-contracts.mjs")
setDefaultTimeout(30_000)

test("the harness model contract accepts the current catalogs", () => {
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.match(/MODEL_CONTRACT=.*:passed/g)).toHaveLength(3)
})

test("the isolated contract uses the trusted harness file and the subject's implementation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-model-contract-"))
  const subject = path.join(directory, "subject")
  const trusted = path.join(directory, "trusted")
  fs.mkdirSync(trusted)
  fs.copyFileSync(script, path.join(trusted, "review-model-contracts.mjs"))
  fs.mkdirSync(path.join(subject, "src/opencode2"), { recursive: true })
  fs.mkdirSync(path.join(subject, "scripts"))
  fs.writeFileSync(path.join(subject, "scripts/review-model-contracts.mjs"), 'console.log("WRONG_HARNESS"); process.exit(0)\n')
  fs.writeFileSync(path.join(subject, "src/model-config.ts"), `
    export function modelsToConfig(models) {
      const safe = id => id === "prototype" || Object.hasOwn(Object.prototype, id) ? id + "-cursor" : id
      return Object.fromEntries(models.map(model => [safe(model.id), { options: {cursorModelId:model.id}, variants:
        Object.fromEntries(model.variants.map((v, i) => ["label-"+i, {cursorVariantParameters:v.parameterValues}]))
      }]))
    }
  `)
  fs.writeFileSync(path.join(subject, "src/models.ts"), `export const normalizeModelCache = value => value\n`)
  const catalog = path.join(subject, "src/opencode2/catalog.ts")
  const implementation = (broken: boolean, empty = false, swapped = false) => `
    import { modelsToConfig } from "../model-config.ts"
    export function modelsToCatalogModelMap(models) {
      const entries = Object.entries(modelsToConfig(models))
      return Object.fromEntries(entries.map(([id, entry], index) => {
        const source = ${swapped ? "entries[(index + 1) % entries.length][1]" : "entry"}
        return [id, { modelID:entry.options.cursorModelId, variants:
          ${empty ? "[]" : `Object.entries(source.variants).map(([id, settings]) => ({id, settings}))
            ${broken ? '.concat([{id:"default",settings:{cursorVariantParameters:[{id:"effort",value:"default"}]}}])' : ""}`}
        }]
      }))
    }
  `
  const run = () => spawnSync("bash", [
    "scripts/isolate-run.sh", "--src", subject, "--tool", "bun",
    "--ro-bind", `${trusted}:/opt/harness/scripts`,
    "--", "bun", "/opt/harness/scripts/review-model-contracts.mjs", "/src",
  ], { cwd: root, encoding: "utf8" })
  try {
    fs.writeFileSync(catalog, implementation(true))
    const broken = run()
    expect(broken.status, broken.stderr).toBe(1)
    expect(broken.stderr).toContain("advertises the reserved default id")
    expect(broken.stdout).not.toContain("WRONG_HARNESS")
    fs.writeFileSync(catalog, implementation(false))
    const fixed = run()
    expect(fixed.status, fixed.stderr).toBe(0)
    expect(fixed.stdout.match(/MODEL_CONTRACT=.*:passed/g)).toHaveLength(3)
    fs.writeFileSync(catalog, implementation(false, true))
    const empty = run()
    expect(empty.status, empty.stderr).toBe(1)
    expect(empty.stderr).toContain("lost an upstream tuple")
    for (const [expression, diagnostic] of [
      ['.map(choice => ({...choice, id: choice.id + "-changed"}))', "changed an original display-label selection"],
      ['.map(choice => ({...choice, settings: {cursorVariantParameters: [{id:"invented",value:"invented"}]}}))', "published a tuple absent from discovery"],
      ['.flatMap(choice => [choice, choice])', "invalid or duplicate ids"],
      ['.map(choice => ({...choice, id:"__proto__"}))', "object-control variant id"],
    ]) {
      const valid = implementation(false)
      const original = "Object.entries(source.variants).map(([id, settings]) => ({id, settings}))"
      expect(valid.includes(original)).toBe(true)
      fs.writeFileSync(catalog, valid.replace(original, original + expression))
      const mutated = run()
      expect(mutated.status, mutated.stderr).toBe(1)
      expect(mutated.stderr).toContain(diagnostic!)
    }
    fs.writeFileSync(catalog, implementation(false).replace("modelID:entry.options.cursorModelId", 'modelID:"wrong-wire-id"'))
    const wire = run()
    expect(wire.status, wire.stderr).toBe(1)
    expect(wire.stderr).toContain("changed the wire model id")
    fs.writeFileSync(catalog, implementation(false, false, true))
    const swapped = run()
    expect(swapped.status, swapped.stderr).toBe(1)
    expect(swapped.stderr).toContain("assigned a tuple to the wrong model")
    expect(swapped.stderr).toContain("example=two-model")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a harness contract failure preserves independent test results and closes the live credential gate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-contract-gate-"))
  const log = path.join(directory, "commands")
  const live = path.join(directory, "live")
  try {
    // External checks are substituted here to test the real wrapper's phase
    // ordering. The previous case exercises the actual isolated contract.
    const result = spawnSync("bash", ["-c", `
      source scripts/isolated-check.sh
      git() {
        case "$*" in
          *fetch*) return 0 ;;
          *rev-parse*) printf '%s\\n' "$CURSOR_REVIEW_TRUST_SHA" ;;
          *archive*) return 0 ;;
          *) return 1 ;;
        esac
      }
      tar() { return 0; }
      check_run_isolated() {
        printf '%s\\n' "$*" >> "$PROBE_LOG"
        case "$*" in *review-model-contracts.mjs*) return 1 ;; esac
        return 0
      }
      check_run_live() { echo called > "$PROBE_LIVE"; }
      check_main 156 --live
    `], { cwd: root, encoding: "utf8", env: {
      ...process.env, PROBE_LOG: log, PROBE_LIVE: live,
      CURSOR_REVIEW_TRUST: "1", CURSOR_REVIEW_TRUST_SHA: "a".repeat(40),
      CURSOR_API_KEY: "test-only-no-credential",
    } })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout).toContain("MODEL_CONTRACTS=failed exit=1")
    expect(result.stdout).toContain("LIVE_TEST=skipped")
    expect(result.stdout).toContain("RETENTION_CONTRACTS=passed")
    expect(result.stdout).toContain("MODEL_CACHE_CONTRACTS=passed")
    expect(result.stdout).toContain("UNIT_TESTS=passed")
    const commands = fs.readFileSync(log, "utf8")
    expect(commands).toContain("bun /opt/harness/scripts/review-model-contracts.mjs /src")
    expect(commands).toContain("bun test")
    expect(fs.existsSync(live)).toBe(false)
    const archive = result.stdout.match(/^Check root: (.+)$/m)?.[1]
    expect(archive).toBeDefined()
    expect(fs.existsSync(archive!)).toBe(false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  { model: 0, retention: 1, units: 0, exit: 1, ranUnits: true },
  { model: 1, retention: 0, units: 1, exit: 1, ranUnits: true },
  { model: 2, retention: 0, units: 0, exit: 2, ranUnits: false },
  { model: 1, retention: 2, units: 0, exit: 2, ranUnits: false },
  { model: 0, cache: 1, retention: 0, units: 0, exit: 1, ranUnits: true },
  { model: 0, cache: 2, retention: 0, units: 0, exit: 2, ranUnits: false },
])("independent failures remain failures and an unavailable boundary stops checks (%j)", (scenario) => {
  const result = spawnSync("bash", ["-c", `
    source scripts/isolated-check.sh
    git() {
      case "$*" in *fetch*|*archive*) return 0 ;; *rev-parse*) printf '%s\\n' "$CURSOR_REVIEW_TRUST_SHA" ;; *) return 1 ;; esac
    }
    tar() { return 0; }
    check_run_isolated() {
      case "$*" in
        *review-model-contracts.mjs*) return "$PROBE_MODEL" ;;
        *review-model-cache-contract.mjs*) return "$PROBE_CACHE" ;;
        *review-retention-contracts.mjs*) return "$PROBE_RETENTION" ;;
        'bun test') return "$PROBE_UNITS" ;;
      esac
      return 0
    }
    check_run_live() { echo UNEXPECTED_LIVE; }
    check_main 156 --live
  `], { cwd: root, encoding: "utf8", env: {
    ...process.env, PROBE_MODEL: String(scenario.model), PROBE_RETENTION: String(scenario.retention),
    PROBE_CACHE: String("cache" in scenario ? scenario.cache : 0),
    PROBE_UNITS: String(scenario.units), CURSOR_REVIEW_TRUST: "1", CURSOR_REVIEW_TRUST_SHA: "a".repeat(40),
    CURSOR_API_KEY: "test-only-no-credential",
  } })
  expect(result.status, result.stderr).toBe(scenario.exit)
  expect(result.stdout).not.toContain("UNEXPECTED_LIVE")
  expect(result.stdout.includes("UNIT_TESTS=")).toBe(scenario.ranUnits)
  if (scenario.model === 1) expect(result.stdout).toContain("MODEL_CONTRACTS=failed exit=1")
  if ("cache" in scenario && scenario.cache === 1) expect(result.stdout).toContain("MODEL_CACHE_CONTRACTS=failed exit=1")
  if (scenario.retention === 1) expect(result.stdout).toContain("RETENTION_CONTRACTS=failed exit=1")
  if (scenario.units === 1) expect(result.stdout).toContain("UNIT_TESTS=failed exit=1")
  const archive = result.stdout.match(/^Check root: (.+)$/m)?.[1]
  expect(archive).toBeDefined()
  expect(fs.existsSync(archive!)).toBe(false)
})

const inheritedCatalog = [
  "MODEL_CONTRACT=effort:failed cases=1",
  "OpenCode 1.x lost an upstream tuple; count=2; example=model=__proto__",
  "OpenCode 1.x published an object-control model id; count=1; example=model=__proto__",
  "OpenCode 1.x published invalid catalog rates; count=1; example=label",
].join("\n")

function gateScript(body: string) {
  return `
    source scripts/isolated-check.sh
    git() {
      case "$*" in
        *fetch*) return 0 ;;
        *rev-parse*) printf '%s\\n' "$CURSOR_REVIEW_TRUST_SHA" ;;
        *archive*) return 0 ;;
        *) return 1 ;;
      esac
    }
    tar() { return 0; }
    ${body}
    check_main 156 --live
  `
}

test("a contract failure that already fails on the merge base opens the live credential gate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-contract-inherited-"))
  const live = path.join(directory, "live")
  try {
    const result = spawnSync("bash", ["-c", gateScript(`
      check_prepare_base() {
        if [[ "\${base_ready:-0}" -eq 1 ]]; then return 0; fi
        base_ready=1
        base_tree="$(mktemp -d "\${TMPDIR:-/tmp}/cursor-pr-base.XXXXXX")"
        echo "BASE_TREE=prepared commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        return 0
      }
      check_run_isolated() {
        printf '%s\\n' "$CHECK_TREE $*" >> "$PROBE_LOG"
        case "$*" in
          *review-model-contracts.mjs*|*review-model-cache-contract.mjs*|*review-retention-contracts.mjs*)
            printf '%s\\n' "$INHERITED"
            return 1
            ;;
        esac
        return 0
      }
      check_run_live() {
        if [[ -n "\${CURSOR_API_KEY:-}" ]]; then echo "KEY_PRESENT=1"; fi
        echo LIVE_INVOKED > "$PROBE_LIVE"
        return 0
      }
    `)], { cwd: root, encoding: "utf8", env: {
      ...process.env, PROBE_LOG: path.join(directory, "commands"), PROBE_LIVE: live,
      INHERITED: inheritedCatalog,
      CURSOR_REVIEW_TRUST: "1", CURSOR_REVIEW_TRUST_SHA: "a".repeat(40),
      CURSOR_API_KEY: "test-only-no-credential",
    } })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("MODEL_CONTRACTS=pre-existing exit=1")
    expect(result.stdout).toContain("MODEL_CACHE_CONTRACTS=pre-existing exit=1")
    expect(result.stdout).toContain("RETENTION_CONTRACTS=pre-existing exit=1")
    expect(result.stdout).toContain("MODEL_CONTRACTS_PREEXISTING=MODEL_CONTRACT=effort|OpenCode 1.x lost an upstream tuple")
    expect(result.stdout).toContain("MODEL_CONTRACTS_NEW=none")
    expect(result.stdout).not.toContain("MODEL_CONTRACTS=failed")
    expect(result.stdout).toContain("CHECK_SUMMARY pr=156 checks=0 new_contracts=0 preexisting_contracts=3 blocking=none live_exit=0")
    expect(result.stdout).toContain("KEY_PRESENT=1")
    expect(result.stdout).not.toContain("test-only-no-credential")
    expect(result.stdout).not.toContain("Checks failed")
    expect(fs.readFileSync(live, "utf8")).toBe("LIVE_INVOKED\n")
    const commands = fs.readFileSync(path.join(directory, "commands"), "utf8")
    expect(commands).toContain("head bun /opt/harness/scripts/review-model-contracts.mjs /src")
    expect(commands).toContain("base bun /opt/harness/scripts/review-model-contracts.mjs /src")
    const archive = result.stdout.match(/^Check root: (.+)$/m)?.[1]
    expect(archive).toBeDefined()
    expect(fs.existsSync(archive!)).toBe(false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a contract failure the merge base does not have still blocks the live credential", () => {
  const result = spawnSync("bash", ["-c", gateScript(`
    check_prepare_base() {
      if [[ "\${base_ready:-0}" -eq 1 ]]; then return 0; fi
      base_ready=1
      base_tree="$(mktemp -d "\${TMPDIR:-/tmp}/cursor-pr-base.XXXXXX")"
      echo "BASE_TREE=prepared commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      return 0
    }
    check_run_isolated() {
      case "$*" in
        *review-model-contracts.mjs*)
          printf '%s\\n' "$INHERITED"
          if [[ "$CHECK_TREE" == head ]]; then
            echo "OpenCode 2.x advertises the reserved default id; count=1; example=sentinel"
          fi
          return 1
          ;;
        *review-model-cache-contract.mjs*|*review-retention-contracts.mjs*) return 0 ;;
      esac
      return 0
    }
    check_run_live() { echo UNEXPECTED_LIVE; }
  `)], { cwd: root, encoding: "utf8", env: {
    ...process.env, INHERITED: inheritedCatalog,
    CURSOR_REVIEW_TRUST: "1", CURSOR_REVIEW_TRUST_SHA: "a".repeat(40),
    CURSOR_API_KEY: "test-only-no-credential",
  } })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
  expect(result.stdout).toContain("MODEL_CONTRACTS=failed exit=1")
  expect(result.stdout).toContain("MODEL_CONTRACTS_NEW=MODEL_CONTRACT=effort|OpenCode 2.x advertises the reserved default id")
  expect(result.stdout).toContain("MODEL_CONTRACTS_PREEXISTING=MODEL_CONTRACT=effort|OpenCode 1.x lost an upstream tuple")
  expect(result.stdout).toContain("blocking=MODEL_CONTRACTS")
  expect(result.stdout).toContain("LIVE_TEST=skipped")
  expect(result.stdout).not.toContain("UNEXPECTED_LIVE")
  expect(result.stdout).not.toContain("test-only-no-credential")
  const archive = result.stdout.match(/^Check root: (.+)$/m)?.[1]
  expect(archive).toBeDefined()
  expect(fs.existsSync(archive!)).toBe(false)
})

test.each(["bun run build", "bun run typecheck", "bun test"])("%s failure still blocks the live credential", (command) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-contract-block-"))
  const prepared = path.join(directory, "prepared")
  try {
    const result = spawnSync("bash", ["-c", gateScript(`
      check_prepare_base() { echo prepared > "$PROBE_PREPARED"; return 1; }
      check_run_isolated() {
        if [[ "$*" == "$BLOCK_COMMAND" ]]; then return 1; fi
        return 0
      }
      check_run_live() { echo UNEXPECTED_LIVE; }
    `)], { cwd: root, encoding: "utf8", env: {
      ...process.env, BLOCK_COMMAND: command, PROBE_PREPARED: prepared,
      CURSOR_REVIEW_TRUST: "1", CURSOR_REVIEW_TRUST_SHA: "a".repeat(40),
      CURSOR_API_KEY: "test-only-no-credential",
    } })
    const label = command === "bun test" ? "UNIT_TESTS" : command === "bun run build" ? "BUILD" : "TYPECHECK"
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
    expect(result.stdout).toContain(`${label}=failed exit=1`)
    expect(result.stdout).toContain(`blocking=${label}`)
    expect(result.stdout).toContain("LIVE_TEST=skipped")
    expect(result.stdout).toContain("Checks failed, so the live test did not run")
    expect(result.stdout).not.toContain("UNEXPECTED_LIVE")
    expect(result.stdout).not.toContain("test-only-no-credential")
    // Build and typecheck fail before any contract, so the merge base is not prepared.
    expect(fs.existsSync(prepared)).toBe(command === "bun test")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
