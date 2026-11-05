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
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("writes the config for an explicit root", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configure-root-"))
    fs.mkdirSync(path.join(directory, "dist"))
    fs.writeFileSync(path.join(directory, "dist/index.js"), "export {}\n")
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
  it("matches the environment install string and the config writer", () => {
    const script = fs.readFileSync(path.join(root, "scripts/cloud-agent-install.sh"), "utf8")
    const configure = fs.readFileSync(path.join(root, "scripts/configure-opencode.sh"), "utf8")
    const environment = JSON.parse(fs.readFileSync(path.join(root, ".cursor/environment.json"), "utf8")) as {
      install: string
    }
    expect(environment.install).toBe(script)
    expect(environment.install).toContain('OPENCODE_PIN="2.2.5"')
    expect(environment.install).not.toContain("scripts/configure-opencode.sh")
    expect(environment.install).not.toContain("scripts/cloud-agent-install.sh")
    expect(environment.install).not.toContain("opencode.json")
    expect(environment.install).not.toContain("CURSOR_REVIEW_PLUGIN")
    expect(script).not.toContain("<<'PY'")
    expect(configure).toContain("CURSOR_REVIEW_PLUGIN_INIT")
    expect(configure).not.toContain('"plugin":')
  })

  it("does not install when sourced, and reads the pinned version", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-source-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho called > \"$HOME/curl-called\"\nexit 1\n")
    fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho 'opencode v2.2.5'\n")
    fs.chmodSync(path.join(bin, "curl"), 0o755)
    fs.chmodSync(path.join(bin, "opencode"), 0o755)
    try {
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/cloud-agent-install.sh
        printf 'pin %s\\n' "$OPENCODE_PIN"
        printf 'match %s\\n' "$(opencode_version_of "$BIN/opencode")"
        printf 'missing %s\\n' "$(opencode_version_of "$BIN/missing")"
        printf 'sourced\\n'
        `,
        { HOME: directory, PATH: `${bin}:/usr/bin:/bin`, BIN: bin },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("pin 2.2.5\nmatch 2.2.5\nmissing \nsourced\n")
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

  it("loads the worktree plugin from a private config and stops when OpenCode does not", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "review-builtin-live-"))
    const bin = path.join(tree, "bin")
    const reviewHome = path.join(tree, "review-home")
    fs.mkdirSync(path.join(tree, "dist"), { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ version: "9.9.9" }) + "\n")
    fs.writeFileSync(path.join(tree, "dist/index.js"), "export {}\n")
    fs.writeFileSync(path.join(tree, "dist/plugin-opencode2.js"), "export default {}\n")
    fs.writeFileSync(
      path.join(bin, "opencode"),
      `#!/bin/sh
if [ "$1" = plugin ]; then
  python3 -c 'import os, pathlib, re, sys
text = pathlib.Path(os.environ["OPENCODE_CONFIG_DIR"], "plugins", "cursor", "index.js").read_text()
match = re.search(r"CURSOR_REVIEW_PLUGIN=\\S+ version=\\S+", text)
sys.stderr.write((match.group(0) if match else "no-marker") + "\\n")'
  exit 0
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
    const env = {
      HOME: tree,
      PATH: `${bin}:/usr/bin:/bin`,
      CURSOR_API_KEY: secret,
      OPENCODE_CONFIG_ROOT: tree,
      OPENCODE_REVIEW_HOME: reviewHome,
    }
    try {
      const passed = run("bash", ["scripts/live-test.sh"], { env })
      expect(passed.status, `${passed.stdout}\n${passed.stderr}`).toBe(0)
      expect(passed.stdout).toContain(`WORKTREE=${tree}`)
      expect(passed.stdout).toContain(`PLUGIN_PATH=${tree}/dist/plugin-opencode2.js`)
      expect(passed.stdout).toContain("PLUGIN_VERSION=9.9.9")
      expect(passed.stdout).toContain(`PLUGIN_LOADED=CURSOR_REVIEW_PLUGIN=${tree}/dist/plugin-opencode2.js version=9.9.9`)
      expect(passed.stdout).toContain("LIVE_TEST=passed")
      expect(passed.stdout).not.toContain(secret)
      expect(passed.stdout).toContain(path.join(reviewHome, "config", "opencode2"))
      const config = JSON.parse(fs.readFileSync(path.join(reviewHome, "config", "opencode2", "opencode.json"), "utf8"))
      expect(config.plugins).toHaveLength(1)
      expect(config.plugin).toBeUndefined()
      expect(config.permission.bash["*"]).toBe("deny")
      expect(passed.stdout).toContain("PLUGIN_INIT_COUNT=1")
      expect(fs.existsSync(path.join(tree, ".opencode-local"))).toBe(false)

      fs.writeFileSync(
        path.join(bin, "opencode"),
        `#!/bin/sh
if [ "$1" = plugin ]; then
  echo "CURSOR_REVIEW_PLUGIN=$OPENCODE_CONFIG_ROOT/dist/plugin-opencode2.js version=9.9.9" >&2
  exit 0
fi
echo "CURSOR_REVIEW_PLUGIN_INIT count=1 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
echo "CURSOR_REVIEW_PLUGIN_INIT count=2 path=$CURSOR_REVIEW_PLUGIN_PATH" >&2
printf '%s\\n' '{"type":"text","part":{"type":"text","text":"pong"}}'
exit 0
`,
      )
      fs.chmodSync(path.join(bin, "opencode"), 0o755)
      const twice = run("bash", ["scripts/live-test.sh"], { env })
      expect(twice.status, `${twice.stdout}\n${twice.stderr}`).toBe(1)
      expect(twice.stdout).toContain("initialized the provider 2 times")
      expect(twice.stdout).not.toContain("LIVE_TEST=passed")

      fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\nif [ \"$1\" = run ]; then echo ran > \"$HOME/ran-model\"; fi\nexit 0\n")
      const failed = run("bash", ["scripts/live-test.sh"], { env: { ...env, HOME: tree } })
      expect(failed.status).toBe(1)
      expect(failed.stdout).toContain("LIVE_TEST=failed")
      expect(failed.stdout).toContain("did not load")
      expect(fs.existsSync(path.join(tree, "ran-model"))).toBe(false)
    } finally {
      fs.rmSync(tree, { recursive: true, force: true })
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
