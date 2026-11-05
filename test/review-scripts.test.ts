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

describe("isolated check", () => {
  it("rejects missing, injected, and non-GitHub targets before git runs", () => {
    expect(run("bash", ["scripts/isolated-check.sh"]).status).toBe(2)
    expect(run("bash", ["scripts/isolated-check.sh", "--live"]).status).toBe(2)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-git-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho called > \"$HOME/git-called\"\nexit 1\n")
    fs.chmodSync(path.join(bin, "git"), 0o755)
    try {
      const env = without([], { HOME: directory, PATH: `${bin}:/usr/bin:/bin` })
      for (const target of ["12;rm -rf /", "https://evil.example/pull/1", "https://github.com/a/b/commit/1", "--local"]) {
        const result = run("bash", ["scripts/isolated-check.sh", target], { env })
        expect(result.status, target).toBe(2)
      }
      expect(fs.existsSync(path.join(directory, "git-called"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("parses a pull number and a canonical pull URL", () => {
    const result = bashHere(`
      set -euo pipefail
      source scripts/isolated-check.sh
      [[ -f "$ROOT/scripts/isolated-check.sh" ]]
      show() {
        if check_parse_target "$1"; then printf 'ok %s\\n' "$pr"; else printf 'bad\\n'; fi
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
      "ok 156",
      "bad",
      "ok 156",
      "ok 156",
      "ok 156",
      "bad",
      "bad",
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
        source scripts/isolated-check.sh
        check_live_action 0 0
        printf '\\n'
        check_live_action 0 1
        printf '\\n'
        check_live_action 1 0
        printf '\\n'
        check_live_action 1 1
        printf '\\n'
      `)
      expect(decision.status, decision.stderr).toBe(0)
      expect(decision.stdout).toBe("skip\nskip-failed\nrun\nskip-failed\n")

      const result = bashHere(`
        set -euo pipefail
        source scripts/isolated-check.sh
        trap check_cleanup EXIT
        check_begin_sandbox
        printf '%s\\n' "$isolate_tmp"
        check_tool_path
        printf '\\n'
        check_live_path
        printf '\\n'
        env -i PATH="$(check_live_path)" opencode
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
      source scripts/isolated-check.sh
      trap check_cleanup EXIT
      check_begin_sandbox
      printf 'home %s\\n' "$isolate_home"
      check_run_isolated python3 -c 'import os; print("KEY="+os.environ.get("CURSOR_API_KEY","")); print("SECRET="+os.environ.get("SECRET_TOKEN","")); print("HOME="+os.environ["HOME"]); print("TMP="+os.environ["TMPDIR"])'
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

  it("removes the worktree when the check exits early", () => {
    const result = bashHere(`
      set -euo pipefail
      source scripts/isolated-check.sh
      trap check_cleanup EXIT
      base_tmp=$(mktemp -d)
      export TMPDIR="$base_tmp"
      worktree=$(mktemp -d "$TMPDIR/cursor-pr-check-test.XXXXXX")
      printf '%s\\n' "$base_tmp"
      exit 1
    `)
    expect(result.status).toBe(1)
    const base = result.stdout.trim()
    expect(fs.readdirSync(base)).toEqual([])
    fs.rmSync(base, { recursive: true, force: true })
  })
})
