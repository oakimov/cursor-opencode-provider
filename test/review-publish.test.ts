import { describe, expect, it } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const head = "b".repeat(40)
const otherHead = "c".repeat(40)

function selectedPython(): string {
  const result = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" })
  const found = (result.stdout || "").trim()
  if (result.status !== 0 || !found.startsWith("/")) throw new Error(result.stderr || "python3 is required")
  return found
}

const python = selectedPython()

function run(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(python, [path.join(root, "scripts/review-publish.py"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function writeGh(bin: string): void {
  fs.mkdirSync(bin)
  const script = `#!${python}
import json, os, sys, time
from pathlib import Path
state = Path(os.environ["GH_STATE"])
args = sys.argv[1:]
method = "GET"
if "--method" in args:
    method = args[args.index("--method") + 1]
endpoints = [item for item in args if item.startswith("repos/")]
endpoint = endpoints[-1]
with (state / "calls").open("a", encoding="utf-8") as handle:
    handle.write(method + " " + endpoint + "\\n")
reviews_path = state / "reviews.json"
comments_path = state / "comments.json"
reviews = json.loads(reviews_path.read_text(encoding="utf-8") or "[]")
comments = json.loads(comments_path.read_text(encoding="utf-8")) if comments_path.exists() else []
if method == "POST":
    if os.environ.get("GH_HOLD_POST") == "1":
        release = state / "release"
        while not release.exists():
            time.sleep(0.05)
    if os.environ.get("GH_SLOW_POST") == "1":
        time.sleep(0.4)
    if os.environ.get("GH_REJECT") == "1":
        sys.stdin.read()
        sys.stderr.write("HTTP 422 Validation Failed\\n")
        raise SystemExit(1)
    payload = json.load(sys.stdin)
    with (state / "post-bodies").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload.get("body", "")) + "\\n")
    review_id = len(reviews) + 1
    review_url = "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-" + str(review_id)
    if os.environ.get("GH_WRONG_URL") == "1":
        review_url = "https://github.com/other/repo/pull/1#pullrequestreview-" + str(review_id)
    review = {
        "id": review_id,
        "body": payload.get("body", ""),
        "html_url": review_url,
    }
    rows = [
        {
            "id": review_id * 10 + index,
            "pull_request_review_id": review_id,
            "html_url": "https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r" + str(review_id) + str(index),
            "path": comment.get("path"),
            "line": comment.get("line"),
            "side": comment.get("side"),
            "body": comment.get("body"),
        }
        for index, comment in enumerate(payload.get("comments") or [])
    ]
    if os.environ.get("GH_FAIL") == "1":
        if os.environ.get("GH_COMMIT") == "1":
            reviews.append({"request": payload, "review": review})
            reviews_path.write_text(json.dumps(reviews), encoding="utf-8")
            comments.extend(rows)
            comments_path.write_text(json.dumps(comments), encoding="utf-8")
        sys.stderr.write("boom\\n")
        raise SystemExit(1)
    reviews.append({"request": payload, "review": review})
    comments.extend(rows)
    reviews_path.write_text(json.dumps(reviews), encoding="utf-8")
    comments_path.write_text(json.dumps(comments), encoding="utf-8")
    json.dump(review, sys.stdout)
    raise SystemExit(0)
def dump(page):
    json.dump([page] if "--slurp" in args else page, sys.stdout)
if endpoint.endswith("/comments"):
    dump(comments)
    raise SystemExit(0)
if endpoint.endswith("/reviews"):
    if os.environ.get("GH_HOLD_GET") == "1":
        release = state / "release"
        while not release.exists():
            time.sleep(0.05)
    dump([item["review"] for item in reviews])
    raise SystemExit(0)
head = (state / "head").read_text(encoding="utf-8").strip()
base_path = state / "base"
base = base_path.read_text(encoding="utf-8").strip() if base_path.exists() else "${"a".repeat(40)}"
if os.environ.get("GH_HOLD_HEAD") == "1":
    release = state / "release"
    while not release.exists():
        time.sleep(0.05)
import re
number_match = re.search(r"/pulls/(\\d+)$", endpoint)
number = int(number_match.group(1)) if number_match else None
json.dump({"number": number, "head": {"sha": head}, "base": {"sha": base}}, sys.stdout)
`
  fs.writeFileSync(path.join(bin, "gh"), script)
  fs.chmodSync(path.join(bin, "gh"), 0o755)
}

function previewDigest(stderr: string): string {
  const match = stderr.match(/PREVIEW_SHA256=([0-9a-f]{64})/)
  if (!match?.[1]) throw new Error(stderr)
  return match[1]
}

function approve(payload: string, approval: string, env: NodeJS.ProcessEnv) {
  const shown = run(["show", payload], env)
  expect(shown.status, shown.stderr).toBe(0)
  return run(["approve", payload, approval, previewDigest(shown.stderr)], env)
}

function draft(
  comments: Array<{ path: string; line: number; side: string; body: string }>,
  body = "Summary of the checked diff.\n",
  pull = 156,
): string {
  return JSON.stringify(
    {
      owner: "oakimov",
      repo: "cursor-opencode-provider",
      pull,
      base: "a".repeat(40),
      head,
      runtime: "linux",
      event: "COMMENT",
      body,
      comments,
    },
    null,
    2,
  ) + "\n"
}

function postBodies(state: string): string {
  const file = path.join(state, "post-bodies")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
}

function freshReview(prefix: string): { directory: string; payload: string; approval: string; bin: string; state: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const payload = path.join(directory, "payload.json")
  const approval = path.join(directory, "approval.json")
  const bin = path.join(directory, "bin")
  const state = path.join(directory, "state")
  fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
  fs.writeFileSync(path.join(state, "head"), head + "\n")
  writeGh(bin)
  return { directory, payload, approval, bin, state }
}

function installDraft(
  payload: string,
  approval: string,
  env: NodeJS.ProcessEnv,
  pull: number,
  summary: string,
  comment: string,
) {
  fs.writeFileSync(
    payload,
    draft([{ path: "scripts/review-publish.py", line: 44, side: "RIGHT", body: comment }], summary, pull),
  )
  const stamped = run(["stamp", payload], env)
  expect(stamped.status, stamped.stderr).toBe(0)
  const approved = approve(payload, approval, env)
  expect(approved.status, approved.stderr).toBe(0)
}

function callsOf(state: string): string[] {
  const file = path.join(state, "calls")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

function postsOf(state: string): number {
  return callsOf(state).filter((line) => line.startsWith("POST ")).length
}

function sleep(ms: number): void {
  Bun.sleepSync(ms)
}

function waitFor(label: string, predicate: () => boolean): void {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 8000) throw new Error(`timed out waiting for ${label}`)
    sleep(50)
  }
}

function publicationLock(approval: string): string {
  const record = JSON.parse(fs.readFileSync(approval, "utf8")) as { owner: string; repo: string; pull: number; identity: string }
  const key = createHash("sha256").update(`${record.owner}/${record.repo}#${record.pull}:${record.identity}`).digest("hex")
  const directory = path.join(path.dirname(approval), ".review-publish")
  fs.mkdirSync(directory, { recursive: true })
  return path.join(directory, `${key}.lock`)
}

function holdLock(lock: string): { release: () => Promise<void> } {
  const held = `${lock}.held`
  const releaseFlag = `${lock}.release`
  const child = spawn(python, ["-c", `
import fcntl, os, sys, time
lock, held, release = sys.argv[1:]
fd = open(lock, "a+")
fcntl.flock(fd, fcntl.LOCK_EX)
open(held, "w", encoding="utf-8").write("held\\n")
while not os.path.exists(release):
    time.sleep(0.05)
fcntl.flock(fd, fcntl.LOCK_UN)
fd.close()
`, lock, held, releaseFlag])
  waitFor("lock holder", () => fs.existsSync(held))
  return {
    async release() {
      fs.writeFileSync(releaseFlag, "go\n")
      const started = Date.now()
      while (Date.now() - started < 2000) {
        try {
          process.kill(child.pid ?? 0, 0)
        } catch {
          return
        }
        await Bun.sleep(20)
      }
      child.kill("SIGKILL")
    },
  }
}

function spawnPost(payload: string, approval: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(python, [path.join(root, "scripts/review-publish.py"), "post", payload, approval], {
    cwd: root,
    detached: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
  })
}

function stopProcess(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return
  try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ }
}

function collect(child: ChildProcess): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

function checkpointText(directory: string): string {
  const names = fs.readdirSync(path.join(directory, ".review-publish")).filter((name) => name.endsWith(".json"))
  expect(names).toHaveLength(1)
  return fs.readFileSync(path.join(directory, ".review-publish", names[0]!), "utf8")
}

function queuedOnLock(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.pid === undefined) return false
  return fs.readFileSync("/proc/locks", "utf8").split("\n").some((line) => line.includes("->") && line.includes(` ${child.pid} `))
}

describe("review publication", () => {
  it("shows the exact payload and does not call GitHub before approval", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-show-"))
    const payload = path.join(directory, "payload.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/configure-opencode.sh", line: 102, side: "RIGHT", body: "P1. A trailing allow lets env files through." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      const stamped = run(["stamp", payload], env)
      expect(stamped.status, stamped.stderr).toBe(0)
      expect(stamped.stdout).toContain("GitHub was not called.")
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      expect(shown.stdout).toBe(fs.readFileSync(payload, "utf8"))
      expect(previewDigest(shown.stderr)).toHaveLength(64)
      expect(fs.readFileSync(`${payload}.preview`, "utf8")).toBe(shown.stdout)
      expect(shown.stdout).toContain("scripts/configure-opencode.sh")
      expect(shown.stdout).toContain('"line": 102')
      expect(shown.stdout).toContain('"side": "RIGHT"')
      const missing = run(["post", payload, path.join(directory, "missing.json")], env)
      expect(missing.status).toBe(4)
      const denial = path.join(directory, "denial.json")
      const denied = run(["deny", denial], env)
      expect(denied.status, denied.stderr).toBe(0)
      const refused = run(["post", payload, denial], env)
      expect(refused.status).toBe(4)
      expect(callsOf(state)).toEqual([])
      expect(fs.existsSync(path.join(state, "calls"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("posts the approved comment on the approved commit and does not duplicate it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-post-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(
      payload,
      draft([{ path: "scripts/configure-opencode.sh", line: 102, side: "RIGHT", body: "P1. A trailing allow lets env files through." }]),
    )
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      const approved = approve(payload, approval, env)
      expect(approved.status, approved.stderr).toBe(0)
      expect(approved.stdout).toContain("GitHub was not called.")
      const posted = run(["post", payload, approval], env)
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout).toContain("REVIEW_URL=https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-1")
      expect(posted.stdout).toContain("COMMENT_URL=https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r10")
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))
      expect(stored).toHaveLength(1)
      expect(stored[0].request.commit_id).toBe(head)
      expect(stored[0].request.event).toBe("COMMENT")
      expect(stored[0].request.comments).toEqual([
        { path: "scripts/configure-opencode.sh", line: 102, side: "RIGHT", body: "P1. A trailing allow lets env files through." },
      ])
      const again = run(["post", payload, approval], env)
      expect(again.status, again.stderr).toBe(0)
      expect(again.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a changed head or a changed payload", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-stale-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), otherHead + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([] , "No findings.\nThe checked diff does not show a defect in the files read.\n"))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const moved = run(["post", payload, approval], env)
      expect(moved.status).toBe(6)
      expect(postsOf(state)).toBe(0)
      fs.writeFileSync(path.join(state, "head"), head + "\n")
      const clean = run(["post", payload, approval], env)
      expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0)
      expect(clean.stdout).toContain("REVIEW_URL=")
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))
      expect(stored[0].request.comments).toEqual([])
      fs.writeFileSync(payload, fs.readFileSync(payload, "utf8") + "\n")
      const edited = run(["post", payload, approval], env)
      expect(edited.status).toBe(5)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("recovers a committed post that reported failure and does not send it again", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-partial-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/isolated-check.sh", line: 4, side: "RIGHT", body: "P1. The check can read files outside its home." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_FAIL: "1" }
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const committed = run(["post", payload, approval], { ...env, GH_COMMIT: "1" })
      expect(committed.status, `${committed.stdout}\n${committed.stderr}`).toBe(0)
      expect(committed.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
      expect(postsOf(state)).toBe(1)
      const retry = run(["post", payload, approval], env)
      expect(retry.status, retry.stderr).toBe(0)
      expect(retry.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects secrets and absolute paths before any GitHub call", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-scan-"))
    const payload = path.join(directory, "payload.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(
      payload,
      draft([{ path: "scripts/live-test.sh", line: 12, side: "RIGHT", body: "See /home/ubuntu/src/plugin.js and crsr_secret." }]),
    )
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      const stamped = run(["stamp", payload], env)
      expect(stamped.status).toBe(3)
      expect(stamped.stderr).toContain("absolute local path")
      expect(stamped.stderr).toContain("secret")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("approves only the preview that was shown", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-preview-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    const first = draft([{ path: "scripts/review-publish.py", line: 40, side: "RIGHT", body: "P1. Approval must name the shown preview." }])
    const second = draft([{ path: "scripts/review-publish.py", line: 41, side: "RIGHT", body: "P1. A later draft is a different preview." }])
    fs.writeFileSync(payload, first)
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      const digest = previewDigest(shown.stderr)
      fs.writeFileSync(payload, second)
      expect(run(["stamp", payload], env).status).toBe(0)
      const replaced = run(["approve", payload, approval, digest], env)
      expect(replaced.status).toBe(5)
      expect(replaced.stderr).toContain("GitHub was not called.")
      expect(fs.existsSync(approval)).toBe(false)
      expect(callsOf(state)).toEqual([])
      const shownAgain = run(["show", payload], env)
      fs.writeFileSync(payload, fs.readFileSync(payload, "utf8").replace("later draft", "edited draft"))
      const edited = run(["approve", payload, approval, previewDigest(shownAgain.stderr)], env)
      expect(edited.status).toBe(5)
      expect(edited.stderr).toContain("not the preview")
      expect(postsOf(state)).toBe(0)
      fs.writeFileSync(payload, second)
      expect(run(["stamp", payload], env).status).toBe(0)
      const approved = approve(payload, approval, env)
      expect(approved.status, approved.stderr).toBe(0)
      const posted = run(["post", payload, approval], env)
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))
      expect(stored[0].request.comments[0].body).toContain("later draft")
      expect(stored[0].request.comments[0].body).not.toContain("shown preview")
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("posts one review when two callers race", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-race-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 50, side: "RIGHT", body: "P2. Concurrent posts must not both create a review." }]))
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_SLOW_POST: "1" }
    const runPost = () => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(python, [path.join(root, "scripts/review-publish.py"), "post", payload, approval], {
        cwd: root,
        env,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
    })
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const [first, second] = await Promise.all([runPost(), runPost()])
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0)
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0)
      expect(postsOf(state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
      const combined = first.stdout + second.stdout
      expect(combined).toContain("REVIEW_URL=")
      expect(combined).toContain("REVIEW_ALREADY_POSTED=1")
      expect(combined).toContain("COMMENT_URL=")
      const checkpoints = fs.readdirSync(path.join(directory, ".review-publish")).filter((name) => name.endsWith(".json"))
      expect(checkpoints).toHaveLength(1)
      expect(fs.readFileSync(path.join(directory, ".review-publish", checkpoints[0]!), "utf8")).toContain('"state": "posted"')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("allows public identifiers and rejects home-relative and other local paths", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-scan-more-"))
    const payload = path.join(directory, "payload.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const samples = [
      { body: "CURSOR_API_KEY is unset, so the live test skips.", status: 0 },
      { body: "copilot.totalNanoAiu is an aggregate counter.", status: 0 },
      { body: "See scripts/configure-opencode.sh, https://github.com/oakimov/cursor-opencode-provider/pull/156, and https://cursor.com/settings.", status: 0 },
      { body: "See [the diff](https://example.test/public) and <https://cursor.com/settings>.", status: 0 },
      { body: "Source: https://example.test/public", status: 0 },
      { body: "[/srv/private-repo/file.ts](https://example.test/public)", status: 3, problem: "absolute local path" },
      { body: "<file:///srv/private-repo/file.ts>", status: 3, problem: "absolute local path" },
      { body: "Source:/srv/private-repo/file.ts", status: 3, problem: "absolute local path" },
      { body: "The private checkout is ~/work/repo.", status: 3, problem: "absolute local path" },
      { body: "The private checkout is /srv/checkouts/private.", status: 3, problem: "absolute local path" },
      { body: "The value is crsr_secret.", status: 3, problem: "secret" },
    ]
    try {
      for (const sample of samples) {
        fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 12, side: "RIGHT", body: sample.body }]))
        const stamped = run(["stamp", payload], env)
        expect(stamped.status, sample.body + stamped.stderr).toBe(sample.status)
        if (sample.problem) expect(stamped.stderr).toContain(sample.problem)
      }
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not post a denial or a replaced payload that arrives while the post is queued", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-queued-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 40, side: "RIGHT", body: "P1. A queued denial must not be published." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    let holder: { release: () => void } | undefined
    let child: ChildProcess | undefined
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      holder = holdLock(publicationLock(approval))
      child = spawnPost(payload, approval, env)
      const finished = collect(child)
      waitFor("queued post", () => queuedOnLock(child!))
      expect(child.exitCode).toBeNull()
      expect(postsOf(state)).toBe(0)
      const denied = run(["deny", approval], env)
      expect(denied.status, denied.stderr).toBe(0)
      const record = JSON.parse(fs.readFileSync(approval, "utf8")) as { decision: string; generation: number }
      expect(record.decision).toBe("deny")
      expect(record.generation).toBeGreaterThan(1)
      await holder.release()
      holder = undefined
      const result = await finished
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(4)
      expect(result.stderr).toContain("GitHub was not called.")
      expect(postsOf(state)).toBe(0)

      fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 40, side: "RIGHT", body: "P1. A replaced payload must not be published." }]))
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const original = fs.readFileSync(payload, "utf8")
      holder = holdLock(publicationLock(approval))
      child = spawnPost(payload, approval, env)
      const replaced = collect(child)
      waitFor("queued replacement", () => queuedOnLock(child!))
      fs.writeFileSync(payload, `${original}\n`)
      await holder.release()
      holder = undefined
      const changed = await replaced
      expect(changed.status, `${changed.stdout}\n${changed.stderr}`).toBe(5)
      expect(postsOf(state)).toBe(0)
    } finally {
      await holder?.release()
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("does not post a denial or a replaced payload that arrives during the preparatory reads", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-inflight-read-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 41, side: "RIGHT", body: "P1. A denial during lookup must not be published." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_GET: "1" }
    let child: ChildProcess | undefined
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      child = spawnPost(payload, approval, env)
      const deniedCall = collect(child)
      waitFor("reviews lookup", () => callsOf(state).some((line) => line.startsWith("GET ") && line.endsWith("/reviews")))
      expect(run(["deny", approval], env).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(approval, "utf8")).decision).toBe("deny")
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const denied = await deniedCall
      expect(denied.status, `${denied.stdout}\n${denied.stderr}`).toBe(4)
      expect(postsOf(state)).toBe(0)
      fs.rmSync(path.join(state, "release"))

      fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 41, side: "RIGHT", body: "P1. A payload edit during lookup must not be published." }]))
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const original = fs.readFileSync(payload, "utf8")
      child = spawnPost(payload, approval, env)
      const editedCall = collect(child)
      waitFor("second reviews lookup", () => callsOf(state).filter((line) => line.endsWith("/reviews")).length >= 2)
      fs.writeFileSync(payload, `${original}\n`)
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const edited = await editedCall
      expect(edited.status, `${edited.stdout}\n${edited.stderr}`).toBe(5)
      expect(postsOf(state)).toBe(0)
    } finally {
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("does not post a replacement approval that arrives during the head lookup", async () => {
    const { directory, payload, approval, bin, state } = freshReview("review-head-swap-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_HEAD: "1" }
    let child: ChildProcess | undefined
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. Draft A stays on the locked pull request.")
      child = spawnPost(payload, approval, env)
      const done = collect(child)
      waitFor("head lookup", () => callsOf(state).includes("GET repos/oakimov/cursor-opencode-provider/pulls/156"))
      installDraft(payload, approval, env, 157, "Summary for pull 157.\n", "P1. Draft B is a different pull request.")
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const result = await done
      expect(result.status, `${result.stdout}\n${result.stderr}\n${callsOf(state).join("\n")}\n${postBodies(state)}`).toBe(5)
      expect(result.stderr).toContain("The approval record was replaced.")
      expect(result.stderr).toContain("GitHub was not called.")
      expect(postsOf(state)).toBe(0)
      expect(postBodies(state)).toBe("")
      expect(callsOf(state).some((line) => line.includes("/pulls/157"))).toBe(false)
    } finally {
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("does not post a replacement approval that arrives during the reviews lookup", async () => {
    const { directory, payload, approval, bin, state } = freshReview("review-reviews-swap-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_GET: "1" }
    let child: ChildProcess | undefined
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. Draft A stays on the locked pull request.")
      const pinned = JSON.parse(fs.readFileSync(approval, "utf8")) as { generation: number }
      child = spawnPost(payload, approval, env)
      const done = collect(child)
      waitFor("reviews lookup", () => callsOf(state).some((line) => line.endsWith("/reviews")))
      installDraft(payload, approval, env, 157, "Summary for pull 157.\n", "P1. Draft B is a different pull request.")
      const forged = JSON.parse(fs.readFileSync(approval, "utf8")) as { generation: number; pull: number; decision: string }
      forged.generation = pinned.generation
      fs.writeFileSync(approval, JSON.stringify(forged, null, 2) + "\n")
      expect(forged.pull).toBe(157)
      expect(forged.decision).toBe("approve")
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const result = await done
      expect(result.status, `${result.stdout}\n${result.stderr}\n${callsOf(state).join("\n")}\n${postBodies(state)}`).toBe(5)
      expect(result.stderr).toContain("The approval record was replaced.")
      expect(postsOf(state)).toBe(0)
      expect(postBodies(state)).toBe("")
      expect(callsOf(state).filter((line) => line.startsWith("POST "))).toEqual([])
    } finally {
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("does not post a same-PR replacement or a new approval generation during lookup", async () => {
    const { directory, payload, approval, bin, state } = freshReview("review-same-pr-swap-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_GET: "1" }
    let child: ChildProcess | undefined
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. The locked draft is the only one that can be sent.")
      child = spawnPost(payload, approval, env)
      const replaced = collect(child)
      waitFor("reviews lookup", () => callsOf(state).some((line) => line.endsWith("/reviews")))
      installDraft(payload, approval, env, 156, "Summary of a later same-PR draft.\n", "P1. A later draft of the same pull request is a different operation.")
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const first = await replaced
      expect(first.status, `${first.stdout}\n${first.stderr}\n${callsOf(state).join("\n")}\n${postBodies(state)}`).toBe(5)
      expect(first.stderr).toContain("The approval record was replaced.")
      expect(postsOf(state)).toBe(0)
      fs.rmSync(path.join(state, "release"))
      fs.writeFileSync(path.join(state, "calls"), "")

      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. The locked draft is the only one that can be sent.")
      const before = JSON.parse(fs.readFileSync(approval, "utf8")) as { generation: number }
      child = spawnPost(payload, approval, env)
      const regenerated = collect(child)
      waitFor("second reviews lookup", () => callsOf(state).filter((line) => line.endsWith("/reviews")).length >= 1)
      const again = approve(payload, approval, env)
      expect(again.status, again.stderr).toBe(0)
      const after = JSON.parse(fs.readFileSync(approval, "utf8")) as { generation: number }
      expect(after.generation).toBeGreaterThan(before.generation)
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const second = await regenerated
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(5)
      expect(second.stderr).toContain("The approval record was replaced.")
      expect(postsOf(state)).toBe(0)
      expect(postBodies(state)).toBe("")
    } finally {
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("does not post a queued replacement approval for another pull request", async () => {
    const { directory, payload, approval, bin, state } = freshReview("review-queued-swap-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    let holder: { release: () => Promise<void> } | undefined
    let child: ChildProcess | undefined
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. The queued draft stays bound to its own approval.")
      holder = holdLock(publicationLock(approval))
      child = spawnPost(payload, approval, env)
      const finished = collect(child)
      waitFor("queued post", () => queuedOnLock(child!))
      expect(postsOf(state)).toBe(0)
      installDraft(payload, approval, env, 157, "Summary for pull 157.\n", "P1. A queued replacement is a different operation.")
      await holder.release()
      holder = undefined
      const result = await finished
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(5)
      expect(result.stderr).toContain("The approval record was replaced.")
      expect(postsOf(state)).toBe(0)
      expect(postBodies(state)).toBe("")
      expect(callsOf(state).some((line) => line.includes("/pulls/157"))).toBe(false)
    } finally {
      await holder?.release()
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("does not post again when a confirmed review loses its marker", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-confirmed-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P2. A confirmed review id remains delivery evidence.")
      const posted = run(["post", payload, approval], env)
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout).toContain("pullrequestreview-1")
      expect(postsOf(state)).toBe(1)
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8")) as Array<{ review: { id: number; body: string } }>
      expect(stored[0]?.review.id).toBe(1)
      expect(stored[0]?.review.body).toContain("cursor-review:")
      stored[0]!.review.body = "Edited summary without the marker.\n"
      fs.writeFileSync(path.join(state, "reviews.json"), JSON.stringify(stored))
      const edited = run(["post", payload, approval], env)
      expect(edited.status, `${edited.stdout}\n${edited.stderr}`).toBe(0)
      expect(edited.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(edited.stdout).toContain("pullrequestreview-1")
      expect(edited.stdout).toContain("COMMENT_URL=")
      expect(postsOf(state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)

      fs.writeFileSync(path.join(state, "reviews.json"), JSON.stringify([{
        request: {},
        review: {
          id: 9,
          body: "Unrelated review without the marker.",
          html_url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-9",
        },
      }]))
      const missing = run(["post", payload, approval], env)
      expect(missing.status, `${missing.stdout}\n${missing.stderr}`).toBe(1)
      expect(missing.stderr).toContain("Confirmed review 1 is not visible.")
      expect(missing.stderr).toContain("GitHub was not called again.")
      expect(missing.stdout).not.toContain("pullrequestreview-9")
      expect(postsOf(state)).toBe(1)
      expect(checkpointText(directory)).toContain('"state": "posted"')
      expect(checkpointText(directory)).toContain('"review_id": 1')

      fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
      const empty = run(["post", payload, approval], env)
      expect(empty.status, empty.stderr).toBe(1)
      expect(empty.stderr).toContain("Confirmed review 1 is not visible.")
      expect(postsOf(state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not send a second request when delivery is unknown", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-unknown-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 42, side: "RIGHT", body: "P2. An unsettled post must not be repeated." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_FAIL: "1" }
    let child: ChildProcess | undefined
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const lost = run(["post", payload, approval], env)
      expect(lost.status).toBe(1)
      expect(lost.stderr).toContain("Delivery is unknown. GitHub was not called again.")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toEqual([])
      expect(checkpointText(directory)).toContain('"state": "posting"')
      const again = run(["post", payload, approval], env)
      expect(again.status, again.stderr).toBe(1)
      expect(again.stderr).toContain("The previous post did not confirm delivery. GitHub was not called again.")
      expect(postsOf(state)).toBe(1)

      const stored = JSON.parse(fs.readFileSync(payload, "utf8")) as { body: string }
      fs.writeFileSync(path.join(state, "reviews.json"), JSON.stringify([{
        request: stored,
        review: { id: 7, body: stored.body, html_url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-7" },
      }]))
      const visible = run(["post", payload, approval], env)
      expect(visible.status, `${visible.stdout}\n${visible.stderr}`).toBe(0)
      expect(visible.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(visible.stdout).toContain("pullrequestreview-7")
      expect(postsOf(state)).toBe(1)
      expect(checkpointText(directory)).toContain('"state": "posted"')

      fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
      fs.rmSync(path.join(directory, ".review-publish"), { recursive: true, force: true })
      child = spawn(python, [path.join(root, "scripts/review-publish.py"), "post", payload, approval], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_POST: "1" },
      })
      waitFor("in-flight post", () => {
        const dir = path.join(directory, ".review-publish")
        const posting = fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.endsWith(".json") && fs.readFileSync(path.join(dir, name), "utf8").includes('"state": "posting"'))
        return posting && postsOf(state) >= 2
      })
      stopProcess(child)
      const stopped = child?.pid
      child = undefined
      if (stopped) {
        const started = Date.now()
        while (Date.now() - started < 2000) {
          try { process.kill(stopped, 0) } catch { break }
          await Bun.sleep(20)
        }
      }
      const afterExit = run(["post", payload, approval], { PATH: env.PATH, GH_STATE: state })
      expect(afterExit.status, afterExit.stderr).toBe(1)
      expect(afterExit.stderr).toContain("GitHub was not called again.")
      expect(postsOf(state)).toBe(2)
    } finally {
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("retries a post GitHub rejected and still posts one review when callers are sequential", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-rejected-"))
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    const bin = path.join(directory, "bin")
    const state = path.join(directory, "state")
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
    fs.writeFileSync(path.join(state, "head"), head + "\n")
    writeGh(bin)
    fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 43, side: "RIGHT", body: "P2. A rejected post can be sent again." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_REJECT: "1" }
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const rejected = run(["post", payload, approval], env)
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain("HTTP 422")
      expect(checkpointText(directory)).toContain('"state": "rejected"')
      expect(postsOf(state)).toBe(1)
      const sent = run(["post", payload, approval], { PATH: env.PATH, GH_STATE: state })
      expect(sent.status, `${sent.stdout}\n${sent.stderr}`).toBe(0)
      expect(sent.stdout).toContain("REVIEW_URL=")
      expect(postsOf(state)).toBe(2)
      const second = run(["post", payload, approval], { PATH: env.PATH, GH_STATE: state })
      expect(second.status, second.stderr).toBe(0)
      expect(second.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(postsOf(state)).toBe(2)
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("renders anchored findings, keeps comment ids, and does not publish an incomplete result", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-structured-")
    const source = path.join(directory, "result.json")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const finding = {
      id: "publish-lock",
      severity: "high",
      rule: "resource-lifecycle",
      path: "scripts/review-publish.py",
      line: 44,
      side: "RIGHT",
      title: "Replacement approval is sent to the locked pull request",
      explanation: "The lookup reload accepts another valid approval.",
      trigger: "Replace both files during the reviews GET.",
      consequence: "The replacement text is posted on the original pull request.",
      evidence: "reproduced",
      verification: "Hold the reviews GET and expect no POST.",
    }
    const outside = {
      ...finding,
      id: "outside-diff",
      path: "scripts/isolated-check.sh",
      line: 4,
      side: "RIGHT",
      title: "A check result from outside this diff",
    }
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ findings: [finding, outside], prior: [{
        id: "old-lock",
        status: "fixed",
        source: "discussion_r10",
        note: "The locked operation is pinned before the lookups.",
      }], mutations: [{
        action: "reply",
        thread: "discussion_r10",
        body: "The lock now keeps the approved pull request.",
        evidence: "test/review-publish.test.ts",
      }] }), null, 2) + "\n")
      const rendered = run(["render", source, payload], env)
      expect(rendered.status, rendered.stderr).toBe(0)
      expect(rendered.stderr).toContain("REVIEW_OUTCOME=findings")
      const body = JSON.parse(fs.readFileSync(payload, "utf8")) as { body: string; comments: Array<{ path: string; body: string }> }
      expect(body.comments).toHaveLength(1)
      expect(body.comments[0]?.path).toBe("scripts/review-publish.py")
      expect(body.comments[0]?.body).toContain("High: Replacement approval is sent to the locked pull request")
      expect(body.comments[0]?.body).toContain("Trigger: Replace both files during the reviews GET.")
      expect(body.comments[0]?.body).toContain("Impact: The replacement text is posted on the original pull request.")
      expect(body.comments[0]?.body).toContain("Evidence: reproduced")
      expect(body.body).toContain("Findings outside the current diff:")
      expect(body.body).toContain("Location: scripts/isolated-check.sh:4 RIGHT")
      expect(body.body).toContain("Earlier findings:")
      expect(body.body).toContain("old-lock (discussion_r10): fixed.")
      expect(body.body).toContain("Proposed GitHub actions, not performed:")
      expect(callsOf(state)).toEqual([])
      const again = run(["render", source, path.join(directory, "second.json")], env)
      expect(fs.readFileSync(payload, "utf8")).toBe(fs.readFileSync(path.join(directory, "second.json"), "utf8"))
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const posted = run(["post", payload, approval], env)
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout).toContain("COMMENT_URL=")
      expect(postsOf(state)).toBe(1)
      expect(callsOf(state).some((line) => line.startsWith("PATCH ") || line.startsWith("PUT "))).toBe(false)
      const journal = JSON.parse(checkpointText(directory)) as { review_id: number; comment_ids: number[]; review_url: string }
      expect(journal.review_id).toBe(1)
      expect(journal.comment_ids).toEqual([10])
      expect(journal.review_url).toContain("/pull/156#pullrequestreview-1")
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8")) as Array<{ review: { body: string } }>
      stored[0]!.review.body = "Edited summary without the marker.\n"
      fs.writeFileSync(path.join(state, "reviews.json"), JSON.stringify(stored))
      const retry = run(["post", payload, approval], env)
      expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0)
      expect(retry.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(retry.stdout).toContain("COMMENT_URL=")
      expect(postsOf(state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(state, "comments.json"), "utf8"))).toHaveLength(1)

      fs.writeFileSync(source, JSON.stringify(structuredResult({
        outcome: "incomplete",
        findings: [],
        checks: [
          { name: "diff", status: "unavailable", detail: "The diff could not be read." },
          { name: "isolated-check", status: "unavailable", detail: "The isolation command was not available." },
        ],
      }), null, 2) + "\n")
      const incomplete = run(["render", source, path.join(directory, "incomplete.json")], env)
      expect(incomplete.status, incomplete.stderr).toBe(0)
      expect(incomplete.stderr).toContain("REVIEW_OUTCOME=incomplete")
      expect(incomplete.stderr).toContain("cannot be published")
      const refused = run(["stamp", path.join(directory, "incomplete.json")], env)
      expect(refused.status, refused.stderr).toBe(2)
      expect(refused.stderr).toContain("The review is incomplete.")
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects malformed, contradictory, and unavailable review results", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-malformed-"))
    const source = path.join(directory, "result.json")
    const payload = path.join(directory, "payload.json")
    const cases: Array<{ name: string; value: Record<string, unknown>; problem: string }> = [
      { name: "missing id", value: structuredResult({ findings: [{ ...structuredResult().findings[0], id: "" }] }), problem: "findings[0].id" },
      { name: "clean with a finding", value: structuredResult({ outcome: "clean" }), problem: "outcome" },
      { name: "failed diff as findings", value: structuredResult({ checks: [{ name: "diff", status: "failed", detail: "The diff could not be read." }] }), problem: "outcome" },
      { name: "unavailable tool", value: structuredResult({ checks: [{ name: "diff", status: "passed", detail: "Read the changed files and their callers." }, { name: "isolated-check", status: "unavailable", detail: "unshare is not available." }] }), problem: "outcome" },
      { name: "duplicate findings", value: structuredResult({ findings: [structuredResult().findings[0], { ...structuredResult().findings[0], id: "same-place" }] }), problem: "findings[1]" },
      { name: "still present without a finding", value: structuredResult({ prior: [{ id: "old-lock", status: "still_present", source: "discussion_r10", note: "The defect is still in the head." }] }), problem: "prior[0].status" },
      { name: "fixed finding reappears", value: structuredResult({ prior: [{ id: "publish-lock", status: "fixed", source: "discussion_r10", note: "It was fixed." }] }), problem: "prior[0].status" },
      { name: "unverified clean review", value: structuredResult({ outcome: "clean", findings: [], prior: [{ id: "old-lock", status: "unverified", source: "discussion_r10", note: "The thread was not rechecked." }] }), problem: "outcome" },
      { name: "other runtime", value: structuredResult({ runtime: "darwin" }), problem: "runtime" },
      { name: "severity does not match the rule", value: structuredResult({ findings: [{ ...structuredResult().findings[0], severity: "low", rule: "important" }] }), problem: "findings[0].severity" },
      { name: "too many nits", value: structuredResult({ findings: Array.from({ length: 6 }, (_, index) => ({ id: `nit-${index}`, severity: "low", rule: "nit", title: `Name ${index} is unclear`, explanation: "The name does not say what it stores.", trigger: "Read the changed function.", consequence: "A later edit can miss the stored value.", evidence: "source" })), diff: [] }), problem: "nits" },
    ]
    try {
      for (const sample of cases) {
        fs.writeFileSync(source, JSON.stringify(sample.value, null, 2) + "\n")
        const result = run(["render", source, payload], {})
        expect(result.status, sample.name + result.stderr).toBe(2)
        expect(result.stderr, sample.name).toContain(sample.problem)
        expect(fs.existsSync(payload)).toBe(false)
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("records the pull request revision and refuses a stale base or a mismatched review url", async () => {
    const { directory, payload, approval, bin, state } = freshReview("review-revision-")
    const target = path.join(directory, "target.json")
    fs.writeFileSync(path.join(state, "base"), `${"a".repeat(40)}\n`)
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      const bound = run(["bind", "oakimov", "cursor-opencode-provider", "156", target], env)
      expect(bound.status, bound.stderr).toBe(0)
      const recorded = JSON.parse(fs.readFileSync(target, "utf8")) as {
        owner: string
        repo: string
        pull: number
        base: string
        head: string
        runtime: string
        findings?: string
      }
      expect(recorded).toEqual({
        owner: "oakimov",
        repo: "cursor-opencode-provider",
        pull: 156,
        base: "a".repeat(40),
        head,
        runtime: "linux",
      })
      recorded.findings = "kept"
      fs.writeFileSync(target, JSON.stringify(recorded, null, 2) + "\n")
      expect(run(["bind", "oakimov", "cursor-opencode-provider", "156", target], env).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(target, "utf8")).findings).toBe("kept")
      fs.writeFileSync(path.join(state, "head"), `${"c".repeat(40)}\n`)
      const moved = run(["bind", "oakimov", "cursor-opencode-provider", "156", target], env)
      expect(moved.status, moved.stderr).toBe(6)
      expect(moved.stderr).toContain("Refresh the review")
      expect(JSON.parse(fs.readFileSync(target, "utf8")).head).toBe(head)
      fs.writeFileSync(path.join(state, "head"), `${head}\n`)

      fs.writeFileSync(payload, draft([{ path: "scripts/review-publish.py", line: 44, side: "RIGHT", body: "P1. A stale base must not be published." }]))
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      fs.writeFileSync(path.join(state, "base"), `${"d".repeat(40)}\n`)
      const stale = run(["post", payload, approval], env)
      expect(stale.status, stale.stderr).toBe(6)
      expect(stale.stderr).toContain("Refresh the review")
      expect(postsOf(state)).toBe(0)
      fs.writeFileSync(path.join(state, "base"), `${"a".repeat(40)}\n`)

      const wrong = run(["post", payload, approval], { ...env, GH_WRONG_URL: "1" })
      expect(wrong.status, `${wrong.stdout}\n${wrong.stderr}`).toBe(1)
      expect(wrong.stderr).toContain("does not match the approved pull request")
      expect(wrong.stdout).not.toContain("other/repo")
      expect(postsOf(state)).toBe(1)
      expect(checkpointText(directory)).toContain('"state": "posting"')
      const retry = run(["post", payload, approval], { ...env, GH_WRONG_URL: "1" })
      expect(retry.status, retry.stderr).toBe(1)
      expect(retry.stderr).toContain("GitHub was not called again.")
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

function structuredResult(overrides: Record<string, unknown> = {}) {
  const finding = {
    id: "publish-lock",
    severity: "high",
    rule: "resource-lifecycle",
    path: "scripts/review-publish.py",
    line: 44,
    side: "RIGHT",
    title: "Replacement approval is sent to the locked pull request",
    explanation: "The lookup reload accepts another valid approval.",
    trigger: "Replace both files during the reviews GET.",
    consequence: "The replacement text is posted on the original pull request.",
    evidence: "reproduced",
    verification: "Hold the reviews GET and expect no POST.",
  }
  return {
    owner: "oakimov",
    repo: "cursor-opencode-provider",
    pull: 156,
    base: "a".repeat(40),
    head,
    runtime: "linux",
    outcome: "findings",
    checks: [
      { name: "diff", status: "passed", detail: "Read the changed files and their callers." },
      { name: "isolated-check", status: "passed", detail: "Install, build, typecheck, and unit tests passed." },
    ],
    limitations: ["Live OpenCode was not required for this diff."],
    diff: [{ path: "scripts/review-publish.py", line: 44, side: "RIGHT" }],
    prior: [],
    findings: [finding],
    mutations: [],
    ...overrides,
  }
}
