import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
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
import json, os, sys
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
reviews = json.loads(reviews_path.read_text(encoding="utf-8") or "[]")
if method == "POST":
    payload = json.load(sys.stdin)
    review = {
        "id": len(reviews) + 1,
        "body": payload.get("body", ""),
        "html_url": "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-" + str(len(reviews) + 1),
        "comments": [
            {
                "html_url": "https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r" + str(len(reviews) + 1) + str(index),
                "path": comment.get("path"),
                "line": comment.get("line"),
                "side": comment.get("side"),
                "body": comment.get("body"),
            }
            for index, comment in enumerate(payload.get("comments") or [])
        ],
    }
    if os.environ.get("GH_FAIL") == "1":
        if os.environ.get("GH_COMMIT") == "1":
            reviews.append({"request": payload, "review": review})
            reviews_path.write_text(json.dumps(reviews), encoding="utf-8")
        sys.stderr.write("boom\\n")
        raise SystemExit(1)
    reviews.append({"request": payload, "review": review})
    reviews_path.write_text(json.dumps(reviews), encoding="utf-8")
    json.dump(review, sys.stdout)
    raise SystemExit(0)
if endpoint.endswith("/reviews"):
    page = [item["review"] for item in reviews]
    json.dump([page] if "--slurp" in args else page, sys.stdout)
    raise SystemExit(0)
head = (state / "head").read_text(encoding="utf-8").strip()
json.dump({"head": {"sha": head}}, sys.stdout)
`
  fs.writeFileSync(path.join(bin, "gh"), script)
  fs.chmodSync(path.join(bin, "gh"), 0o755)
}

function draft(comments: Array<{ path: string; line: number; side: string; body: string }>, body = "Summary of the checked diff.\n"): string {
  return JSON.stringify(
    {
      owner: "oakimov",
      repo: "cursor-opencode-provider",
      pull: 156,
      base: "a".repeat(40),
      head,
      event: "COMMENT",
      body,
      comments,
    },
    null,
    2,
  ) + "\n"
}

function callsOf(state: string): string[] {
  const file = path.join(state, "calls")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

function postsOf(state: string): number {
  return callsOf(state).filter((line) => line.startsWith("POST ")).length
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
      const approved = run(["approve", payload, approval], env)
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
      expect(run(["approve", payload, approval], env).status).toBe(0)
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

  it("recovers a committed post that reported failure and retries one that did not commit", () => {
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
      expect(run(["approve", payload, approval], env).status).toBe(0)
      const failed = run(["post", payload, approval], env)
      expect(failed.status).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toEqual([])
      const committed = run(["post", payload, approval], { ...env, GH_COMMIT: "1" })
      expect(committed.status, `${committed.stdout}\n${committed.stderr}`).toBe(0)
      expect(committed.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
      const retry = run(["post", payload, approval], env)
      expect(retry.status, retry.stderr).toBe(0)
      expect(retry.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toHaveLength(1)
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
})
