import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const secret = "crsr_" + "testsecretvalue"

function reply(stdout: string, code = 0): { status: number; output: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-reply-"))
  const stdoutPath = path.join(directory, "stdout")
  const stderrPath = path.join(directory, "stderr")
  fs.writeFileSync(stdoutPath, stdout)
  fs.writeFileSync(stderrPath, "")
  try {
    const result = spawnSync(
      "python3",
      [path.join(root, "scripts/live-reply.py"), stdoutPath, stderrPath, String(code), "cursor/composer-2.5"],
      { cwd: root, encoding: "utf8", env: { ...process.env, CURSOR_API_KEY: secret } },
    )
    return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function textEvent(text: string): string {
  return JSON.stringify({ type: "text", part: { type: "text", text } })
}

describe("live reply", () => {
  it("accepts a complete assistant reply of pong", () => {
    const judged = reply([textEvent("pon"), textEvent("g")].join("\n"))
    expect(judged.status).toBe(0)
    expect(judged.output).toContain("LIVE_TEST=passed")
  })

  it("rejects extra assistant text", () => {
    expect(reply(textEvent("pong!")).status).toBe(1)
    expect(reply(textEvent("pong\nmore")).status).toBe(1)
  })

  it("rejects a pong line and an unrelated JSON field", () => {
    const surrounded = `note\npong\n${JSON.stringify({ type: "step_finish", note: "pong" })}`
    expect(reply(surrounded).status).toBe(1)
    expect(reply(JSON.stringify({ type: "step_finish", message: "pong" })).status).toBe(1)
  })

  it("redacts the API key from failure output", () => {
    const judged = reply(textEvent(`pong ${secret}`))
    expect(judged.status).toBe(1)
    expect(judged.output).toContain("[REDACTED]")
    expect(judged.output).not.toContain(secret)
  })
})

function scan(diff: string, names: string[], indexSource?: string): { status: number; output: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-diff-"))
  const namesPath = path.join(directory, "names")
  const indexPath = path.join(directory, "index.ts")
  fs.writeFileSync(namesPath, names.join("\n"))
  if (indexSource !== undefined) fs.writeFileSync(indexPath, indexSource)
  try {
    const result = spawnSync(
      "python3",
      [path.join(root, "scripts/review-diff.py"), namesPath, indexSource === undefined ? "" : indexPath],
      { cwd: root, encoding: "utf8", input: diff },
    )
    return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

describe("local review paths", () => {
  const quotedDir = path.join(root, "test/.review-local-quoted")
  const namesDir = path.join(root, "test/.review-local-names")

  it("includes an untracked path that Git quotes", () => {
    const fileName = "caf\u00e9.ts"
    const gitEnv = { ...process.env }
    delete gitEnv.GIT_CONFIG_COUNT
    delete gitEnv.GIT_CONFIG_KEY_0
    delete gitEnv.GIT_CONFIG_VALUE_0
    fs.rmSync(quotedDir, { recursive: true, force: true })
    fs.mkdirSync(quotedDir)
    try {
      const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: quotedDir, encoding: "utf8", env: gitEnv })
        expect(result.status).toBe(0)
      }
      git(["init"])
      git(["config", "user.email", "test@example.com"])
      git(["config", "user.name", "test"])
      git(["config", "core.quotePath", "true"])
      fs.writeFileSync(path.join(quotedDir, fileName), "export const marker = \"quoted-untracked\"\n")
      const quoted = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: quotedDir,
        encoding: "utf8",
        env: gitEnv,
      })
      expect(quoted.stdout.startsWith("\"")).toBe(true)
      const result = spawnSync("bash", ["-c", `
        set -euo pipefail
        source scripts/review-pr.sh
        cd test/.review-local-quoted
        diff_names=""
        diff_text=""
        review_add_untracked
        printf '%s' "$diff_names" > names-out
        printf '%s' "$diff_text" > text-out
      `], { cwd: root, encoding: "utf8", env: gitEnv })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(fs.readFileSync(path.join(quotedDir, "names-out"), "utf8")).toBe(fileName)
      expect(fs.readFileSync(path.join(quotedDir, "text-out"), "utf8")).toContain("quoted-untracked")
    } finally {
      fs.rmSync(quotedDir, { recursive: true, force: true })
    }
  })

  it("decodes NUL-delimited names without quoting", () => {
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      source scripts/review-pr.sh
      python3 -c 'import os,sys; sys.stdout.buffer.write(os.environ["NAME"].encode() + b"\\0src/index.ts\\0")' | review_paths_from_nul
    `], { cwd: root, encoding: "utf8", env: { ...process.env, NAME: "caf\u00e9.ts" } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe("caf\u00e9.ts\nsrc/index.ts\n")
  })

  it("removes the names file when the review exits early", () => {
    fs.rmSync(namesDir, { recursive: true, force: true })
    fs.mkdirSync(namesDir)
    const record = path.join(namesDir, "path")
    try {
      const result = spawnSync("bash", ["-c", `
        set -euo pipefail
        source scripts/review-pr.sh
        names_file=$(mktemp)
        echo pending > "$names_file"
        printf '%s' "$names_file" > test/.review-local-names/path
        trap review_cleanup EXIT
        exit 1
      `], { cwd: root, encoding: "utf8" })
      expect(result.status).toBe(1)
      const namesFile = fs.readFileSync(record, "utf8")
      expect(fs.existsSync(namesFile)).toBe(false)
    } finally {
      fs.rmSync(namesDir, { recursive: true, force: true })
    }
  })
})

describe("review diff checks", () => {
  it("flags a secret added in a long diff and ignores a removed secret", () => {
    const filler = Array.from({ length: 5000 }, () => "+const ok = 1").join("\n")
    const token = "crsr_" + "abcdefghij"
    const addedScan = scan(`+const key = "${token}"\n${filler}`, ["src/example.ts"])
    expect(addedScan.status).toBe(1)
    expect(addedScan.output).toContain("id=no-secrets")

    const removedScan = scan(`-const key = "${token}"\n${filler}`, ["src/example.ts"])
    expect(removedScan.status).toBe(0)
    expect(removedScan.output).not.toContain("id=no-secrets")
  })

  it("does not treat the root comment as a CursorPluginV2 export", () => {
    const comment = [
      "export { CursorPlugin }",
      "// CursorPluginV2 is NOT re-exported here — see plugin-v2.ts.",
    ].join("\n")
    const clean = scan("diff --git a/src/index.ts b/src/index.ts\n", ["src/index.ts"], comment)
    expect(clean.status).toBe(0)
    expect(clean.output).not.toContain("id=entrypoints")

    const exported = scan("diff --git a/src/index.ts b/src/index.ts\n", ["src/index.ts"], "export { CursorPluginV2 }\n")
    expect(exported.status).toBe(1)
    expect(exported.output).toContain("id=entrypoints")
  })

  it("flags an added compatibility import and keeps a later match", () => {
    const specifier = ["@opencode-", "compat/pi-bridge"].join("")
    const early = `+import bridge from "${specifier}"\n`
    const later = `+const token = "${"crsr_" + "zzzzzzzzzz"}"\n`
    const result = scan(`${early}${later}`, ["src/example.ts"])
    expect(result.output).toContain("id=provider-boundary")
    expect(result.output).toContain("id=no-secrets")
    expect(result.status).toBe(1)
  })
})
