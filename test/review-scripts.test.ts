import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Each case spawns Python, Bash or Git several times; Bun's 5 s default fails
// under ordinary machine load, unevenly across cases.
setDefaultTimeout(30_000)

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

function hostKernel(): string {
  return spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim()
}

function selectedPython(): string {
  const result = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" })
  const found = (result.stdout || "").trim()
  if (result.status !== 0 || !found.startsWith("/")) throw new Error(result.stderr || "python3 is required")
  return found
}

function writeTimeoutAdapter(file: string, python: string): void {
  fs.writeFileSync(
    file,
    `#!${python}
import os, subprocess, sys
seconds = float(sys.argv[1])
log = os.environ.get("TIMEOUT_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(sys.argv[1:]) + "\\n")
command = sys.argv[2:]
try:
    completed = subprocess.run(command, timeout=seconds)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(completed.returncode)
`,
  )
  fs.chmodSync(file, 0o755)
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
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
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
      expect(config.$schema).toBe("https://opencode.ai/config.json")
      expect(config.plugins[0]).toContain("plugins/cursor")
      expect(config.plugin).toBeUndefined()
      expect(config.permission.bash["*"]).toBe("deny")
      expect(config.permission.bash["git *"]).toBeUndefined()
      expect(config.permission.read.env).toBe("deny")
      expect(config.agents.explore.model.providerID).toBe("cursor")
      expect(config.mcp).toBeUndefined()
      expect(config.provider).toBeUndefined()
      const env = fs.readFileSync(path.join(directory, ".opencode-local/env"), "utf8")
      expect(env).toContain("dir with space")
      expect(env).toContain("'")
      expect(env).toContain("XDG_CACHE_HOME=")
      const plugin = fs.readFileSync(path.join(directory, ".opencode-local/plugins/cursor/index.js"), "utf8")
      expect(plugin).toContain("file://")
      expect(plugin).toContain("%20")
      expect(plugin).toContain("CURSOR_REVIEW_PLUGIN=")
      expect(plugin).toContain("CURSOR_REVIEW_PLUGIN_INIT count=")
      expect(plugin.match(/export default/g)).toHaveLength(1)
      const classicConfig = JSON.parse(fs.readFileSync(path.join(directory, ".opencode-local-1/opencode.json"), "utf8"))
      expect(classicConfig.plugins).toBeUndefined()
      expect(classicConfig.plugin).toHaveLength(1)
      expect(classicConfig.plugin[0]).toContain("cursor-review.mjs")
      expect(classicConfig.provider.cursor.npm).toContain("index.js")
      expect(classicConfig.permission.bash["*"]).toBe("deny")
      const classic = fs.readFileSync(path.join(directory, ".opencode-local-1/cursor-review.mjs"), "utf8")
      expect(classic).toContain("dist/plugin.js")
      expect(classic).toContain("export async function CursorPlugin")
      expect(classic).not.toContain("export default")
      const classicEnv = fs.readFileSync(path.join(directory, ".opencode-local-1/env"), "utf8")
      expect(classicEnv).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1")
      expect(classicEnv).not.toContain("CURSOR_OPENCODE2_DEV_ENTRY=")
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("writes the config for an explicit root", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configure-root-"))
    fs.mkdirSync(path.join(directory, "dist"))
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    try {
      const result = run("bash", ["scripts/configure-opencode.sh"], {
        env: { ...process.env, OPENCODE_CONFIG_ROOT: directory },
      })
      expect(result.status, result.stderr).toBe(0)
      expect(fs.existsSync(path.join(directory, ".opencode-local/opencode.json"))).toBe(true)
      const plugin = fs.readFileSync(path.join(directory, ".opencode-local/plugins/cursor/index.js"), "utf8")
      expect(plugin).toContain(directory)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
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
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    fs.copyFileSync(path.join(root, "scripts/live-test.sh"), path.join(directory, "scripts/live-test.sh"))
    fs.copyFileSync(path.join(root, "scripts/configure-opencode.sh"), path.join(directory, "scripts/configure-opencode.sh"))
    try {
      const result = run("bash", [path.join(directory, "scripts/live-test.sh")], {
        env: without([], { CURSOR_API_KEY: "not-a-real-key", PATH: "/usr/bin:/bin" }),
      })
      expect(result.status).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain("LIVE_TEST=failed")
      expect(`${result.stdout}${result.stderr}`).toContain("opencode1 (OpenCode 1.x)")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails when OpenCode 1.x is missing and does not skip", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-no-opencode1-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho should-not-run > \"$HOME/ran\"\nexit 0\n")
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    try {
      const result = run("bash", ["scripts/live-test.sh"], {
        env: without([], { CURSOR_API_KEY: "not-a-real-key", HOME: directory, PATH: `${bin}:/usr/bin:/bin` }),
      })
      expect(result.status).toBe(1)
      const output = `${result.stdout}${result.stderr}`
      expect(output).toContain("LIVE_TEST=failed")
      expect(output).toContain("opencode1 (OpenCode 1.x)")
      expect(output).not.toContain("LIVE_TEST=skipped")
      expect(output).not.toContain("LIVE_TEST=passed")
      expect(fs.existsSync(path.join(directory, "ran"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("cloud agent install", () => {
  it("matches the environment install string and the config writer", () => {
    const script = fs.readFileSync(path.join(root, "scripts/cloud-agent-install.sh"), "utf8")
    const configure = fs.readFileSync(path.join(root, "scripts/configure-opencode.sh"), "utf8")
    // A checkout may keep this tracked file out of its working tree (skip-worktree),
    // so Cursor does not apply it locally; compare the tracked copy then.
    const environmentFile = path.join(root, ".cursor/environment.json")
    const environmentText = fs.existsSync(environmentFile)
      ? fs.readFileSync(environmentFile, "utf8")
      : spawnSync("git", ["show", ":.cursor/environment.json"], { cwd: root, encoding: "utf8" }).stdout
    const environment = JSON.parse(environmentText) as {
      install: string
    }
    expect(environment.install).toBe(script)
    expect(environment.install).not.toContain("OPENCODE_PIN")
    expect(environment.install).not.toContain("2.2.5")
    expect(environment.install).not.toContain("bash -s -- --version")
    expect(environment.install).toContain("https://opencode.ai/v2/install | bash -s -- --no-modify-path")
    expect(environment.install).toContain("https://opencode.ai/install | bash -s -- --no-modify-path")
    expect(environment.install).toContain("https://opencode.ai/update/api/latest/cli/npm")
    expect(environment.install).toContain("https://registry.npmjs.org/opencode-ai/latest")
    expect(environment.install).toContain('HOME="$opencode1_home"')
    expect(environment.install).not.toContain("1.19.5")
    expect(environment.install).not.toContain("2.2.6")
    expect(environment.install).not.toContain("scripts/configure-opencode.sh")
    expect(environment.install).not.toContain("scripts/cloud-agent-install.sh")
    expect(environment.install).not.toContain("opencode.json")
    expect(environment.install).not.toContain("CURSOR_REVIEW_PLUGIN")
    expect(script).not.toContain("<<'PY'")
    expect(configure).toContain("CURSOR_REVIEW_PLUGIN_INIT")
    expect(configure).toContain("dist/plugin.js")
    expect(configure).toContain("cursor-review.mjs")
  })

  it("does not install when sourced, and reads a reported version", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-source-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho called > \"$HOME/curl-called\"\nexit 1\n")
    fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho 'opencode v9.9.9'\n")
    fs.chmodSync(path.join(bin, "curl"), 0o755)
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    try {
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/cloud-agent-install.sh
        printf 'parsed %s\\n' "$(opencode_version_from_metadata '{"version":"v9.9.9","package":"@opencode/cli"}')"
        printf 'match %s\\n' "$(opencode_version_of "$BIN/opencode")"
        printf 'missing %s\\n' "$(opencode_version_of "$BIN/missing")"
        printf 'one %s\\n' "$(opencode1_release_version '{"version":"1.2.3"}')"
        if opencode1_release_version '{"version":"2.2.6"}' >/dev/null; then printf 'accepted\\n'; else printf 'rejected\\n'; fi
        printf 'sourced\\n'
        `,
        { HOME: directory, PATH: `${bin}:/usr/bin:/bin`, BIN: bin },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("parsed 9.9.9\nmatch 9.9.9\nmissing \none 1.2.3\nrejected\nsourced\n")
      expect(fs.existsSync(path.join(directory, "curl-called"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-origin-"))
    try {
      expect(run("git", ["init", "--quiet", directory]).status).toBe(0)
      expect(run("git", ["-C", directory, "remote", "add", "origin", "https://github.com/oakimov/cursor-opencode-provider.git"]).status).toBe(0)
      const result = bashHere(`
        set -euo pipefail
        source scripts/isolated-check.sh
        [[ -f "$ROOT/scripts/isolated-check.sh" ]]
        ROOT="$FIXTURE_REPOSITORY"
        show() {
          if check_parse_target "$1"; then printf 'ok %s\\n' "$pr"; else printf 'bad\\n'; fi
        }
        show 156
        show '12;rm -rf /'
        show 'https://github.com/oakimov/cursor-opencode-provider/pull/156'
        show 'https://github.com/oakimov/cursor-opencode-provider/pull/156/files'
        show 'https://github.com/oakimov/cursor-opencode-provider/pull/156?w=1'
        show 'https://github.com/unrelated/project/pull/156'
        show 'https://evil.example/pull/1'
        show --local
      `, { ...process.env, FIXTURE_REPOSITORY: directory })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain("x-access-token")
      expect(result.stdout).toBe([
        "ok 156",
        "bad",
        "ok 156",
        "ok 156",
        "ok 156",
        "bad",
        "bad",
        "bad",
      ].join("\n") + "\n")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not fetch when the pull URL names a different repository", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-foreign-"))
    const log = path.join(directory, "git.log")
    try {
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          printf '%s\\n' "$*" >> "$LOG"
          if [[ "$*" == *"remote get-url"* ]]; then
            printf '%s\\n' "https://x-access-token:supersecret@github.com/oakimov/cursor-opencode-provider"
            return 0
          fi
          if [[ "$*" == *fetch* ]]; then
            printf 'FETCHED\\n' >> "$LOG"
            return 0
          fi
          echo "unexpected git $*" >&2
          return 1
        }
        check_main "https://github.com/unrelated/project/pull/156"
        `,
        { LOG: log },
      )
      expect(result.status).toBe(2)
      expect(`${result.stdout}${result.stderr}`).toContain("Refusing unrelated/project")
      expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret")
      expect(fs.readFileSync(log, "utf8")).not.toContain("FETCHED")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("places a tool linked from outside /usr/bin on the boundary PATH", () => {
    // macOS's default temp directory is a symlink; the tool file is reported resolved.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-tool-link-"))
    const src = path.join(directory, "src")
    const bin = path.join(directory, "bin")
    const hidden = path.join(directory, "hidden")
    const real = path.join(hidden, "opencode-real")
    const secret = path.join(hidden, "secret")
    fs.mkdirSync(src)
    fs.mkdirSync(bin)
    fs.mkdirSync(hidden)
    fs.writeFileSync(real, "#!/bin/sh\necho tool-ok\n")
    fs.chmodSync(real, 0o755)
    fs.writeFileSync(secret, "SECRET\n", { mode: 0o600 })
    fs.symlinkSync(real, path.join(bin, "opencode"))
    const env = { PATH: `${bin}:/usr/bin:/bin` }
    try {
      const decision = bashHere(`
        set -euo pipefail
        source scripts/isolate-run.sh
        if isolate_tool_file true; then echo 'true-mounted'; else echo 'true-visible'; fi
        isolate_tool_file opencode
      `, env)
      expect(decision.status, decision.stderr).toBe(0)
      expect(decision.stdout).toBe(`true-visible\n${fs.realpathSync(real)}\n`)
      if (hostKernel() !== "Linux") return
      const ran = run("bash", ["scripts/isolate-run.sh", "--src", src, "--tool", "opencode", "--", "/bin/sh", "-c", 'printf "where=%s\\n" "$(command -v opencode)"; opencode; if ls "$1" >/dev/null 2>&1; then echo LEAK; else echo hidden; fi', "sh", hidden], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      })
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0)
      expect(ran.stdout).toContain("where=/opt/tools/opencode")
      expect(ran.stdout).toContain("tool-ok")
      expect(ran.stdout).toContain("hidden")
      expect(ran.stdout).not.toContain("SECRET")
      expect(ran.stdout).not.toContain("LEAK")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("runs a native runtime binary without exposing its install directory", () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "review-native-runtime-"))
    const src = path.join(directory, "src")
    const bin = path.join(directory, "bin")
    const homeInstall = path.join(directory, "private-install")
    fs.mkdirSync(src)
    fs.mkdirSync(bin)
    fs.mkdirSync(homeInstall)
    const native = path.join(homeInstall, "runtime")
    fs.copyFileSync(process.execPath, native)
    fs.chmodSync(native, 0o755)
    fs.symlinkSync(native, path.join(bin, "opencode"))
    try {
      const ran = run("bash", ["scripts/isolate-run.sh", "--src", src, "--tool", "opencode", "--", "/bin/sh", "-c", 'printf "where=%s\\n" "$(command -v opencode)"; opencode --version; if ls "$1" >/dev/null 2>&1; then echo LEAK; else echo hidden; fi', "sh", homeInstall], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      })
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0)
      if (hostKernel() === "Linux") expect(ran.stdout).toContain("where=/opt/tools/opencode")
      else expect(ran.stdout).toMatch(/where=.+\/cursor-isolate-tools\.[^/]+\/opencode/)
      expect(ran.stdout).toContain("hidden")
      expect(ran.stdout).not.toContain("LEAK")
      expect(ran.stdout.trim().split("\n").some((line) => /\d+\.\d+/.test(line))).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
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
        CURSOR_REVIEW_TRUST=1
        check_live_action 1 0
        printf '\\n'
        CURSOR_REVIEW_TRUST_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        check_live_action 1 0
        printf '\\n'
        CURSOR_REVIEW_TRUST_SHA=not-a-commit
        check_live_action 1 0
        printf '\\n'
      `)
      expect(decision.status, decision.stderr).toBe(0)
      expect(decision.stdout).toBe("skip\nskip-failed\nskip-untrusted\nskip-failed\nskip-untrusted\nrun\nskip-untrusted\n")

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

  it("loads the worktree plugin from a private config and stops when OpenCode does not", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "review-builtin-live-"))
    const bin = path.join(tree, "bin")
    const reviewHome = path.join(tree, "review-home")
    fs.mkdirSync(path.join(tree, "dist"), { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ version: "9.9.9" }) + "\n")
    fs.writeFileSync(path.join(tree, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(tree, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(tree, "dist/plugin-opencode2.js"), "export default {}\n")
    const python = selectedPython()
    const timeoutLog = path.join(tree, "timeout.log")
    writeTimeoutAdapter(path.join(bin, "review-timeout"), python)
    fs.writeFileSync(
      path.join(bin, "read-marker.py"),
      `#!${python}
import os, pathlib, re, sys
text = pathlib.Path(os.environ["OPENCODE_CONFIG_DIR"], "plugins", "cursor", "index.js").read_text()
match = re.search(r"CURSOR_REVIEW_PLUGIN=\\S+ version=\\S+", text)
sys.stderr.write((match.group(0) if match else "no-marker") + "\\n")
`,
    )
    fs.chmodSync(path.join(bin, "read-marker.py"), 0o755)
    fs.writeFileSync(
      path.join(bin, "read-classic.py"),
      `#!${python}
import os, pathlib, re, sys
text = pathlib.Path(os.environ["OPENCODE_CONFIG_DIR"], "cursor-review.mjs").read_text()
match = re.search(r"CURSOR_REVIEW_PLUGIN=\\S+ version=\\S+", text)
sys.stderr.write((match.group(0) if match else "no-marker") + "\\n")
`,
    )
    fs.chmodSync(path.join(bin, "read-classic.py"), 0o755)
    fs.writeFileSync(
      path.join(bin, "opencode"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "opencode v2.2.6"
  exit 0
fi
mkdir -p "$TMPDIR/runtime-created"
printf native-library > "$TMPDIR/runtime-created/library.bin"
if [ "$1" = plugin ]; then
  exec ${JSON.stringify(python)} ${JSON.stringify(path.join(bin, "read-marker.py"))}
fi
if [ "$1" = run ]; then
  printf '%s\\n' "CURSOR_REVIEW_PLUGIN_INIT count=1 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
  printf '%s\\n' '{"type":"text","part":{"type":"text","text":"pong"}}'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`,
    )
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    fs.writeFileSync(
      path.join(bin, "opencode1"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.19.5"
  exit 0
fi
mkdir -p "$TMPDIR/runtime-created"
printf native-library > "$TMPDIR/runtime-created/library.bin"
if [ "$1" = run ]; then
  ${JSON.stringify(python)} ${JSON.stringify(path.join(bin, "read-classic.py"))}
  printf '%s\\n' "CURSOR_REVIEW_PLUGIN_INIT count=1 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
  printf '%s\\n' '{"type":"text","part":{"type":"text","text":"pong"}}'
  exit 0
fi
echo "unexpected $*" >&2
exit 1
`,
    )
    fs.chmodSync(path.join(bin, "opencode1"), 0o755)
    const env = {
      HOME: tree,
      PATH: `${bin}:/usr/bin:/bin`,
      CURSOR_API_KEY: secret,
      OPENCODE_CONFIG_ROOT: tree,
      OPENCODE_REVIEW_HOME: reviewHome,
      LIVE_TEST_TIMEOUT: path.join(bin, "review-timeout"),
      LIVE_TEST_PYTHON: python,
      TIMEOUT_LOG: timeoutLog,
    }
    const tempRoot = path.join(reviewHome, "tmp")
    fs.mkdirSync(tempRoot, { recursive: true })
    fs.writeFileSync(path.join(tempRoot, "preexisting"), "keep")
    let aliasParent: string | undefined
    try {
      const passed = run("bash", ["scripts/live-test.sh"], { env })
      expect(passed.status, `${passed.stdout}\n${passed.stderr}`).toBe(0)
      expect(fs.readdirSync(tempRoot)).toEqual(["preexisting"])
      expect(fs.readFileSync(path.join(tempRoot, "preexisting"), "utf8")).toBe("keep")
      const pluginPath = fs.realpathSync(path.join(tree, "dist/plugin-opencode2.js"))
      expect(passed.stdout).toContain(`WORKTREE=${tree}`)
      expect(passed.stdout).toContain(`PLUGIN_PATH=${pluginPath}`)
      expect(passed.stdout).toContain("PLUGIN_VERSION=9.9.9")
      expect(passed.stdout).toContain("OPENCODE_MAJOR=2")
      expect(passed.stdout).toContain("OPENCODE_MAJOR=1")
      expect(passed.stdout).toContain("OPENCODE_VERSION=opencode v2.2.6")
      expect(passed.stdout).toContain("OPENCODE_VERSION=1.19.5")
      expect(passed.stdout).toContain(`PLUGIN_LOADED=CURSOR_REVIEW_PLUGIN=${pluginPath} version=9.9.9`)
      const classicPath = fs.realpathSync(path.join(tree, "dist/plugin.js"))
      expect(passed.stdout).toContain(`PLUGIN_LOADED=CURSOR_REVIEW_PLUGIN=${classicPath} version=9.9.9`)
      expect(passed.stdout.match(/LIVE_TEST=passed/g)).toEqual(["LIVE_TEST=passed", "LIVE_TEST=passed"])
      expect(passed.stdout).not.toContain(secret)
      expect(passed.stdout).toContain(fs.realpathSync(path.join(reviewHome, "config", "opencode2")))
      expect(passed.stdout).toContain(fs.realpathSync(path.join(reviewHome, "config", "opencode1")))
      const config = JSON.parse(fs.readFileSync(path.join(reviewHome, "config", "opencode2", "opencode.json"), "utf8"))
      expect(config.plugins).toHaveLength(1)
      expect(config.plugin).toBeUndefined()
      expect(config.permission.bash["*"]).toBe("deny")
      const classicConfig = JSON.parse(fs.readFileSync(path.join(reviewHome, "config", "opencode1", "opencode.json"), "utf8"))
      expect(classicConfig.plugins).toBeUndefined()
      expect(classicConfig.plugin).toHaveLength(1)
      expect(classicConfig.plugin[0]).toContain("cursor-review.mjs")
      expect(classicConfig.provider.cursor.npm).not.toContain("plugin.js")
      expect(classicConfig.provider.cursor.npm).toContain("index.js")
      expect(passed.stdout.match(/PLUGIN_INIT_COUNT=1/g)).toEqual(["PLUGIN_INIT_COUNT=1", "PLUGIN_INIT_COUNT=1"])
      expect(fs.existsSync(path.join(tree, ".opencode-local"))).toBe(false)
      const deadlines = fs.readFileSync(timeoutLog, "utf8")
      expect(deadlines).toContain("60 ")
      expect(deadlines).toContain("180 ")

      fs.writeFileSync(
        path.join(bin, "opencode"),
        `#!/bin/sh
if [ "$1" = plugin ]; then
  echo "CURSOR_REVIEW_PLUGIN=$CURSOR_REVIEW_PLUGIN_PATH version=$CURSOR_REVIEW_PLUGIN_VERSION" >&2
  exit 0
fi
echo "CURSOR_REVIEW_PLUGIN_INIT count=1 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
echo "CURSOR_REVIEW_PLUGIN_INIT count=2 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
printf '%s\\n' '{"type":"text","part":{"type":"text","text":"pong"}}'
exit 0
`,
      )
      fs.chmodSync(path.join(bin, "opencode"), 0o755)
      aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "review-alias-"))
      const alias = path.join(aliasParent, "root")
      fs.symlinkSync(tree, alias)
      expect(fs.realpathSync(alias)).toBe(fs.realpathSync(tree))
      expect(alias).not.toBe(fs.realpathSync(tree))
      const twice = run("bash", ["scripts/live-test.sh"], { env: { ...env, OPENCODE_CONFIG_ROOT: alias } })
      expect(twice.status, `${twice.stdout}\n${twice.stderr}`).toBe(1)
      const opener = twice.stdout.split("OPENCODE_MAJOR=1")[0] ?? ""
      expect(opener).toContain("initialized the provider 2 times")
      expect(opener).toContain(`path=${pluginPath}`)
      expect(opener).not.toContain("LIVE_TEST=passed")
      expect(twice.stdout).not.toContain(`${alias}/dist/plugin-opencode2.js`)
      expect(twice.stdout).toContain("LIVE_TEST=passed")

      fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\nmkdir -p \"$TMPDIR/runtime-created\"\nprintf native-library > \"$TMPDIR/runtime-created/library.bin\"\nif [ \"$1\" = run ]; then echo ran > \"$HOME/ran-model\"; fi\nexit 0\n")
      const failed = run("bash", ["scripts/live-test.sh"], { env: { ...env, HOME: tree } })
      expect(failed.status).toBe(1)
      expect(failed.stdout).toContain("LIVE_TEST=failed")
      expect(failed.stdout).toContain("did not load")
      expect(fs.readdirSync(tempRoot)).toEqual(["preexisting"])
      expect(fs.existsSync(path.join(tree, "ran-model"))).toBe(false)
    } finally {
      if (aliasParent) fs.rmSync(aliasParent, { recursive: true, force: true })
      fs.rmSync(tree, { recursive: true, force: true })
    }
  })

  it("drops reviewer secrets and removes the sandbox on exit", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-isolate-src-"))
    const result = bashHere(`
      set -euo pipefail
      source scripts/isolated-check.sh
      trap check_cleanup EXIT
      check_begin_sandbox
      printf 'home %s\\n' "$isolate_home"
      ISOLATE_SRC="$SRC" check_run_isolated /bin/sh -c 'printf "KEY=%s\\nSECRET=%s\\nAPPKEY=%s\\nHOME=%s\\nTMP=%s\\n" "\${CURSOR_API_KEY-}" "\${SECRET_TOKEN-}" "\${REVIEW_APP_PRIVATE_KEY-}" "$HOME" "$TMPDIR"'
    `, { ...process.env, CURSOR_API_KEY: secret, SECRET_TOKEN: "super-secret", REVIEW_APP_PRIVATE_KEY: "app-key-material", SRC: src })
    fs.rmSync(src, { recursive: true, force: true })
    expect(result.status, result.stderr).toBe(0)
    const home = result.stdout.match(/^home (\S+)$/m)?.[1]
    expect(home).toBeTruthy()
    expect(result.stdout).toContain("KEY=")
    expect(result.stdout).not.toContain(secret)
    expect(result.stdout).not.toContain("super-secret")
    expect(result.stdout).not.toContain("app-key-material")
    expect(result.stdout).toContain("APPKEY=")
    if (hostKernel() === "Linux") {
      expect(result.stdout).toContain("HOME=/home/reviewer")
      expect(result.stdout).toContain("TMP=/tmp")
    } else {
      expect(result.stdout).toContain("HOME=")
      expect(result.stdout).not.toContain(`HOME=${process.env.HOME}`)
      expect(result.stdout).not.toContain("HOME=/home/reviewer")
    }
    expect(fs.existsSync(home!)).toBe(false)
  })

  it("does not archive a commit other than the trusted one", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-trust-"))
    const log = path.join(directory, "git.log")
    const trusted = "a".repeat(40)
    const fetched = "b".repeat(40)
    try {
      const mismatch = bashHere(`
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          printf '%s\\n' "$*" >> "$LOG"
          if [[ "$*" == *fetch* ]]; then return 0; fi
          if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$FETCHED"; return 0; fi
          if [[ "$*" == *archive* ]]; then printf 'ARCHIVED\\n' >> "$LOG"; return 0; fi
          echo "unexpected git $*" >&2
          return 1
        }
        tar() { printf 'TAR\\n' >> "$LOG"; }
        check_main 156
      `, { LOG: log, FETCHED: fetched, CURSOR_REVIEW_TRUST: "1", CURSOR_REVIEW_TRUST_SHA: trusted })
      expect(mismatch.status).toBe(2)
      expect(mismatch.stderr).toContain(`Fetched ${fetched}, not the trusted ${trusted}`)
      expect(mismatch.stdout).toContain(`Check commit: ${fetched}`)
      const trace = fs.readFileSync(log, "utf8")
      expect(trace).not.toContain("ARCHIVED")
      expect(trace).not.toContain("TAR")

      fs.writeFileSync(log, "")
      const moved = bashHere(`
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$MOVED"; return 0; fi
          return 1
        }
        check_refuse_moved_commit "$ARCHIVED"
      `, { MOVED: fetched, ARCHIVED: trusted, CURSOR_REVIEW_TRUST_SHA: trusted })
      expect(moved.status).toBe(2)
      expect(moved.stderr).toContain("Refusing to forward the key")
      expect(moved.stderr).toContain(fetched)

      const same = bashHere(`
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$MOVED"; return 0; fi
          return 1
        }
        check_refuse_moved_commit "$ARCHIVED"
      `, { MOVED: trusted, ARCHIVED: trusted, CURSOR_REVIEW_TRUST_SHA: trusted })
      expect(same.status, same.stderr).toBe(0)
      expect(same.stdout).toContain(`Check commit: ${trusted}`)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("archives the captured commit when FETCH_HEAD moves during archive", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-archive-sha-"))
    const log = path.join(directory, "git.log")
    const archiveArg = path.join(directory, "archive-arg")
    const trusted = "a".repeat(40)
    const other = "b".repeat(40)
    try {
      const result = bashHere(`
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          printf '%s\\n' "$*" >> "$LOG"
          if [[ "$*" == *fetch* ]]; then return 0; fi
          if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$TRUSTED"; return 0; fi
          if [[ "$*" == *archive* ]]; then
            printf '%s\\n' "\${@: -1}" > "$ARCHIVE_ARG"
            return 0
          fi
          echo "unexpected git $*" >&2
          return 1
        }
        tar() {
          local dest=""
          while [[ "$#" -gt 0 ]]; do
            if [[ "$1" == -C ]]; then dest="$2"; shift 2; continue; fi
            shift
          done
          [[ -n "$dest" ]]
          local obj
          obj="$(cat "$ARCHIVE_ARG")"
          if [[ "$obj" == FETCH_HEAD ]]; then obj="$OTHER"; fi
          printf '%s\\n' "$obj" > "$dest/REV"
        }
        check_step() { echo "\${1}=passed"; return 0; }
        check_run_live() {
          echo "LIVE_TREE_REVISION=$(cat "$1/REV")"
          if [[ -n "\${CURSOR_API_KEY:-}" ]]; then echo "KEY_WAS_AVAILABLE=1"; fi
          return 0
        }
        check_main 156 --live
      `, {
        LOG: log,
        ARCHIVE_ARG: archiveArg,
        TRUSTED: trusted,
        OTHER: other,
        CURSOR_REVIEW_TRUST: "1",
        CURSOR_REVIEW_TRUST_SHA: trusted,
        CURSOR_API_KEY: "harmless",
        PATH: "/usr/bin:/bin",
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain(`LIVE_TREE_REVISION=${trusted}`)
      expect(result.stdout).not.toContain(`LIVE_TREE_REVISION=${other}`)
      expect(result.stdout).toContain("KEY_WAS_AVAILABLE=1")
      expect(result.stdout).not.toContain("harmless")
      expect(fs.readFileSync(archiveArg, "utf8").trim()).toBe(trusted)
      expect(fs.readFileSync(log, "utf8")).not.toContain("archive FETCH_HEAD")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("translates darwin virtual paths and does not allow every file read", () => {
    // On macOS the default temp directory is a symlink into /private. Seatbelt
    // matches resolved paths, so the profile must name them, never the link.
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "review-darwin-"))
    const directory = fs.realpathSync(linked)
    const src = path.join(directory, "src")
    const harness = path.join(directory, "harness")
    const secretDir = path.join(directory, "secret-dir")
    const toolDir = path.join(directory, "cellar", "tool", "1", "bin")
    try {
    fs.mkdirSync(src)
    fs.mkdirSync(harness)
    fs.mkdirSync(secretDir)
    const toolRoot = path.join(directory, "cellar", "tool", "1")
    const outsideBin = path.join(directory, "outside", "bin")
    fs.mkdirSync(path.join(toolRoot, "lib"), { recursive: true })
    fs.mkdirSync(toolDir, { recursive: true })
    fs.mkdirSync(outsideBin, { recursive: true })
    fs.writeFileSync(path.join(toolDir, "mytool"), "#!/bin/sh\nexit 0\n")
    fs.chmodSync(path.join(toolDir, "mytool"), 0o755)
    fs.writeFileSync(path.join(toolRoot, "credential"), "SECRET\n", { mode: 0o600 })
    fs.writeFileSync(path.join(outsideBin, "other"), "#!/bin/sh\nexit 0\n")
    fs.chmodSync(path.join(outsideBin, "other"), 0o755)
    fs.writeFileSync(path.join(directory, "outside", "secret"), "SECRET\n", { mode: 0o600 })
    fs.symlinkSync(path.join(outsideBin, "other"), path.join(toolDir, "other"))
      const result = bashHere(`
        set -euo pipefail
        source scripts/isolate-run.sh
        darwin_home=""
        darwin_tmp=""
        darwin_tools=""
        darwin_profile=""
        cleanup() {
          [[ -z "$darwin_home" ]] || rm -rf "$darwin_home"
          [[ -z "$darwin_tmp" ]] || rm -rf "$darwin_tmp"
          [[ -z "$darwin_tools" ]] || rm -rf "$darwin_tools"
          [[ -z "$darwin_profile" ]] || rm -f "$darwin_profile"
        }
        trap cleanup EXIT
        src="$SRC"
        tools=(mytool other)
        ro_binds=("$HARNESS:/opt/harness")
        env_names=()
        set_pairs=("OPENCODE_CONFIG_ROOT=/src" "OPENCODE_REVIEW_HOME=/tmp/review-opencode")
        command=(bash /opt/harness/scripts/live-test.sh /src/file.txt)
        isolate_darwin_prepare "$src"
        printf 'TOOLS=%s\\n' "$darwin_tools"
        echo '---PROFILE---'
        cat "$darwin_profile"
        echo '---COMMAND---'
        n="$(isolate_count darwin_command)"
        i=0
        while [[ "$i" -lt "$n" ]]; do
          isolate_at darwin_command "$i"
          printf '\\n'
          i=$((i + 1))
        done
        echo '---TRANSLATED---'
        isolate_translate /src
        printf '\\n'
        isolate_translate /tmp/review-opencode
        printf '\\n'
        echo '---LINK---'
        readlink "$darwin_tools/mytool"
      `, {
        SRC: path.join(linked, "src"),
        HARNESS: path.join(linked, "harness"),
        PATH: `${path.join(linked, "cellar", "tool", "1", "bin")}:/usr/bin:/bin`,
      })
      expect(result.status, result.stderr).toBe(0)
      const profile = result.stdout.split("---PROFILE---\n")[1]?.split("---COMMAND---\n")[0] ?? ""
      if (linked !== directory) expect(profile).not.toContain(`"${linked}`)
      for (const scratch of ["home", "tmp", "tools"]) {
        const rule = profile.match(new RegExp(`"([^"]*/cursor-isolate-${scratch}\\.[^"/]+)"`))?.[1]
        expect(rule, scratch).toBeDefined()
        expect(fs.realpathSync.native(path.dirname(rule!))).toBe(path.dirname(rule!))
      }
      expect(profile).toContain('(allow file-write*\n  (literal "/dev/null")\n')
      const command = result.stdout.split("---COMMAND---\n")[1]?.split("---TRANSLATED---\n")[0]?.trim().split("\n") ?? []
      const translated = result.stdout.split("---TRANSLATED---\n")[1]?.trim().split("\n") ?? []
      expect(profile.split("\n")).not.toContain("(allow file-read*)")
      expect(profile).toContain('(literal "/")')
      expect(profile).not.toContain('(subpath "/")')
      expect(profile).toContain("(allow file-map-executable")
      expect(profile).toContain("/System/Volumes/Preboot/Cryptexes/OS")
      expect(profile).toContain("/private/var/db/dyld")
      expect(profile).toContain("/private/etc")
      expect(profile).toContain(harness)
      expect(profile).not.toContain(secretDir)
      const write = profile.split("(allow file-write*")[1] ?? ""
      expect(write).toContain(src)
      expect(write).not.toContain(harness)
      expect(command).toEqual(["bash", path.join(harness, "scripts/live-test.sh"), path.join(src, "file.txt")])
      expect(translated[0]).toBe(src)
      expect(translated[1]).toMatch(/\/review-opencode$/)
      expect(result.stdout.split("---LINK---\n")[1]?.trim()).toBe(path.join(toolDir, "mytool"))
      const toolFile = path.join(toolDir, "mytool")
      const otherFile = path.join(outsideBin, "other")
      expect(profile).toContain(`(literal "${toolFile}")`)
      expect(profile).toContain(`(literal "${otherFile}")`)
      expect(profile).not.toContain(`(subpath "${toolRoot}")`)
      expect(profile).not.toContain(`(subpath "${toolDir}")`)
      expect(profile).not.toContain(`(subpath "${path.join(toolRoot, "lib")}")`)
      expect(profile).not.toContain(`(subpath "${path.join(directory, "outside")}")`)
      expect(profile).not.toContain(path.join(toolRoot, "credential"))
      expect(profile).not.toContain(path.join(directory, "outside", "secret"))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("allows only the root directory inode and the selected tool file", () => {
    // The default temp directory is a symlink on macOS; rules name the resolved file.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-darwin-root-"))
    const src = path.join(directory, "src")
    const prefix = path.join(directory, "private-prefix")
    const bin = path.join(prefix, "bin")
    const sentinel = path.join(prefix, "credential")
    const tool = path.join(bin, "mytool")
    fs.mkdirSync(src)
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(tool, 0o755)
    fs.writeFileSync(sentinel, "SECRET\n", { mode: 0o600 })
    const script = `
      set -euo pipefail
      source scripts/isolate-run.sh
      darwin_home=""
      darwin_tmp=""
      darwin_tools=""
      darwin_profile=""
      cleanup() {
        [[ -z "$darwin_home" ]] || rm -rf "$darwin_home"
        [[ -z "$darwin_tmp" ]] || rm -rf "$darwin_tmp"
        [[ -z "$darwin_tools" ]] || rm -rf "$darwin_tools"
        [[ -z "$darwin_profile" ]] || rm -f "$darwin_profile"
      }
      trap cleanup EXIT
      src="$SRC"
      tools=(mytool)
      ro_binds=()
      env_names=()
      set_pairs=()
      command=(/usr/bin/true)
      isolate_darwin_prepare "$src"
      cat "$darwin_profile"
    `
    try {
      for (const shell of ["bash", "/bin/bash"]) {
        const result = run(shell, ["-c", script], { env: { SRC: src, PATH: `${bin}:/usr/bin:/bin` } })
        expect(result.status, `${shell}\n${result.stderr}`).toBe(0)
        expect(result.stdout).toContain('(literal "/")')
        expect(result.stdout).not.toContain('(subpath "/")')
        expect(result.stdout.split("\n")).not.toContain("(allow file-read*)")
        expect(result.stdout).toContain(`(literal "${fs.realpathSync(tool)}")`)
        for (const hidden of [prefix, bin, fs.realpathSync(prefix), fs.realpathSync(bin)]) {
          expect(result.stdout).not.toContain(`(subpath "${hidden}")`)
        }
        expect(result.stdout).not.toContain(sentinel)
        expect(result.stdout).not.toContain(fs.realpathSync(sentinel))
      }
      if (hostKernel() === "Darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
        for (const shell of ["bash", "/bin/bash"]) {
          for (const args of [["/usr/bin/true"], ["/bin/echo", "ok"], ["/bin/bash", "-c", "exit 0"]]) {
            const ran = run(shell, ["scripts/isolate-run.sh", "--src", src, "--tool", "mytool", "--", ...args], {
              env: { PATH: `${bin}:/usr/bin:/bin` },
            })
            expect(ran.status, `${shell} ${args.join(" ")}\n${ran.stderr}`).toBe(0)
          }
        }
        const leaked = run("bash", ["scripts/isolate-run.sh", "--src", src, "--tool", "mytool", "--", "/bin/cat", sentinel], {
          env: { PATH: `${bin}:/usr/bin:/bin` },
        })
        expect(leaked.status).not.toBe(0)
        expect(leaked.stdout).not.toContain("SECRET")
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("hides host files and refuses to modify the trusted harness", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-boundary-"))
    const src = path.join(directory, "src")
    const secretFile = path.join(directory, "sentinel")
    const harness = path.join(directory, "harness.txt")
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, "file.txt"), "hello\n")
    fs.writeFileSync(secretFile, "TOPSECRET\n", { mode: 0o600 })
    fs.writeFileSync(harness, "CANARY\n")
    fs.symlinkSync(secretFile, path.join(src, "escape"))
    fs.writeFileSync(path.join(directory, "parent-secret"), "PARENTSECRET\n")
    fs.symlinkSync("../parent-secret", path.join(src, "rel"))
    const probe = path.join(src, "probe.py")
    fs.writeFileSync(
      probe,
      `import pathlib, sys
secret, harness, socket = sys.argv[1:]
print("SRC="+pathlib.Path("/src/file.txt").read_text().strip())
def attempt(label, fn):
    try:
        print(label + "=" + fn())
    except Exception as error:
        print(label + "_ERR=" + type(error).__name__)
attempt("SECRET", lambda: pathlib.Path(secret).read_text())
attempt("ESCAPE", lambda: pathlib.Path("/src/escape").read_text())
attempt("REL", lambda: pathlib.Path("/src/rel").read_text())
attempt("HARNESS", lambda: pathlib.Path(harness).write_text("PWNED\\n") or "ok")
attempt("RO", lambda: pathlib.Path("/opt/harness/harness.txt").write_text("PWNED\\n") or "ok")
import subprocess
pathlib.Path("/src/copied").mkdir(exist_ok=True)
remount = subprocess.run(["mount", "-o", "remount,bind,rw", "/opt/harness"], capture_output=True, text=True)
print("REMOUNT=" + str(remount.returncode))
copied = subprocess.run(["mount", "--bind", "/opt/harness", "/src/copied"], capture_output=True, text=True)
print("REMOUNT_BIND=" + str(copied.returncode))
attempt("REMOUNT_WRITE", lambda: pathlib.Path("/opt/harness/harness.txt").write_text("PWNED\\n") or "ok")
for line in pathlib.Path("/proc/self/status").read_text().splitlines():
    if line.startswith(("CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:", "NoNewPrivs:")):
        print(line.replace("\\t", " "))
pathlib.Path("/src/owned.txt").write_text("ok\\n")
print("OWNED=ok")
print("WORKSPACE=" + str(pathlib.Path("/workspace").exists()))
print("GIT=" + str(pathlib.Path("/src/.git").exists()))
print("SOCKET=" + str(pathlib.Path(socket).exists()))
`,
    )
    const socket = path.join(directory, "agent.sock")
    const bound = spawnSync(selectedPython(), ["-c", "import socket,sys\ns=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", socket])
    expect(bound.status).toBe(0)
    const marker = `isolate-host-only-${process.pid}`
    let sleeper: ReturnType<typeof spawn> | undefined
    try {
      const result = run(
        "bash",
        [
          "scripts/isolate-run.sh",
          "--src",
          src,
          "--ro-bind",
          `${directory}:/opt/harness`,
          "--",
          "python3",
          "/src/probe.py",
          secretFile,
          harness,
          socket,
        ],
        { env: { ...process.env, CURSOR_API_KEY: secret } },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("SRC=hello")
      expect(result.stdout).toContain("SECRET_ERR=FileNotFoundError")
      expect(result.stdout).toContain("ESCAPE_ERR=FileNotFoundError")
      expect(result.stdout).toContain("REL_ERR=FileNotFoundError")
      expect(result.stdout).toContain("HARNESS_ERR=FileNotFoundError")
      expect(result.stdout).toContain("RO_ERR=")
      expect(result.stdout).toMatch(/REMOUNT=[1-9]/)
      expect(result.stdout).toMatch(/REMOUNT_BIND=[1-9]/)
      expect(result.stdout).toContain("REMOUNT_WRITE_ERR=")
      for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
        expect(result.stdout).toContain(`${set}: 0000000000000000`)
      }
      expect(result.stdout).toContain("NoNewPrivs: 1")
      expect(result.stdout).toContain("OWNED=ok")
      expect(result.stdout).toContain("WORKSPACE=False")
      expect(result.stdout).toContain("GIT=False")
      expect(result.stdout).toContain("SOCKET=False")
      expect(result.stdout).not.toContain(secret)
      expect(result.stdout).not.toContain("TOPSECRET")
      expect(fs.readFileSync(harness, "utf8")).toBe("CANARY\n")
      sleeper = spawn("bash", ["-c", `exec -a ${marker} sleep 30`], { detached: true, stdio: "ignore" })
      sleeper.unref()
      const seen = spawnSync("bash", ["-c", `ps -A -o args= | grep -F ${JSON.stringify(marker)} || true`], {
        encoding: "utf8",
      })
      expect(seen.stdout).toContain(marker)
      fs.writeFileSync(
        path.join(src, "scan.py"),
        `import os, pathlib
marker = os.environ["MARKER"]
found = False
for child in pathlib.Path("/proc").iterdir():
    if not child.name.isdigit():
        continue
    try:
        raw = (child / "cmdline").read_bytes().decode("utf-8", "replace")
    except Exception:
        continue
    if marker in raw:
        found = True
print("SAW=" + str(found))
`,
      )
      const inside = run(
        "bash",
        ["scripts/isolate-run.sh", "--src", src, "--set", `MARKER=${marker}`, "--", "python3", "/src/scan.py"],
      )
      expect(inside.status, inside.stderr).toBe(0)
      expect(inside.stdout).toContain("SAW=False")
    } finally {
      if (sleeper?.pid) spawnSync("kill", ["-KILL", String(sleeper.pid)])
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails closed when the isolation mechanism is unavailable", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-no-unshare-"))
    const bin = path.join(directory, "bin")
    const src = path.join(directory, "src")
    const marker = path.join(directory, "ran")
    fs.mkdirSync(bin)
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\necho Linux\n")
    fs.writeFileSync(path.join(bin, "unshare"), "#!/bin/sh\nexit 1\n")
    fs.chmodSync(path.join(bin, "uname"), 0o755)
    fs.chmodSync(path.join(bin, "unshare"), 0o755)
    try {
      const result = run(
        "bash",
        ["scripts/isolate-run.sh", "--src", src, "--", "python3", "-c", `open(${JSON.stringify(marker)},"w").write("ran")`],
        { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
      )
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("ISOLATION=unavailable")
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
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

  it("keeps user-namespace setup in the workflow instead of the pull request checkout", () => {
    const yaml = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")
    expect(yaml).not.toContain("bash scripts/ci-enable-userns.sh")
    expect(yaml).toContain("kernel.apparmor_restrict_unprivileged_userns")
    expect(yaml).toContain("*userns-step")
    const publish = fs.readFileSync(path.join(root, ".github/workflows/publish.yml"), "utf8")
    expect(publish).not.toContain("bash scripts/ci-enable-userns.sh")
    expect(publish).toContain("kernel.apparmor_restrict_unprivileged_userns")
    expect(publish).toContain("Allow user namespaces")
  })

  it("runs a command when no tools or environment names are passed", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-empty-arrays-"))
    try {
      const result = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "/usr/bin/true"])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it("lets the command write its source, home, temp directory and /dev/null from the default temp root", () => {
    // os.tmpdir() is a symlink on macOS. A profile naming the link denied every
    // write and the working directory while the run still exited 0.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-writable-"))
    try {
      const result = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "/bin/sh", "-c", [
        'cd "$1"',
        'pwd -P >/dev/null',
        'echo source > "$1/written"',
        'echo home > "$HOME/written"',
        'echo temp > "$TMPDIR/written"',
        'echo discarded > /dev/null',
        'echo WROTE',
      ].join(" && "), "sh", "/src"])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toBe("WROTE\n")
      expect(fs.readFileSync(path.join(src, "written"), "utf8")).toBe("source\n")
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("runs nested isolation with no capabilities and keeps ancestor binds read-only", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-nested-isolation-"))
    const src = path.join(directory, "src")
    const trusted = path.join(directory, "trusted")
    fs.mkdirSync(path.join(src, "inner"), { recursive: true })
    fs.mkdirSync(trusted)
    fs.writeFileSync(path.join(trusted, "canary"), "CANARY\n")
    fs.copyFileSync(path.join(root, "scripts/isolate-run.sh"), path.join(src, "isolate-run.sh"))
    const inner = `
import json, os, pathlib
status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
print(json.dumps({"uid":os.geteuid(), "gid":os.getegid(), "caps":{key:status[key].strip() for key in ("CapInh","CapPrm","CapEff","CapBnd","CapAmb")}, "nnp":status["NoNewPrivs"].strip()}))
`
    const attack = `
import pathlib, subprocess, sys
result = subprocess.run(["mount", "-o", "remount,bind,rw", "/opt/trusted"], capture_output=True)
if result.returncode == 0: sys.exit("ancestor bind remounted writable")
try:
    pathlib.Path("/opt/trusted/canary").write_text("CHANGED")
except OSError:
    print("ANCESTOR_READONLY")
else:
    sys.exit("ancestor bind changed")
`
    fs.writeFileSync(path.join(src, "probe.py"), `
import json, os, pathlib, subprocess, sys
${inner}
if "CURSOR_API_KEY" in os.environ: sys.exit("credential entered boundary")
# This raw child gets capabilities in its own namespace, but inherited
# read-only mounts must remain locked against remounting and writes.
subprocess.run(["unshare","--user","--map-root-user","--mount","--pid","--fork","--mount-proc","python3","-c",${JSON.stringify(attack)}], check=True)
subprocess.run(["bash","/src/isolate-run.sh","--src","/src/inner","--","python3","-c",${JSON.stringify(inner)}], check=True)
`)
    try {
      const result = run("bash", ["scripts/isolate-run.sh", "--src", src, "--ro-bind", `${trusted}:/opt/trusted`, "--", "python3", "/src/probe.py"], {
        env: { ...process.env, CURSOR_API_KEY: secret },
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const rows = result.stdout.split("\n").filter((line) => line.startsWith("{"))
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(JSON.parse(row)).toEqual({ uid: 1000, gid: 1000,
          caps: Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((key) => [key, "0000000000000000"])), nnp: "1" })
      }
      expect(result.stdout).toContain("ANCESTOR_READONLY")
      expect(fs.readFileSync(path.join(trusted, "canary"), "utf8")).toBe("CANARY\n")
      expect(result.stdout).not.toContain(secret)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("retains locked nested bind mounts and makes each one read-only", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-nested-bind-"))
    fs.mkdirSync(path.join(directory, "src"))
    fs.mkdirSync(path.join(directory, "shared", "nested"), { recursive: true })
    fs.mkdirSync(path.join(directory, "data"))
    const data = path.join(directory, "data", "value")
    fs.writeFileSync(data, "preserved\n")
    try {
      const result = run("unshare", ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "bash", "-c", `
        set -euo pipefail
        mount --bind "$1/data" "$1/shared/nested"
        bash "$2/scripts/isolate-run.sh" --src "$1/src" --ro-bind "$1/shared:/opt/shared" -- python3 -c '
import pathlib, sys
target = pathlib.Path("/opt/shared/nested/value")
print(target.read_text().strip())
try:
    target.write_text("changed")
except OSError:
    print("READONLY")
else:
    sys.exit(4)
'
      `, "sh", directory, root])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toBe("preserved\nREADONLY\n")
      expect(fs.readFileSync(data, "utf8")).toBe("preserved\n")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("reaps an orphaned grandchild and returns the command status", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-reaper-"))
    fs.writeFileSync(path.join(src, "probe.py"), [
      "import os, sys, time",
      "if os.getpid() == 1 or os.getppid() != 1:",
      "    print('COMMAND_PID=%s PARENT=%s' % (os.getpid(), os.getppid()))",
      "    sys.exit(2)",
      "pid = os.fork()",
      "if pid == 0:",
      "    grand = os.fork()",
      "    if grand == 0:",
      "        os.execv('/bin/sleep', ['sleep', '30'])",
      "    os.kill(grand, 9)",
      "    open('/src/orphan', 'w').write(str(grand))",
      "    os._exit(0)",
      "os.waitpid(pid, 0)",
      "orphan = int(open('/src/orphan').read())",
      "deadline = time.time() + 2",
      "while time.time() < deadline:",
      "    try:",
      "        os.kill(orphan, 0)",
      "    except OSError:",
      "        print('ORPHAN_GONE')",
      "        sys.exit(0)",
      "    time.sleep(0.05)",
      "print('ORPHAN_ALIVE')",
      "sys.exit(3)",
      "",
    ].join("\n"))
    try {
      const result = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "python3", "/src/probe.py"])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("ORPHAN_GONE")
      const status = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "python3", "-c", "import sys; sys.exit(7)"])
      expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(7)
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("forwards termination to the command session", async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-reaper-signal-"))
    const ready = path.join(src, "ready")
    const child = spawn(
      "bash",
      ["scripts/isolate-run.sh", "--src", src, "--", "sh", "-c", "echo $$ > /src/ready; exec sleep 30"],
      { cwd: root, detached: true },
    )
    const started = Date.now()
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50))
    const sleepAlive = (namespacePid: string) => {
      for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue
        try {
          const status = fs.readFileSync(`/proc/${name}/status`, "utf8")
          if (!status.startsWith("Name:\tsleep\n")) continue
          const nspid = status.split("\n").find((line) => line.startsWith("NSpid:"))
          if (nspid?.split(/\s+/).includes(namespacePid)) return true
        } catch {
          // The process exited while it was being read.
        }
      }
      return false
    }
    try {
      while (!fs.existsSync(ready)) {
        if (child.exitCode !== null || Date.now() - started > 8000) {
          throw new Error(`command did not start: exit=${child.exitCode}`)
        }
        await pause()
      }
      const namespacePid = fs.readFileSync(ready, "utf8").trim()
      expect(sleepAlive(namespacePid)).toBe(true)
      process.kill(-child.pid!, "SIGTERM")
      const killed = Date.now()
      while (sleepAlive(namespacePid)) {
        if (Date.now() - killed > 5000) throw new Error("sleep survived SIGTERM to the boundary")
        await pause()
      }
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() - killed > 5000) throw new Error("boundary did not exit after SIGTERM")
        await pause()
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ }
      }
      fs.rmSync(src, { recursive: true, force: true })
    }
  })
})

describe("effective opencode permissions", () => {
  it("denies env files, sibling temp directories, and symlink targets", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "permission-order-"))
    const directory = path.join(parent, "checkout")
    const reviewHome = path.join(parent, "review-home")
    const sibling = path.join(parent, "other-temp")
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    fs.writeFileSync(path.join(sibling, "secret.env"), "nope\n")
    try {
      const configured = run("bash", ["scripts/configure-opencode.sh"], {
        env: { ...process.env, OPENCODE_CONFIG_ROOT: directory, OPENCODE_REVIEW_HOME: reviewHome },
      })
      expect(configured.status, configured.stderr).toBe(0)
      const configPath = path.join(reviewHome, "config", "opencode2", "opencode.json")
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
      expect(config.permission.external_directory["/tmp/*"]).toBeUndefined()
      expect(Object.keys(config.permission.read)[0]).toBe("*")
      expect(Object.keys(config.permission.read).at(-1)).toBe("*.env.example")
      expect(Object.keys(config.permission.edit).at(-1)).toBe("*.env.example")
      const decide = (action: string, resource: string) => {
        const decided = run("bun", ["scripts/opencode-permission.mjs", configPath, action, resource])
        expect(decided.status, `${action} ${resource}\n${decided.stderr}`).toBe(0)
        return decided.stdout.trim()
      }
      for (const action of ["read", "edit"]) {
        expect(decide(action, ".env")).toBe("deny")
        expect(decide(action, "src/app/.env")).toBe("deny")
        expect(decide(action, "credentials.env")).toBe("deny")
        expect(decide(action, "env")).toBe("deny")
        expect(decide(action, ".env.local")).toBe("deny")
        expect(decide(action, "a/b/.env.local")).toBe("deny")
        expect(decide(action, ".env.example")).toBe("allow")
        expect(decide(action, "docs/.env.example")).toBe("allow")
        expect(decide(action, "src/index.ts")).toBe("allow")
      }
      const owned = path.join(reviewHome, "tmp")
      expect(decide("external_directory", `${sibling}/*`)).toBe("deny")
      expect(decide("external_directory", `${owned}/*`)).toBe("allow")
      const link = path.join(owned, "escape")
      fs.symlinkSync(path.join(sibling, "secret.env"), link)
      expect(decide("external_directory", `${path.dirname(fs.realpathSync(link))}/*`)).toBe("deny")
      expect(decide("read", path.join(sibling, "secret.env"))).toBe("deny")
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("does not treat a shell-looking checkout path as a command", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "configure-literal-"))
    const marker = path.join(parent, "not-created")
    const directory = path.join(parent, `dir with space ' ; $(touch ${marker})`)
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.mkdirSync(path.join(directory, "scripts"))
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    fs.copyFileSync(path.join(root, "scripts/configure-opencode.sh"), path.join(directory, "scripts/configure-opencode.sh"))
    try {
      const result = run("bash", [path.join(directory, "scripts/configure-opencode.sh")])
      expect(result.status, result.stderr).toBe(0)
      expect(fs.existsSync(marker)).toBe(false)
      expect(fs.existsSync(path.join(directory, ".opencode-local/opencode.json"))).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe("live test deadlines and cleanup", () => {
  it("reports a missing deadline command instead of a command-not-found failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-no-timeout-"))
    const bin = path.join(directory, "bin")
    const reviewHome = path.join(directory, "review-home")
    try {
      fs.mkdirSync(bin)
      fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
      fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
      fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
      fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
      // Dedupe by name: existsSync follows links, so a broken host link (an
      // Ubuntu image ships one) read as missing and was linked twice.
      const linked = new Set(["timeout", "gtimeout"])
      for (const dir of ["/usr/bin", "/bin"]) {
        for (const name of fs.readdirSync(dir)) {
          if (linked.has(name)) continue
          linked.add(name)
          fs.symlinkSync(path.join(dir, name), path.join(bin, name))
        }
      }
      fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho should-not-run > \"$HOME/ran\"\nexit 0\n")
      fs.writeFileSync(path.join(bin, "opencode1"), "#!/bin/sh\necho should-not-run > \"$HOME/ran\"\nexit 0\n")
      fs.chmodSync(path.join(bin, "opencode"), 0o755)
      fs.chmodSync(path.join(bin, "opencode1"), 0o755)
      const result = run("bash", ["scripts/live-test.sh"], {
        env: {
          ...process.env,
          HOME: directory,
          PATH: bin,
          CURSOR_API_KEY: secret,
          OPENCODE_CONFIG_ROOT: directory,
          OPENCODE_REVIEW_HOME: reviewHome,
          LIVE_TEST_TIMEOUT: "",
        },
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain("A deadline command is required")
      expect(`${result.stdout}${result.stderr}`).not.toContain("command not found")
      expect(fs.existsSync(path.join(directory, "ran"))).toBe(false)
      const temps = fs.readdirSync(path.join(reviewHome, "tmp")).filter((name) => name.startsWith("tmp."))
      expect(temps).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("stops a short command at the adapter deadline", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-adapter-"))
    const python = selectedPython()
    const adapter = path.join(directory, "review-timeout")
    writeTimeoutAdapter(adapter, python)
    try {
      const started = Date.now()
      const result = spawnSync(adapter, ["1", "sleep", "30"], { encoding: "utf8" })
      expect(result.status).toBe(124)
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("removes plugin-list files when the live test is cancelled", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-cancel-"))
    const bin = path.join(directory, "bin")
    const reviewHome = path.join(directory, "review-home")
    const pidFile = path.join(directory, "sleep.pid")
    const python = selectedPython()
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    writeTimeoutAdapter(path.join(bin, "review-timeout"), python)
    fs.writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\nmkdir -p "$TMPDIR/runtime-created"\nprintf native-library > "$TMPDIR/runtime-created/library.bin"\necho $$ > ${JSON.stringify(pidFile)}\nsleep 60\n`)
    fs.writeFileSync(path.join(bin, "opencode1"), "#!/bin/sh\nexit 0\n")
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    fs.chmodSync(path.join(bin, "opencode1"), 0o755)
    const child = spawn("bash", ["scripts/live-test.sh"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: directory,
        PATH: `${bin}:/usr/bin:/bin`,
        CURSOR_API_KEY: secret,
        OPENCODE_CONFIG_ROOT: directory,
        OPENCODE_REVIEW_HOME: reviewHome,
        LIVE_TEST_TIMEOUT: path.join(bin, "review-timeout"),
        LIVE_TEST_PYTHON: python,
      },
    })
    const started = Date.now()
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50))
    try {
      while (!fs.existsSync(pidFile)) {
        if (Date.now() - started > 8000) throw new Error("plugin list did not start")
        await pause()
      }
      child.kill("SIGTERM")
      const killed = Date.now()
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() - killed > 8000) throw new Error("live test did not exit after SIGTERM")
        await pause()
      }
      const temps = fs.readdirSync(path.join(reviewHome, "tmp"))
      expect(temps).toEqual([])
      const sleeperAlive = spawnSync("kill", ["-0", fs.readFileSync(pidFile, "utf8").trim()])
      expect(sleeperAlive.status).not.toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      if (fs.existsSync(pidFile)) spawnSync("kill", ["-KILL", fs.readFileSync(pidFile, "utf8").trim()])
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("prints redacted diagnostics when discovery, the model, or the deadline fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-diagnose-"))
    const bin = path.join(directory, "bin")
    const reviewHome = path.join(directory, "review-home")
    const python = selectedPython()
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "9.9.9" }) + "\n")
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    writeTimeoutAdapter(path.join(bin, "review-timeout"), python)
    const env = {
      HOME: directory,
      PATH: `${bin}:/usr/bin:/bin`,
      CURSOR_API_KEY: secret,
      OPENCODE_CONFIG_ROOT: directory,
      OPENCODE_REVIEW_HOME: reviewHome,
      LIVE_TEST_TIMEOUT: path.join(bin, "review-timeout"),
      LIVE_TEST_PYTHON: python,
    }
    try {
      fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho deliberate-failure >&2\nexit 23\n")
      fs.writeFileSync(path.join(bin, "opencode1"), "#!/bin/sh\nexit 0\n")
      fs.chmodSync(path.join(bin, "opencode"), 0o755)
      fs.chmodSync(path.join(bin, "opencode1"), 0o755)
      const discovery = run("bash", ["scripts/live-test.sh"], { env })
      expect(discovery.status, `${discovery.stdout}\n${discovery.stderr}`).toBe(1)
      expect(discovery.stdout).toContain("LIVE_TEST=failed")
      expect(discovery.stdout).toContain("plugin_list_exit=23")
      expect(discovery.stdout).toContain("deliberate-failure")
      expect(fs.readdirSync(path.join(reviewHome, "tmp")).filter((name) => name.startsWith("tmp."))).toEqual([])

      fs.writeFileSync(
        path.join(bin, "opencode"),
        `#!/bin/sh
if [ "$1" = plugin ]; then
  echo "CURSOR_REVIEW_PLUGIN=$CURSOR_REVIEW_PLUGIN_PATH version=$CURSOR_REVIEW_PLUGIN_VERSION" >&2
  exit 0
fi
echo "CURSOR_REVIEW_PLUGIN_INIT count=1 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
echo deliberate-failure >&2
exit 23
`,
      )
      const model = run("bash", ["scripts/live-test.sh"], { env })
      expect(model.status, `${model.stdout}\n${model.stderr}`).toBe(1)
      expect(model.stdout).toContain("LIVE_TEST=failed")
      expect(model.stdout).toContain("opencode_exit=23")
      expect(model.stdout).toContain("deliberate-failure")

      fs.writeFileSync(path.join(bin, "review-timeout"), "#!/bin/sh\necho deadline-fired >&2\nexit 124\n")
      fs.chmodSync(path.join(bin, "review-timeout"), 0o755)
      const expired = run("bash", ["scripts/live-test.sh"], { env })
      expect(expired.status, `${expired.stdout}\n${expired.stderr}`).toBe(1)
      expect(expired.stdout).toContain("LIVE_TEST=failed")
      expect(expired.stdout).toContain("plugin_list_exit=124")
      expect(expired.stdout).toContain("deadline-fired")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("kills a descendant that ignores TERM and one hidden from ps", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-kill-"))
    const bin = path.join(directory, "bin")
    const reviewHome = path.join(directory, "review-home")
    const parentPid = path.join(directory, "parent.pid")
    const childPid = path.join(directory, "child.pid")
    const python = selectedPython()
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(directory, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(directory, "dist/plugin-opencode2.js"), "export default {}\n")
    writeTimeoutAdapter(path.join(bin, "review-timeout"), python)
    fs.writeFileSync(
      path.join(bin, "opencode"),
      `#!/bin/sh
echo $$ > ${JSON.stringify(parentPid)}
${JSON.stringify(python)} -c 'import os,signal,time,sys
signal.signal(signal.SIGTERM, signal.SIG_IGN)
open(sys.argv[1],"w").write(str(os.getpid()))
while True:
    time.sleep(30)
' ${JSON.stringify(childPid)} &
wait
`,
    )
    fs.writeFileSync(path.join(bin, "opencode1"), "#!/bin/sh\nexit 0\n")
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    fs.chmodSync(path.join(bin, "opencode1"), 0o755)
    const child = spawn("bash", ["scripts/live-test.sh"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: directory,
        PATH: `${bin}:/usr/bin:/bin`,
        CURSOR_API_KEY: secret,
        OPENCODE_CONFIG_ROOT: directory,
        OPENCODE_REVIEW_HOME: reviewHome,
        LIVE_TEST_TIMEOUT: path.join(bin, "review-timeout"),
        LIVE_TEST_PYTHON: python,
      },
    })
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    try {
      while (!fs.existsSync(childPid)) {
        if (Date.now() - started > 8000) throw new Error("resistant descendant did not start")
        await pause()
      }
      child.kill("SIGTERM")
      const killed = Date.now()
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() - killed > 8000) throw new Error("live test did not exit after SIGTERM")
        await pause()
      }
      expect(spawnSync("kill", ["-0", fs.readFileSync(childPid, "utf8").trim()]).status).not.toBe(0)
      expect(spawnSync("kill", ["-0", fs.readFileSync(parentPid, "utf8").trim()]).status).not.toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      for (const file of [parentPid, childPid]) {
        if (fs.existsSync(file)) spawnSync("kill", ["-KILL", fs.readFileSync(file, "utf8").trim()])
      }
      fs.rmSync(directory, { recursive: true, force: true })
    }

    const hidden = fs.mkdtempSync(path.join(os.tmpdir(), "live-ps-"))
    const hiddenBin = path.join(hidden, "bin")
    const hiddenHome = path.join(hidden, "review-home")
    const hiddenPid = path.join(hidden, "sleep.pid")
    fs.mkdirSync(hiddenBin)
    fs.mkdirSync(path.join(hidden, "dist"), { recursive: true })
    fs.writeFileSync(path.join(hidden, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(hidden, "dist/plugin.js"), "export async function CursorPlugin() { return {} }\n")
    fs.writeFileSync(path.join(hidden, "dist/plugin-opencode2.js"), "export default {}\n")
    writeTimeoutAdapter(path.join(hiddenBin, "review-timeout"), python)
    fs.writeFileSync(path.join(hiddenBin, "ps"), "#!/bin/sh\nexit 1\n")
    fs.chmodSync(path.join(hiddenBin, "ps"), 0o755)
    fs.writeFileSync(path.join(hiddenBin, "opencode"), `#!/bin/sh\necho $$ > ${JSON.stringify(hiddenPid)}\nsleep 60\n`)
    fs.writeFileSync(path.join(hiddenBin, "opencode1"), "#!/bin/sh\nexit 0\n")
    fs.chmodSync(path.join(hiddenBin, "opencode"), 0o755)
    fs.chmodSync(path.join(hiddenBin, "opencode1"), 0o755)
    const listed = spawn("bash", ["scripts/live-test.sh"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: hidden,
        PATH: `${hiddenBin}:/usr/bin:/bin`,
        CURSOR_API_KEY: secret,
        OPENCODE_CONFIG_ROOT: hidden,
        OPENCODE_REVIEW_HOME: hiddenHome,
        LIVE_TEST_TIMEOUT: path.join(hiddenBin, "review-timeout"),
        LIVE_TEST_PYTHON: python,
      },
    })
    let stderr = ""
    listed.stderr?.on("data", (chunk) => { stderr += chunk })
    const hiddenStarted = Date.now()
    try {
      while (!fs.existsSync(hiddenPid)) {
        if (Date.now() - hiddenStarted > 8000) throw new Error("hidden sleeper did not start")
        await pause()
      }
      listed.kill("SIGTERM")
      const closed = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 8000)
        listed.on("close", (status) => {
          clearTimeout(timer)
          resolve(status)
        })
      })
      if (closed === null) throw new Error("live test did not exit after a failed process listing")
      expect(stderr).toContain("Process listing failed")
      expect(spawnSync("kill", ["-0", fs.readFileSync(hiddenPid, "utf8").trim()]).status).not.toBe(0)
    } finally {
      if (listed.exitCode === null && listed.signalCode === null) listed.kill("SIGKILL")
      if (fs.existsSync(hiddenPid)) spawnSync("kill", ["-KILL", fs.readFileSync(hiddenPid, "utf8").trim()])
      fs.rmSync(hidden, { recursive: true, force: true })
    }
  })
})
