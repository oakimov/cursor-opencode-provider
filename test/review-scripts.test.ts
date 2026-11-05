import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const secret = "crsr_" + "testsecretvalue"

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...(options.env ?? process.env), PYTHONDONTWRITEBYTECODE: "1" },
    input: options.input,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function without(names: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  for (const name of names) delete env[name]
  return env
}

function textEvent(text: string): string {
  return JSON.stringify({ type: "text", part: { type: "text", text } })
}

function reply(stdout: string, code: string | number = 0): { status: number; output: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-reply-"))
  const stdoutPath = path.join(directory, "stdout")
  const stderrPath = path.join(directory, "stderr")
  fs.writeFileSync(stdoutPath, stdout)
  fs.writeFileSync(stderrPath, "")
  try {
    const result = run(
      "python3",
      [path.join(root, "scripts/live-reply.py"), stdoutPath, stderrPath, String(code), "cursor/composer-2.5"],
      { env: { ...process.env, CURSOR_API_KEY: secret } },
    )
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

describe("live reply", () => {
  it("accepts a complete assistant reply of pong", () => {
    const judged = reply([textEvent("pon"), textEvent("g")].join("\n"))
    expect(judged.status).toBe(0)
    expect(judged.output).toContain("LIVE_TEST=passed")
  })

  it("accepts one trailing newline and rejects surrounding text", () => {
    expect(reply(textEvent("pong\n")).status).toBe(0)
    expect(reply(textEvent(" pong")).status).toBe(1)
    expect(reply(textEvent("pong ")).status).toBe(1)
    expect(reply(textEvent("pong!")).status).toBe(1)
  })

  it("rejects a pong line and an unrelated JSON field", () => {
    const surrounded = `note\npong\n${JSON.stringify({ type: "step_finish", note: "pong" })}`
    expect(reply(surrounded).status).toBe(1)
    expect(reply(JSON.stringify({ type: "step_finish", message: "pong" })).status).toBe(1)
  })

  it("fails when opencode exits non-zero even if the reply is pong", () => {
    expect(reply(textEvent("pong"), 1).status).toBe(1)
  })

  it("rejects a non-integer exit code and a missing transcript", () => {
    expect(reply(textEvent("pong"), "nope").status).toBe(2)
    const missing = run("python3", [path.join(root, "scripts/live-reply.py"), "/no/such-stdout", "/no/such-stderr", "0", "model"])
    expect(missing.status).toBe(2)
    expect(missing.stderr).not.toContain("Traceback")
  })

  it("rejects the wrong number of arguments", () => {
    const result = run("python3", [path.join(root, "scripts/live-reply.py")])
    expect(result.status).toBe(2)
  })

  it("redacts the API key from failure output and does not take it from argv", () => {
    const judged = reply(textEvent(`pong ${secret}`))
    expect(judged.status).toBe(1)
    expect(judged.output).toContain("[REDACTED]")
    expect(judged.output).not.toContain(secret)
  })
})

function scan(
  diff: string,
  names: string[],
  options: { root?: string; index?: string; deleted?: string[] } = {},
): { status: number; output: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-diff-"))
  const reviewRoot = options.root ?? directory
  const namesPath = path.join(directory, "names")
  fs.mkdirSync(path.join(reviewRoot, ".cursor", "rules"), { recursive: true })
  fs.writeFileSync(path.join(reviewRoot, ".cursor", "rules", "sample.mdc"), [
    "---",
    "alwaysApply: true",
    "---",
    "Greptile id: sample",
    "Severity: high",
    "",
  ].join("\n"))
  if (options.index !== undefined) {
    fs.mkdirSync(path.join(reviewRoot, "src"), { recursive: true })
    fs.writeFileSync(path.join(reviewRoot, "src", "index.ts"), options.index)
  }
  const encoded = names.map((name) => Buffer.from(name, "utf8"))
  fs.writeFileSync(namesPath, Buffer.concat(encoded.flatMap((part) => [part, Buffer.from([0])])))
  const args = [path.join(root, "scripts/review-diff.py"), reviewRoot, namesPath]
  if (options.deleted) {
    const deletedPath = path.join(directory, "deleted")
    const deletedBytes = options.deleted.map((name) => Buffer.from(name, "utf8"))
    fs.writeFileSync(deletedPath, Buffer.concat(deletedBytes.flatMap((part) => [part, Buffer.from([0])])))
    args.push(deletedPath)
  }
  try {
    const result = run("python3", args, { input: diff })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    if (options.root && options.root !== directory) fs.rmSync(options.root, { recursive: true, force: true })
  }
}

describe("review diff checks", () => {
  it("flags a secret added in a long diff and ignores a removed secret", () => {
    const filler = Array.from({ length: 5000 }, () => "+const ok = 1").join("\n")
    const token = "crsr_" + "abcdefghij"
    const addedScan = scan(`+const key = "${token}"\n${filler}`, ["src/example.ts"])
    expect(addedScan.status).toBe(1)
    expect(addedScan.output).toContain("id=no-secrets")
    expect(addedScan.output).not.toContain(token)

    const removedScan = scan(`-const key = "${token}"\n${filler}`, ["src/example.ts"])
    expect(removedScan.status).toBe(0)
    expect(removedScan.output).not.toContain("id=no-secrets")
  })

  it("flags a skipped test and a deleted test file, not a removed skip", () => {
    const skipCall = ["it", "skip"].join(".")
    const skipped = scan(`+${skipCall}("later")\n`, ["test/example.test.ts"])
    expect(skipped.status).toBe(1)
    expect(skipped.output).toContain("id=no-weakened-tests")
    const removedSkip = scan(`-${skipCall}("later")\n`, ["test/example.test.ts"])
    expect(removedSkip.output).not.toContain("id=no-weakened-tests")
    const deleted = scan(
      "diff --git a/test/example.test.ts b/test/example.test.ts\ndeleted file mode 100644\n",
      ["test/example.test.ts"],
    )
    expect(deleted.status).toBe(1)
    expect(deleted.output).toContain("test/example.test.ts")
    const quoted = scan("diff --git \"a/test/quoted.test.ts\" b/test/quoted.test.ts\n", ["src/example.ts"], {
      deleted: ["test/caf\u00e9.test.ts", "README.md"],
    })
    expect(quoted.status).toBe(1)
    expect(quoted.output).toContain("test/caf\u00e9.test.ts")
    expect(quoted.output).not.toContain("README.md")
  })

  it("does not treat the root comment as a CursorPluginV2 export", () => {
    const comment = [
      "export { CursorPlugin }",
      "// CursorPluginV2 is NOT re-exported here — see plugin-v2.ts.",
    ].join("\n")
    const clean = scan("", ["src/index.ts"], { index: comment })
    expect(clean.status).toBe(0)
    expect(clean.output).not.toContain("id=entrypoints")

    const exported = scan("", ["src/index.ts"], { index: "export { CursorPluginV2 }\n" })
    expect(exported.status).toBe(1)
    expect(exported.output).toContain("id=entrypoints")
  })

  it("does not crash when the changed index file is already gone", () => {
    const result = scan("", ["src/index.ts"])
    expect(result.status).toBe(0)
    expect(result.output).not.toContain("Traceback")
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

  it("does not flag its own import pattern as a compatibility import", () => {
    const source = fs.readFileSync(path.join(root, "scripts/review-diff.py"), "utf8")
    const needle = ["opencode-", "plugin-compat"].join("")
    const line = source.split("\n").find((entry) => entry.includes(needle))
    expect(line).toBeTruthy()
    const result = scan(`+${line}\n`, ["scripts/review-diff.py"])
    expect(result.output).not.toContain("id=provider-boundary")
  })

  it("reports a medium changelog gap without failing the process", () => {
    const result = scan("+export const n = 1\n", ["src/example.ts"])
    expect(result.status).toBe(0)
    expect(result.output).toContain("id=changelog")
    expect(result.output).toContain("medium=1")
  })

  it("reads NUL-separated names and a real rule set", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-rules-"))
    const namesPath = path.join(directory, "names")
    fs.writeFileSync(namesPath, Buffer.concat([
      Buffer.from("src/session.ts\0", "utf8"),
      Buffer.from("caf\u00e9.ts\0", "utf8"),
    ]))
    try {
      const result = run(
        "python3",
        [path.join(root, "scripts/review-diff.py"), root, namesPath],
        { input: "" },
      )
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("] resource-lifecycle (")
      expect(result.stdout).toContain("] no-secrets (")
      expect(result.stdout).not.toContain("] entrypoints (")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails closed when a rule file has no frontmatter", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-bad-rule-"))
    fs.mkdirSync(path.join(directory, ".cursor", "rules"), { recursive: true })
    fs.writeFileSync(path.join(directory, ".cursor", "rules", "broken.mdc"), "not frontmatter\n")
    const namesPath = path.join(directory, "names")
    fs.writeFileSync(namesPath, Buffer.from(""))
    try {
      const result = run("python3", [path.join(root, "scripts/review-diff.py"), directory, namesPath], { input: "" })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("RULE_PARSE")
      expect(result.stderr).not.toContain("Traceback")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects the wrong number of arguments", () => {
    expect(run("python3", [path.join(root, "scripts/review-diff.py")]).status).toBe(2)
  })
})

describe("configure opencode", () => {
  it("fails when the build output is missing", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configure-missing-"))
    fs.mkdirSync(path.join(directory, "scripts"))
    fs.copyFileSync(path.join(root, "scripts/configure-opencode.sh"), path.join(directory, "scripts/configure-opencode.sh"))
    try {
      const result = run("bash", [path.join(directory, "scripts/configure-opencode.sh")])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Missing")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("writes a plugin config without replacing OPENCODE_CONFIG_DIR", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "configure-ok-"))
    const directory = path.join(parent, "dir with space")
    const sentinel = path.join(parent, "sentinel.json")
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    fs.mkdirSync(path.join(directory, "scripts"))
    fs.copyFileSync(path.join(root, "scripts/configure-opencode.sh"), path.join(directory, "scripts/configure-opencode.sh"))
    fs.writeFileSync(sentinel, "{\"keep\":true}\n")
    try {
      const result = run("bash", [path.join(directory, "scripts/configure-opencode.sh")], {
        env: { ...process.env, OPENCODE_CONFIG_DIR: sentinel },
      })
      expect(result.status, result.stderr).toBe(0)
      expect(fs.readFileSync(sentinel, "utf8")).toBe("{\"keep\":true}\n")
      const config = JSON.parse(fs.readFileSync(path.join(directory, ".opencode-local/opencode.json"), "utf8"))
      expect(config.plugins[0]).toContain("plugins/cursor")
      const env = fs.readFileSync(path.join(directory, ".opencode-local/env"), "utf8")
      expect(env).toContain("dir with space")
      expect(env).toContain("'")
      const plugin = fs.readFileSync(path.join(directory, ".opencode-local/plugins/cursor/index.js"), "utf8")
      expect(plugin).toContain("file://")
      expect(plugin).not.toContain("dir with space")
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe("live test script", () => {
  it("skips before configure when the key is unset", () => {
    const result = run("bash", ["scripts/live-test.sh"], { env: without(["CURSOR_API_KEY"]) })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LIVE_TEST=skipped")
  })

  it("fails when opencode is not on PATH", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-no-opencode-"))
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.mkdirSync(path.join(directory, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    fs.copyFileSync(path.join(root, "scripts/live-test.sh"), path.join(directory, "scripts/live-test.sh"))
    fs.copyFileSync(path.join(root, "scripts/configure-opencode.sh"), path.join(directory, "scripts/configure-opencode.sh"))
    try {
      const result = run("bash", [path.join(directory, "scripts/live-test.sh")], {
        env: without([], { CURSOR_API_KEY: "not-a-real-key", PATH: "/usr/bin:/bin" }),
      })
      expect(result.status).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain("LIVE_TEST=failed")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("cloud agent install", () => {
  it("stops when the OpenCode installer cannot be downloaded", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-fail-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho called > \"$HOME/curl-called\"\nexit 1\n")
    fs.chmodSync(path.join(bin, "curl"), 0o755)
    try {
      const result = run("bash", ["scripts/cloud-agent-install.sh"], {
        env: without([], { HOME: directory, PATH: `${bin}:/usr/bin:/bin` }),
      })
      expect(result.status).not.toBe(0)
      expect(fs.readFileSync(path.join(directory, "curl-called"), "utf8")).toContain("called")
      expect(fs.existsSync(path.join(directory, ".bun"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

function bashHere(script: string, env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  return run("bash", ["-c", script], { env })
}

describe("review command", () => {
  it("rejects missing, injected, and non-GitHub targets before git runs", () => {
    expect(run("bash", ["scripts/review-pr.sh"]).status).toBe(2)
    expect(run("bash", ["scripts/review-pr.sh", "--live"]).status).toBe(2)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-git-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho called > \"$HOME/git-called\"\nexit 1\n")
    fs.chmodSync(path.join(bin, "git"), 0o755)
    try {
      const env = without([], { HOME: directory, PATH: `${bin}:/usr/bin:/bin` })
      for (const target of ["12;rm -rf /", "https://evil.example/pull/1", "https://github.com/a/b/commit/1"]) {
        const result = run("bash", ["scripts/review-pr.sh", target], { env })
        expect(result.status, target).toBe(2)
      }
      const newlineModel = run("bash", ["scripts/review-pr.sh", "--local"], {
        env: { ...env, CURSOR_REVIEW_MODEL: "cursor/default\nINJECTED" },
      })
      expect(newlineModel.status).toBe(2)
      expect(fs.existsSync(path.join(directory, "git-called"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("parses a pull number and a canonical pull URL", () => {
    const result = bashHere(`
      set -euo pipefail
      source scripts/review-pr.sh
      [[ -f "$ROOT/scripts/review-pr.sh" ]]
      show() {
        if review_parse_target "$1"; then printf 'ok %s %s\\n' "$mode" "$pr"; else printf 'bad\\n'; fi
      }
      show 156
      show '12;rm -rf /'
      show 'https://github.com/oakimov/cursor-opencode-provider/pull/156'
      show 'https://github.com/oakimov/cursor-opencode-provider/pull/156/files'
      show 'https://github.com/oakimov/cursor-opencode-provider/pull/156?w=1'
      show 'https://evil.example/pull/1'
      show --local
    `)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe([
      "ok pr 156",
      "bad",
      "ok pr 156",
      "ok pr 156",
      "ok pr 156",
      "bad",
      "ok local ",
    ].join("\n") + "\n")
  })

  it("does not run the live script when checks fail, and adds only opencode to its PATH", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-live-path-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho live-ok\n")
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    try {
      const decision = bashHere(`
        source scripts/review-pr.sh
        review_live_action pr 0 0 0
        printf '\\n'
        review_live_action pr 0 1 0
        printf '\\n'
        review_live_action pr 1 0 0
        printf '\\n'
        review_live_action pr 1 1 0
        printf '\\n'
        review_live_action pr 1 0 1
        printf '\\n'
        review_live_action local 0 1 1
        printf '\\n'
      `)
      expect(decision.status, decision.stderr).toBe(0)
      expect(decision.stdout).toBe("skip\nskip-failed-checks\nisolated\nskip-failed-checks\nskip-failed-checks\nlocal\n")

      const result = bashHere(`
        set -euo pipefail
        source scripts/review-pr.sh
        trap review_cleanup EXIT
        review_begin_sandbox
        printf '%s\\n' "$isolate_tmp"
        review_tool_path
        printf '\\n'
        review_live_path
        printf '\\n'
        env -i PATH="$(review_live_path)" opencode
      `, { PATH: `${bin}:/usr/bin:/bin` })
      expect(result.status, result.stderr).toBe(0)
      const [tmp, toolPath, livePath, ran] = result.stdout.split("\n")
      expect(toolPath).not.toContain(bin)
      expect(livePath).toContain("opencode-bin")
      expect(livePath).not.toContain(bin)
      expect(ran).toBe("live-ok")
      expect(fs.existsSync(tmp!)).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("drops reviewer secrets and removes the sandbox on exit", () => {
    const result = bashHere(`
      set -euo pipefail
      source scripts/review-pr.sh
      trap review_cleanup EXIT
      review_begin_sandbox
      printf 'home %s\\n' "$isolate_home"
      review_run_isolated python3 -c 'import os; print("KEY="+os.environ.get("CURSOR_API_KEY","")); print("SECRET="+os.environ.get("SECRET_TOKEN","")); print("HOME="+os.environ["HOME"]); print("TMP="+os.environ["TMPDIR"])'
    `, { ...process.env, CURSOR_API_KEY: secret, SECRET_TOKEN: "super-secret" })
    expect(result.status, result.stderr).toBe(0)
    const home = result.stdout.match(/^home (\S+)$/m)?.[1]
    expect(home).toBeTruthy()
    expect(result.stdout).toContain("KEY=")
    expect(result.stdout).not.toContain(secret)
    expect(result.stdout).not.toContain("super-secret")
    expect(result.stdout).toContain(`HOME=${home}`)
    expect(fs.existsSync(home!)).toBe(false)
  })

  it("removes the worktree and names file when the review exits early", () => {
    const result = bashHere(`
      set -euo pipefail
      source scripts/review-pr.sh
      trap review_cleanup EXIT
      base_tmp=$(mktemp -d)
      export TMPDIR="$base_tmp"
      worktree=$(mktemp -d "$TMPDIR/cursor-pr-review-test.XXXXXX")
      names_file=$(mktemp "$TMPDIR/names.XXXXXX")
      echo pending > "$names_file"
      printf '%s\\n' "$base_tmp"
      exit 1
    `)
    expect(result.status).toBe(1)
    const base = result.stdout.trim()
    expect(fs.readdirSync(base)).toEqual([])
    fs.rmSync(base, { recursive: true, force: true })
  })

  it("includes a quoted untracked file and not a symlink target", () => {
    const directory = path.join(root, "test/.review-local-quoted")
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-symlink-"))
    const fileName = "caf\u00e9.ts"
    const gitEnv = without(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
    fs.rmSync(directory, { recursive: true, force: true })
    fs.mkdirSync(directory)
    try {
      const git = (args: string[]) => {
        const result = run("git", args, { cwd: directory, env: gitEnv })
        expect(result.status, result.stderr).toBe(0)
      }
      git(["init"])
      git(["config", "user.email", "test@example.com"])
      git(["config", "user.name", "test"])
      git(["config", "core.quotePath", "true"])
      fs.writeFileSync(path.join(directory, fileName), "export const marker = \"quoted-untracked\"\n")
      fs.writeFileSync(path.join(outside, "secret.txt"), "symlink-marker-secret\n")
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(directory, "linked.txt"))
      const quoted = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: directory, env: gitEnv })
      expect(quoted.stdout.startsWith("\"")).toBe(true)
      const result = bashHere(`
        set -euo pipefail
        source scripts/review-pr.sh
        cd test/.review-local-quoted
        names_file=$(mktemp)
        diff_text=""
        review_add_untracked
        cp "$names_file" names-bin
        printf '%s' "$diff_text" > text-out
        rm -f "$names_file"
      `, gitEnv)
      expect(result.status, result.stderr).toBe(0)
      const names = fs.readFileSync(path.join(directory, "names-bin"))
      const decoded = names.toString("utf8").split("\0").filter(Boolean)
      expect(decoded).toContain(fileName)
      expect(decoded).toContain("linked.txt")
      const text = fs.readFileSync(path.join(directory, "text-out"), "utf8")
      expect(text).toContain("quoted-untracked")
      expect(text).not.toContain("symlink-marker-secret")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
