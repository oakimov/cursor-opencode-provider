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

function publisherArgs(args: string[]): string[] {
  // Keep the real JWT/HTTP construction; route only the HTTPS boundary to fake gh.
  return ["-c", `
import http.client, json, os, runpy, subprocess, sys
from pathlib import Path
class Connection:
    def __init__(self, host, timeout):
        assert host == "api.github.com" and timeout == 30
    def request(self, method, endpoint, body, headers):
        authorization = headers["Authorization"]
        assert authorization.startswith("Bearer ")
        state = Path(os.environ["GH_STATE"])
        with (state / "app-http").open("a") as handle:
            handle.write(json.dumps({"method": method, "endpoint": endpoint, "bearer": True}) + "\\n")
        env = {key: value for key, value in os.environ.items() if not key.startswith("REVIEW_APP_")}
        env["GH_TOKEN"] = authorization[7:]
        command = ["gh", "api", "--method", method, endpoint.lstrip("/")]
        if body is not None: command.extend(["--input", "-"])
        self.completed = subprocess.run(command, input=body.encode() if body is not None else None, capture_output=True, env=env)
    def getresponse(self):
        completed = self.completed
        class Response:
            status = 200 if completed.returncode == 0 else 401
            def read(self): return completed.stdout
        return Response()
    def close(self): pass
http.client.HTTPSConnection = Connection
script = sys.argv.pop(1)
sys.argv[0] = script
runpy.run_path(script, run_name="__main__")
`, path.join(root, "scripts/review-publish.py"), ...args]
}

function writeAppKey(state: string): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-app-key-"))
  const pemPath = path.join(directory, "app.pem")
  const pubPath = path.join(directory, "app.pub")
  try {
    const generated = spawnSync("openssl", ["genrsa", "-out", pemPath, "2048"], { encoding: "utf8" })
    if (generated.status !== 0) throw new Error(generated.stderr || "openssl genrsa failed")
    const derived = spawnSync("openssl", ["rsa", "-in", pemPath, "-pubout", "-out", pubPath], { encoding: "utf8" })
    if (derived.status !== 0) throw new Error(derived.stderr || "openssl rsa failed")
    fs.writeFileSync(path.join(state, "app.pem"), fs.readFileSync(pemPath))
    fs.chmodSync(path.join(state, "app.pem"), 0o600)
    fs.writeFileSync(path.join(state, "app.pub"), fs.readFileSync(pubPath))
    fs.writeFileSync(path.join(state, "app-id"), "12345\n")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function withApp(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  if (next.REVIEW_APP_UNCONFIGURED === "1") {
    delete next.REVIEW_APP_UNCONFIGURED
    for (const key of Object.keys(next)) {
      if (key.startsWith("REVIEW_APP_")) delete next[key]
    }
    return next
  }
  const state = next.GH_STATE ? String(next.GH_STATE) : ""
  const pemPath = state ? path.join(state, "app.pem") : ""
  if (!next.REVIEW_APP_ID) next.REVIEW_APP_ID = "12345"
  if (next.REVIEW_APP_INSTALLATION_ID === undefined) next.REVIEW_APP_INSTALLATION_ID = "67890"
  const omit = next.REVIEW_APP_OMIT_KEY === "1"
  delete next.REVIEW_APP_OMIT_KEY
  if (omit) {
    delete next.REVIEW_APP_PRIVATE_KEY
    delete next.REVIEW_APP_PRIVATE_KEY_FILE
    return next
  }
  if (!next.REVIEW_APP_PRIVATE_KEY && !next.REVIEW_APP_PRIVATE_KEY_FILE && pemPath && fs.existsSync(pemPath)) {
    next.REVIEW_APP_PRIVATE_KEY = fs.readFileSync(pemPath, "utf8")
  }
  return next
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd = root): { status: number; stdout: string; stderr: string } {
  const artifacts = env.REVIEW_ARTIFACT_DIR || path.join(env.GH_STATE ? path.dirname(String(env.GH_STATE)) : path.dirname(path.resolve(cwd, args[1] || "unused")), "retained")
  const result = spawnSync(python, publisherArgs(args), {
    cwd,
    encoding: "utf8",
    env: withApp({ ...process.env, PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: artifacts, ...env }),
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function writeGh(bin: string): void {
  fs.mkdirSync(bin)
  writeAppKey(path.join(path.dirname(bin), "state"))
  const script = `#!${python}
import base64, json, os, subprocess, sys, tempfile, time
from pathlib import Path
state = Path(os.environ["GH_STATE"])
args = sys.argv[1:]
if args and args[0] == "api":
    args = args[1:]
method = "GET"
positional = []
index = 0
while index < len(args):
    item = args[index]
    if item == "--method":
        method = args[index + 1]
        index += 2
        continue
    if item in ("--input", "-H", "--header", "-f", "-F", "-X"):
        index += 2
        continue
    if item.startswith("-"):
        index += 1
        continue
    positional.append(item)
    index += 1
endpoint = positional[-1]

def b64decode(part):
    pad = "=" * ((4 - len(part) % 4) % 4)
    return base64.urlsafe_b64decode(part + pad)

def verify_jwt(token):
    parts = token.split(".")
    if len(parts) != 3:
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    try:
        header = json.loads(b64decode(parts[0]))
        payload = json.loads(b64decode(parts[1]))
        signature = b64decode(parts[2])
    except Exception:
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    if header.get("alg") != "RS256" or str(payload.get("iss")) != (state / "app-id").read_text(encoding="utf-8").strip():
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    now = int(time.time())
    try:
        issued = int(payload.get("iat"))
        expires = int(payload.get("exp"))
    except (TypeError, ValueError):
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    if issued < now - 180 or issued > now + 30 or expires <= now or expires > issued + 600:
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    descriptor, name = tempfile.mkstemp(dir=state)
    try:
        os.write(descriptor, signature)
    finally:
        os.close(descriptor)
    try:
        checked = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(state / "app.pub"), "-signature", name],
            input=(parts[0] + "." + parts[1]).encode(),
            capture_output=True,
        )
    finally:
        os.unlink(name)
    if checked.returncode != 0:
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    (state / "jwt-iss").write_text(str(payload["iss"]), encoding="utf-8")

def note_key():
    leaked = bool(os.environ.get("REVIEW_APP_PRIVATE_KEY") or os.environ.get("REVIEW_APP_PRIVATE_KEY_FILE"))
    flag = state / "saw-app-key"
    if leaked or not flag.exists():
        flag.write_text("1" if leaked else "0", encoding="utf-8")

note_key()
with (state / "calls").open("a", encoding="utf-8") as handle:
    handle.write(method + " " + endpoint + "\\n")
token = os.environ.get("GH_TOKEN", "")
if endpoint == "graphql":
    request = json.load(sys.stdin)
    query = request["query"]
    variables = request["variables"]
    threads_path = state / "threads.json"
    threads = json.loads(threads_path.read_text()) if threads_path.exists() else []
    if "mutation ResolveThread" in query:
        if token != "ghs_testinstallationtoken":
            sys.stderr.write("HTTP 403\\n")
            raise SystemExit(1)
        with (state / "resolves").open("a") as handle:
            handle.write(variables["id"] + "\\n")
        if os.environ.get("GH_RESOLVE_FORBIDDEN") == "1" or os.environ.get("GH_RESOLVE_FORBIDDEN_THREAD") == variables["id"]:
            sys.stderr.write("HTTP 403\\n")
            raise SystemExit(1)
        thread = next(item for item in threads if item["id"] == variables["id"])
        if os.environ.get("GH_RESOLVE_UNKNOWN") != "1" or os.environ.get("GH_RESOLVE_COMMIT") == "1":
            thread["isResolved"] = True
            threads_path.write_text(json.dumps(threads))
        if os.environ.get("GH_RESOLVE_UNKNOWN") == "1":
            sys.stderr.write("connection reset\\n")
            raise SystemExit(1)
        receipt = {"id": thread["id"], "isResolved": thread["isResolved"]}
        if os.environ.get("GH_RESOLVE_WRONG_RECEIPT") == "1": receipt["id"] = "PRRT_other"
        if os.environ.get("GH_RESOLVE_NOT_APPLIED") == "1":
            thread["isResolved"] = False
            threads_path.write_text(json.dumps(threads))
        json.dump({"data": {"resolveReviewThread": {"thread": receipt}}}, sys.stdout)
        raise SystemExit(0)
    start = int(variables.get("cursor") or "0")
    size = int(os.environ.get("GH_THREAD_PAGE_SIZE", "100"))
    if "query ReviewThreads(" in query:
        selected = threads[start:start + size]
        connection = {"nodes": [{"id": item["id"]} for item in selected], "pageInfo": {"hasNextPage": start + size < len(threads), "endCursor": str(start + size)}}
        json.dump({"data": {"repository": {"pullRequest": {"reviewThreads": connection}}}}, sys.stdout)
    else:
        thread = next((item for item in threads if item["id"] == variables["id"]), None)
        if thread is not None:
            thread = dict(thread)
            comments = thread["comments"]
            thread["comments"] = {"nodes": comments[start:start + size], "pageInfo": {"hasNextPage": start + size < len(comments), "endCursor": str(start + size)}}
        json.dump({"data": {"node": thread}}, sys.stdout)
    raise SystemExit(0)
if endpoint.startswith("app/installations/") and endpoint.endswith("/access_tokens"):
    if os.environ.get("GH_MINT_FAIL") == "1":
        sys.stderr.write("HTTP 401 Bad credentials\\n")
        raise SystemExit(1)
    verify_jwt(token)
    issued = "ghs_12345_synthetic.Header-with_dash.signature" if os.environ.get("GH_STATELESS") == "1" else "ghs_testinstallationtoken"
    if os.environ.get("GH_MINT_USER") == "1": issued = "ghp_notabot"
    request = json.load(sys.stdin) if "--input" in args else None
    (state / "mint-body").write_text(json.dumps(request))
    json.dump({"token": issued, "permissions": {"pull_requests": "read" if os.environ.get("GH_READ_ONLY") == "1" else "write"}}, sys.stdout)
    raise SystemExit(0)
if endpoint.endswith("/installation"):
    verify_jwt(token)
    json.dump({"id": 67890}, sys.stdout)
    raise SystemExit(0)
if method == "POST" and endpoint.endswith("/reviews"):
    expected = "ghs_12345_synthetic.Header-with_dash.signature" if os.environ.get("GH_STATELESS") == "1" else "ghs_testinstallationtoken"
    if token != expected:
        sys.stderr.write("HTTP 403 Resource not accessible by integration\\n")
        raise SystemExit(1)
    (state / "review-auth").write_text("app", encoding="utf-8")
reviews_path = state / "reviews.json"
comments_path = state / "comments.json"
reviews = json.loads(reviews_path.read_text(encoding="utf-8") or "[]")
comments = json.loads(comments_path.read_text(encoding="utf-8")) if comments_path.exists() else []
if method == "POST":
    if os.environ.get("GH_FORBIDDEN") == "1":
        sys.stdin.read()
        sys.stderr.write("HTTP 403 Resource not accessible by integration " + token + "\\n")
        raise SystemExit(1)
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
    if os.environ.get("GH_ISSUE_COMMENT_URL") == "1":
        review_url = "https://github.com/oakimov/cursor-opencode-provider/pull/156#issuecomment-" + str(review_id)
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
    after = os.environ.get("GH_AFTER_REVIEW")
    if after == "reply":
        threads_path = state / "threads.json"
        threads = json.loads(threads_path.read_text())
        threads[0]["comments"].append({"id":"new-reply", "url":threads[0]["comments"][0]["url"] + "-reply", "body":"New evidence after approval", "updatedAt":"2026-01-02T00:00:00Z"})
        threads_path.write_text(json.dumps(threads))
    if after == "head": (state / "head").write_text("c" * 40)
    if after == "deny": Path(os.environ["GH_APPROVAL_PATH"]).write_text(json.dumps({"decision":"deny"}))
    if after == "replacement":
        approval_path = Path(os.environ["GH_APPROVAL_PATH"])
        approval_record = json.loads(approval_path.read_text())
        approval_record["generation"] += 1
        approval_path.write_text(json.dumps(approval_record))
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
  return callsOf(state).filter((line) => /^POST repos\/\S+\/pulls\/\d+\/reviews$/.test(line)).length
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
  return spawn(python, publisherArgs(["post", payload, approval]), {
    cwd: root,
    detached: true,
    env: withApp({ ...process.env, PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: env.REVIEW_ARTIFACT_DIR || path.join(env.GH_STATE ? path.dirname(String(env.GH_STATE)) : path.dirname(payload), "retained"), ...env }),
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

function documentedPublishCommands(): string[] {
  const doc = fs.readFileSync(path.join(root, "docs/pr-review.md"), "utf8")
  const commands: string[] = []
  for (const block of doc.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("python3 scripts/review-publish.py ")) commands.push(trimmed)
    }
  }
  return commands
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
  it("reports App configuration without reading credentials or calling GitHub", () => {
    const { directory, bin, state } = freshReview("review-auth-info-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_TOKEN: "synthetic-user-token" }
    try {
      const result = run(["auth-info"], env)
      expect(result.status, result.stderr).toBe(0)
      const info = JSON.parse(result.stdout)
      expect(info.publication_source).toBe("GitHub App installation")
      expect(info.read_source).toBe("GH_TOKEN")
      expect(info.permission_verification).toBe("not checked")
      expect(result.stdout + result.stderr).not.toContain("synthetic-user-token")
      expect(result.stdout + result.stderr).not.toContain("PRIVATE KEY-----")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects installation credentials in review text before calling GitHub", () => {
    const { directory, payload, bin, state } = freshReview("review-installation-scan-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      for (const prefix of ["ghs_", "ghu_", "gho_", "ghr_"]) {
        fs.writeFileSync(payload, draft([], prefix + "synthetic_token\n"))
        expect(run(["stamp", payload], env).status).toBe(3)
      }
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("publishes with stateless installation tokens, Bearer JWT requests and repository-scoped permissions", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-stateless-app-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_STATELESS: "1" }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P2. The approved review uses the configured App.")
      const posted = run(["post", payload, approval], env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(posted.stdout).toContain("#pullrequestreview-1")
      expect(JSON.parse(fs.readFileSync(path.join(state, "mint-body"), "utf8"))).toEqual({
        repositories: ["cursor-opencode-provider"], permissions: { pull_requests: "write" },
      })
      expect(JSON.parse(fs.readFileSync(path.join(state, "app-http"), "utf8").trim())).toEqual({
        method: "POST", endpoint: "/app/installations/67890/access_tokens", bearer: true,
      })
      expect(fs.readFileSync(path.join(state, "saw-app-key"), "utf8")).toBe("0")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a minted token without review-write permission and redacts a rejected stateless token", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-app-grant-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_STATELESS: "1" }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P2. A wrong App grant cannot publish.")
      const readOnly = run(["post", payload, approval], { ...env, GH_STATELESS: "0", GH_READ_ONLY: "1" })
      expect(readOnly.status).toBe(4)
      expect(readOnly.stderr).toContain("Pull requests: write")
      expect(postsOf(state)).toBe(0)
      const denied = run(["post", payload, approval], { ...env, GH_FORBIDDEN: "1" })
      expect(denied.status).toBe(1)
      expect(denied.stderr).toContain("HTTP 403")
      expect(denied.stderr).not.toContain("synthetic.Header-with_dash.signature")
      expect(checkpointText(directory)).toContain('"state": "rejected"')
      const again = run(["post", payload, approval], env)
      expect(again.status, again.stderr).toBe(0)
      expect(postsOf(state)).toBe(2)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not accept a discussion comment as a submitted review receipt", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-wrong-vehicle-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_ISSUE_COMMENT_URL: "1" }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "A submitted review must have a review receipt.")
      const refused = run(["post", payload, approval], env)
      expect(refused.status, `${refused.stdout}\n${refused.stderr}`).toBe(1)
      expect(refused.stdout).not.toContain("REVIEW_URL=")
      expect(checkpointText(directory)).toContain('"state": "posting"')
      const retry = run(["post", payload, approval], env)
      expect(retry.status).toBe(1)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not render a clean verdict supported only by successful checks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-only-"))
    const source = path.join(directory, "result.json")
    const payload = path.join(directory, "payload.json")
    const checks = [
      { name: "diff", status: "passed", detail: "The description matches the diff." },
      { name: "unit-tests", status: "passed", detail: "The full suite passed." },
    ]
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], checks })) + "\n")
      const refused = run(["render", source, payload], {})
      expect(refused.status, refused.stderr).toBe(2)
      expect(refused.stderr).toContain("checks.adversarial")
      expect(fs.existsSync(payload)).toBe(false)
      checks.push({ name: "adversarial", status: "passed", detail: "Traced validation, partial updates, recovery and downstream consumption against the contract, with source checks and a fake-service reproduction." })
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], checks })) + "\n")
      const rendered = run(["render", source, payload], {})
      expect(rendered.status, rendered.stderr).toBe(0)
      expect(JSON.parse(fs.readFileSync(payload, "utf8")).body).toContain("adversarial: passed.")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

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
    const env = withApp({ ...process.env, PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: path.join(directory, "retained"), PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_SLOW_POST: "1" })
    const runPost = () => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(python, publisherArgs(["post", payload, approval]), {
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
      child = spawn(python, publisherArgs(["post", payload, approval]), {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: withApp({ ...process.env, PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: path.join(directory, "retained"), PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_POST: "1" }),
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
      expect(body.body).toContain("GitHub actions after approval (replies remain proposals):")
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

  it("publishes the documented payload.json sequence through the fake API", () => {
    expect(documentedPublishCommands()).toEqual([
      'python3 scripts/review-publish.py bind owner repo 156 "$review_dir/review.json"',
      'python3 scripts/review-publish.py render "$review_dir/review.json" "$review_dir/payload.json"',
      'python3 scripts/review-publish.py stamp "$review_dir/payload.json"',
      'python3 scripts/review-publish.py show "$review_dir/payload.json"',
      'python3 scripts/review-publish.py approve "$review_dir/payload.json" "$review_dir/approval.json" "$PREVIEW_SHA256"',
      'python3 scripts/review-publish.py post "$review_dir/payload.json" "$review_dir/approval.json"',
      'python3 scripts/review-publish.py deny "$review_dir/approval.json"',
      'python3 scripts/review-publish.py cleanup "$review_dir"',
      'python3 scripts/review-publish.py cleanup "$review_dir" --discard-instruction "Discard this review."',
      'python3 scripts/review-publish.py threads owner repo 156 > "$review_dir/threads.json"',
    ])
    const { directory, bin, state } = freshReview("review-documented-")
    const review = path.join(directory, "review.json")
    const payload = path.join(directory, "payload.json")
    const approval = path.join(directory, "approval.json")
    fs.writeFileSync(path.join(state, "base"), `${"a".repeat(40)}\n`)
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      fs.writeFileSync(review, JSON.stringify(structuredResult(), null, 2) + "\n")
      const bound = run(["bind", "oakimov", "cursor-opencode-provider", "156", "review.json"], env, directory)
      expect(bound.status, bound.stderr).toBe(0)
      expect(JSON.parse(fs.readFileSync(review, "utf8")).findings).toHaveLength(1)
      const rendered = run(["render", "review.json", "payload.json"], env, directory)
      expect(rendered.status, rendered.stderr).toBe(0)
      expect(rendered.stderr).toContain("REVIEW_OUTCOME=findings")
      expect(run(["stamp", "payload.json"], env, directory).status).toBe(0)
      const shown = run(["show", "payload.json"], env, directory)
      expect(shown.status, shown.stderr).toBe(0)
      expect(shown.stdout).toBe(fs.readFileSync(payload, "utf8"))
      expect(fs.existsSync(`${payload}.preview`)).toBe(true)
      expect(fs.existsSync(`${review}.preview`)).toBe(false)
      const digest = previewDigest(shown.stderr)
      const resultFile = run(["approve", "review.json", "approval.json", digest], env, directory)
      expect(resultFile.status, resultFile.stderr).toBe(5)
      expect(resultFile.stderr).toContain("No preview is frozen")
      expect(fs.existsSync(approval)).toBe(false)
      expect(postsOf(state)).toBe(0)
      const approved = run(["approve", "payload.json", "approval.json", digest], env, directory)
      expect(approved.status, approved.stderr).toBe(0)
      const posted = run(["post", "payload.json", "approval.json"], env, directory)
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout).toContain("REVIEW_URL=https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-1")
      expect(posted.stdout).toContain("COMMENT_URL=")
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8")) as Array<{ request: { commit_id: string; comments: Array<{ path: string; body: string }> } }>
      expect(stored).toHaveLength(1)
      expect(stored[0]?.request.commit_id).toBe(head)
      expect(stored[0]?.request.comments[0]?.path).toBe("scripts/review-publish.py")
      expect(stored[0]?.request.comments[0]?.body).toContain("High: Replacement approval is sent to the locked pull request")
      expect(callsOf(state).filter((line) => line.startsWith("POST "))).toEqual([
        "POST graphql",
        "POST app/installations/67890/access_tokens",
        "POST repos/oakimov/cursor-opencode-provider/pulls/156/reviews",
      ])
      expect(fs.readFileSync(path.join(state, "review-auth"), "utf8")).toBe("app")
      expect(fs.readFileSync(path.join(state, "saw-app-key"), "utf8")).toBe("0")
      expect(fs.readFileSync(path.join(state, "jwt-iss"), "utf8")).toBe("12345")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a review until the GitHub App private key can sign", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-app-missing-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. A missing app key must not post.")
      const missing = run(["post", payload, approval], { ...env, REVIEW_APP_UNCONFIGURED: "1" })
      expect(missing.status, missing.stderr).toBe(4)
      expect(missing.stderr).toContain("REVIEW_APP_ID")
      expect(missing.stderr).toContain("GitHub was not called.")
      expect(missing.stderr).toContain("was not used")
      expect(callsOf(state)).toEqual([])

      const secretOnly = run(["post", payload, approval], {
        ...env,
        REVIEW_APP_ID: "12345",
        REVIEW_APP_OMIT_KEY: "1",
        REVIEW_APP_CLIENT_SECRET: "not-the-app-key",
      })
      expect(secretOnly.status, secretOnly.stderr).toBe(4)
      expect(secretOnly.stderr).toContain("client secret")
      expect(secretOnly.stderr).toContain("GitHub was not called.")
      expect(callsOf(state)).toEqual([])

      const userToken = run(["post", payload, approval], {
        ...env,
        REVIEW_APP_PRIVATE_KEY: "ghp_exampletoken",
      })
      expect(userToken.status, userToken.stderr).toBe(4)
      expect(userToken.stderr).toContain("cannot be the app key")
      expect(userToken.stderr).not.toContain("ghp_exampletoken")
      expect(callsOf(state)).toEqual([])

      const pem = fs.readFileSync(path.join(state, "app.pem"), "utf8")
      const both = run(["post", payload, approval], {
        ...env,
        REVIEW_APP_PRIVATE_KEY: pem,
        REVIEW_APP_PRIVATE_KEY_FILE: path.join(state, "app.pem"),
      })
      expect(both.status, both.stderr).toBe(4)
      expect(both.stderr).toContain("only one")
      expect(callsOf(state)).toEqual([])

      fs.chmodSync(path.join(state, "app.pem"), 0o644)
      const readable = run(["post", payload, approval], {
        ...env,
        REVIEW_APP_PRIVATE_KEY_FILE: path.join(state, "app.pem"),
      })
      expect(readable.status, readable.stderr).toBe(4)
      expect(readable.stderr).toContain("readable only by its owner")
      expect(readable.stderr).not.toContain("BEGIN")
      expect(callsOf(state)).toEqual([])
      fs.chmodSync(path.join(state, "app.pem"), 0o600)

      const link = path.join(state, "linked.pem")
      fs.symlinkSync(path.join(state, "app.pem"), link)
      const linked = run(["post", payload, approval], { ...env, REVIEW_APP_PRIVATE_KEY_FILE: link })
      expect(linked.status, linked.stderr).toBe(4)
      expect(linked.stderr).toContain("unreadable")
      expect(callsOf(state)).toEqual([])

      const broken = run(["post", payload, approval], {
        ...env,
        REVIEW_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
      })
      expect(broken.status, broken.stderr).toBe(4)
      expect(broken.stderr).toContain("could not sign")
      expect(broken.stderr).not.toContain("not-a-key")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("posts as the GitHub App and does not accept another credential", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-app-post-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const pem = fs.readFileSync(path.join(state, "app.pem"), "utf8")
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. The review must be posted by the app.")
      const escaped = `"${pem.trim().replaceAll("\n", "\\n")}"`
      const posted = run(["post", payload, approval], { ...env, REVIEW_APP_PRIVATE_KEY: escaped, REVIEW_APP_INSTALLATION_ID: "" })
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stderr).not.toContain("PRIVATE KEY")
      expect(posted.stderr).not.toContain("ghs_")
      expect(fs.readFileSync(path.join(state, "review-auth"), "utf8")).toBe("app")
      expect(fs.readFileSync(path.join(state, "saw-app-key"), "utf8")).toBe("0")
      expect(fs.readFileSync(path.join(state, "jwt-iss"), "utf8")).toBe("12345")
      expect(callsOf(state)).toContain("GET repos/oakimov/cursor-opencode-provider/installation")
      expect(callsOf(state).filter((line) => line.startsWith("POST "))).toEqual([
        "POST app/installations/67890/access_tokens",
        "POST repos/oakimov/cursor-opencode-provider/pulls/156/reviews",
      ])

      fs.writeFileSync(path.join(state, "reviews.json"), "[]\n")
      fs.rmSync(path.join(directory, ".review-publish"), { recursive: true, force: true })
      for (const name of ["review-auth", "jwt-iss", "calls"]) fs.rmSync(path.join(state, name), { force: true })
      const rejected = run(["post", payload, approval], { ...env, REVIEW_APP_ID: "99999" })
      expect(rejected.status, rejected.stderr).toBe(4)
      expect(rejected.stderr).toContain("did not authorize")
      expect(rejected.stderr).not.toContain("PRIVATE KEY")
      expect(postsOf(state)).toBe(0)
      expect(callsOf(state).some((line) => line.endsWith("/reviews") && line.startsWith("POST "))).toBe(false)
      const journalDir = path.join(directory, ".review-publish")
      const journals = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((name) => name.endsWith(".json")) : []
      expect(journals).toEqual([])

      fs.writeFileSync(path.join(state, "calls"), "")
      const userMint = run(["post", payload, approval], { ...env, GH_MINT_USER: "1" })
      expect(userMint.status, userMint.stderr).toBe(4)
      expect(userMint.stderr).toContain("did not return an app installation token")
      expect(userMint.stderr).not.toContain("ghp_")
      expect(postsOf(state)).toBe(0)
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not publish when the head moves during the reviews lookup", async () => {
    await expectNoPublishWhenRevisionMoves("head")
  }, 15000)

  it("does not publish when the base moves during the reviews lookup", async () => {
    await expectNoPublishWhenRevisionMoves("base")
  }, 15000)
})

async function expectNoPublishWhenRevisionMoves(kind: "head" | "base"): Promise<void> {
  const { directory, payload, approval, bin, state } = freshReview(`review-move-${kind}-`)
  fs.writeFileSync(path.join(state, "base"), `${"a".repeat(40)}\n`)
  const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_GET: "1" }
  const pull = "GET repos/oakimov/cursor-opencode-provider/pulls/156"
  let child: ChildProcess | undefined
  try {
    installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. A moved revision during lookup must not be published.")
    const approvalBytes = fs.readFileSync(approval)
    child = spawnPost(payload, approval, env)
    const done = collect(child)
    waitFor("reviews lookup", () => callsOf(state).some((line) => line.endsWith("/reviews")))
    const duringLookup = callsOf(state)
    expect(duringLookup.filter((line) => line === pull)).toHaveLength(1)
    expect(duringLookup.some((line) => line.endsWith("/reviews"))).toBe(true)
    expect(duringLookup.some((line) => line.startsWith("POST "))).toBe(false)
    if (kind === "head") fs.writeFileSync(path.join(state, "head"), `${otherHead}\n`)
    else fs.writeFileSync(path.join(state, "base"), `${"d".repeat(40)}\n`)
    fs.writeFileSync(path.join(state, "release"), "go\n")
    const result = await done
    expect(result.status, `${result.stdout}\n${result.stderr}\n${callsOf(state).join("\n")}\n${postBodies(state)}`).toBe(6)
    expect(result.stderr).toContain("The pull request revision changed. Refresh the review and approve it again.")
    expect(postsOf(state)).toBe(0)
    expect(postBodies(state)).toBe("")
    expect(fs.readFileSync(approval).equals(approvalBytes)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toEqual([])
    const calls = callsOf(state)
    const reviewsAt = calls.findIndex((line) => line.endsWith("/reviews"))
    const pullGets = calls.map((line, index) => ({ line, index })).filter((item) => item.line === pull)
    expect(pullGets).toHaveLength(2)
    expect(pullGets[0]!.index).toBeLessThan(reviewsAt)
    expect(pullGets[1]!.index).toBeGreaterThan(reviewsAt)
    expect(calls.some((line) => line.startsWith("POST "))).toBe(false)
    const journalDir = path.join(directory, ".review-publish")
    const journals = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((name) => name.endsWith(".json")) : []
    expect(journals).toEqual([])
  } finally {
    stopProcess(child)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

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
      { name: "adversarial", status: "passed", detail: "Traced the operation through denial, replacement, partial delivery and retry." },
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

function resolutionDraft(fixture: ReturnType<typeof freshReview>, statuses = ["fixed"], extra: NodeJS.ProcessEnv = {}) {
  const { directory, payload, bin, state } = fixture
  const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, ...extra }
  const threads = statuses.map((_, index) => ({
    id: `PRRT_fixture${index}`,
    isResolved: false,
    pullRequest: { number: 156, repository: { nameWithOwner: "oakimov/cursor-opencode-provider" } },
    comments: [
      { id: `original-${index}`, url: `https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r${10 + index}`, body: "Earlier review finding", updatedAt: "2026-01-01T00:00:00Z" },
      { id: `reply-${index}`, url: `https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r${20 + index}`, body: "The author says this is addressed; verify the current code.", updatedAt: "2026-01-02T00:00:00Z" },
    ],
  }))
  fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify(threads))
  const inventory = run(["threads", "oakimov", "cursor-opencode-provider", "156"], env)
  expect(inventory.status, inventory.stderr).toBe(0)
  const snapshots = JSON.parse(inventory.stdout) as { head: string; threads: Array<{ id: string; snapshot: string; comments: unknown[] }> }
  expect(snapshots.head).toBe(head)
  expect(snapshots.threads.map((item) => item.comments.length)).toEqual(statuses.map(() => 2))
  const result = structuredResult({
    outcome: "clean", findings: [],
    prior: statuses.map((status, index) => ({ id: `earlier-${index}`, status, source: threads[index]!.comments[0]!.url, note: "Verified the current branch against its contract and regression test." })),
    mutations: statuses.map((_, index) => ({
      action: "resolve", thread: threads[index]!.id, finding: `earlier-${index}`,
      snapshot: snapshots.threads[index]!.snapshot,
      body: "The earlier finding is addressed at the reviewed head.",
      evidence: "scripts/review-publish.py:1; test/review-publish.test.ts:1",
    })),
  })
  const source = path.join(directory, "result.json")
  fs.writeFileSync(source, JSON.stringify(result))
  const rendered = run(["render", source, payload], env)
  expect(rendered.status, rendered.stderr).toBe(0)
  expect(run(["stamp", payload], env).status).toBe(0)
  return { env, result, source, threads }
}

function resolutionsOf(state: string): string[] {
  const file = path.join(state, "resolves")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []
}

describe("review artifact retention", () => {
  it("defaults to the harness store rather than the process temp directory or working directory", () => {
    const { directory, bin, state } = freshReview("review-default-store-")
    try {
      const harness = path.join(directory, "harness")
      const scripts = path.join(harness, "scripts")
      const temporary = path.join(directory, "ephemeral")
      fs.mkdirSync(scripts, { recursive: true })
      fs.mkdirSync(temporary)
      const script = path.join(scripts, "review-publish.py")
      fs.copyFileSync(path.join(root, "scripts/review-publish.py"), script)
      const processEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, TMPDIR: temporary, PYTHONDONTWRITEBYTECODE: "1" }
      delete processEnv.REVIEW_ARTIFACT_DIR
      const started = spawnSync(python, [script, "start", "oakimov", "cursor-opencode-provider", "156"], { cwd: temporary, env: processEnv, encoding: "utf8" })
      expect(started.status, started.stderr).toBe(0)
      const workspace = started.stdout.trim()
      expect(path.dirname(workspace)).toBe(fs.realpathSync(path.join(harness, ".review-artifacts")))
      fs.rmSync(temporary, { recursive: true })
      expect(fs.existsSync(path.join(workspace, "review.json"))).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("starts in durable storage and recovers the exact shown preview after temporary working files are removed", () => {
    const fixture = freshReview("review-retention-")
    const { directory, bin, state } = fixture
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      const started = run(["start", "oakimov", "cursor-opencode-provider", "156"], env)
      expect(started.status, started.stderr).toBe(0)
      const workspace = started.stdout.trim()
      expect(path.dirname(workspace)).toBe(fs.realpathSync(path.join(directory, "retained")))
      expect(fs.statSync(workspace).mode & 0o777).toBe(0o700)
      expect(JSON.parse(fs.readFileSync(path.join(workspace, "review.json"), "utf8")).head).toBe(head)
      expect(run(["cleanup", workspace], env).status).not.toBe(0)

      // Reproduce the legacy mistake without losing the durable copy.
      const temporary = path.join(directory, "ephemeral")
      fs.mkdirSync(temporary)
      const source = path.join(temporary, "review.json")
      const payload = path.join(temporary, "preview.json")
      const original = JSON.stringify(structuredResult(), null, 2) + "\n"
      fs.writeFileSync(source, original)
      const rendered = run(["render", source, payload], env)
      expect(rendered.status).toBe(0)
      const draftStore = rendered.stderr.match(/REVIEW_RETAINED=(.+)/)![1]!
      fs.writeFileSync(source, JSON.stringify(structuredResult()))
      expect(run(["render", source, payload], env).status).toBe(0)
      expect(fs.readFileSync(path.join(draftStore, "review.json"), "utf8")).toBe(original)
      expect(fs.readdirSync(draftStore).filter((name) => name.startsWith("source-")).length).toBe(2)
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      const retained = shown.stderr.match(/REVIEW_RETAINED=(.+)/)?.[1]
      expect(retained).toBeDefined()
      const saved = path.join(retained!, "payload.json")
      fs.rmSync(temporary, { recursive: true })
      expect(fs.readFileSync(saved, "utf8")).toBe(shown.stdout)
      expect(fs.readFileSync(`${saved}.preview`, "utf8")).toBe(shown.stdout)
      expect(createHash("sha256").update(fs.readFileSync(saved)).digest("hex")).toBe(previewDigest(shown.stderr))
      expect(JSON.parse(fs.readFileSync(path.join(retained!, "review.json"), "utf8"))).toEqual(structuredResult())
      expect(run(["cleanup", retained!], env).stderr).toContain("pending")
      const approval = path.join(retained!, "approval.json")
      expect(run(["approve", saved, approval, previewDigest(shown.stderr)], env).status).toBe(0)
      expect(run(["deny", approval], env).status).toBe(0)
      expect(run(["cleanup", retained!], env).status).not.toBe(0)
      expect(fs.existsSync(saved)).toBe(true)
      expect(postsOf(state)).toBe(0)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("retains unconfirmed publication and permits explicit discard without resending", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-retention-posted-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      fs.writeFileSync(payload, draft([]))
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      const retained = shown.stderr.match(/REVIEW_RETAINED=(.+)/)![1]!
      expect(run(["approve", payload, approval, previewDigest(shown.stderr)], env).status).toBe(0)
      const unknown = run(["post", payload, approval], { ...env, GH_FAIL: "1" })
      expect(unknown.status).not.toBe(0)
      expect(run(["cleanup", retained], env).status).not.toBe(0)
      // Explicit discard ends an unconfirmed attempt; it is not permission to resend.
      const discarded = run(["cleanup", retained, "--discard-instruction", "Discard this unposted review."], env)
      expect(discarded.status, discarded.stderr).toBe(0)
      expect(fs.existsSync(retained)).toBe(false)
      expect(run(["post", payload, approval], env).stderr).toContain("explicitly discarded")
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("cleans a posted workspace while refusing changed artifacts and directories outside the store", () => {
    const { directory, bin, state } = freshReview("review-durable-cleanup-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      const workspace = run(["start", "oakimov", "cursor-opencode-provider", "156"], env).stdout.trim()
      const source = path.join(workspace, "review.json")
      const payload = path.join(workspace, "payload.json")
      const approval = path.join(workspace, "approval.json")
      fs.writeFileSync(source, JSON.stringify(structuredResult()))
      expect(run(["render", source, payload], env).status).toBe(0)
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      const retained = shown.stderr.match(/REVIEW_RETAINED=(.+)/)![1]!
      expect(run(["approve", payload, approval, previewDigest(shown.stderr)], env).status).toBe(0)
      expect(run(["post", payload, approval], env).status).toBe(0)
      fs.writeFileSync(source, JSON.stringify(structuredResult({ limitations: ["A new draft needs another review."] })))
      expect(run(["cleanup", workspace], env).status).not.toBe(0)
      expect(fs.existsSync(source)).toBe(true)
      expect(run(["cleanup", directory], env).status).not.toBe(0)
      expect(run(["cleanup", retained], env).status).toBe(0)
      expect(fs.existsSync(retained)).toBe(false)
      expect(run(["cleanup", workspace, "--discard-instruction", "Discard the revised draft."], env).status).toBe(0)
      expect(fs.existsSync(workspace)).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("review thread resolution", () => {
  it("reads all replies and pages, then resolves only approved fixed or refuted findings as the App", () => {
    const fixture = freshReview("review-resolve-")
    const { directory, payload, approval, state } = fixture
    try {
      const { env } = resolutionDraft(fixture, ["fixed", "refuted"], { GH_THREAD_PAGE_SIZE: "1" })
      const before = callsOf(state)
      expect(run(["post", payload, approval], env).status).toBe(4)
      expect(callsOf(state)).toEqual(before)
      expect(postsOf(state)).toBe(0)
      expect(resolutionsOf(state)).toEqual([])
      expect(approve(payload, approval, env).status).toBe(0)
      const posted = run(["post", payload, approval], env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(posted.stdout).toContain("REVIEW_URL=")
      expect(posted.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(posted.stdout).toContain("THREAD_RESOLVED=PRRT_fixture1")
      expect(resolutionsOf(state)).toEqual(["PRRT_fixture0", "PRRT_fixture1"])
      const visible = JSON.parse(fs.readFileSync(path.join(state, "threads.json"), "utf8")) as Array<{ isResolved: boolean }>
      expect(visible.every((thread) => thread.isResolved)).toBe(true)
      expect(checkpointText(directory)).toContain('"resolutions"')
      expect(run(["post", payload, approval], env).status).toBe(0)
      expect(postsOf(state)).toBe(1)
      expect(resolutionsOf(state)).toHaveLength(2)
      // Reopening by a human is not undone by a retry of the old approval.
      visible[0]!.isResolved = false
      fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify(visible))
      expect(run(["post", payload, approval], env).status).not.toBe(0)
      expect(resolutionsOf(state)).toHaveLength(2)
      expect(fs.readFileSync(path.join(state, "saw-app-key"), "utf8")).toBe("0")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 20000)

  it("requires a resolution for an addressed inline finding and refuses unresolved or mismatched actions", () => {
    const fixture = freshReview("review-resolution-schema-")
    const { directory, payload, state } = fixture
    try {
      const { env, source, threads } = resolutionDraft(fixture)
      const original = JSON.parse(fs.readFileSync(source, "utf8")) as Record<string, unknown>
      const action = { action: "resolve", thread: threads[0]!.id, finding: "earlier-0", snapshot: "a".repeat(64), body: "Addressed", evidence: "test/review-publish.test.ts:1" }
      const previous = { id: "earlier-0", status: "fixed", source: threads[0]!.comments[0]!.url, note: "Verified in the current head." }
      for (const change of [
        { mutations: [] },
        { prior: [{ ...previous, status: "unverified" }], mutations: [action] },
        { prior: [{ ...previous, status: "still_present" }], mutations: [action] },
        { mutations: [{ ...action, finding: "another-finding" }] },
        { mutations: [{ ...action, snapshot: "not-a-snapshot" }] },
        { mutations: [action, action] },
      ]) {
        fs.writeFileSync(source, JSON.stringify({ ...original, ...change }))
        expect(run(["render", source, payload], env).status).toBe(2)
      }
      expect(postsOf(state)).toBe(0)
      expect(resolutionsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a re-review that omits an open earlier thread", () => {
    const fixture = freshReview("review-thread-omission-")
    const { directory, payload, approval, state } = fixture
    try {
      const { env, source } = resolutionDraft(fixture)
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], prior: [], mutations: [] })))
      expect(run(["render", source, payload], env).status).toBe(0)
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const posted = run(["post", payload, approval], env)
      expect(posted.status).not.toBe(0)
      expect(posted.stderr).toContain("not classified")
      expect(postsOf(state)).toBe(0)
      expect(resolutionsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects changed discussion, a different source comment, or a thread on another PR before posting", () => {
    for (const change of ["reply", "source", "target"] as const) {
      const fixture = freshReview("review-stale-thread-")
      const { directory, payload, approval, state } = fixture
      try {
        const { env, threads } = resolutionDraft(fixture)
        expect(approve(payload, approval, env).status).toBe(0)
        if (change === "reply") threads[0]!.comments[1]!.body = "New evidence needs re-review."
        if (change === "source") threads[0]!.comments[0]!.url += "-different"
        if (change === "target") threads[0]!.pullRequest.number = 157
        fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify(threads))
        expect(run(["post", payload, approval], env).status).not.toBe(0)
        expect(postsOf(state)).toBe(0)
        expect(resolutionsOf(state)).toEqual([])
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 20000)

  it("stops thread actions if the head, replies, denial, or approval changes after the review is submitted", () => {
    for (const after of ["reply", "head", "deny", "replacement"]) {
      const fixture = freshReview("review-thread-race-")
      const { directory, payload, approval, state } = fixture
      try {
        const { env } = resolutionDraft(fixture)
        expect(approve(payload, approval, env).status).toBe(0)
        const posted = run(["post", payload, approval], { ...env, GH_AFTER_REVIEW: after, GH_APPROVAL_PATH: approval })
        expect(posted.status, after).not.toBe(0)
        expect(postsOf(state)).toBe(1)
        expect(resolutionsOf(state)).toEqual([])
        expect(posted.stdout).not.toContain("THREAD_RESOLVED=")
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 20000)

  it("keeps the review receipt on a rejected resolution and safely retries the rejected action", () => {
    const fixture = freshReview("review-resolve-forbidden-")
    const { directory, payload, approval, state } = fixture
    try {
      const { env } = resolutionDraft(fixture, ["fixed", "refuted"])
      expect(approve(payload, approval, env).status).toBe(0)
      const rejected = run(["post", payload, approval], { ...env, GH_RESOLVE_FORBIDDEN_THREAD: "PRRT_fixture1" })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stdout).toContain("REVIEW_URL=")
      expect(rejected.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(rejected.stdout).not.toContain("THREAD_RESOLVED=PRRT_fixture1")
      expect(checkpointText(directory)).toContain('"state": "posted"')
      expect(checkpointText(directory)).toContain('"state": "rejected"')
      expect(run(["post", payload, approval], env).status).toBe(0)
      expect(postsOf(state)).toBe(1)
      expect(resolutionsOf(state)).toEqual(["PRRT_fixture0", "PRRT_fixture1", "PRRT_fixture1"])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("confirms visible ambiguous resolutions on retry and never blindly repeats an unconfirmed mutation", () => {
    for (const committed of [false, true]) {
      const fixture = freshReview("review-resolution-unknown-")
      const { directory, payload, approval, state } = fixture
      try {
        const { env } = resolutionDraft(fixture)
        expect(approve(payload, approval, env).status).toBe(0)
        expect(run(["post", payload, approval], { ...env, GH_RESOLVE_UNKNOWN: "1", GH_RESOLVE_COMMIT: committed ? "1" : "0" }).status).not.toBe(0)
        const retried = run(["post", payload, approval], env)
        expect(retried.status === 0).toBe(committed)
        expect(resolutionsOf(state)).toHaveLength(1)
        expect(postsOf(state)).toBe(1)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 20000)

  it("requires both a matching mutation receipt and resolved readback", () => {
    for (const flag of ["GH_RESOLVE_WRONG_RECEIPT", "GH_RESOLVE_NOT_APPLIED"]) {
      const fixture = freshReview("review-resolution-receipt-")
      const { directory, payload, approval, state } = fixture
      try {
        const { env } = resolutionDraft(fixture)
        expect(approve(payload, approval, env).status).toBe(0)
        const sent = run(["post", payload, approval], { ...env, [flag]: "1" })
        expect(sent.status).not.toBe(0)
        expect(sent.stdout).not.toContain("THREAD_RESOLVED=")
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 20000)
})
