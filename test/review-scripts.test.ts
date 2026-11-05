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
