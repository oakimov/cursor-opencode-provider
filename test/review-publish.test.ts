import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Each case spawns Python, Bash or Git several times; Bun's 5 s default fails
// under ordinary machine load, unevenly across cases.
setDefaultTimeout(30_000)

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

function publisherArgs(args: string[], script = path.join(root, "scripts/review-publish.py")): string[] {
  // Keep the real JWT/HTTP construction; route only the HTTPS boundary to fake gh.
  return ["-c", `
import fcntl, http.client, json, os, runpy, subprocess, sys
from pathlib import Path
wait_marker = os.environ.get("REVIEW_TEST_LOCK_WAIT")
if wait_marker:
    real_flock = fcntl.flock
    def observed_flock(fd, operation):
        if operation == fcntl.LOCK_EX:
            Path(wait_marker).write_text(str(os.getpid()), encoding="utf-8")
        return real_flock(fd, operation)
    fcntl.flock = observed_flock
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
`, script, ...args]
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

function processEnvWithoutReviewApp(): NodeJS.ProcessEnv {
  // A cloud agent injects its own REVIEW_APP_* credentials into every process.
  // The fake boundary verifies against fixture values, so ambient credentials
  // must not reach the publisher; a test that names them still wins.
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("REVIEW_APP_")) continue
    next[key] = value
  }
  return next
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = root,
  script = path.join(root, "scripts/review-publish.py"),
): { status: number; stdout: string; stderr: string } {
  const artifacts = env.REVIEW_ARTIFACT_DIR || path.join(env.GH_STATE ? path.dirname(String(env.GH_STATE)) : path.dirname(path.resolve(cwd, args[1] || "unused")), "retained")
  const result = spawnSync(python, publisherArgs(args, script), {
    cwd,
    encoding: "utf8",
    env: withApp({ ...processEnvWithoutReviewApp(), PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: artifacts, ...env }),
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function runComplete(env: NodeJS.ProcessEnv, ...args: string[]) {
  return run(args, env, root, path.join(root, "scripts/complete-resolutions.py"))
}

function writeGh(bin: string): void {
  fs.mkdirSync(bin)
  writeAppKey(path.join(path.dirname(bin), "state"))
  const script = `#!${python}
import base64, hashlib, json, os, subprocess, sys, tempfile, time
from pathlib import Path
state = Path(os.environ["GH_STATE"])
args = sys.argv[1:]
if os.environ.get("GH_LEGACY_PAGES") == "1" and "--slurp" in args:
    sys.stderr.write("unknown flag: --slurp\\n")
    raise SystemExit(1)
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
with (state / "call-auth").open("a", encoding="utf-8") as handle:
    handle.write((hashlib.sha256(token.encode()).hexdigest() if token else "missing") + "\\n")
if method == "GET":
    digest = hashlib.sha256(token.encode()).hexdigest() if token else "missing"
    with (state / "read-auth").open("a", encoding="utf-8") as handle:
        handle.write(digest + "\\n")
if method == "GET" and endpoint == "user":
    # Installation tokens cannot read the authenticated user. Only a PAT can.
    if os.environ.get("GH_USER_FAIL") == "1" or not (token.startswith("ghp_") or token.startswith("github_pat_")):
        sys.stderr.write("HTTP 403 Resource not accessible by integration\\n")
        raise SystemExit(1)
    json.dump({"id": int(os.environ.get("GH_USER_ID", "77")), "login": os.environ.get("GH_USER_LOGIN", "pat-reviewer")}, sys.stdout)
    raise SystemExit(0)
if method == "GET" and endpoint == "app":
    if os.environ.get("GH_APP_FAIL") == "1":
        sys.stderr.write("HTTP 401\\n")
        raise SystemExit(1)
    verify_jwt(token)
    json.dump({"slug": os.environ.get("GH_APP_SLUG", "review-publisher")}, sys.stdout)
    raise SystemExit(0)
if endpoint == "graphql":
    request = json.load(sys.stdin)
    query = request["query"]
    variables = request["variables"]
    threads_path = state / "threads.json"
    threads = json.loads(threads_path.read_text()) if threads_path.exists() else []
    if "mutation ResolveThread" in query:
        pat = token.startswith("ghp_") or token.startswith("github_pat_")
        if token != "ghs_testinstallationtoken" and not pat:
            sys.stderr.write("HTTP 403\\n")
            raise SystemExit(1)
        if pat:
            (state / "resolve-token-sha256").write_text(hashlib.sha256(token.encode()).hexdigest(), encoding="utf-8")
        with (state / "resolves").open("a") as handle:
            handle.write(variables["id"] + "\\n")
        if os.environ.get("GH_RESOLVE_FORBIDDEN") == "1" or os.environ.get("GH_RESOLVE_FORBIDDEN_THREAD") == variables["id"]:
            sys.stderr.write("HTTP 403\\n")
            raise SystemExit(1)
        if os.environ.get("GH_RESOLVE_INTEGRATION") == "1" or os.environ.get("GH_RESOLVE_INTEGRATION_THREAD") == variables["id"]:
            sys.stderr.write("Resource not accessible by integration\\n")
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
if (method == "POST" and endpoint.endswith(("/reviews", "/comments"))) or (method == "PUT" and "/reviews/" in endpoint) or (method == "PATCH" and "/pulls/comments/" in endpoint):
    expected = "ghs_12345_synthetic.Header-with_dash.signature" if os.environ.get("GH_STATELESS") == "1" else "ghs_testinstallationtoken"
    pat = token.startswith("ghp_") or token.startswith("github_pat_")
    if pat:
        leaked = sorted(
            key for key, value in os.environ.items()
            if key not in ("GH_TOKEN", "GITHUB_TOKEN") and (value.startswith("ghp_") or value.startswith("github_pat_"))
        )
        (state / "pat-env-keys").write_text("\\n".join(leaked), encoding="utf-8")
        (state / "token-sha256").write_text(hashlib.sha256(token.encode()).hexdigest(), encoding="utf-8")
        (state / "review-auth").write_text("pat", encoding="utf-8")
    elif token != expected:
        sys.stderr.write("HTTP 403 Resource not accessible by integration\\n")
        raise SystemExit(1)
    else:
        (state / "review-auth").write_text("app", encoding="utf-8")
reviews_path = state / "reviews.json"
comments_path = state / "comments.json"
reviews = json.loads(reviews_path.read_text(encoding="utf-8") or "[]")
comments = json.loads(comments_path.read_text(encoding="utf-8")) if comments_path.exists() else []
if (method == "POST" and endpoint.endswith("/comments")) or (method == "PATCH" and "/pulls/comments/" in endpoint):
    request = json.load(sys.stdin)
    with (state / "inline-writes").open("a") as handle:
        handle.write(json.dumps({"method": method, "endpoint": endpoint, "request": request}) + "\\n")
    if os.environ.get("GH_INLINE_REJECT") == "1":
        sys.stderr.write("HTTP 403 Resource not accessible by integration\\n")
        raise SystemExit(1)
    if method == "PATCH":
        assert set(request) == {"body"}
        identifier = int(endpoint.rsplit("/", 1)[1])
        existing = next(item for item in comments if item["id"] == identifier)
        comment = dict(existing, body=request["body"])
    else:
        assert set(request) == {"commit_id", "body", "path", "line", "side"}
        identifier = max([item["id"] for item in comments] + [1000]) + 1
        comment = dict(request, id=identifier, user={"id": 77}, pull_request_review_id=900,
          html_url="https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r" + str(identifier))
    if os.environ.get("GH_INLINE_FAIL") != "1" or os.environ.get("GH_INLINE_COMMIT") == "1":
        if method == "PATCH": comments = [comment if item["id"] == identifier else item for item in comments]
        else: comments.append(comment)
        if os.environ.get("GH_INLINE_NO_APPLY") != "1":
            comments_path.write_text(json.dumps(comments))
            if method == "POST":
                reviews.append({"request": {}, "review": {"id": 1900 + identifier, "body": "", "state": "COMMENTED", "user": {"id": 77}, "commit_id": request["commit_id"],
                  "html_url": "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-" + str(1900 + identifier)}})
                comment["pull_request_review_id"] = 1900 + identifier
                comments_path.write_text(json.dumps(comments))
                reviews_path.write_text(json.dumps(reviews))
            threads_path = state / "threads.json"
            threads = json.loads(threads_path.read_text()) if threads_path.exists() else []
            if method == "POST":
                threads.append({"id": "PRRT_inline" + str(identifier), "isResolved": False,
                  "pullRequest": {"number": 156, "repository": {"nameWithOwner": "oakimov/cursor-opencode-provider"}},
                  "comments": [{"id": "inline-" + str(identifier), "url": comment["html_url"], "body": comment["body"], "updatedAt": "2026-01-01T00:00:00Z"}]})
            else:
                for thread in threads:
                    for row in thread["comments"]:
                        if row["url"] == comment["html_url"]: row["body"] = comment["body"]
            threads_path.write_text(json.dumps(threads))
    if os.environ.get("GH_INLINE_FAIL") == "1":
        sys.stderr.write("connection reset\\n")
        raise SystemExit(1)
    if os.environ.get("GH_INLINE_WRONG_TARGET") == "1": comment = dict(comment, line=99)
    after = os.environ.get("GH_AFTER_INLINE")
    if after == "head": (state / "head").write_text("c" * 40)
    if after == "deny": Path(os.environ["GH_APPROVAL_PATH"]).write_text(json.dumps({"decision":"deny"}))
    json.dump(comment, sys.stdout)
    raise SystemExit(0)
if "/reviews/" in endpoint and method in ("GET", "PUT"):
    review_id = int(endpoint.rsplit("/", 1)[1])
    entry = next((item for item in reviews if item["review"]["id"] == review_id), None)
    if entry is None:
        sys.stderr.write("HTTP 404\\n")
        raise SystemExit(1)
    if method == "GET":
        if os.environ.get("GH_UPDATE_CHANGED") == "1":
            entry["review"]["body"] += "\\nConcurrent edit"
            reviews_path.write_text(json.dumps(reviews))
        json.dump(entry["review"], sys.stdout)
        raise SystemExit(0)
    request = json.load(sys.stdin)
    assert set(request) == {"body"}
    with (state / "put-bodies").open("a") as handle:
        handle.write(json.dumps(request) + "\\n")
    if os.environ.get("GH_UPDATE_REJECT") == "1":
        sys.stderr.write("HTTP 403 Resource not accessible by integration\\n")
        raise SystemExit(1)
    changed = dict(entry["review"], body=request["body"])
    if os.environ.get("GH_UPDATE_FAIL") != "1" or os.environ.get("GH_UPDATE_COMMIT") == "1":
        if os.environ.get("GH_UPDATE_NO_APPLY") != "1":
            entry["review"] = changed
            reviews_path.write_text(json.dumps(reviews))
    if os.environ.get("GH_UPDATE_FAIL") == "1":
        sys.stderr.write("connection reset\\n")
        raise SystemExit(1)
    if os.environ.get("GH_UPDATE_WRONG_ID") == "1": changed["id"] += 1
    after = os.environ.get("GH_AFTER_UPDATE")
    if after == "head": (state / "head").write_text("c" * 40)
    if after == "deny": Path(os.environ["GH_APPROVAL_PATH"]).write_text(json.dumps({"decision":"deny"}))
    json.dump(changed, sys.stdout)
    raise SystemExit(0)
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
    pat_actor = token.startswith("ghp_") or token.startswith("github_pat_")
    actor = {"id": int(os.environ.get("GH_USER_ID", "77")), "login": os.environ.get("GH_USER_LOGIN", "pat-reviewer")} if pat_actor else {"id": int(os.environ.get("GH_APP_USER_ID", "77")), "login": os.environ.get("GH_APP_SLUG", "review-publisher") + "[bot]"}
    review = {
        "id": review_id,
        "body": payload.get("body", ""),
        "html_url": review_url,
        "state": "COMMENTED", "user": actor, "commit_id": payload.get("commit_id"),
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
            "commit_id": payload.get("commit_id"), "user": {"id": 77},
        }
        for index, comment in enumerate(payload.get("comments") or [])
    ]
    if os.environ.get("GH_INITIAL_INLINE_FAULT") == "missing": rows = []
    if os.environ.get("GH_INITIAL_INLINE_FAULT") == "anchor": rows = [dict(row, line=99) for row in rows]
    inline_only = payload.get("body") == "" and bool(rows)
    if inline_only:
        with (state / "inline-writes").open("a") as handle:
            handle.write(json.dumps({"method": "POST", "endpoint": endpoint, "request": payload}) + "\\n")
        if os.environ.get("GH_INLINE_REJECT") == "1":
            sys.stderr.write("HTTP 403 Resource not accessible by integration\\n")
            raise SystemExit(1)
    if os.environ.get("GH_FAIL") == "1":
        if os.environ.get("GH_COMMIT") == "1":
            reviews.append({"request": payload, "review": review})
            reviews_path.write_text(json.dumps(reviews), encoding="utf-8")
            comments.extend(rows)
            comments_path.write_text(json.dumps(comments), encoding="utf-8")
        sys.stderr.write("boom\\n")
        raise SystemExit(1)
    persist = not inline_only or os.environ.get("GH_INLINE_NO_APPLY") != "1"
    if inline_only and os.environ.get("GH_INLINE_FAIL") == "1" and os.environ.get("GH_INLINE_COMMIT") != "1":
        persist = False
    if persist:
        reviews.append({"request": payload, "review": review})
        comments.extend(rows)
        reviews_path.write_text(json.dumps(reviews), encoding="utf-8")
        comments_path.write_text(json.dumps(comments), encoding="utf-8")
        if inline_only:
            threads_path = state / "threads.json"
            threads = json.loads(threads_path.read_text()) if threads_path.exists() else []
            for row in rows:
                threads.append({"id": "PRRT_inline" + str(row["id"]), "isResolved": False,
                  "pullRequest": {"number": 156, "repository": {"nameWithOwner": "oakimov/cursor-opencode-provider"}},
                  "comments": [{"id": "inline-" + str(row["id"]), "url": row["html_url"], "body": row["body"], "updatedAt": "2026-01-01T00:00:00Z"}]})
            threads_path.write_text(json.dumps(threads))
    if inline_only and os.environ.get("GH_INLINE_FAIL") == "1":
        sys.stderr.write("connection reset\\n")
        raise SystemExit(1)
    response = dict(review, body="changed") if inline_only and os.environ.get("GH_INLINE_WRONG_TARGET") == "1" else review
    inline_after = os.environ.get("GH_AFTER_INLINE") if inline_only else None
    if inline_after == "head": (state / "head").write_text("c" * 40)
    if inline_after == "deny": Path(os.environ["GH_APPROVAL_PATH"]).write_text(json.dumps({"decision":"deny"}))
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
    json.dump(response, sys.stdout)
    raise SystemExit(0)
def dump(page):
    if "--paginate" in args and os.environ.get("GH_LEGACY_PAGES") == "1":
        # gh emits adjacent JSON documents; a match may be on a later page.
        fault = os.environ.get("GH_PAGE_FAULT")
        if fault == "empty": return
        sys.stdout.write("[]\\n")
        for item in page:
            json.dump([item], sys.stdout)
            sys.stdout.write("\\n")
        if fault == "truncated": sys.stdout.write("[{\\\"id\\\":")
        if fault == "object": sys.stdout.write("{}")
        if fault == "scalar": sys.stdout.write("[1]")
        if fault == "failed":
            sys.stderr.write("later page failed\\n")
            raise SystemExit(1)
        return
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
if endpoint.endswith("/files"):
    if os.environ.get("GH_FILES_FAIL") == "1":
        sys.stderr.write("HTTP 502\\n")
        raise SystemExit(1)
    files_path = state / "files.json"
    dump(json.loads(files_path.read_text(encoding="utf-8")) if files_path.exists() else [])
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

/** Existing publication races also exercise recovery of pre-gate retained bytes. */
function writeLegacyPayload(payload: string, text: string): void {
  const value = JSON.parse(text)
  const body = value.body.trim()
  const material = { ...value, event: "COMMENT", body, result: value.result ?? null }
  const keys = new Set<string>()
  JSON.stringify(material, (key, item) => { keys.add(key); return item })
  const identity = createHash("sha256").update(JSON.stringify(material, [...keys].sort())).digest("hex")
  value.body = `${body}\n\n<!-- cursor-review:${identity} -->\n`
  const raw = JSON.stringify(value, null, 2) + "\n"
  fs.writeFileSync(payload, raw)
  const retained = path.join(path.dirname(payload), "retained", `preview-${createHash("sha256").update(raw).digest("hex")}`)
  fs.mkdirSync(retained, { recursive: true })
  fs.writeFileSync(path.join(retained, "payload.json"), raw)
  fs.writeFileSync(path.join(retained, "payload.json.preview"), raw)
  fs.writeFileSync(path.join(retained, ".retention.json"), JSON.stringify({
    kind: "cursor-review-artifacts-v1", identities: [identity], posted: {}, state: "pending",
  }))
}

function evidenceLedger(result: ReturnType<typeof structuredResult>) {
  return {
    version: 3,
    revision: result.head,
    diagnostics: result.checks.filter(check => check.status === "failed").map((check, index) => ({
      id: `check-${index}`, check: check.name, observation: check.detail,
      classification: "failure" in check ? "environment" : "defect",
      basis: "failure" in check ? "The capability probe establishes the environment cause." : "The command failure is caused by the publication defect below.",
      candidates: "failure" in check ? [] : result.findings.map(finding => finding.id),
    })),
    behaviors: [{
      id: "publication", summary: "Synthetic publication fixture",
      contract: [{ path: "scripts/review-publish.py", line: 1, note: "Only the approved review is sent." }],
      scenarios: [{
        id: "fixture", category: "publication", applicable: true, reason: "",
        expected: "The pinned operation is sent once.", observed: "Fixture observation.",
        evidence: "synthetic", downstream: "Fixture receipt is checked.",
      }], uncovered: [],
    }],
    candidates: result.findings.map(finding => ({
      id: finding.id, behavior: "publication", disposition: "actionable",
      observation: finding.explanation, contract: "The approved operation is pinned.",
      trigger: finding.trigger, causalPath: finding.explanation,
      consequence: finding.consequence, violation: "A replacement is sent.",
      evidenceKind: "synthetic", setup: "synthetic", provenance: "introduced",
      policyConflict: false, citedRequirement: "",
      assessment: { head: result.head, status: "present", basis: finding.explanation, elsewhere: [] },
    })),
    omissions: [], omissionsNone: "Fixture omission pass completed.",
    retries: [], retriesNone: "No refresh operation in this fixture.",
    passes: {
      candidatesValidated: result.outcome !== "incomplete",
      omissionsAnalyzed: result.outcome !== "incomplete",
      failedWorkAnalyzed: result.outcome !== "incomplete",
    },
  }
}

/** Supply explicit valid evidence for tests whose subject is another publication guard. */
function renderReview(source: string, payload: string, env: NodeJS.ProcessEnv) {
  const result = JSON.parse(fs.readFileSync(source, "utf8"))
  fs.writeFileSync(path.join(path.dirname(source), "ledger.json"), JSON.stringify(evidenceLedger(result)))
  return run(["render", source, payload], env)
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
  writeLegacyPayload(
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

function tokenSha(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function callAuth(state: string): string[] {
  const file = path.join(state, "call-auth")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

function credentialRows(state: string, stdout: string, stderr: string, secret: string) {
  const calls = callsOf(state)
  const auth = callAuth(state)
  const data = calls.flatMap((call, index) => (
    call.includes("access_tokens") || call.endsWith("/installation") ? [] : [auth[index] ?? "missing"]
  ))
  return {
    paired: auth.length === calls.length && calls.length > 0,
    missing: auth.includes("missing"),
    data,
    leaked: `${stdout}${stderr}`.includes(secret),
  }
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
    env: withApp({ ...processEnvWithoutReviewApp(), PYTHONDONTWRITEBYTECODE: "1", REVIEW_TEST_LOCK_WAIT: path.join(String(env.GH_STATE), "lock-wait"), REVIEW_ARTIFACT_DIR: env.REVIEW_ARTIFACT_DIR || path.join(env.GH_STATE ? path.dirname(String(env.GH_STATE)) : path.dirname(payload), "retained"), ...env }),
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

function queuedOnLock(child: ChildProcess, state: string): boolean {
  if (child.exitCode !== null || child.pid === undefined) return false
  // The holder owns the real lock before spawnPost. Observe the contender at
  // flock, after its approval peek, without depending on Linux's procfs.
  const marker = path.join(state, "lock-wait")
  return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === String(child.pid)
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
        writeLegacyPayload(payload, draft([], prefix + "synthetic_token\n"))
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
        repositories: ["cursor-opencode-provider"],
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

  it("publishes and recovers later-page receipts with gh that has no slurp flag", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-legacy-pages-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_LEGACY_PAGES: "1" }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P2. Read every page before deciding whether to send.")
      const delivered = run(["post", payload, approval], { ...env, GH_FAIL: "1", GH_COMMIT: "1" })
      expect(delivered.status, delivered.stderr).toBe(0)
      expect(delivered.stdout).toContain("#pullrequestreview-1")
      expect(postsOf(state)).toBe(1)
      const recovered = run(["post", payload, approval], env)
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(recovered.stdout).toContain("REVIEW_ALREADY_POSTED=1")
      expect(recovered.stdout).toContain("#pullrequestreview-1")
      expect(recovered.stdout).toContain("#discussion_r10")
      expect(postsOf(state)).toBe(1)
      expect(checkpointText(directory)).toContain('"state": "posted"')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses partial, malformed, non-array or empty paginated lookups before posting", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-bad-pages-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_LEGACY_PAGES: "1" }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P2. Invalid lookup output cannot authorize a send.")
      for (const fault of ["truncated", "object", "scalar", "empty", "failed"]) {
        const refused = run(["post", payload, approval], { ...env, GH_PAGE_FAULT: fault })
        expect(refused.status, `${fault}: ${refused.stderr}`).toBe(1)
        expect(postsOf(state)).toBe(0)
      }
      const retry = run(["post", payload, approval], env)
      expect(retry.status, retry.stderr).toBe(0)
      expect(postsOf(state)).toBe(1)
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
      { name: "unit-tests", status: "passed", detail: "The full suite passed.", exitCode: 0 },
      { name: "isolated-check", status: "passed", detail: "The fixture isolated command passed.", exitCode: 0 },
    ]
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], checks })) + "\n")
      const refused = renderReview(source, payload, {})
      expect(refused.status, refused.stderr).toBe(2)
      expect(refused.stderr).toContain("checks.adversarial")
      expect(fs.existsSync(payload)).toBe(false)
      checks.push({ name: "adversarial", status: "passed", detail: "Traced validation, partial updates, recovery and downstream consumption against the contract, with source checks and a fake-service reproduction." })
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], checks })) + "\n")
      const rendered = renderReview(source, payload, {})
      expect(rendered.status, rendered.stderr).toBe(0)
      expect(JSON.parse(fs.readFileSync(payload, "utf8")).body).toContain("adversarial: passed.")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects command statuses that contradict their exit codes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-exit-codes-"))
    const source = path.join(directory, "result.json")
    const payload = path.join(directory, "payload.json")
    try {
      for (const check of [
        { status: "passed", exitCode: 1 },
        { status: "failed", exitCode: 0 },
        { status: "skipped", exitCode: 0 },
        { status: "passed", exitCode: true },
        { status: "passed", exitCode: 0.5 },
      ]) {
        const result = structuredResult()
        const checks = [...result.checks, { name: "command", detail: "Recorded command result.", ...check }]
        fs.writeFileSync(source, JSON.stringify({ ...result, checks }))
        const refused = renderReview(source, payload, {})
        expect(refused.status, refused.stderr).toBe(2)
        expect(refused.stderr).toContain("checks[3].exitCode")
        expect(fs.existsSync(payload)).toBe(false)
      }
      const result = structuredResult()
      fs.writeFileSync(source, JSON.stringify({ ...result, checks: [...result.checks, {
        name: "command", status: "passed", detail: "The command exited successfully.", exitCode: 0,
      }] }))
      const rendered = renderReview(source, payload, {})
      expect(rendered.status, rendered.stderr).toBe(0)
      expect(JSON.parse(fs.readFileSync(payload, "utf8")).body).toContain("command: passed (exit 0).")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keeps attributed baseline and environment failures visible in a clean code review", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-failure-cause-"))
    const source = path.join(directory, "result.json")
    const payload = path.join(directory, "payload.json")
    try {
      for (const cause of ["baseline", "environment"]) {
        const result = structuredResult({ outcome: "clean", findings: [] })
        const command = {
          name: "isolated-command", status: "failed", exitCode: 1,
          detail: "Install and build passed; the wrapper failed in isolation self-tests.",
          failure: { cause, evidence: "The same self-test fails on the base revision with the same namespace refusal; the changed recovery tests pass on both revisions." },
        }
        const checks = [...result.checks, command]
        fs.writeFileSync(source, JSON.stringify({ ...result, checks }))
        const rendered = renderReview(source, payload, {})
        expect(rendered.status, rendered.stderr).toBe(0)
        const body = JSON.parse(fs.readFileSync(payload, "utf8")).body as string
        expect(body).toContain("No actionable findings.")
        expect(body).toContain("isolated-command: failed (exit 1).")
        expect(body).toContain(`Failure cause: ${cause}.`)
        expect(body).toContain("same self-test fails on the base revision")
        fs.rmSync(payload)

        for (const invalid of [
          { ...command, failure: { cause, evidence: "" } },
          { ...command, failure: { cause: "unknown", evidence: "Not investigated." } },
          { ...command, failure: { cause: [], evidence: "Invalid attribution." } },
          { ...command, exitCode: undefined },
          { ...command, status: "passed", exitCode: 0 },
        ]) {
          fs.writeFileSync(source, JSON.stringify({ ...result, checks: [...result.checks, invalid] }))
          const refused = renderReview(source, payload, {})
          expect(refused.status, refused.stderr).toBe(2)
          expect(fs.existsSync(payload)).toBe(false)
        }
        // A failed command without established attribution still blocks clean.
        for (const name of ["diff", "adversarial"]) {
          fs.writeFileSync(source, JSON.stringify({ ...result, checks: [
            ...result.checks.filter((check) => check.name !== name), { ...command, name },
          ] }))
          const refused = renderReview(source, payload, {})
          expect(refused.status, refused.stderr).toBe(2)
          expect(refused.stderr).toContain(".failure")
        }
        const { failure: _failure, ...unattributed } = command
        fs.writeFileSync(source, JSON.stringify({ ...result, checks: [...result.checks, unattributed] }))
        expect(renderReview(source, payload, {}).status).toBe(2)
      }
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
    writeLegacyPayload(payload, draft([{ path: "scripts/configure-opencode.sh", line: 102, side: "RIGHT", body: "P1. A trailing allow lets env files through." }]))
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
    writeLegacyPayload(
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
    writeLegacyPayload(payload, draft([] , "No findings.\nThe checked diff does not show a defect in the files read.\n"))
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
    writeLegacyPayload(payload, draft([{ path: "scripts/isolated-check.sh", line: 4, side: "RIGHT", body: "P1. The check can read files outside its home." }]))
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
    writeLegacyPayload(
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
    writeLegacyPayload(payload, first)
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      const digest = previewDigest(shown.stderr)
      writeLegacyPayload(payload, second)
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
      writeLegacyPayload(payload, second)
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
    writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 50, side: "RIGHT", body: "P2. Concurrent posts must not both create a review." }]))
    const env = withApp({ ...processEnvWithoutReviewApp(), PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: path.join(directory, "retained"), PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_SLOW_POST: "1" })
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
        writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 12, side: "RIGHT", body: sample.body }]))
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
    writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 40, side: "RIGHT", body: "P1. A queued denial must not be published." }]))
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    let holder: { release: () => void } | undefined
    let child: ChildProcess | undefined
    try {
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      holder = holdLock(publicationLock(approval))
      child = spawnPost(payload, approval, env)
      const finished = collect(child)
      waitFor("queued post", () => queuedOnLock(child!, state))
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

      writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 40, side: "RIGHT", body: "P1. A replaced payload must not be published." }]))
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const original = fs.readFileSync(payload, "utf8")
      holder = holdLock(publicationLock(approval))
      child = spawnPost(payload, approval, env)
      const replaced = collect(child)
      waitFor("queued replacement", () => queuedOnLock(child!, state))
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
    writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 41, side: "RIGHT", body: "P1. A denial during lookup must not be published." }]))
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

      writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 41, side: "RIGHT", body: "P1. A payload edit during lookup must not be published." }]))
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
      expect(callsOf(state).filter((line) => line.startsWith("POST ") && !line.includes("access_tokens"))).toEqual([])
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
      waitFor("queued post", () => queuedOnLock(child!, state))
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
    writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 42, side: "RIGHT", body: "P2. An unsettled post must not be repeated." }]))
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
        env: withApp({ ...processEnvWithoutReviewApp(), PYTHONDONTWRITEBYTECODE: "1", REVIEW_ARTIFACT_DIR: path.join(directory, "retained"), PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_POST: "1" }),
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
    writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 43, side: "RIGHT", body: "P2. A rejected post can be sent again." }]))
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
      const rendered = renderReview(source, payload, env)
      expect(rendered.status, rendered.stderr).toBe(0)
      expect(rendered.stderr).toContain("REVIEW_OUTCOME=findings")
      const body = JSON.parse(fs.readFileSync(payload, "utf8")) as { body: string; comments: Array<{ path: string; body: string }> }
      expect(body.comments).toHaveLength(1)
      expect(body.comments[0]?.path).toBe("scripts/review-publish.py")
      expect(body.comments[0]?.body).toContain("High: Replacement approval is sent to the locked pull request")
      expect(body.comments[0]?.body).toContain("Trigger: Replace both files during the reviews GET.")
      expect(body.comments[0]?.body).toContain("Impact: The replacement text is posted on the original pull request.")
      expect(body.comments[0]?.body).toContain("Evidence: reproduced")
      expect(body.body).toContain("2 actionable findings.")
      expect(body.body).not.toContain("High: Replacement approval is sent to the locked pull request")
      expect(body.body).toContain("Findings outside the current diff:")
      expect(body.body).toContain("High: A check result from outside this diff")
      expect(body.body).toContain("Location: scripts/isolated-check.sh:4 RIGHT")
      expect(body.body).toContain("Earlier findings:")
      expect(body.body).toContain("old-lock (discussion_r10): fixed.")
      expect(body.body).toContain("GitHub actions after approval (replies remain proposals):")
      expect(callsOf(state)).toEqual([])
      const again = renderReview(source, path.join(directory, "second.json"), env)
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
      const stored = JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8")) as Array<{ review: { id: number; body: string } }>
      expect(stored).toHaveLength(1)
      expect(stored[0]!.review.body).toContain("<!-- cursor-review:")
      expect(stored[0]!.review.body).not.toContain("High: Replacement approval is sent to the locked pull request")
      const attached = JSON.parse(fs.readFileSync(path.join(state, "comments.json"), "utf8")) as Array<{ pull_request_review_id: number }>
      expect(attached[0]?.pull_request_review_id).toBe(stored[0]!.review.id)
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
      const incomplete = renderReview(source, path.join(directory, "incomplete.json"), env)
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
        const result = renderReview(source, payload, {})
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
      expect(callsOf(state)).toEqual(["GET repos/oakimov/cursor-opencode-provider/pulls/156"])
      expect(bound.stdout).toContain("from GitHub. No GitHub changes were made.")
      expect(bound.stdout + bound.stderr).not.toContain("GitHub was not called.")
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
      const rebound = run(["bind", "oakimov", "cursor-opencode-provider", "156", target], env)
      expect(rebound.status, rebound.stderr).toBe(0)
      expect(rebound.stdout).toContain("The GitHub revision matches the recorded review. No GitHub changes were made.")
      expect(JSON.parse(fs.readFileSync(target, "utf8")).findings).toBe("kept")
      fs.writeFileSync(path.join(state, "head"), `${"c".repeat(40)}\n`)
      const moved = run(["bind", "oakimov", "cursor-opencode-provider", "156", target], env)
      expect(moved.status, moved.stderr).toBe(6)
      expect(moved.stderr).toContain("Refresh the review")
      expect(moved.stderr).toContain("No GitHub changes were made.")
      expect(moved.stderr).not.toContain("GitHub was not called.")
      expect(JSON.parse(fs.readFileSync(target, "utf8")).head).toBe(head)
      fs.writeFileSync(path.join(state, "head"), `${head}\n`)

      writeLegacyPayload(payload, draft([{ path: "scripts/review-publish.py", line: 44, side: "RIGHT", body: "P1. A stale base must not be published." }]))
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
      'python3 scripts/review-publish.py reviews owner repo 156 > "$review_dir/reviews.json"',
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
      fs.writeFileSync(path.join(directory, "ledger.json"), JSON.stringify(evidenceLedger(structuredResult())))
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
        "POST app/installations/67890/access_tokens",
        "POST graphql",
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

  it("documents --token-env and does not accept it on other commands", () => {
    const help = run(["--help"], { REVIEW_APP_UNCONFIGURED: "1" })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain("--token-env")
    expect(help.stdout).toContain("ghp_")
    expect(help.stdout).toContain("github_pat_")
    expect(help.stdout.replaceAll(/\s+/g, " ")).toContain("do not pass the token")
    const elsewhere = run(["show", "--token-env", "REVIEW_PUBLISH_TOKEN"], { REVIEW_APP_UNCONFIGURED: "1" })
    expect(elsewhere.status).not.toBe(0)
    expect(elsewhere.stderr).toContain("--token-env is only valid with post, threads and reviews")
    expect(elsewhere.stdout + elsewhere.stderr).not.toContain("REVIEW_PUBLISH_TOKEN=")
  })

  it("keeps the GitHub App path when --token-env is omitted", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-pat-ignored-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const token = "ghp_ambienttokenvalue1234567890"
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. An ambient PAT must not replace the App.")
      const posted = run(["post", payload, approval], { ...env, REVIEW_PUBLISH_TOKEN: token, GITHUB_CC: token })
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout + posted.stderr).not.toContain(token)
      expect(fs.readFileSync(path.join(state, "review-auth"), "utf8")).toBe("app")
      expect(callsOf(state)).toContain("POST app/installations/67890/access_tokens")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("posts with the named personal access token and does not mint an app token", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-pat-post-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const token = "ghp_exampletokenvalue1234567890"
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. The named PAT posts the review.")
      const posted = run(["post", payload, approval, "--token-env", "REVIEW_PUBLISH_TOKEN"], {
        ...env,
        REVIEW_APP_UNCONFIGURED: "1",
        REVIEW_PUBLISH_TOKEN: token,
      })
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout).toContain("REVIEW_URL=")
      expect(posted.stdout + posted.stderr).not.toContain(token)
      expect(fs.readFileSync(path.join(state, "review-auth"), "utf8")).toBe("pat")
      expect(fs.readFileSync(path.join(state, "token-sha256"), "utf8")).toBe(tokenSha(token))
      expect(fs.readFileSync(path.join(state, "pat-env-keys"), "utf8")).not.toContain("REVIEW_PUBLISH_TOKEN")
      expect(callsOf(state).some((line) => line.includes("access_tokens") || line.endsWith("/installation"))).toBe(false)
      expect(callsOf(state).filter((line) => line.startsWith("POST "))).toEqual([
        "POST repos/oakimov/cursor-opencode-provider/pulls/156/reviews",
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("uses the named token for required reads when it is the only GitHub credential", () => {
    const token = "ghp_readpathonlytokenvalue123456"
    const cases = [
      { name: "GH_TOKEN", env: { GH_TOKEN: token, GITHUB_TOKEN: "" } },
      { name: "GITHUB_CC", env: { GH_TOKEN: "", GITHUB_TOKEN: "", GITHUB_CC: token } },
    ]
    const directories: string[] = []
    const observed = cases.map(item => {
      const { directory, payload, approval, bin, state } = freshReview(`review-pat-read-${item.name}-`)
      directories.push(directory)
      const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, REVIEW_APP_UNCONFIGURED: "1" }
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. Reads keep the only credential.")
      const posted = run(["post", payload, approval, "--token-env", item.name], { ...env, ...item.env })
      const readPath = path.join(state, "read-auth")
      const reads = fs.existsSync(readPath) ? fs.readFileSync(readPath, "utf8").trim().split("\n") : []
      const authPath = path.join(state, "review-auth")
      return {
        name: item.name,
        status: posted.status,
        detail: `${posted.stdout}\n${posted.stderr}`.slice(0, 500),
        leaked: `${posted.stdout}${posted.stderr}`.includes(token),
        readCount: reads.length,
        readsMatch: reads.length > 0 && reads.every(line => line === tokenSha(token)),
        auth: fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : "",
      }
    })
    try {
      expect(observed.map(row => ({
        name: row.name,
        status: row.status,
        leaked: row.leaked,
        readCount: row.readCount > 0,
        readsMatch: row.readsMatch,
        auth: row.auth,
        detail: row.status === 0 ? "" : row.detail,
      }))).toEqual(cases.map(item => ({
        name: item.name,
        status: 0,
        leaked: false,
        readCount: true,
        readsMatch: true,
        auth: "pat",
        detail: "",
      })))
    } finally {
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("sends the publication credential on every threads and pre-publish gh call", () => {
    const pat = "ghp_threadreadtokenvalue123456789"
    const ambient = "ghp_ambientthreadtokenvalue12345"
    const installation = "ghs_testinstallationtoken"
    const thread = {
      id: "PRRT_fixture0",
      isResolved: false,
      pullRequest: { number: 156, repository: { nameWithOwner: "oakimov/cursor-opencode-provider" } },
      comments: [{
        id: "original",
        url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r10",
        body: "Earlier review finding",
        updatedAt: "2026-01-01T00:00:00Z",
      }],
    }
    const directories: string[] = []
    const observed: Array<Record<string, unknown>> = []
    try {
      const appFixture = freshReview("review-thread-app-")
      directories.push(appFixture.directory)
      fs.writeFileSync(path.join(appFixture.state, "threads.json"), JSON.stringify([thread]))
      const appEnv = { PATH: `${appFixture.bin}:/usr/bin:/bin`, GH_STATE: appFixture.state, GH_TOKEN: ambient, GITHUB_TOKEN: ambient }
      const appThreads = run(["threads", "oakimov", "cursor-opencode-provider", "156"], appEnv)
      const appRows = credentialRows(appFixture.state, appThreads.stdout, appThreads.stderr, installation)
      observed.push({
        name: "threads-app",
        status: appThreads.status,
        graphql: callsOf(appFixture.state).includes("POST graphql"),
        paired: appRows.paired,
        missing: appRows.missing,
        authed: appRows.data.length > 0 && appRows.data.every(line => line === tokenSha(installation)),
        leaked: appRows.leaked || `${appThreads.stdout}${appThreads.stderr}`.includes(ambient),
      })

      const patFixture = freshReview("review-thread-pat-")
      directories.push(patFixture.directory)
      fs.writeFileSync(path.join(patFixture.state, "threads.json"), JSON.stringify([thread]))
      const patThreads = run(
        ["threads", "oakimov", "cursor-opencode-provider", "156", "--token-env", "REVIEW_PUBLISH_TOKEN"],
        {
          PATH: `${patFixture.bin}:/usr/bin:/bin`,
          GH_STATE: patFixture.state,
          REVIEW_APP_UNCONFIGURED: "1",
          REVIEW_PUBLISH_TOKEN: pat,
          GH_TOKEN: ambient,
          GITHUB_TOKEN: ambient,
        },
      )
      const patRows = credentialRows(patFixture.state, patThreads.stdout, patThreads.stderr, pat)
      observed.push({
        name: "threads-pat",
        status: patThreads.status,
        graphql: callsOf(patFixture.state).includes("POST graphql"),
        minted: callsOf(patFixture.state).some(line => line.includes("access_tokens") || line.endsWith("/installation")),
        paired: patRows.paired,
        missing: patRows.missing,
        authed: patRows.data.length > 0 && patRows.data.every(line => line === tokenSha(pat)),
        leaked: patRows.leaked || `${patThreads.stdout}${patThreads.stderr}`.includes(ambient),
      })

      const missingFixture = freshReview("review-thread-missing-")
      directories.push(missingFixture.directory)
      const missing = run(["threads", "oakimov", "cursor-opencode-provider", "156"], {
        PATH: `${missingFixture.bin}:/usr/bin:/bin`,
        GH_STATE: missingFixture.state,
        REVIEW_APP_UNCONFIGURED: "1",
        GH_TOKEN: ambient,
        GITHUB_TOKEN: ambient,
      })
      observed.push({
        name: "threads-missing",
        status: missing.status,
        told: missing.stderr.includes("GitHub was not called.") && missing.stderr.includes("REVIEW_APP_ID"),
        calls: callsOf(missingFixture.state).join("\n"),
        leaked: `${missing.stdout}${missing.stderr}`.includes(ambient),
      })
    } finally {
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
    }
    expect(observed).toEqual([
      { name: "threads-app", status: 0, graphql: true, paired: true, missing: false, authed: true, leaked: false },
      { name: "threads-pat", status: 0, graphql: true, minted: false, paired: true, missing: false, authed: true, leaked: false },
      { name: "threads-missing", status: 4, told: true, calls: "", leaked: false },
    ])
  })

  it("sends that same credential on the pre-publish thread lookup and resolution reads", () => {
    const pat = "ghp_prepublishreadtokenvalue12345"
    const ambient = "ghp_ambientprepublishtokenvalue1"
    const installation = "ghs_testinstallationtoken"
    const directories: string[] = []
    const observed: Array<Record<string, unknown>> = []
    try {
      const appFixture = freshReview("review-prepublish-app-")
      directories.push(appFixture.directory)
      const { env } = resolutionDraft(appFixture, ["fixed"])
      fs.rmSync(path.join(appFixture.state, "calls"), { force: true })
      fs.rmSync(path.join(appFixture.state, "call-auth"), { force: true })
      expect(approve(appFixture.payload, appFixture.approval, env).status).toBe(0)
      const posted = run(["post", appFixture.payload, appFixture.approval], { ...env, GH_TOKEN: ambient, GITHUB_TOKEN: ambient })
      const appRows = credentialRows(appFixture.state, posted.stdout, posted.stderr, installation)
      observed.push({
        name: "post-app",
        status: posted.status,
        graphql: callsOf(appFixture.state).includes("POST graphql"),
        paired: appRows.paired,
        missing: appRows.missing,
        authed: appRows.data.length > 0 && appRows.data.every(line => line === tokenSha(installation)),
        leaked: appRows.leaked || `${posted.stdout}${posted.stderr}`.includes(ambient),
      })

      fs.rmSync(path.join(appFixture.state, "calls"), { force: true })
      fs.rmSync(path.join(appFixture.state, "call-auth"), { force: true })
      const appFinished = runComplete({ ...env, GH_TOKEN: ambient, GITHUB_TOKEN: ambient }, appFixture.payload, appFixture.approval)
      const appCompleteRows = credentialRows(appFixture.state, appFinished.stdout, appFinished.stderr, installation)
      observed.push({
        name: "complete-app",
        status: appFinished.status,
        reviews: callsOf(appFixture.state).some(line => line.endsWith("/reviews")),
        paired: appCompleteRows.paired,
        missing: appCompleteRows.missing,
        authed: appCompleteRows.data.length > 0 && appCompleteRows.data.every(line => line === tokenSha(installation)),
        leaked: appCompleteRows.leaked || `${appFinished.stdout}${appFinished.stderr}`.includes(ambient),
      })

      const patFixture = freshReview("review-prepublish-pat-")
      directories.push(patFixture.directory)
      const drafted = resolutionDraft(patFixture, ["fixed"])
      fs.rmSync(path.join(patFixture.state, "calls"), { force: true })
      fs.rmSync(path.join(patFixture.state, "call-auth"), { force: true })
      expect(approve(patFixture.payload, patFixture.approval, drafted.env).status).toBe(0)
      const patPosted = run(["post", patFixture.payload, patFixture.approval, "--token-env", "REVIEW_PUBLISH_TOKEN"], {
        ...drafted.env,
        REVIEW_APP_UNCONFIGURED: "1",
        REVIEW_PUBLISH_TOKEN: pat,
        GH_TOKEN: ambient,
        GITHUB_TOKEN: ambient,
      })
      const patRows = credentialRows(patFixture.state, patPosted.stdout, patPosted.stderr, pat)
      observed.push({
        name: "post-pat",
        status: patPosted.status,
        graphql: callsOf(patFixture.state).includes("POST graphql"),
        minted: callsOf(patFixture.state).some(line => line.includes("access_tokens") || line.endsWith("/installation")),
        paired: patRows.paired,
        missing: patRows.missing,
        authed: patRows.data.length > 0 && patRows.data.every(line => line === tokenSha(pat)),
        leaked: patRows.leaked || `${patPosted.stdout}${patPosted.stderr}`.includes(ambient),
      })

      fs.rmSync(path.join(patFixture.state, "calls"), { force: true })
      fs.rmSync(path.join(patFixture.state, "call-auth"), { force: true })
      const finished = runComplete({
        ...drafted.env,
        REVIEW_APP_UNCONFIGURED: "1",
        REVIEW_PUBLISH_TOKEN: pat,
        GH_TOKEN: ambient,
        GITHUB_TOKEN: ambient,
      }, "--token-env", "REVIEW_PUBLISH_TOKEN", patFixture.payload, patFixture.approval)
      const completeRows = credentialRows(patFixture.state, finished.stdout, finished.stderr, pat)
      observed.push({
        name: "complete-pat",
        status: finished.status,
        reviews: callsOf(patFixture.state).some(line => line.endsWith("/reviews")),
        minted: callsOf(patFixture.state).some(line => line.includes("access_tokens") || line.endsWith("/installation")),
        paired: completeRows.paired,
        missing: completeRows.missing,
        authed: completeRows.data.length > 0 && completeRows.data.every(line => line === tokenSha(pat)),
        leaked: completeRows.leaked || `${finished.stdout}${finished.stderr}`.includes(ambient),
      })
    } finally {
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
    }
    expect(observed).toEqual([
      { name: "post-app", status: 0, graphql: true, paired: true, missing: false, authed: true, leaked: false },
      { name: "complete-app", status: 0, reviews: true, paired: true, missing: false, authed: true, leaked: false },
      { name: "post-pat", status: 0, graphql: true, minted: false, paired: true, missing: false, authed: true, leaked: false },
      { name: "complete-pat", status: 0, reviews: true, minted: false, paired: true, missing: false, authed: true, leaked: false },
    ])
  })

  it("resolves threads with the named personal access token", () => {
    const fixture = freshReview("review-pat-resolve-")
    const { directory, payload, approval, state } = fixture
    const token = "github_pat_11AAAAAAA_exampletokenvalue"
    try {
      const { env } = resolutionDraft(fixture, ["fixed"])
      expect(approve(payload, approval, env).status).toBe(0)
      fs.rmSync(path.join(state, "calls"), { force: true })
      fs.rmSync(path.join(state, "call-auth"), { force: true })
      const posted = run(["post", payload, approval, "--token-env", "GITHUB_CC"], { ...env, GITHUB_CC: token })
      expect(posted.status, `${posted.stdout}\n${posted.stderr}`).toBe(0)
      expect(posted.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(posted.stdout + posted.stderr).not.toContain(token)
      expect(fs.readFileSync(path.join(state, "review-auth"), "utf8")).toBe("pat")
      expect(fs.readFileSync(path.join(state, "token-sha256"), "utf8")).toBe(tokenSha(token))
      expect(fs.readFileSync(path.join(state, "resolve-token-sha256"), "utf8")).toBe(tokenSha(token))
      expect(fs.readFileSync(path.join(state, "pat-env-keys"), "utf8")).not.toContain("GITHUB_CC")
      expect(callsOf(state).some((line) => line.includes("access_tokens") || line.endsWith("/installation"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses a missing, empty, or non-PAT value without printing it", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-pat-refuse-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const secret = "not-a-token-SECRETVALUE"
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. A bad PAT must not be printed or sent.")
      const missing = run(["post", payload, approval, "--token-env", "REVIEW_PUBLISH_TOKEN"], env)
      expect(missing.status, missing.stderr).toBe(4)
      expect(missing.stderr).toContain("REVIEW_PUBLISH_TOKEN is missing or empty")
      expect(missing.stderr).toContain("GitHub was not called.")
      expect(callsOf(state)).toEqual([])

      const empty = run(["post", payload, approval, "--token-env", "REVIEW_PUBLISH_TOKEN"], {
        ...env,
        REVIEW_PUBLISH_TOKEN: "   ",
      })
      expect(empty.status, empty.stderr).toBe(4)
      expect(empty.stderr).toContain("REVIEW_PUBLISH_TOKEN is missing or empty")
      expect(callsOf(state)).toEqual([])

      const named = run(["post", payload, approval, "--token-env", "ghp_commandlinesecret"], env)
      expect(named.status, named.stderr).toBe(4)
      expect(named.stderr).not.toContain("ghp_commandlinesecret")
      expect(named.stderr).toContain("missing or empty")
      expect(callsOf(state)).toEqual([])

      const rejected = run(["post", payload, approval, "--token-env", "REVIEW_PUBLISH_TOKEN"], {
        ...env,
        REVIEW_PUBLISH_TOKEN: secret,
      })
      expect(rejected.status, rejected.stderr).toBe(4)
      expect(rejected.stderr).toContain("personal access token")
      expect(rejected.stderr).not.toContain(secret)
      expect(rejected.stderr).not.toContain("SECRETVALUE")
      expect(callsOf(state)).toEqual([])

      const echoed = run(["post", payload, approval, "--token-env", "REVIEW_PUBLISH_TOKEN"], {
        ...env,
        REVIEW_APP_UNCONFIGURED: "1",
        REVIEW_PUBLISH_TOKEN: "ghp_exampletokenvalue1234567890",
        GH_FORBIDDEN: "1",
      })
      expect(echoed.status).not.toBe(0)
      expect(echoed.stderr).not.toContain("ghp_exampletokenvalue1234567890")
      expect(echoed.stderr).toContain("[redacted]")
      expect(echoed.stderr).toContain("personal access token")
      expect(JSON.parse(fs.readFileSync(path.join(state, "reviews.json"), "utf8"))).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("complete-resolutions.py uses --token-env and refuses a missing variable before GitHub", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-pat-complete-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    try {
      installDraft(payload, approval, env, 156, "Summary of the checked diff.\n", "P1. Resolution needs the named PAT.")
      const help = runComplete(env, "--help")
      expect(help.status, help.stderr).toBe(0)
      expect(help.stdout).toContain("--token-env")
      expect(help.stdout).toContain("command line")
      const missing = runComplete(env, "--token-env", "REVIEW_PUBLISH_TOKEN", payload, approval)
      expect(missing.status, missing.stderr).toBe(4)
      expect(missing.stderr).toContain("REVIEW_PUBLISH_TOKEN is missing or empty")
      expect(missing.stderr).toContain("GitHub was not called.")
      expect(callsOf(state)).toEqual([])
      const blank = runComplete({ ...env, REVIEW_PUBLISH_TOKEN: "" }, "--token-env", "REVIEW_PUBLISH_TOKEN", payload, approval)
      expect(blank.status, blank.stderr).toBe(4)
      expect(blank.stderr).toContain("missing or empty")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("complete-resolutions.py resolves with the named personal access token", () => {
    const fixture = freshReview("review-pat-complete-resolve-")
    const { directory, payload, approval, state } = fixture
    const token = "ghp_resolverexampletoken1234567890"
    try {
      const { env } = resolutionDraft(fixture, ["fixed"])
      expect(approve(payload, approval, env).status).toBe(0)
      const denied = run(["post", payload, approval], { ...env, GH_RESOLVE_FORBIDDEN: "1" })
      expect(denied.status).not.toBe(0)
      expect(denied.stdout).toContain("REVIEW_URL=")
      const finished = runComplete({ ...env, GITHUB_CC: token }, "--token-env", "GITHUB_CC", payload, approval)
      expect(finished.status, `${finished.stdout}\n${finished.stderr}`).toBe(0)
      expect(finished.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(finished.stdout + finished.stderr).not.toContain(token)
      expect(fs.readFileSync(path.join(state, "resolve-token-sha256"), "utf8")).toBe(tokenSha(token))
      // threads and the App post each mint once. The completion uses the named PAT.
      expect(callsOf(state).filter((line) => line.includes("access_tokens"))).toEqual([
        "POST app/installations/67890/access_tokens",
        "POST app/installations/67890/access_tokens",
      ])
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
    expect(duringLookup.some((line) => line.startsWith("POST ") && line.endsWith("/reviews"))).toBe(false)
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
    expect(calls.some((line) => line.startsWith("POST ") && line.endsWith("/reviews"))).toBe(false)
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
      { name: "isolated-check", status: "passed", detail: "Install, build, typecheck, and unit tests passed.", exitCode: 0 },
    ],
    limitations: ["Live OpenCode was not required for this diff."],
    diff: [{ path: "scripts/review-publish.py", line: 44, side: "RIGHT" }],
    prior: [],
    findings: [finding],
    mutations: [],
    ...overrides,
  }
}

describe("review summary updates", () => {
  function fixture() {
    const f = freshReview("review-update-")
    const env = { PATH: `${f.bin}:/usr/bin:/bin`, GH_STATE: f.state }
    const original = {
      id: 7, state: "COMMENTED", user: { id: 77, login: "reviewer[bot]" },
      body: `No actionable findings.\n\n<!-- cursor-review:${"d".repeat(64)} -->\n`,
      html_url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-7",
      commit_id: "a".repeat(40),
    }
    fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify([{ request: {}, review: original }]))
    const listed = run(["reviews", "oakimov", "cursor-opencode-provider", "156"], env)
    expect(listed.status, listed.stderr).toBe(0)
    const [snapshot] = JSON.parse(listed.stdout)
    expect(snapshot.bodySha256).toBe(createHash("sha256").update(original.body).digest("hex"))
    const source = path.join(f.directory, "result.json")
    fs.writeFileSync(source, JSON.stringify({
      ...structuredResult(),
      update: { review: snapshot.id, author: snapshot.user.id, bodySha256: snapshot.bodySha256 },
    }))
    expect(renderReview(source, f.payload, env).status).toBe(0)
    expect(run(["stamp", f.payload], env).status).toBe(0)
    expect(approve(f.payload, f.approval, env).status).toBe(0)
    return { ...f, env, source, original }
  }

  const puts = (state: string) => callsOf(state).filter(line => line.startsWith("PUT ")).length
  const inlineWrites = (state: string) => {
    const file = path.join(state, "inline-writes")
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []
  }

  function withExistingInline(f: ReturnType<typeof fixture>, oldHead = head, side = "RIGHT") {
    const comment = { id: 100, user: { id: 77 }, pull_request_review_id: 7,
      html_url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r100",
      path: "scripts/review-publish.py", line: 44, side, commit_id: oldHead,
      body: "Earlier finding with its original explanation.",
    }
    fs.writeFileSync(path.join(f.state, "comments.json"), JSON.stringify([comment]))
    fs.writeFileSync(path.join(f.state, "threads.json"), JSON.stringify([{
      id: "PRRT_existing", isResolved: false,
      pullRequest: { number: 156, repository: { nameWithOwner: "oakimov/cursor-opencode-provider" } },
      comments: [{ id: "native-100", url: comment.html_url, body: comment.body, updatedAt: "2026-01-01T00:00:00Z" }],
    }]))
    const inventory = run(["threads", "oakimov", "cursor-opencode-provider", "156"], f.env)
    expect(inventory.status, inventory.stderr).toBe(0)
    const thread = JSON.parse(inventory.stdout).threads[0]
    const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
    result.findings[0].side = side
    result.diff[0].side = side
    result.findings[0].comment = { id: comment.id, author: comment.user.id, thread: thread.id, repliesSha256: thread.repliesSha256,
      bodySha256: createHash("sha256").update(comment.body).digest("hex"),
    }
    result.prior = [{ id: result.findings[0].id, status: "still_present", source: comment.html_url,
      note: "Verified that the existing inline finding remains present on the bound head." }]
    fs.writeFileSync(f.source, JSON.stringify(result))
    expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
    expect(run(["stamp", f.payload], f.env).status).toBe(0)
    expect(approve(f.payload, f.approval, f.env).status).toBe(0)
    return { comment, result }
  }

  it.each(["RIGHT", "LEFT"])("updates an owned inline thread in place on the %s side", side => {
    const f = fixture()
    try {
      withExistingInline(f, head, side)
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(posted.stdout).toContain("#discussion_r100")
      expect(inlineWrites(f.state)).toMatchObject([{ method: "PATCH", endpoint: "repos/oakimov/cursor-opencode-provider/pulls/comments/100" }])
      const comments = JSON.parse(fs.readFileSync(path.join(f.state, "comments.json"), "utf8"))
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({ id: 100, commit_id: head, line: 44, side })
      expect(comments[0].body).toContain("<!-- cursor-finding:publish-lock -->")
      expect(postsOf(f.state)).toBe(0)
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(inlineWrites(f.state)).toHaveLength(1)
      expect(puts(f.state)).toBe(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("creates a current-head inline thread when the bound earlier anchor belongs to another commit", () => {
    const f = fixture()
    try {
      const { comment } = withExistingInline(f, otherHead)
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(inlineWrites(f.state)).toEqual([expect.objectContaining({
        method: "POST",
        endpoint: "repos/oakimov/cursor-opencode-provider/pulls/156/reviews",
        request: expect.objectContaining({
          body: "",
          commit_id: head,
          event: "COMMENT",
          comments: [expect.objectContaining({ path: comment.path, line: 44, side: "RIGHT" })],
        }),
      })])
      const comments = JSON.parse(fs.readFileSync(path.join(f.state, "comments.json"), "utf8"))
      expect(comments).toHaveLength(2)
      expect(comments[0]).toEqual(comment)
      expect(comments[1].commit_id).toBe(head)
      const rows = JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))
      expect(rows.filter((row: { review: { body: string } }) => row.review.body === "")).toHaveLength(1)
      expect(rows.filter((row: { review: { body: string } }) => row.review.body.includes("<!-- cursor-review:"))).toHaveLength(1)
      expect(postsOf(f.state)).toBe(1)
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(inlineWrites(f.state)).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it.each(["body", "author", "anchor", "url", "reply", "discussion"])("refuses a changed inline %s before updating the summary", change => {
    const f = fixture()
    try {
      const { comment } = withExistingInline(f)
      const changed = { ...comment, ...(change === "body" ? { body: "Concurrent edit" }
        : change === "author" ? { user: { id: 78 } }
        : change === "anchor" ? { line: 99 }
        : change === "url" ? { html_url: comment.html_url.replace("/156#", "/157#") }
        : change === "reply" ? { in_reply_to_id: 50 } : {}) }
      fs.writeFileSync(path.join(f.state, "comments.json"), JSON.stringify([changed]))
      if (change === "discussion") {
        const threads = JSON.parse(fs.readFileSync(path.join(f.state, "threads.json"), "utf8"))
        threads[0].comments.push({ id: "reply-101", url: comment.html_url.replace("100", "101"), body: "New evidence after preview", updatedAt: "2026-01-02T00:00:00Z" })
        fs.writeFileSync(path.join(f.state, "threads.json"), JSON.stringify(threads))
      }
      expect(run(["post", f.payload, f.approval], f.env).status).not.toBe(0)
      expect(puts(f.state)).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it.each([false, true])("recovers a lost inline response only when the approved comment is visible (delivered=%s)", delivered => {
    const f = fixture()
    try {
      const first = run(["post", f.payload, f.approval], { ...f.env, GH_INLINE_FAIL: "1", GH_INLINE_COMMIT: delivered ? "1" : "0" })
      expect(first.status, first.stderr).toBe(delivered ? 0 : 1)
      const second = run(["post", f.payload, f.approval], f.env)
      expect(second.status, second.stderr).toBe(delivered ? 0 : 1)
      expect(inlineWrites(f.state)).toHaveLength(1)
      expect(puts(f.state)).toBe(1)
      if (!delivered) {
        expect(second.stderr).toContain("No automatic resend")
        expect(runComplete(f.env, f.payload, f.approval).stderr).toContain("Inline publication is incomplete")
      }
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("keeps a rejected inline action retryable without resending the summary", () => {
    const f = fixture()
    try {
      const first = run(["post", f.payload, f.approval], { ...f.env, GH_INLINE_REJECT: "1" })
      expect(first.status).toBe(1)
      expect(first.stdout).toContain(f.original.html_url)
      expect(first.stderr).toContain("inline publication remains pending")
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(inlineWrites(f.state)).toHaveLength(2)
      expect(puts(f.state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "comments.json"), "utf8"))).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it.each(["GH_INLINE_NO_APPLY", "GH_INLINE_WRONG_TARGET"])("requires actual inline target readback after %s", fault => {
    const f = fixture()
    try {
      const first = run(["post", f.payload, f.approval], { ...f.env, [fault]: "1" })
      expect(first.status).toBe(1)
      const second = run(["post", f.payload, f.approval], f.env)
      expect(second.status).toBe(fault === "GH_INLINE_WRONG_TARGET" ? 0 : 1)
      expect(inlineWrites(f.state)).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it.each(["head", "deny"])("stops new inline publication after a summary-side %s change", change => {
    const f = fixture()
    try {
      const result = run(["post", f.payload, f.approval], { ...f.env, GH_AFTER_UPDATE: change, GH_APPROVAL_PATH: f.approval })
      expect(result.status).not.toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(inlineWrites(f.state)).toEqual([])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it.each(["head", "deny"])("stops further inline writes after the first comment and a %s change", change => {
    const f = fixture()
    try {
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.findings.push({ ...result.findings[0], id: "second-lock", title: "Second publication defect", line: 45 })
      result.diff.push({ ...result.diff[0], line: 45 })
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      const posted = run(["post", f.payload, f.approval], { ...f.env, GH_AFTER_INLINE: change, GH_APPROVAL_PATH: f.approval })
      expect(posted.status).not.toBe(0)
      expect(inlineWrites(f.state)).toHaveLength(1)
      expect(inlineWrites(f.state)[0].request.comments).toHaveLength(2)
      expect(puts(f.state)).toBe(1)
      expect(postsOf(f.state)).toBe(1)
      if (change === "head") fs.writeFileSync(path.join(f.state, "head"), head)
      else expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      const resumed = run(["post", f.payload, f.approval], f.env)
      expect(resumed.status, resumed.stderr).toBe(0)
      expect(inlineWrites(f.state)).toHaveLength(1)
      expect(puts(f.state)).toBe(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("refuses malformed or missing snapshots instead of duplicating an existing finding", () => {
    const f = fixture()
    try {
      const { result } = withExistingInline(f)
      for (const binding of [undefined, { ...result.findings[0].comment, id: true },
        { ...result.findings[0].comment, author: 78 }, { ...result.findings[0].comment, bodySha256: "not-a-digest" }]) {
        const changed = structuredClone(result)
        changed.findings[0].comment = binding
        fs.writeFileSync(f.source, JSON.stringify(changed))
        const rendered = renderReview(f.source, f.payload, f.env)
        expect(rendered.status, rendered.stderr).toBe(2)
        expect(rendered.stderr).toContain(".comment")
      }
      expect(inlineWrites(f.state)).toEqual([])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("uses the chosen personal access token for every inline-publication call", () => {
    const f = fixture()
    const token = "ghp_" + "syntheticinlinefixturetoken"
    try {
      const before = fs.readFileSync(path.join(f.state, "call-auth"), "utf8").trim().split("\n").length
      const posted = run(["post", f.payload, f.approval, "--token-env", "REVIEW_TEST_PAT"], { ...f.env, REVIEW_TEST_PAT: token })
      expect(posted.status, posted.stderr).toBe(0)
      expect(inlineWrites(f.state)).toHaveLength(1)
      const digests = fs.readFileSync(path.join(f.state, "call-auth"), "utf8").trim().split("\n").slice(before)
      expect(digests.length).toBeGreaterThan(0)
      expect([...new Set(digests)]).toEqual([createHash("sha256").update(token).digest("hex")])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("keeps a retained version-three summary-only update byte-identical without adding inline writes", () => {
    const f = fixture()
    try {
      const legacy = spawnSync(python, ["-B", "-W", "error", "-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("publisher","scripts/review-publish.py")
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
with open(sys.argv[1]) as source: result=json.load(source)
body,comments=publisher.public_review(result)
print(json.dumps({"body":body,"comments":comments}))
`, f.source], { cwd: root, encoding: "utf8" })
      expect(legacy.status, legacy.stderr).toBe(0)
      const value = JSON.parse(fs.readFileSync(f.payload, "utf8"))
      Object.assign(value, JSON.parse(legacy.stdout))
      value.evidence.version = 3
      writeLegacyPayload(f.payload, JSON.stringify(value))
      const original = fs.readFileSync(f.payload)
      expect(run(["show", f.payload], f.env).status).toBe(0)
      expect(fs.readFileSync(f.payload)).toEqual(original)
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
      expect(puts(f.state)).toBe(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it.each(["missing", "anchor"])("requires proper initial review anchors after a %s readback fault", fault => {
    const f = freshReview("review-initial-inline-")
    const env = { PATH: `${f.bin}:/usr/bin:/bin`, GH_STATE: f.state }
    const source = path.join(f.directory, "result.json")
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult()))
      expect(renderReview(source, f.payload, env).status).toBe(0)
      expect(run(["stamp", f.payload], env).status).toBe(0)
      expect(approve(f.payload, f.approval, env).status).toBe(0)
      const first = run(["post", f.payload, f.approval], { ...env, GH_INITIAL_INLINE_FAULT: fault })
      expect(first.status).toBe(1)
      expect(first.stderr).toContain("inline anchors are unconfirmed")
      expect(run(["post", f.payload, f.approval], env).status).toBe(1)
      expect(runComplete(env, f.payload, f.approval).stderr).toContain("Inline publication is incomplete")
      expect(postsOf(f.state)).toBe(1)
      expect(inlineWrites(f.state)).toEqual([])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  const line44Patch = [
    "@@ -40,7 +40,7 @@",
    " context",
    " context",
    " context",
    " context",
    "-old",
    "+new",
    " context",
    " context",
  ].join("\n")

  function writePullFiles(state: string, files: Array<Record<string, unknown>>) {
    fs.writeFileSync(path.join(state, "files.json"), JSON.stringify(files))
  }

  it("refuses a summary-only update when a located finding is in the pull diff", () => {
    const f = fixture()
    try {
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.diff = [{ path: "src/shared.ts", line: 53, side: "RIGHT" }]
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      const rendered = JSON.parse(fs.readFileSync(f.payload, "utf8"))
      expect(rendered.comments).toEqual([])
      expect(rendered.body).toContain("Location: scripts/review-publish.py:44 RIGHT")
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      writePullFiles(f.state, [{ filename: "scripts/review-publish.py", patch: line44Patch }])
      const refused = run(["post", f.payload, f.approval], f.env)
      expect(refused.status, refused.stderr).not.toBe(0)
      expect(refused.stderr).toContain("scripts/review-publish.py:44 RIGHT")
      expect(refused.stderr).toContain("No review was updated.")
      expect(puts(f.state)).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
      expect(postsOf(f.state)).toBe(0)
      const journalDir = path.join(f.directory, ".review-publish")
      const journals = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter(name => name.endsWith(".json")) : []
      expect(journals).toEqual([])

      result.diff = [{ path: "scripts/review-publish.py", line: 44, side: "RIGHT" }]
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(f.payload, "utf8")).comments).toHaveLength(1)
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(inlineWrites(f.state)).toEqual([expect.objectContaining({
        method: "POST",
        request: expect.objectContaining({
          body: "",
          comments: [expect.objectContaining({ path: "scripts/review-publish.py", line: 44, side: "RIGHT" })],
        }),
      })])
      const rows = JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))
      expect(rows.filter((row: { review: { body: string } }) => row.review.body.includes("<!-- cursor-review:"))).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("keeps a located finding in the summary when its line is outside the pull diff", () => {
    const f = fixture()
    try {
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.diff = []
      result.findings[0].path = "scripts/isolated-check.sh"
      result.findings[0].line = 4
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      const rendered = JSON.parse(fs.readFileSync(f.payload, "utf8"))
      expect(rendered.comments).toEqual([])
      expect(rendered.body).toContain("Location: scripts/isolated-check.sh:4 RIGHT")
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      writePullFiles(f.state, [
        { filename: "scripts/review-publish.py", patch: line44Patch },
        { filename: "src/generated.bin" },
      ])
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(inlineWrites(f.state)).toEqual([])
      expect(postsOf(f.state)).toBe(0)
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("refuses a summary-only update when the pull diff cannot be read", () => {
    const f = fixture()
    try {
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.diff = [{ path: "src/shared.ts", line: 53, side: "RIGHT" }]
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      const refused = run(["post", f.payload, f.approval], { ...f.env, GH_FILES_FAIL: "1" })
      expect(refused.status, refused.stderr).not.toBe(0)
      expect(refused.stderr).toContain("The pull request diff could not be read. No review was updated.")
      expect(puts(f.state)).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
      expect(postsOf(f.state)).toBe(0)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("refuses a left-side finding on a renamed file when it was left in the summary", () => {
    const f = fixture()
    try {
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.diff = []
      result.findings[0].path = "scripts/review-publish.py"
      result.findings[0].line = 12
      result.findings[0].side = "LEFT"
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(f.payload, "utf8")).comments).toEqual([])
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      writePullFiles(f.state, [{
        filename: "scripts/publisher.py",
        previous_filename: "scripts/review-publish.py",
        patch: "@@ -12,1 +12,1 @@\n-old\n+new\n",
      }])
      const refused = run(["post", f.payload, f.approval], f.env)
      expect(refused.status, refused.stderr).not.toBe(0)
      expect(refused.stderr).toContain("scripts/review-publish.py:12 LEFT")
      expect(puts(f.state)).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("updates the original post with the current verdict and head, preserving its URL and old inline anchors", () => {
    const f = fixture()
    try {
      const payload = JSON.parse(fs.readFileSync(f.payload, "utf8"))
      expect(payload.comments).toHaveLength(1)
      expect(payload.comments[0]).toMatchObject({ path: "scripts/review-publish.py", line: 44, side: "RIGHT", finding: "publish-lock" })
      expect(payload.comments[0].body).toContain("<!-- cursor-finding:publish-lock -->")
      expect(payload.body).toContain("1 actionable finding.")
      expect(payload.body).not.toContain("Replacement approval is sent to the locked pull request")
      expect(payload.body).toContain(`at ${head}`)
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(posted.stdout).toContain(f.original.html_url)
      expect(posted.stdout).toContain("#discussion_r20")
      const rows = JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))
      expect(rows.filter((row: { review: { body: string } }) => row.review.body.includes("<!-- cursor-review:"))).toHaveLength(1)
      expect(rows.filter((row: { review: { body: string } }) => row.review.body === "")).toHaveLength(1)
      expect(rows[0].review).toEqual({ ...f.original, body: payload.body })
      expect(postsOf(f.state)).toBe(1)
      expect(puts(f.state)).toBe(1)
      expect(fs.readFileSync(path.join(f.state, "inline-writes"), "utf8").trim().split("\n")).toHaveLength(1)
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(postsOf(f.state)).toBe(1)
      expect(fs.readFileSync(path.join(f.state, "inline-writes"), "utf8").trim().split("\n")).toHaveLength(1)
      const later = `A later verdict.\n<!-- cursor-review:${"e".repeat(64)} -->\n`
      rows[0].review.body = later
      fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify(rows))
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))[0].review.body).toBe(later)
      expect(puts(f.state)).toBe(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("refuses a changed body, changed author, missing target or wrong state without creating another post", () => {
    for (const change of ["body", "author", "missing", "state", "unstamped"]) {
      const f = fixture()
      try {
        const review = { ...f.original }
        if (change === "body") review.body += "Concurrent edit"
        if (change === "author") review.user = { id: 78, login: "other-reviewer[bot]" }
        if (change === "state") review.state = "APPROVED"
        if (change === "unstamped") review.body = "Unrelated review"
        fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify(change === "missing" ? [] : [{ request: {}, review }]))
        expect(run(["post", f.payload, f.approval], f.env).status).not.toBe(0)
        expect(postsOf(f.state)).toBe(0)
        expect(puts(f.state)).toBe(0)
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
    }
  })

  it("pins the update target in the approved bytes and rechecks the remote body immediately before sending", () => {
    for (const mode of ["target", "head", "denial", "concurrent"]) {
      const f = fixture()
      try {
        if (mode === "target") {
          const payload = JSON.parse(fs.readFileSync(f.payload, "utf8"))
          payload.update.review = 8
          payload.result.update.review = 8
          fs.writeFileSync(f.payload, JSON.stringify(payload))
        }
        if (mode === "head") fs.writeFileSync(path.join(f.state, "head"), otherHead)
        if (mode === "denial") expect(run(["deny", f.approval], f.env).status).toBe(0)
        const result = run(["post", f.payload, f.approval], { ...f.env, ...(mode === "concurrent" ? { GH_UPDATE_CHANGED: "1" } : {}) })
        expect(result.status).not.toBe(0)
        expect(postsOf(f.state)).toBe(0)
        expect(puts(f.state)).toBe(0)
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
    }
  })

  it("recovers a delivered update whose response was lost without sending it again", () => {
    const f = fixture()
    try {
      const lost = run(["post", f.payload, f.approval], { ...f.env, GH_UPDATE_FAIL: "1", GH_UPDATE_COMMIT: "1" })
      expect(lost.status, lost.stderr).toBe(0)
      expect(run(["post", f.payload, f.approval], f.env).status).toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(postsOf(f.state)).toBe(1)
      const rows = JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))
      expect(rows.filter((row: { review: { body: string } }) => row.review.body.includes("<!-- cursor-review:"))).toHaveLength(1)
      expect(rows.filter((row: { review: { body: string } }) => row.review.body === "")).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("keeps an ambiguous update unsettled and retries only a proven rejection", () => {
    for (const reject of [false, true]) {
      const f = fixture()
      try {
        const failed = run(["post", f.payload, f.approval], {
          ...f.env, ...(reject ? { GH_UPDATE_REJECT: "1" } : { GH_UPDATE_FAIL: "1" }),
        })
        expect(failed.status).not.toBe(0)
        expect(JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))[0].review.body).toBe(f.original.body)
        const retried = run(["post", f.payload, f.approval], f.env)
        expect(retried.status).toBe(reject ? 0 : 1)
        expect(puts(f.state)).toBe(reject ? 2 : 1)
        expect(postsOf(f.state)).toBe(reject ? 1 : 0)
        if (reject) {
          const rows = JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))
          expect(rows.filter((row: { review: { body: string } }) => row.review.body.includes("<!-- cursor-review:"))).toHaveLength(1)
          expect(rows.filter((row: { review: { body: string } }) => row.review.body === "")).toHaveLength(1)
        }
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
    }
  })

  it("requires the correct receipt and actual body readback before confirming an update", () => {
    for (const fault of ["GH_UPDATE_WRONG_ID", "GH_UPDATE_NO_APPLY"]) {
      const f = fixture()
      try {
        expect(run(["post", f.payload, f.approval], { ...f.env, [fault]: "1" }).status).not.toBe(0)
        expect(postsOf(f.state)).toBe(0)
        expect(puts(f.state)).toBe(1)
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
    }
  })

  it("rejects malformed update targets before rendering a publishable preview", () => {
    const f = fixture()
    try {
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      for (const update of [{ ...result.update, review: true }, { ...result.update, author: 0 }, { ...result.update, bodySha256: "bad" }]) {
        fs.writeFileSync(f.source, JSON.stringify({ ...result, update }))
        expect(renderReview(f.source, f.payload, f.env).status).toBe(2)
      }
      expect(puts(f.state)).toBe(0)
      expect(postsOf(f.state)).toBe(0)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("resolves approved earlier threads only after updating the same summary and preserves completion recovery", () => {
    const f = fixture()
    try {
      const target = JSON.parse(fs.readFileSync(f.payload, "utf8")).update
      const d = resolutionDraft(f)
      fs.writeFileSync(d.source, JSON.stringify({ ...d.result, update: target }))
      expect(renderReview(d.source, f.payload, d.env).status).toBe(0)
      expect(run(["stamp", f.payload], d.env).status).toBe(0)
      expect(approve(f.payload, f.approval, d.env).status).toBe(0)
      const posted = run(["post", f.payload, f.approval], d.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(posted.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(puts(f.state)).toBe(1)
      expect(postsOf(f.state)).toBe(0)
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))).toHaveLength(1)
      const finished = runComplete(d.env, f.payload, f.approval)
      expect(finished.status, finished.stderr).toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(fs.readFileSync(path.join(f.state, "resolves"), "utf8").trim().split("\n")).toEqual(["PRRT_fixture0"])
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("leaves an unchanged current-head finding in place", () => {
    const f = fixture()
    try {
      withExistingInline(f)
      const rendered = JSON.parse(fs.readFileSync(f.payload, "utf8"))
      const body = rendered.comments[0].body as string
      const comments = JSON.parse(fs.readFileSync(path.join(f.state, "comments.json"), "utf8"))
      comments[0].body = body
      fs.writeFileSync(path.join(f.state, "comments.json"), JSON.stringify(comments))
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.findings[0].comment.bodySha256 = createHash("sha256").update(body).digest("hex")
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
      expect(postsOf(f.state)).toBe(0)
      expect(puts(f.state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "comments.json"), "utf8"))).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("resolves a fixed inline finding and keeps its comment without a new review", () => {
    const f = fixture()
    try {
      const { comment } = withExistingInline(f)
      const inventory = run(["threads", "oakimov", "cursor-opencode-provider", "156"], f.env)
      expect(inventory.status, inventory.stderr).toBe(0)
      const thread = JSON.parse(inventory.stdout).threads[0]
      const result = JSON.parse(fs.readFileSync(f.source, "utf8"))
      result.outcome = "clean"
      result.findings = []
      result.diff = []
      result.prior = [{
        id: "publish-lock",
        status: "fixed",
        source: comment.html_url,
        note: "The locked lookup now rejects a replaced approval.",
      }]
      result.mutations = [{
        action: "resolve",
        thread: thread.id,
        finding: "publish-lock",
        snapshot: thread.snapshot,
        body: "Resolved because the current head rejects the replacement.",
        evidence: "test/review-publish.test.ts",
      }]
      fs.writeFileSync(f.source, JSON.stringify(result))
      expect(renderReview(f.source, f.payload, f.env).status).toBe(0)
      const rendered = JSON.parse(fs.readFileSync(f.payload, "utf8"))
      expect(rendered.comments).toEqual([])
      expect(rendered.body).not.toContain("Replacement approval is sent to the locked pull request")
      expect(run(["stamp", f.payload], f.env).status).toBe(0)
      expect(approve(f.payload, f.approval, f.env).status).toBe(0)
      const posted = run(["post", f.payload, f.approval], f.env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(posted.stdout).toContain(`THREAD_RESOLVED=${thread.id}`)
      expect(puts(f.state)).toBe(1)
      expect(postsOf(f.state)).toBe(0)
      expect(inlineWrites(f.state)).toEqual([])
      const comments = JSON.parse(fs.readFileSync(path.join(f.state, "comments.json"), "utf8"))
      expect(comments).toEqual([comment])
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("refuses a second review whose body carries summary text", () => {
    const f = freshReview("review-one-summary-")
    const env = { PATH: `${f.bin}:/usr/bin:/bin`, GH_STATE: f.state }
    const source = path.join(f.directory, "result.json")
    const secondPayload = path.join(f.directory, "second.json")
    const secondApproval = path.join(f.directory, "second-approval.json")
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], diff: [] })))
      expect(renderReview(source, f.payload, env).status).toBe(0)
      expect(run(["stamp", f.payload], env).status).toBe(0)
      expect(approve(f.payload, f.approval, env).status).toBe(0)
      expect(run(["post", f.payload, f.approval], env).status).toBe(0)
      expect(postsOf(f.state)).toBe(1)
      const changed = structuredResult({ outcome: "clean", findings: [], diff: [] })
      changed.checks[0]!.detail = "Read the changed files again."
      fs.writeFileSync(source, JSON.stringify(changed))
      expect(renderReview(source, secondPayload, env).status).toBe(0)
      expect(run(["stamp", secondPayload], env).status).toBe(0)
      expect(approve(secondPayload, secondApproval, env).status).toBe(0)
      const refused = run(["post", secondPayload, secondApproval], env)
      expect(refused.status, refused.stderr).not.toBe(0)
      expect(refused.stderr).toContain("Refusing to create another review with summary text")
      expect(postsOf(f.state)).toBe(1)
      expect(JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))).toHaveLength(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("publishes beside another reviewer's summary as the App even though GET /user is forbidden", () => {
    const f = freshReview("review-other-author-")
    const env = { PATH: `${f.bin}:/usr/bin:/bin`, GH_STATE: f.state }
    const source = path.join(f.directory, "result.json")
    const other = {
      id: 4, state: "COMMENTED", user: { id: 78, login: "other-reviewer" },
      body: `Other reviewer.\n<!-- cursor-review:${"a".repeat(64)} -->\n`,
      html_url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-4",
    }
    fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify([{ request: {}, review: other }]))
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], diff: [] })))
      expect(renderReview(source, f.payload, env).status).toBe(0)
      expect(run(["stamp", f.payload], env).status).toBe(0)
      expect(approve(f.payload, f.approval, env).status).toBe(0)
      const unread = run(["post", f.payload, f.approval], { ...env, GH_APP_FAIL: "1" })
      expect(unread.status, unread.stderr).not.toBe(0)
      expect(unread.stderr).toContain("The publishing identity could not be read")
      expect(postsOf(f.state)).toBe(0)
      fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify([{ request: {}, review: { ...other, user: { id: 78 } } }]))
      const hidden = run(["post", f.payload, f.approval], env)
      expect(hidden.status, hidden.stderr).not.toBe(0)
      expect(hidden.stderr).toContain("Refusing to create another review with summary text")
      expect(postsOf(f.state)).toBe(0)
      expect(callsOf(f.state)).toContain("GET app")
      expect(callsOf(f.state)).not.toContain("GET user")
      fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify([{ request: {}, review: other }]))
      const posted = run(["post", f.payload, f.approval], env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(callsOf(f.state)).toContain("GET app")
      expect(callsOf(f.state)).not.toContain("GET user")
      expect(postsOf(f.state)).toBe(1)
      const rows = JSON.parse(fs.readFileSync(path.join(f.state, "reviews.json"), "utf8"))
      expect(rows.map((row: { review: { user: { login: string } } }) => row.review.user.login).sort()).toEqual(["other-reviewer", "review-publisher[bot]"])
      const secondPayload = path.join(f.directory, "second.json")
      const secondApproval = path.join(f.directory, "second-approval.json")
      const changed = structuredResult({ outcome: "clean", findings: [], diff: [] })
      changed.checks[0]!.detail = "Read the changed files again."
      fs.writeFileSync(source, JSON.stringify(changed))
      expect(renderReview(source, secondPayload, env).status).toBe(0)
      expect(run(["stamp", secondPayload], env).status).toBe(0)
      expect(approve(secondPayload, secondApproval, env).status).toBe(0)
      const refused = run(["post", secondPayload, secondApproval], env)
      expect(refused.status, refused.stderr).not.toBe(0)
      expect(refused.stderr).toContain("Refusing to create another review with summary text")
      expect(postsOf(f.state)).toBe(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })

  it("reads a personal access token's user and still refuses that user's second summary", () => {
    const f = freshReview("review-pat-author-")
    const env = { PATH: `${f.bin}:/usr/bin:/bin`, GH_STATE: f.state, REVIEW_APP_UNCONFIGURED: "1", REVIEW_PUBLISH_TOKEN: "ghp_authorpatvalue1234567890" }
    const source = path.join(f.directory, "result.json")
    const other = {
      id: 4, state: "COMMENTED", user: { id: 78, login: "other-reviewer" },
      body: `Other reviewer.\n<!-- cursor-review:${"a".repeat(64)} -->\n`,
      html_url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#pullrequestreview-4",
    }
    fs.writeFileSync(path.join(f.state, "reviews.json"), JSON.stringify([{ request: {}, review: other }]))
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [], diff: [] })))
      expect(renderReview(source, f.payload, env).status).toBe(0)
      expect(run(["stamp", f.payload], env).status).toBe(0)
      expect(approve(f.payload, f.approval, env).status).toBe(0)
      const args = ["post", f.payload, f.approval, "--token-env", "REVIEW_PUBLISH_TOKEN"]
      const unread = run(args, { ...env, GH_USER_FAIL: "1" })
      expect(unread.status, unread.stderr).not.toBe(0)
      expect(unread.stderr).toContain("The publishing identity could not be read")
      expect(postsOf(f.state)).toBe(0)
      const posted = run(args, env)
      expect(posted.status, posted.stderr).toBe(0)
      expect(callsOf(f.state)).toContain("GET user")
      expect(callsOf(f.state)).not.toContain("GET app")
      expect(postsOf(f.state)).toBe(1)
      const secondPayload = path.join(f.directory, "second.json")
      const secondApproval = path.join(f.directory, "second-approval.json")
      const changed = structuredResult({ outcome: "clean", findings: [], diff: [] })
      changed.checks[0]!.detail = "Read the changed files again."
      fs.writeFileSync(source, JSON.stringify(changed))
      expect(renderReview(source, secondPayload, env).status).toBe(0)
      expect(run(["stamp", secondPayload], env).status).toBe(0)
      expect(approve(secondPayload, secondApproval, env).status).toBe(0)
      const refused = run(["post", secondPayload, secondApproval, "--token-env", "REVIEW_PUBLISH_TOKEN"], env)
      expect(refused.status, refused.stderr).not.toBe(0)
      expect(refused.stderr).toContain("Refusing to create another review with summary text")
      expect(postsOf(f.state)).toBe(1)
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }) }
  })
})

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
  const rendered = renderReview(source, payload, env)
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
      const rendered = renderReview(source, payload, env)
      expect(rendered.status).toBe(0)
      const draftStore = rendered.stderr.match(/REVIEW_RETAINED=(.+)/)![1]!
      fs.writeFileSync(source, JSON.stringify(structuredResult()))
      expect(renderReview(source, payload, env).status).toBe(0)
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
      writeLegacyPayload(payload, draft([]))
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
      expect(renderReview(source, payload, env).status).toBe(0)
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
  })

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
        expect(renderReview(source, payload, env).status).toBe(2)
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
      expect(renderReview(source, payload, env).status).toBe(0)
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
  })

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
  })

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
  })

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
  })

  it("records an integration-forbidden rejection as proven and retries it after the grant is corrected", () => {
    const fixture = freshReview("review-resolve-integration-")
    const { directory, payload, approval, state } = fixture
    try {
      const { env } = resolutionDraft(fixture, ["fixed", "refuted"])
      expect(approve(payload, approval, env).status).toBe(0)
      const denied = run(["post", payload, approval], { ...env, GH_RESOLVE_INTEGRATION_THREAD: "PRRT_fixture0" })
      expect(denied.status).not.toBe(0)
      expect(denied.stderr).toContain("Resource not accessible by integration")
      expect(denied.stdout).toContain("REVIEW_URL=")
      expect(denied.stdout).not.toContain("THREAD_RESOLVED=")
      expect(checkpointText(directory)).toContain('"state": "posted"')
      expect(checkpointText(directory)).toContain('"state": "rejected"')
      expect(checkpointText(directory)).not.toContain('"state": "sending"')
      const retried = run(["post", payload, approval], env)
      expect(retried.status, retried.stderr).toBe(0)
      expect(retried.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(retried.stdout).toContain("THREAD_RESOLVED=PRRT_fixture1")
      expect(postsOf(state)).toBe(1)
      expect(resolutionsOf(state)).toEqual(["PRRT_fixture0", "PRRT_fixture0", "PRRT_fixture1"])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("a retry after posting skips classification of the review's own open comment threads but not replies on them", () => {
    const fixture = freshReview("review-own-threads-")
    const { directory, payload, approval, state, bin } = fixture
    try {
      const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
      const earlier = {
        id: "PRRT_earlier",
        isResolved: false,
        pullRequest: { number: 156, repository: { nameWithOwner: "oakimov/cursor-opencode-provider" } },
        comments: [
          { id: "original", url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r900", body: "Earlier review finding", updatedAt: "2026-01-01T00:00:00Z" },
          { id: "reply", url: "https://github.com/oakimov/cursor-opencode-provider/pull/156#discussion_r901", body: "The author says this is addressed.", updatedAt: "2026-01-02T00:00:00Z" },
        ],
      }
      fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify([earlier]))
      const inventory = run(["threads", "oakimov", "cursor-opencode-provider", "156"], env)
      expect(inventory.status, inventory.stderr).toBe(0)
      const snapshot = (JSON.parse(inventory.stdout) as { threads: Array<{ snapshot: string }> }).threads[0]!.snapshot
      const source = path.join(directory, "result.json")
      fs.writeFileSync(source, JSON.stringify(structuredResult({
        prior: [{ id: "earlier-0", status: "fixed", source: earlier.comments[0]!.url, note: "Verified the current branch against its regression test." }],
        mutations: [{ action: "resolve", thread: "PRRT_earlier", finding: "earlier-0", snapshot, body: "The earlier finding is addressed at the reviewed head.", evidence: "scripts/review-publish.py:1; test/review-publish.test.ts:1" }],
      })))
      expect(renderReview(source, payload, env).status).toBe(0)
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      // The review posts with one inline finding; its first resolution is rejected.
      const denied = run(["post", payload, approval], { ...env, GH_RESOLVE_INTEGRATION_THREAD: "PRRT_earlier" })
      expect(denied.status).not.toBe(0)
      expect(postsOf(state)).toBe(1)
      // GitHub now also lists the posted review's own comment as an open thread.
      const posted = JSON.parse(fs.readFileSync(path.join(state, "comments.json"), "utf8")) as Array<{ html_url: string }>
      expect(posted).toHaveLength(1)
      const own = {
        id: "PRRT_own",
        isResolved: false,
        pullRequest: { number: 156, repository: { nameWithOwner: "oakimov/cursor-opencode-provider" } },
        comments: posted.map((row) => ({ id: `own-${row.html_url}`, url: row.html_url, body: "Current review finding", updatedAt: "2026-01-03T00:00:00Z" })),
      }
      fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify([earlier, own]))
      const retried = run(["post", payload, approval], env)
      expect(retried.status, retried.stderr).toBe(0)
      expect(postsOf(state)).toBe(1)
      expect(retried.stdout).toContain("THREAD_RESOLVED=PRRT_earlier")
      expect(resolutionsOf(state)).toEqual(["PRRT_earlier", "PRRT_earlier"])
      // A reply on the review's own thread still demands a fresh review.
      const threads = JSON.parse(fs.readFileSync(path.join(state, "threads.json"), "utf8")) as Array<{ comments: Array<{ id: string; url: string; body: string; updatedAt: string }> }>
      threads[1]!.comments.push({ id: "author-reply", url: posted[0]!.html_url + "-reply", body: "The author responds to the finding.", updatedAt: "2026-01-04T00:00:00Z" })
      fs.writeFileSync(path.join(state, "threads.json"), JSON.stringify(threads))
      const refused = run(["post", payload, approval], env)
      expect(refused.status).not.toBe(0)
      expect(refused.stderr).toContain("not classified")
      expect(resolutionsOf(state)).toHaveLength(2)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("completes rejected resolutions idempotently through complete-resolutions.py", () => {
    const fixture = freshReview("review-complete-resolutions-")
    const { directory, payload, approval, state } = fixture
    try {
      const { env } = resolutionDraft(fixture, ["fixed", "refuted"])
      expect(approve(payload, approval, env).status).toBe(0)
      const denied = run(["post", payload, approval], { ...env, GH_RESOLVE_FORBIDDEN_THREAD: "PRRT_fixture1" })
      expect(denied.status).not.toBe(0)
      expect(denied.stdout).toContain("REVIEW_URL=")
      expect(denied.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(denied.stdout).not.toContain("THREAD_RESOLVED=PRRT_fixture1")
      const finished = runComplete(env, payload, approval)
      expect(finished.status, finished.stderr).toBe(0)
      expect(finished.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(finished.stdout).toContain("THREAD_RESOLVED=PRRT_fixture1")
      expect(postsOf(state)).toBe(1)
      expect(resolutionsOf(state)).toEqual(["PRRT_fixture0", "PRRT_fixture1", "PRRT_fixture1"])
      const again = runComplete(env, payload, approval)
      expect(again.status, again.stderr).toBe(0)
      expect(again.stdout).toContain("THREAD_RESOLVED=PRRT_fixture0")
      expect(again.stdout).toContain("THREAD_RESOLVED=PRRT_fixture1")
      expect(resolutionsOf(state)).toHaveLength(3)
      expect(postsOf(state)).toBe(1)
      expect(fs.readFileSync(path.join(state, "saw-app-key"), "utf8")).toBe("0")
      const digest = createHash("sha256").update(fs.readFileSync(payload)).digest("hex")
      const retained = path.join(directory, "retained", `preview-${digest}`)
      const cleanup = run(["cleanup", retained], env)
      expect(cleanup.status, cleanup.stderr).toBe(0)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("complete-resolutions.py refuses a missing approval and a review without a confirmed receipt", () => {
    const fixture = freshReview("review-complete-refusals-")
    const { directory, payload, approval, state } = fixture
    try {
      const { env } = resolutionDraft(fixture, ["fixed"])
      const unapproved = runComplete(env, payload, approval)
      expect(unapproved.status).toBe(4)
      expect(unapproved.stderr).toContain("No approval file")
      expect(postsOf(state)).toBe(0)
      expect(resolutionsOf(state)).toEqual([])
      expect(approve(payload, approval, env).status).toBe(0)
      const unreceived = runComplete(env, payload, approval)
      expect(unreceived.status).toBe(1)
      expect(unreceived.stderr).toContain("No confirmed review receipt")
      expect(postsOf(state)).toBe(0)
      expect(resolutionsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("review evidence gate", () => {
  it("requires failed checks to be adjudicated beyond their baseline provenance", () => {
    const { directory, payload, bin, state } = freshReview("review-diagnostics-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    const ledgerPath = path.join(directory, "ledger.json")
    const clean = structuredResult({ outcome: "clean", findings: [] })
    const checks = [...clean.checks, { name: "model-contracts", status: "failed", exitCode: 1,
      detail: "Accepted metadata disappears before the changed catalog export.",
      failure: { cause: "baseline", evidence: "The same accepted input loses the tuple on base and head." },
    }]
    const diagnostic = { id: "lost-tuple", check: "model-contracts",
      observation: "A selectable upstream tuple is missing from the consumer catalog.",
      classification: "defect", basis: "The changed catalog path still reaches the lossy shared producer.", candidates: [] as string[],
    }
    const render = (result: unknown, ledger: unknown) => {
      fs.rmSync(payload, { force: true })
      fs.writeFileSync(source, JSON.stringify(result))
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
      return run(["render", source, payload], env)
    }
    const ledger = { ...evidenceLedger(clean), diagnostics: [diagnostic] }
    try {
      for (const [diagnostics, expected] of [
        [[], "diagnostics.checks"],
        [[{ ...diagnostic, classification: "baseline" }], ".classification"],
        [[diagnostic], ".findings"],
        [[{ ...diagnostic, classification: "unresolved" }], ".incomplete"],
        [[{ ...diagnostic, classification: "outside-scope", basis: "" }], ".basis"],
        [[{ ...diagnostic, classification: "environment", check: "diff" }], ".check"],
        [[{ ...diagnostic, classification: "outside-scope", candidates: [null] }], ".candidates"],
        [[{ ...diagnostic, classification: "environment" }, { ...diagnostic, classification: "environment" }], ".id"],
      ] as const) {
        const refused = render({ ...clean, checks }, { ...ledger, diagnostics })
        expect(refused.status, refused.stderr).toBe(2)
        expect(refused.stderr).toContain(expected)
        expect(fs.existsSync(payload)).toBe(false)
      }
      // Once in-scope, pre-existing provenance does not erase the finding.
      const found = structuredResult({ checks })
      const foundLedger = evidenceLedger(found)
      foundLedger.candidates[0]!.provenance = "preexisting"
      expect(render(found, { ...foundLedger, diagnostics: [{ ...diagnostic, candidates: [found.findings[0]!.id] }] }).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(payload, "utf8")).body).toContain("1 actionable finding.")

      // An unrelated baseline defect can remain outside this PR's behavior scope.
      const outside = { ...diagnostic, classification: "outside-scope",
        basis: "This retention-only change never consumes the model catalog; the separate catalog defect is outside its reachable behavior." }
      expect(render({ ...clean, checks }, { ...ledger, diagnostics: [outside] }).status).toBe(0)
      // Unknown causes remain explicitly incomplete, even with passing reruns.
      const incomplete = structuredResult({ outcome: "incomplete", findings: [], checks })
      expect(render(incomplete, { ...evidenceLedger(incomplete), diagnostics: [{ ...diagnostic,
        classification: "unresolved", basis: "The isolated case passes but the full suite failure has no established cause yet.",
      }] }).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(payload, "utf8")).body).toContain("incomplete")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keeps a defect on the reviewed head actionable when another revision fixes it", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-revision-scope-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    const ledgerPath = path.join(directory, "ledger.json")
    const result = structuredResult()
    const original = evidenceLedger(result)
    const candidate = { ...original.candidates[0]!, assessment: {
      head, status: "present", basis: "The reviewed head still sends the replacement.",
      elsewhere: [{ revision: otherHead, status: "fixed", basis: "The other revision pins the operation." }],
    } }
    const ledger = { ...original, candidates: [candidate] }
    const externalFixes = [{ finding: candidate.id, revision: otherHead,
      detail: "The separate commit pins the operation; the reviewed head still has the defect." }]
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [] })))
      // The former shape admitted a clean verdict after the agent relabelled
      // the reproduced problem operational because another tree repaired it.
      fs.writeFileSync(ledgerPath, JSON.stringify({ ...ledger, candidates: [{ ...candidate,
        disposition: "operational", violation: "", provenance: "not-applicable",
      }] }))
      const dismissed = run(["render", source, payload], env)
      expect(dismissed.status, dismissed.stderr).toBe(2)
      expect(dismissed.stderr).toContain("assessment.disposition")
      expect(fs.existsSync(payload)).toBe(false)

      fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
      const clean = run(["render", source, payload], env)
      expect(clean.status, clean.stderr).toBe(2)
      expect(clean.stderr).toContain("findings.candidates")
      fs.writeFileSync(source, JSON.stringify(result))
      const hiddenFix = run(["render", source, payload], env)
      expect(hiddenFix.status, hiddenFix.stderr).toBe(2)
      expect(hiddenFix.stderr).toContain("externalFixes.candidates")

      fs.writeFileSync(source, JSON.stringify(structuredResult({ externalFixes })))
      const rendered = run(["render", source, payload], env)
      expect(rendered.status, rendered.stderr).toBe(0)
      const value = JSON.parse(fs.readFileSync(payload, "utf8"))
      expect(value.evidence.version).toBe(4)
      expect(value.body).toContain("1 actionable finding.")
      expect(value.body).toContain("outside the reviewed head")
      expect(value.body).toContain(otherHead)
      expect(value.head).toBe(head)
      expect(value.comments).toHaveLength(1)
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      expect(run(["post", payload, approval], env).status).toBe(0)
      expect(postBodies(state)).toContain("1 actionable finding.")
      expect(postBodies(state)).toContain(otherHead)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("distinguishes a fixed reviewed head and a genuine operational limitation from a fix elsewhere", () => {
    const { directory, payload, bin, state } = freshReview("review-head-assessment-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    const ledgerPath = path.join(directory, "ledger.json")
    const original = evidenceLedger(structuredResult())
    const candidate = { ...original.candidates[0]!, disposition: "operational", violation: "",
      provenance: "not-applicable", assessment: { head, status: "not-a-defect",
        basis: "The environment lacks a required tool; source behavior satisfies its contract.", elsewhere: [] },
    }
    const render = (value: unknown) => {
      fs.writeFileSync(ledgerPath, JSON.stringify(value))
      return run(["render", source, payload], env)
    }
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [] })))
      const ledger = { ...original, candidates: [candidate] }
      expect(render(ledger).status).toBe(0)
      const fixedHead = { ...candidate, disposition: "refuted", assessment: {
        head, status: "absent", basis: "The repair is already in the reviewed head, verified at the source and regression.", elsewhere: [],
      } }
      expect(render({ ...ledger, candidates: [fixedHead] }).status).toBe(0)
      for (const [assessment, diagnostic] of [
        [{ ...candidate.assessment, head: otherHead }, "assessment.head"],
        [{ ...candidate.assessment, status: "present" }, "assessment.disposition"],
        [{ ...candidate.assessment, status: ["present"] }, "assessment.status"],
        [{ ...candidate.assessment, basis: "" }, "assessment.basis"],
        [{ ...candidate.assessment, elsewhere: [{ revision: otherHead, status: "fixed", basis: "Separate repair." }] }, "head-status"],
        [{ ...fixedHead.assessment, elsewhere: [{ revision: "main", status: "fixed", basis: "A moving branch is not evidence." }] }, ".revision"],
        [{ ...fixedHead.assessment, elsewhere: [{ revision: head, status: "fixed", basis: "The same revision is not elsewhere." }] }, ".revision"],
      ] as const) {
        const refused = render({ ...ledger, candidates: [{ ...candidate, assessment }] })
        expect(refused.status, refused.stderr).toBe(2)
        expect(refused.stderr).toContain(diagnostic)
      }
      const old = { ...original, version: 1,
        candidates: original.candidates.map(({ assessment: _assessment, ...item }) => item),
      }
      const legacy = render(old)
      expect(legacy.status, legacy.stderr).toBe(2)
      expect(legacy.stderr).toContain("ledger.version")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([1, 2, 3])("recovers retained version-%i evidence without allowing a fresh downgrade", (version) => {
    const { directory, payload, approval, bin, state } = freshReview("review-scope-legacy-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    const result = structuredResult()
    try {
      fs.writeFileSync(source, JSON.stringify(result))
      expect(renderReview(source, payload, env).status).toBe(0)
      const value = JSON.parse(fs.readFileSync(payload, "utf8"))
      const ledger = evidenceLedger(result)
      const { diagnostics: _diagnostics, ...previousLedger } = ledger
      const legacy = JSON.stringify({ ...(version === 3 ? ledger : previousLedger), version,
        candidates: version === 1 ? ledger.candidates.map(({ assessment: _assessment, ...item }) => item) : ledger.candidates,
      })
      value.evidence = { version, ledgerSha256: createHash("sha256").update(legacy).digest("hex") }
      value.comments = value.comments.map(({ finding: _finding, update: _update, ...comment }: Record<string, unknown>) => ({
        ...comment, body: String(comment.body).split("\n\n<!-- cursor-finding:")[0],
      }))
      fs.writeFileSync(path.join(directory, `ledger-${value.evidence.ledgerSha256}.json`), legacy)
      fs.writeFileSync(payload, JSON.stringify(value, null, 2) + "\n")
      const refused = run(["stamp", payload], env)
      expect(refused.status, refused.stderr).toBe(2)
      expect(refused.stderr).toContain("Unretained legacy evidence")
      writeLegacyPayload(payload, JSON.stringify(value))
      const original = fs.readFileSync(payload)
      expect(run(["show", payload], env).status).toBe(0)
      expect(fs.readFileSync(payload)).toEqual(original)
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      expect(run(["post", payload, approval], env).status).toBe(0)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("requires a matching completed ledger and an isolated command result before rendering", () => {
    const { directory, payload, bin, state } = freshReview("review-evidence-render-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    const ledgerPath = path.join(directory, "ledger.json")
    const result = structuredResult({ outcome: "clean", findings: [] })
    try {
      fs.writeFileSync(source, JSON.stringify(result))
      const missing = run(["render", source, payload], env)
      expect(missing.status, missing.stderr).toBe(2)
      expect(missing.stderr).toContain("ledger is missing")
      const ledger = evidenceLedger(result)
      for (const [change, diagnostic] of [
        [{ revision: otherHead }, "revision.head"],
        [{ passes: { ...ledger.passes, omissionsAnalyzed: false } }, "passes"],
        [{ candidates: evidenceLedger(structuredResult()).candidates }, "findings.candidates"],
      ] as const) {
        fs.writeFileSync(ledgerPath, JSON.stringify({ ...ledger, ...change }))
        const refused = run(["render", source, payload], env)
        expect(refused.status, refused.stderr).toBe(2)
        expect(refused.stderr).toContain(diagnostic)
        expect(fs.existsSync(payload)).toBe(false)
      }
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger))
      fs.writeFileSync(source, JSON.stringify({ ...result, checks: result.checks.filter(check => check.name !== "isolated-check") }))
      const noCommand = run(["render", source, payload], env)
      expect(noCommand.status, noCommand.stderr).toBe(2)
      expect(noCommand.stderr).toContain("checks.isolated-check.exitCode")
      fs.writeFileSync(source, JSON.stringify(result))
      expect(run(["render", source, payload], env).status).toBe(0)
      const value = JSON.parse(fs.readFileSync(payload, "utf8"))
      expect(value.evidence.ledgerSha256).toBe(createHash("sha256").update(fs.readFileSync(ledgerPath)).digest("hex"))
      expect(value).not.toHaveProperty("ledger")
      expect(value.body).not.toContain("Fixture omission")
      expect(callsOf(state)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects fresh hand-built payloads and rechecks bound evidence before preview, approval and post", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-evidence-stages-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    try {
      // This is deliberately not the retained-legacy fixture helper.
      fs.writeFileSync(payload, draft([]))
      const bypass = run(["stamp", payload], env)
      expect(bypass.status, bypass.stderr).toBe(2)
      expect(bypass.stderr).toContain("evidence binding")
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [] })))
      expect(renderReview(source, payload, env).status).toBe(0)
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      const value = JSON.parse(fs.readFileSync(payload, "utf8"))
      const bound = path.join(directory, `ledger-${value.evidence.ledgerSha256}.json`)
      const original = fs.readFileSync(bound)
      const originalPayload = fs.readFileSync(payload)
      fs.rmSync(bound)
      expect(run(["show", payload], env).status).toBe(2)
      expect(run(["approve", payload, approval, previewDigest(shown.stderr)], env).status).toBe(2)
      expect(fs.existsSync(approval)).toBe(false)
      fs.writeFileSync(bound, original)
      expect(run(["approve", payload, approval, previewDigest(shown.stderr)], env).status).toBe(0)
      fs.writeFileSync(bound, Buffer.concat([original, Buffer.from("\n")]))
      const changed = run(["post", payload, approval], env)
      expect(changed.status, changed.stderr).toBe(2)
      expect(changed.stderr).toContain("ledger changed")
      expect(callsOf(state)).toEqual([])
      // A new, internally consistent binding still needs a new preview/approval.
      const replacement = Buffer.concat([original, Buffer.from("\n")])
      value.evidence.ledgerSha256 = createHash("sha256").update(replacement).digest("hex")
      fs.writeFileSync(path.join(directory, `ledger-${value.evidence.ledgerSha256}.json`), replacement)
      fs.writeFileSync(payload, JSON.stringify(value, null, 2) + "\n")
      expect(run(["post", payload, approval], env).status).not.toBe(0)
      expect(callsOf(state)).toEqual([])
      fs.writeFileSync(payload, originalPayload)
      fs.writeFileSync(bound, original)
      expect(run(["post", payload, approval], env).status).toBe(0)
      expect(postsOf(state)).toBe(1)
      expect(postBodies(state)).not.toContain("Fixture omission")
      expect(postBodies(state)).not.toContain("ledgerSha256")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses evidence removed during a held lookup without sending a review", async () => {
    const { directory, payload, approval, bin, state } = freshReview("review-evidence-race-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state, GH_HOLD_GET: "1" }
    const source = path.join(directory, "result.json")
    let child: ChildProcess | undefined
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [] })))
      expect(renderReview(source, payload, env).status).toBe(0)
      expect(run(["stamp", payload], env).status).toBe(0)
      expect(approve(payload, approval, env).status).toBe(0)
      const value = JSON.parse(fs.readFileSync(payload, "utf8"))
      child = spawnPost(payload, approval, env)
      const done = collect(child)
      waitFor("reviews lookup", () => callsOf(state).some(line => line.endsWith("/reviews")))
      fs.rmSync(path.join(directory, `ledger-${value.evidence.ledgerSha256}.json`))
      fs.writeFileSync(path.join(state, "release"), "go\n")
      const refused = await done
      expect(refused.status, refused.stderr).toBe(2)
      expect(refused.stderr).toContain("ledger is missing")
      expect(postsOf(state)).toBe(0)
    } finally {
      stopProcess(child)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("recovers retained evidence after the working copy is lost", () => {
    const { directory, bin, state } = freshReview("review-evidence-recovery-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const working = path.join(directory, "working")
    fs.mkdirSync(working)
    const source = path.join(working, "result.json")
    const payload = path.join(working, "payload.json")
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [] })))
      expect(renderReview(source, payload, env).status).toBe(0)
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      const retained = shown.stderr.match(/REVIEW_RETAINED=(.+)/)![1]!
      const saved = path.join(retained, "payload.json")
      const value = JSON.parse(fs.readFileSync(saved, "utf8"))
      expect(fs.existsSync(path.join(retained, `ledger-${value.evidence.ledgerSha256}.json`))).toBe(true)
      fs.rmSync(working, { recursive: true })
      const recovered = run(["show", saved], env)
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(recovered.stdout).toBe(shown.stdout)
      const approval = path.join(retained, "approval.json")
      expect(run(["approve", saved, approval, previewDigest(shown.stderr)], env).status).toBe(0)
      expect(run(["post", saved, approval], env).status).toBe(0)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keeps an existing retained structured preview without command exits byte-identical", () => {
    const { directory, payload, approval, bin, state } = freshReview("review-evidence-legacy-")
    const env = { PATH: `${bin}:/usr/bin:/bin`, GH_STATE: state }
    const source = path.join(directory, "result.json")
    try {
      fs.writeFileSync(source, JSON.stringify(structuredResult({ outcome: "clean", findings: [] })))
      expect(renderReview(source, payload, env).status).toBe(0)
      const old = JSON.parse(fs.readFileSync(payload, "utf8"))
      delete old.evidence
      delete old.result.checks.find((check: { name: string }) => check.name === "isolated-check").exitCode
      old.body = old.body.replace("isolated-check: passed (exit 0).", "isolated-check: passed.")
      writeLegacyPayload(payload, JSON.stringify(old))
      const bytes = fs.readFileSync(payload)
      expect(run(["stamp", payload], env).status).toBe(0)
      const shown = run(["show", payload], env)
      expect(shown.status, shown.stderr).toBe(0)
      expect(Buffer.from(shown.stdout)).toEqual(bytes)
      expect(run(["approve", payload, approval, previewDigest(shown.stderr)], env).status).toBe(0)
      expect(run(["post", payload, approval], env).status).toBe(0)
      expect(fs.readFileSync(payload)).toEqual(bytes)
      expect(postsOf(state)).toBe(1)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
