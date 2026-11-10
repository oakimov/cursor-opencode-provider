import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONWARNINGS: "error" }
const roots: string[] = []

function outDir(): string {
  const dir = path.join(os.tmpdir(), `review-eval-${process.pid}-${Math.random().toString(16).slice(2)}`)
  roots.push(dir)
  return dir
}

function python(args: string[], cwd = ROOT) {
  return spawnSync("python3", args, { cwd, env, encoding: "utf8" })
}

function prepare(args: string[]) {
  const out = outDir()
  const result = python(["scripts/review-eval.py", ...args, "--out", out])
  return { out, result, mount: path.join(out, "mount"), checkout: path.join(out, "mount", "checkout") }
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value))
}

function fixtureGit(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=1+fixture@users.noreply.github.com", ...args,
  ], { cwd, env: { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function prepareRevision(repository: string, revision: string, base: string, out: string) {
  return python(["-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("review_eval", "scripts/review-eval.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.prepare_revision("revised", pathlib.Path(sys.argv[4]), pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3])
`, repository, revision, base, out])
}

function removeOuts() {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

describe("review fixtures", () => {
  test("a failed refresh of an existing record makes the next default run skip it", () => {
    const { checkout } = prepare(["prepare", "--case", "index-sync", "--variant", "buggy", "--skill", "revised"])
    try {
      const record = path.join(checkout, "record.json")
      const fail = path.join(checkout, "fail.json")
      const ok = path.join(checkout, "ok.json")
      writeJson(record, { entries: { pkg: "1" }, due: [] })
      writeJson(fail, { pkg: { error: "down" } })
      writeJson(ok, { pkg: { value: "2" } })
      const first = python(["sync_index.py", record, "--endpoint", fail, "--refresh", "pkg"], checkout)
      expect(first.status).toBe(1)
      expect(JSON.parse(fs.readFileSync(record, "utf8")).entries.pkg).toBe("1")
      const second = python(["sync_index.py", record, "--endpoint", ok], checkout)
      expect(second.status).toBe(0)
      expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual({ entries: { pkg: "1" }, due: [] })
      const query = python(["query_index.py", record, "pkg"], checkout)
      expect(query.status).toBe(0)
      expect(query.stdout.trim()).toBe("1")
      expect(python(["tests/test_merge.py"], checkout).status).toBe(0)
      expect(fs.readFileSync(path.join(checkout, "sync_index.py"), "utf8")).not.toContain("due.append")
    } finally {
      removeOuts()
    }
  })

  test("the fixed refresh stays due and the next default run fetches it", () => {
    const { checkout } = prepare(["prepare", "--case", "index-sync", "--variant", "fixed", "--skill", "baseline"])
    try {
      const record = path.join(checkout, "record.json")
      writeJson(record, { entries: { pkg: "1" }, due: [] })
      writeJson(path.join(checkout, "fail.json"), { pkg: { error: "down" } })
      writeJson(path.join(checkout, "ok.json"), { pkg: { value: "2" } })
      expect(python(["sync_index.py", record, "--endpoint", "fail.json", "--refresh", "pkg"], checkout).status).toBe(1)
      expect(JSON.parse(fs.readFileSync(record, "utf8")).due).toEqual(["pkg"])
      expect(python(["sync_index.py", record, "--endpoint", "ok.json"], checkout).status).toBe(0)
      expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual({ entries: { pkg: "2" }, due: [] })
    } finally {
      removeOuts()
    }
  })

  test("cancel still lets the worker record success, and the fixed supervisor does not", () => {
    const protocol = `
import os, signal, subprocess, sys
fifo, checkout, label = sys.argv[1:]
os.mkfifo(fifo)
proc = subprocess.Popen(
    [sys.executable, "supervise.py", "--worker", "worker.py", "--done", "done", "--receipt", "receipt", "--cancel", fifo],
    cwd=checkout,
)
def stop(signum, frame):
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    raise SystemExit(1)
signal.signal(signal.SIGALRM, stop)
signal.alarm(5)
try:
    with open(fifo, "w", encoding="utf-8") as handle:
        handle.write("cancel\\n")
    code = proc.wait()
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
print(f"{label} exit={code} receipt={os.path.exists(os.path.join(checkout, 'receipt'))} done={os.path.exists(os.path.join(checkout, 'done'))}")
`
    const buggy = prepare(["prepare", "--case", "job-lease", "--variant", "buggy", "--skill", "revised"])
    const fixed = prepare(["prepare", "--case", "job-lease", "--variant", "fixed", "--skill", "revised"])
    try {
      const buggyRun = python(["-c", protocol, path.join(buggy.checkout, "cancel"), buggy.checkout, "buggy"])
      const fixedRun = python(["-c", protocol, path.join(fixed.checkout, "cancel"), fixed.checkout, "fixed"])
      expect(buggyRun.status).toBe(0)
      expect(fixedRun.status).toBe(0)
      expect(buggyRun.stdout).toContain("receipt=True")
      expect(buggyRun.stdout).toContain("done=True")
      expect(fixedRun.stdout).toContain("receipt=False")
      expect(fixedRun.stdout).toContain("done=False")
    } finally {
      removeOuts()
    }
  })

  // Drives the real runner: a leader starts a descendant in its own session,
  // the experiment cancels or lets the leader exit only after both wrote a ready
  // marker, and the postconditions are read after the runner returned. Every
  // writer is stopped before the disposable directories are removed.
  const ownershipProtocol = `
import json, os, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path

checkout = Path(sys.argv[1])
transfer = sys.argv[2] == "transfer"
work = Path(tempfile.mkdtemp(prefix="ownership-probe-"))
DESCENDANT = '''
import os, signal, sys, time
from pathlib import Path
state, ignore = Path(sys.argv[1]), sys.argv[2] == "ignore"
if ignore:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
(state / "descendant.pid").write_text(str(os.getpid()))
(state / "workspace").write_text(os.getcwd())
open("heartbeat", "a").close()
(state / "descendant.ready").write_text("1")
deadline = time.monotonic() + 20
while time.monotonic() < deadline and not (state / "stop").exists():
    try:
        # Append without creating. A write that brought the file back between
        # a runner's unlink and rmdir made that runner's removal fail.
        handle = os.open("heartbeat", os.O_WRONLY | os.O_APPEND)
        try:
            os.write(handle, b"x")
        finally:
            os.close(handle)
    except OSError:
        pass
    time.sleep(0.05)
'''
LEADER = '''
import os, subprocess, sys, time
from pathlib import Path
state, mode, script, ignore = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
(state / "leader.pid").write_text(str(os.getpid()))
subprocess.Popen([sys.executable, script, str(state), ignore])
deadline = time.monotonic() + 10
while not (state / "descendant.ready").exists():
    if time.monotonic() > deadline:
        raise SystemExit(9)
    time.sleep(0.02)
if mode == "linger":
    import signal
    def acknowledge(signum, frame):
        (state / "leader.term").write_text("1")  # and keep running
    signal.signal(signal.SIGTERM, acknowledge)
(state / "leader.ready").write_text("1")
if mode == "done":
    (state / "leader.done").write_text("1")
if mode in ("hang", "linger"):
    time.sleep(20)
raise SystemExit(3 if mode == "fail" else 0)
'''
SERVICE = '''
import os, sys, time
from pathlib import Path
state = Path(sys.argv[1])
(state / "service.pid").write_text(str(os.getpid()))
deadline = time.monotonic() + 20
while time.monotonic() < deadline and not (state / "stop").exists():
    time.sleep(0.05)
'''

def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(stat) and not stat.startswith("Z")

def wait_for(path, seconds=10):
    deadline = time.monotonic() + seconds
    while not path.exists():
        if time.monotonic() > deadline:
            raise SystemExit(f"no acknowledgement: {path.name}")
        time.sleep(0.02)

def pid_of(path):
    return int(path.read_text()) if path.exists() else None

def scenario(name, mode, cancel, ignore, then=None, filler=0, after="leader.ready"):
    state = work / name
    source = work / f"{name}-source"
    state.mkdir()
    source.mkdir()
    for index in range(filler):
        (source / f"filler-{index}").write_text("x")
    (source / "leader.py").write_text(LEADER)
    (state / "descendant.py").write_text(DESCENDANT)
    (state / "service.py").write_text(SERVICE)
    command = [sys.executable, "leader.py", str(state), mode, str(state / "descendant.py"), "ignore" if ignore else "default"]
    argv = [sys.executable, str(checkout / "runner.py"), "--source", str(source), "--command", json.dumps(command)]
    if transfer:
        argv += ["--service", "svc=" + json.dumps([sys.executable, str(state / "service.py"), str(state)]), "--services", str(state / "services")]
    runner = subprocess.Popen(argv, cwd=checkout, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if cancel:
            wait_for(state / after)
            runner.send_signal(cancel)
        if then:
            # A second signal while cleanup waits on a leader that acknowledged TERM and still runs.
            wait_for(state / "leader.term")
            runner.send_signal(then)
        status = runner.wait(timeout=30)
        # Postconditions once the owner has returned.
        workspace = Path((state / "workspace").read_text())
        try:
            (workspace / "late-write").write_text("x")
            writable = True
        except OSError:
            writable = False
        result = {
            "status": status,
            "descendantAlive": alive(pid_of(state / "descendant.pid")),
            "workspaceExists": workspace.exists(),
            "workspaceWritable": writable,
        }
        if transfer:
            result["serviceAlive"] = alive(pid_of(state / "service.pid") or 0)
            result["serviceRegistered"] = (state / "services" / "svc.pid").exists()
        return result
    finally:
        (state / "stop").write_text("1")
        if runner.poll() is None:
            runner.kill()
            runner.wait()
        for name in ("descendant.pid", "leader.pid", "service.pid"):
            pid = pid_of(state / name)
            if pid and alive(pid):
                os.kill(pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while any(alive(pid_of(state / name) or 0) for name in ("descendant.pid", "leader.pid", "service.pid") if (state / name).exists()):
            if time.monotonic() > deadline:
                break
            time.sleep(0.05)
        if (state / "workspace").exists():
            shutil.rmtree((state / "workspace").read_text(), ignore_errors=True)

try:
    report = {
        "completion": scenario("completion", "ok", None, False),
        "nonzero": scenario("nonzero", "fail", None, False),
        "termination": scenario("termination", "hang", signal.SIGTERM, True),
        "interrupt": scenario("interrupt", "hang", signal.SIGINT, True),
        "repeated": scenario("repeated", "linger", signal.SIGINT, True, signal.SIGTERM if sys.argv[2] != "buggy" else signal.SIGINT),
        # SIGTERM once the check has finished: it lands while the runner settles or removes a large workspace.
        "cleanup": scenario("cleanup", "done", signal.SIGTERM, False, filler=5000, after="leader.done"),
    }
    print(json.dumps(report))
finally:
    shutil.rmtree(work, ignore_errors=True)
`

  test("only the settling runners leave no owned process or workspace behind; the transfer keeps its service", () => {
    const run = (variant: string) => {
      const prepared = prepare(["prepare", "--case", "check-runner", "--variant", variant, "--skill", "revised"])
      expect(prepared.result.status, prepared.result.stderr).toBe(0)
      const result = python(["-c", ownershipProtocol, prepared.checkout, variant])
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as Record<string, Record<string, unknown>>
    }
    const settled = (status: number) => ({ status, descendantAlive: false, workspaceExists: false, workspaceWritable: false })
    try {
      // A signal during cleanup races a defective runner's own exit, so only the controls assert it.
      const { cleanup: _buggyCleanup, ...buggy } = run("buggy")
      // A finished leader leaves owned work running while the workspace is removed under it.
      expect(buggy.completion).toEqual({ status: 0, descendantAlive: true, workspaceExists: false, workspaceWritable: false })
      expect(buggy.nonzero).toEqual({ status: 3, descendantAlive: true, workspaceExists: false, workspaceWritable: false })
      // SIGTERM kills the runner by default: nothing is stopped or removed.
      expect(buggy.termination).toEqual({ status: -15, descendantAlive: true, workspaceExists: true, workspaceWritable: true })
      // SIGINT waits for the leader only; the TERM-ignoring descendant survives.
      expect(buggy.interrupt).toEqual({ status: 130, descendantAlive: true, workspaceExists: false, workspaceWritable: false })
      // A second SIGINT during the grace wait skips the KILL escalation.
      expect(buggy.repeated).toEqual({ status: 130, descendantAlive: true, workspaceExists: false, workspaceWritable: false })

      const { cleanup: _termCleanup, ...term } = run("term")
      expect(term.completion).toEqual(settled(0))
      expect(term.nonzero).toEqual(settled(3))
      expect(term.termination).toEqual({ status: 143, descendantAlive: true, workspaceExists: false, workspaceWritable: false })
      expect(term.interrupt).toEqual({ status: 130, descendantAlive: true, workspaceExists: false, workspaceWritable: false })
      // SIGTERM during the interrupt's grace wait abandons it before KILL.
      expect(term.repeated).toEqual({ status: 143, descendantAlive: true, workspaceExists: false, workspaceWritable: false })

      // Negative control: the same experiments find nothing left by a runner that settles its session.
      const fixed = run("fixed")
      // A SIGTERM during the interrupt's cleanup waits for that cleanup, KILL included; the first signal sets the status.
      // A SIGTERM after the check finished still lets settling and workspace removal finish.
      expect(fixed).toEqual({ completion: settled(0), nonzero: settled(3), termination: settled(143), interrupt: settled(130), repeated: settled(130), cleanup: settled(143) })

      // An explicit, documented handoff is not a leak: owned work stops, the service stays registered.
      const transfer = run("transfer")
      for (const [name, status] of [["completion", 0], ["nonzero", 3], ["termination", 143], ["interrupt", 130], ["repeated", 130], ["cleanup", 143]] as const) {
        expect(transfer[name]).toEqual({ ...settled(status), serviceAlive: true, serviceRegistered: true })
      }
    } finally {
      removeOuts()
    }
  }, 180_000)

  test("a failed export leaves its writer blocked, and the fixed exporter stops it on every path", () => {
    const protocol = `
import json, math, os, sys, tempfile, threading
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import exporter
made = []
real = exporter.tempfile.mkdtemp
def recording(*args, **kwargs):
    made.append(real(*args, **kwargs))
    return made[-1]
exporter.tempfile.mkdtemp = recording  # observes the staging path only
report = {}
with tempfile.TemporaryDirectory() as directory:
    dest = Path(directory) / "out.jsonl"
    for name, rows in (("success", [{"n": index} for index in range(600)]), ("failure", [{"n": index} for index in range(600)] + [{"n": math.nan}])):
        dest.write_text("previous\\n", encoding="utf-8")
        before = set(threading.enumerate())
        try:
            exporter.export_rows(rows, dest)
            raised = False
        except ValueError:
            raised = True
        left = [thread for thread in threading.enumerate() if thread not in before and thread.is_alive()]
        report[name] = {
            "raised": raised,
            "writerAlive": bool(left),
            "stagingExists": os.path.exists(made[-1]),
            "destChanged": dest.read_text(encoding="utf-8") != "previous\\n",
        }
    # A writer I/O error after a few lines: both variants must raise it, not publish a partial file.
    real_open = open
    class Full:
        def __init__(self, handle):
            self.handle, self.count = handle, 0
        def write(self, text):
            self.count += 1
            if self.count > 10:
                raise OSError(28, "No space left on device")
            return self.handle.write(text)
        def close(self):
            self.handle.close()
    exporter.open = lambda *args, **kwargs: Full(real_open(*args, **kwargs))
    dest.write_text("previous\\n", encoding="utf-8")
    try:
        exporter.export_rows([{"n": index} for index in range(1000)], dest)
        error = None
    except OSError as caught:
        error = caught.errno
    report["ioError"] = {"errno": error, "destChanged": dest.read_text(encoding="utf-8") != "previous\\n"}
print(json.dumps(report))
`
    const run = (variant: string) => {
      const prepared = prepare(["prepare", "--case", "spool-export", "--variant", variant, "--skill", "revised"])
      expect(prepared.result.status, prepared.result.stderr).toBe(0)
      const result = python(["-c", protocol, prepared.checkout])
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    try {
      const success = { raised: false, writerAlive: false, stagingExists: false, destChanged: true }
      const ioError = { errno: 28, destChanged: false }
      expect(run("buggy")).toEqual({ success, failure: { raised: true, writerAlive: true, stagingExists: false, destChanged: false }, ioError })
      // Negative control: the variants differ only in the failed export's writer.
      expect(run("fixed")).toEqual({ success, failure: { raised: true, writerAlive: false, stagingExists: false, destChanged: false }, ioError })
    } finally {
      removeOuts()
    }
  }, 60_000)

  test("a rejected export is still published, and the helper test passes", () => {
    const buggy = prepare(["prepare", "--case", "export-path", "--variant", "buggy", "--skill", "revised"])
    const fixed = prepare(["prepare", "--case", "export-path", "--variant", "fixed", "--skill", "revised"])
    try {
      for (const [tree, status] of [[buggy.checkout, 0], [fixed.checkout, 1]] as const) {
        const workspace = path.join(tree, "workspace")
        const approved = path.join(tree, "approved.txt")
        fs.mkdirSync(workspace)
        const result = python(["export.py", workspace, "../secret", "hidden", approved], tree)
        expect(result.status).toBe(status)
      }
      expect(fs.readFileSync(path.join(buggy.checkout, "secret"), "utf8")).toBe("hidden")
      const published = python(["-c", "import sys; sys.path.insert(0, sys.argv[1]); from publish import publish; print(publish(sys.argv[2], sys.argv[3], sys.argv[4])[0])",
        buggy.checkout, path.join(buggy.checkout, "workspace"), path.join(buggy.checkout, "approved.txt"), path.join(buggy.checkout, "published")])
      expect(published.stdout.trim()).toBe("../secret")
      expect(fs.readFileSync(path.join(buggy.checkout, "published", "secret"), "utf8")).toBe("hidden")
      expect(fs.existsSync(path.join(fixed.checkout, "secret"))).toBe(false)
      expect(python(["tests/test_validate.py"], buggy.checkout).status).toBe(0)
    } finally {
      removeOuts()
    }
  })

  test("the quota test encodes acceptance while the requirement denies it", () => {
    const buggy = prepare(["prepare", "--case", "quota-contract", "--variant", "buggy", "--skill", "revised"])
    const fixed = prepare(["prepare", "--case", "quota-contract", "--variant", "fixed", "--skill", "revised"])
    try {
      expect(python(["tests/test_check.py"], buggy.checkout).status).toBe(0)
      expect(python(["check.py", "100", "10"], buggy.checkout).status).toBe(0)
      expect(python(["tests/test_check.py"], fixed.checkout).status).toBe(0)
      expect(python(["check.py", "100", "10"], fixed.checkout).status).toBe(1)
    } finally {
      removeOuts()
    }
  })

  test("the new caller reaches a lock that is not held during the mutation", () => {
    const probe = `
import subprocess, sys
from pathlib import Path
sys.path.insert(0, "ledger")
from lock import update
path = sys.argv[1]
script = """
import fcntl, sys
handle = open(sys.argv[1], "a+")
try:
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.stdout.write("held")
else:
    sys.stdout.write("free")
"""
def mutate(handle):
    result = subprocess.run([sys.executable, "-c", script, path], check=False, capture_output=True, text=True)
    handle.write(result.stdout)
update(path, mutate)
sys.stdout.write(Path(path).read_text())
`
    const buggy = prepare(["prepare", "--case", "preexisting-lock", "--variant", "buggy", "--skill", "revised"])
    const fixed = prepare(["prepare", "--case", "preexisting-lock", "--variant", "fixed", "--skill", "revised"])
    try {
      expect(python(["tests/test_update.py"], buggy.checkout).status).toBe(0)
      expect(python(["-c", probe, path.join(buggy.checkout, "counter")], buggy.checkout).stdout).toBe("free")
      expect(python(["-c", probe, path.join(fixed.checkout, "counter")], fixed.checkout).stdout).toBe("held")
      const counter = path.join(buggy.checkout, "counter")
      fs.writeFileSync(counter, "0")
      expect(python(["reserve.py", counter], buggy.checkout).status).toBe(0)
      expect(python(["reserve.py", counter], buggy.checkout).status).toBe(0)
      expect(fs.readFileSync(counter, "utf8")).toBe("2")
      const diff = fs.readFileSync(path.join(buggy.mount, "diff.patch"), "utf8")
      expect(diff).toContain("reserve.py")
      expect(diff).not.toContain("ledger/lock.py")
    } finally {
      removeOuts()
    }
  })

  test("precision controls implement the contracts they look like they violate", () => {
    const budget = prepare(["prepare", "--case", "budget-reject", "--variant", "subject", "--skill", "revised"])
    const gate = prepare(["prepare", "--case", "release-gate", "--variant", "subject", "--skill", "revised"])
    const catalog = prepare(["prepare", "--case", "catalog-retire", "--variant", "subject", "--skill", "revised"])
    const observed = prepare(["prepare", "--case", "observed-flag", "--variant", "subject", "--skill", "revised"])
    const retry = prepare(["prepare", "--case", "already-retries", "--variant", "subject", "--skill", "revised"])
    const log = prepare(["prepare", "--case", "log-truncate", "--variant", "subject", "--skill", "revised"])
    try {
      expect(python(["tests/test_budget.py"], budget.checkout).status).toBe(0)
      expect(python(["tests/test_release_gate.py"], gate.checkout).status).toBe(0)
      expect(python(["tests/test_reconcile.py"], catalog.checkout).status).toBe(0)
      expect(python(["tests/test_capability.py"], observed.checkout).status).toBe(0)
      expect(python(["tests/test_retry_due.py"], retry.checkout).status).toBe(0)
      expect(python(["tests/test_log_line.py"], log.checkout).status).toBe(0)
    } finally {
      removeOuts()
    }
  })

  test("a cached role is reused for the other role until the key includes both", () => {
    const snippet = `
import sys
sys.path.insert(0, sys.argv[1])
from cache_alias import fetch
store = {}
calls = []
def compute(subject, role):
    calls.append(role)
    return role
first = fetch(store, "ada", "admin", compute)
second = fetch(store, "ada", "guest", compute)
sys.stdout.write(f"{first}|{second}|{','.join(calls)}")
`
    const buggy = prepare(["prepare", "--case", "cache-alias", "--variant", "buggy", "--skill", "revised"])
    const fixed = prepare(["prepare", "--case", "cache-alias", "--variant", "fixed", "--skill", "revised"])
    try {
      expect(python(["-c", snippet, buggy.checkout]).stdout).toBe("admin|admin|admin")
      expect(python(["-c", snippet, fixed.checkout]).stdout).toBe("admin|guest|admin,guest")
    } finally {
      removeOuts()
    }
  })
})

describe("review mount", () => {
  test("reports unknown Git provenance for an archive inside another repository", () => {
    const repository = outDir()
    fs.mkdirSync(path.join(repository, "archive"), { recursive: true })
    try {
      fixtureGit(repository, "init", "-q")
      fs.writeFileSync(path.join(repository, "source.txt"), "fixture\n")
      fixtureGit(repository, "add", "source.txt")
      fixtureGit(repository, "commit", "-qm", "fixture")
      const result = python(["-c", `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("review_eval", "scripts/review-eval.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ROOT = pathlib.Path(sys.argv[1]) / "archive"
print(json.dumps(module.harness_metadata()))
module.ROOT = pathlib.Path(sys.argv[1])
print(json.dumps(module.harness_metadata()))
`, repository])
      expect(result.status, result.stderr).toBe(0)
      const [archive, checkout] = result.stdout.trim().split("\n").map(line => JSON.parse(line))
      expect(archive).toEqual({ harnessHead: null, harnessDirty: null })
      expect(checkout).toEqual({ harnessHead: fixtureGit(repository, "rev-parse", "HEAD"), harnessDirty: false })
    } finally {
      removeOuts()
    }
  })

  test("consumer parity distinguishes an unchanged working path from a regressed adapter", () => {
    const preserved = prepare(["prepare", "--case", "consumer-parity", "--variant", "preserved", "--skill", "revised"])
    const regressed = prepare(["prepare", "--case", "consumer-parity", "--variant", "regressed", "--skill", "revised"])
    const base = path.join(ROOT, "eval/review/cases/consumer-parity/base")
    const model = { tunable: false, levels: [
      { id: "low", settings: { depth: 1 } },
      { id: "high", settings: { depth: 3 } },
    ] }
    const run = (checkout: string, consumer: string) => {
      const result = python(["catalog.py", consumer, JSON.stringify(model)], checkout)
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    try {
      expect(preserved.result.status, preserved.result.stderr).toBe(0)
      expect(regressed.result.status, regressed.result.stderr).toBe(0)
      expect(run(base, "legacy")).toEqual({ choices: [] })
      const workingModern = run(base, "modern")
      expect(workingModern).toEqual({ choices: model.levels })
      for (const prepared of [preserved, regressed]) {
        expect(python(["tests/test_catalog.py"], prepared.checkout).status).toBe(0)
        expect(python(["scripts/review-eval.py", "verify-mount", prepared.mount]).status).toBe(0)
        expect(run(prepared.checkout, "legacy")).toEqual({ choices: model.levels })
      }
      expect(run(preserved.checkout, "modern")).toEqual(workingModern)
      expect(run(regressed.checkout, "modern")).toEqual({ choices: [] })
      const diff = fs.readFileSync(path.join(preserved.mount, "diff.patch"), "utf8")
      expect(diff).toContain('+        "tunable": model["tunable"] or bool(model["levels"])')
      expect(diff).not.toContain("def modern")
      expect(fs.existsSync(path.join(preserved.mount, "private/consumer-parity.json"))).toBe(false)
    } finally {
      removeOuts()
    }
  })

  test("the reviewer mount excludes the answer key and the other variant", () => {
    const prepared = prepare(["prepare", "--case", "index-sync", "--variant", "buggy", "--skill", "revised"])
    try {
      expect(prepared.result.status).toBe(0)
      expect(python(["scripts/review-eval.py", "verify-mount", prepared.mount]).status).toBe(0)
      const leaked = python(["-c", "import pathlib,sys; root=pathlib.Path(sys.argv[1]);\nprint('\\n'.join(str(p) for p in root.rglob('*') if p.is_file() and ('REVIEW_EVAL_ANSWER' in p.read_text() or 'failed-refresh-skips-retry' in p.read_text())))", prepared.mount])
      expect(leaked.status).toBe(0)
      expect(leaked.stdout.trim()).toBe("")
      expect(fs.existsSync(path.join(prepared.mount, "checkout", "sync_index.py"))).toBe(true)
      expect(fs.readFileSync(path.join(prepared.mount, "PROMPT.txt"), "utf8")).not.toContain("index-sync")
      expect(fs.readFileSync(path.join(prepared.mount, "instructions", "SKILL.md"), "utf8")).toContain("scripts/review-ledger.py")
      const marker = path.join(prepared.mount, "note.txt")
      fs.writeFileSync(marker, "REVIEW_EVAL_ANSWER")
      expect(python(["scripts/review-eval.py", "verify-mount", prepared.mount]).status).toBe(1)
    } finally {
      removeOuts()
    }
  })

  test("baseline and revised instructions are different snapshots", () => {
    const baseline = prepare(["prepare", "--case", "log-truncate", "--variant", "subject", "--skill", "baseline"])
    const revised = prepare(["prepare", "--case", "log-truncate", "--variant", "subject", "--skill", "revised"])
    try {
      const baselineSkill = fs.readFileSync(path.join(baseline.mount, "instructions", "SKILL.md"), "utf8")
      const revisedSkill = fs.readFileSync(path.join(revised.mount, "instructions", "SKILL.md"), "utf8")
      expect(baselineSkill).toBe(fs.readFileSync(path.join(ROOT, "eval/review/baseline/SKILL.md"), "utf8"))
      expect(revisedSkill).toBe(fs.readFileSync(path.join(ROOT, ".cursor/skills/review/SKILL.md"), "utf8"))
      expect(baselineSkill).not.toContain("scripts/review-ledger.py")
      expect(revisedSkill).not.toContain("REVIEW_EVAL_ANSWER")
      expect(revisedSkill).not.toContain("fcf331e")
      expect(revisedSkill).not.toContain("imageProbeVerdict")
      // The procedure names no evaluation case, file, or calibration subject.
      for (const answer of ["check-runner", "spool-export", "runner.py", "exporter.py", "test-harness.py", "#161", "4f1843d"]) {
        expect(revisedSkill).not.toContain(answer)
      }
      expect(fs.readFileSync(path.join(baseline.mount, "PROMPT.txt"), "utf8"))
        .toBe(fs.readFileSync(path.join(revised.mount, "PROMPT.txt"), "utf8"))
      expect(JSON.parse(fs.readFileSync(path.join(baseline.out, "meta.json"), "utf8")).supportSha256)
        .toBe(JSON.parse(fs.readFileSync(path.join(revised.out, "meta.json"), "utf8")).supportSha256)
    } finally {
      removeOuts()
    }
  })

  test("calibration archives the pinned revision and diff without unrelated repository history", () => {
    const repository = outDir()
    const out = outDir()
    fs.mkdirSync(repository)
    try {
      fixtureGit(repository, "init", "-q")
      fs.writeFileSync(path.join(repository, "subject.py"), "value = 1\n")
      fixtureGit(repository, "add", ".")
      fixtureGit(repository, "commit", "-qm", "base")
      const base = fixtureGit(repository, "rev-parse", "HEAD")
      fs.writeFileSync(path.join(repository, "subject.py"), "value = 2\n")
      fixtureGit(repository, "commit", "-qam", "head")
      const head = fixtureGit(repository, "rev-parse", "HEAD")
      fs.writeFileSync(path.join(repository, "subject.py"), "uncommitted\n")
      fs.writeFileSync(path.join(repository, "grading-key.json"), "REVIEW_EVAL_ANSWER")
      const result = prepareRevision(repository, head, base, out)
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      const mount = path.join(out, "mount")
      expect(fs.readFileSync(path.join(mount, "checkout/subject.py"), "utf8")).toBe("value = 2\n")
      expect(fs.existsSync(path.join(mount, "checkout/grading-key.json"))).toBe(false)
      expect(fs.existsSync(path.join(mount, "checkout/.git"))).toBe(false)
      expect(fs.readFileSync(path.join(mount, "diff.patch"), "utf8")).toContain("-value = 1\n+value = 2\n")
      expect(python(["scripts/review-eval.py", "verify-mount", mount]).status).toBe(0)
      const prompt = fs.readFileSync(path.join(mount, "PROMPT.txt"), "utf8")
      expect(prompt).not.toContain("REVIEW_EVAL_ANSWER")
      expect(prompt).not.toContain("failed-refresh-skips-next-default")
      const meta = JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8"))
      expect(meta.revision).toBe(head)
      expect(meta.base).toBe(base)
      expect(fs.existsSync(path.join(mount, "meta.json"))).toBe(false)

      const shallow = outDir()
      fixtureGit(ROOT, "clone", "-q", "--depth=1", `file://${repository}`, shallow)
      const missingBase = outDir()
      const failedBase = prepareRevision(shallow, head, base, missingBase)
      expect(failedBase.status).toBe(1)
      expect(failedBase.stderr).toContain(`calibration commit unavailable: ${base}`)
      expect(failedBase.stderr).toContain("fetch the pinned head and base")
      expect(fs.existsSync(missingBase)).toBe(false)

      const missingHead = outDir()
      const failedHead = prepareRevision(shallow, "0".repeat(40), head, missingHead)
      expect(failedHead.status).toBe(1)
      expect(failedHead.stderr).toContain("calibration commit unavailable:")
      expect(fs.existsSync(missingHead)).toBe(false)

      fixtureGit(shallow, "fetch", "-q", "--unshallow")
      expect(prepareRevision(shallow, head, base, missingBase).status).toBe(0)
    } finally {
      removeOuts()
    }
  })
})

describe("review ledger and score", () => {
  const ledger = {
    revision: "local",
    behaviors: [{
      id: "sync",
      summary: "Refresh an existing record and the next default run.",
      contract: [{ path: "CONTRACT.md", line: 1, note: "A failed refresh stays due." }],
      scenarios: [{
        id: "failed-then-default",
        category: "existing-state-failure-retry",
        applicable: true,
        reason: "",
        expected: "The id stays due and the next default run fetches it.",
        observed: "The failed refresh leaves due empty and the next run exits 0.",
        evidence: "reproduced",
        downstream: "query returns the previous value",
      }],
      uncovered: ["concurrent refresh"],
    }],
    candidates: [{
      id: "failed-refresh-skips-retry",
      behavior: "sync",
      disposition: "actionable",
      observation: "The failed refresh returns 1.",
      contract: "CONTRACT.md says the id stays due.",
      trigger: "A forced refresh of an existing id fails.",
      causalPath: "The handler leaves due empty, so the default loop has no work.",
      consequence: "The next default run exits 0 and query serves the stale value.",
      violation: "The contract requires that id to stay due and be fetched again.",
      evidenceKind: "synthetic",
      setup: "synthetic",
      provenance: "introduced",
      policyConflict: false,
      citedRequirement: "",
    }],
    omissions: [],
    omissionsNone: "The failed refresh and the following default run were both exercised.",
    retries: [{
      behavior: "sync",
      operation: "forced refresh of an existing recorded id",
      forced: "The mocked fetch answered an error for the forced refresh.",
      promise: "The failing run reported the id stays due.",
      persisted: "The record kept the old value and due was left empty: 1 refresh attempt, 0 ids due.",
      retried: "The next default run made 0 fetch attempts: due was empty.",
      consumer: "query served the previous value.",
      exit: "The forced run exited 1; the next default run exited 0.",
      verdict: "violated",
    }],
    retriesNone: "",
    passes: { candidatesValidated: true, omissionsAnalyzed: true, failedWorkAnalyzed: true },
  }
  const review = {
    head: "local",
    outcome: "findings",
    findings: [{
      id: "failed-refresh-skips-retry",
      title: "Failed refresh is treated as done",
      explanation: "A failed refresh of an existing id leaves due empty.",
      trigger: "The forced refresh fails.",
      consequence: "The next default run skips the fetch and exits 0.",
      evidence: "reproduced",
      path: "sync_index.py",
      line: 24,
    }],
  }

  test("the mounted tools complete an offline review without files outside the mount", () => {
    const prepared = prepare(["prepare", "--case", "index-sync", "--variant", "buggy", "--skill", "revised"])
    try {
      expect(prepared.result.status).toBe(0)
      for (const relative of [
        "AGENTS.md", "CONTRIBUTING.md", ".greptile/config.json", ".greptile/files.json",
        ".cursor/rules/greptile-context.mdc", "docs/cache-log-runbook.md",
        "docs/host-compat-acceptance.md",
      ]) expect(fs.existsSync(path.join(prepared.mount, relative))).toBe(true)
      // Later incident lessons describe the calibration subject and must stay out.
      expect(fs.existsSync(path.join(prepared.mount, "tasks/lessons/opencode.md"))).toBe(false)
      const prompt = fs.readFileSync(path.join(prepared.mount, "PROMPT.txt"), "utf8")
      expect(prompt).toContain("offline local review")
      expect(prompt).toContain('head "local"')
      writeJson(path.join(prepared.mount, "ledger.json"), ledger)
      writeJson(path.join(prepared.mount, "review.json"), review)
      expect(python(["scripts/review-ledger.py", "check", "ledger.json"], prepared.mount).status).toBe(0)
      expect(python(["scripts/review-ledger.py", "compare", "ledger.json", "review.json"], prepared.mount).status).toBe(0)
      const unfinished = structuredClone(ledger)
      unfinished.passes.omissionsAnalyzed = false
      unfinished.omissionsNone = ""
      writeJson(path.join(prepared.mount, "ledger.json"), unfinished)
      expect(python(["scripts/review-ledger.py", "check", "ledger.json"], prepared.mount).status).toBe(2)
      expect(python(["scripts/review-ledger.py", "compare", "ledger.json", "review.json"], prepared.mount).status).not.toBe(0)
      const unanalyzed = structuredClone(ledger)
      unanalyzed.passes.failedWorkAnalyzed = false
      unanalyzed.retries = []
      unanalyzed.retriesNone = ""
      writeJson(path.join(prepared.mount, "ledger.json"), unanalyzed)
      expect(python(["scripts/review-ledger.py", "check", "ledger.json"], prepared.mount).status).toBe(2)
      expect(python(["scripts/review-ledger.py", "compare", "ledger.json", "review.json"], prepared.mount).status).not.toBe(0)
      const badVerdict = structuredClone(ledger)
      badVerdict.retries[0].verdict = "maybe"
      writeJson(path.join(prepared.mount, "ledger.json"), badVerdict)
      const verdict = python(["scripts/review-ledger.py", "check", "ledger.json"], prepared.mount)
      expect(verdict.status).toBe(1)
      expect(verdict.stderr).toContain("verdict")
      const unjustified = structuredClone(ledger)
      unjustified.retries = []
      unjustified.retriesNone = ""
      writeJson(path.join(prepared.mount, "ledger.json"), unjustified)
      const missing = python(["scripts/review-ledger.py", "check", "ledger.json"], prepared.mount)
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain("retriesNone")
    } finally {
      removeOuts()
    }
  })

  test("ledger comparison binds the reviewed head, including the local evaluation mode", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const ledgerPath = path.join(dir, "ledger.json")
      const reviewPath = path.join(dir, "review.json")
      for (const [revision, head, valid] of [
        ["a".repeat(40), "a".repeat(40), true],
        ["a".repeat(40), "b".repeat(40), false],
        ["local", "a".repeat(40), false],
        ["a".repeat(40), "local", false],
        ["local", "local", true],
        ["local", undefined, false],
        ["a".repeat(40), undefined, false],
        ["local", "bad-head", false],
      ] as const) {
        writeJson(ledgerPath, { ...ledger, revision })
        writeJson(reviewPath, { ...review, head })
        const compared = python(["scripts/review-ledger.py", "compare", ledgerPath, reviewPath])
        expect(compared.status === 0).toBe(valid)
        if (!valid) expect(compared.stderr).toContain("head")
      }
      writeJson(ledgerPath, [])
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stderr.trim()).toBe("ledger")
      expect(python(["scripts/review-ledger.py", "compare", ledgerPath, reviewPath]).stderr.trim()).toBe("ledger")
    } finally {
      removeOuts()
    }
  })

  test("an ownership record covers each lifecycle path and names indirect evidence as a gap", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const scenario = (category: string, evidence: string) => ({
        id: category, category, applicable: true, reason: "",
        expected: "No owned process or write remains once the owner returns.",
        observed: "The descendant's pid was gone and a write into the released directory failed.",
        evidence, downstream: "The next run starts with no leftover writer.",
      })
      const paths = ["ownership-completion", "ownership-nonzero", "ownership-termination", "ownership-early-leader"]
      const owned = (evidence: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
        const value = structuredClone(ledger) as Record<string, any>
        value.behaviors.push({
          id: "runner",
          summary: "Run a command in a private workspace and remove it afterward.",
          contract: [{ path: "CONTRACT.md", line: 1, note: "Owned processes stop before the workspace is removed." }],
          scenarios: paths.map((path) => scenario(path, evidence[path] ?? "synthetic")),
          uncovered: [],
          ownership: {
            owner: "run_checks", resources: ["process group", "workspace directory"],
            subordinates: "every process a command starts", cancellation: ["return", "SIGTERM", "SIGINT"],
            release: "The workspace is removed after no owned process remains.", transfer: "",
          },
          ...extra,
        })
        return value
      }
      const check = (value: unknown) => {
        writeJson(path.join(dir, "ledger.json"), value)
        return python(["scripts/review-ledger.py", "check", path.join(dir, "ledger.json")])
      }
      expect(check(owned()).stdout).toContain("LEDGER_OK")

      // Every lifecycle path is accounted for; an inapplicable one says why.
      const missing = owned()
      missing.behaviors[1].scenarios.pop()
      expect(check(missing).stderr).toContain("behaviors[1].ownership.ownership-early-leader")
      const inapplicable = owned()
      inapplicable.behaviors[1].scenarios[3] = { ...scenario("ownership-early-leader", "not-run"), applicable: false,
        reason: "The owner runs no subordinate process.", expected: "", observed: "", downstream: "" }
      expect(check(inapplicable).stdout).toContain("LEDGER_OK")

      // A path only traced, mocked, or unavailable at runtime is a recorded gap.
      for (const kind of ["source", "mocked", "unverified"]) {
        expect(check(owned({ "ownership-termination": kind })).stderr).toContain("ownership-termination.uncovered")
        const named = owned({ "ownership-termination": kind })
        named.behaviors[1].uncovered = ["ownership-termination: the signal path was not run."]
        expect(check(named).stdout).toContain("LEDGER_OK")
      }

      const malformed = owned()
      malformed.behaviors[1].ownership = { ...malformed.behaviors[1].ownership, resources: [], release: "" }
      const refused = check(malformed).stderr
      expect(refused).toContain("behaviors[1].ownership.resources")
      expect(refused).toContain("behaviors[1].ownership.release")
      // An unrelated behavior needs no ownership record.
      expect(check(ledger).stdout).toContain("LEDGER_OK")
    } finally {
      removeOuts()
    }
  })

  test("a complete ledger matches its public finding and a misleading one does not", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const ledgerPath = path.join(dir, "ledger.json")
      const reviewPath = path.join(dir, "review.json")
      writeJson(ledgerPath, ledger)
      writeJson(reviewPath, review)
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stdout).toContain("LEDGER_OK")
      expect(python(["scripts/review-ledger.py", "compare", ledgerPath, reviewPath]).status).toBe(0)

      const observation = structuredClone(ledger)
      observation.candidates[0].violation = ""
      writeJson(ledgerPath, observation)
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stderr).toContain("violation")

      const policy = structuredClone(ledger)
      policy.candidates[0].disposition = "policy"
      policy.candidates[0].violation = "prefer a different retry"
      policy.candidates[0].provenance = "not-applicable"
      writeJson(ledgerPath, policy)
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stderr).toContain("violation")

      const liveClaim = structuredClone(ledger)
      liveClaim.candidates[0].evidenceKind = "live"
      liveClaim.candidates[0].setup = "synthetic"
      writeJson(ledgerPath, liveClaim)
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).status).toBe(1)

      const unfinished = structuredClone(ledger)
      unfinished.passes.omissionsAnalyzed = false
      unfinished.omissionsNone = ""
      writeJson(ledgerPath, unfinished)
      const incomplete = python(["scripts/review-ledger.py", "check", ledgerPath])
      expect(incomplete.status).toBe(2)
      expect(incomplete.stderr).toContain("LEDGER_INCOMPLETE")
      writeJson(reviewPath, review)
      expect(python(["scripts/review-ledger.py", "compare", ledgerPath, reviewPath]).status).not.toBe(0)

      for (const note of ["see /tmp/review", "see ~/work/review"]) {
        const absolute = structuredClone(ledger)
        absolute.behaviors[0].contract[0].note = note
        writeJson(ledgerPath, absolute)
        expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stderr).toContain("private-path")
      }
      // A slash between numbers is not a path.
      const ratio = structuredClone(ledger)
      ratio.behaviors[0].contract[0].note = "65 / 200 lines arrived"
      writeJson(ledgerPath, ratio)
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stderr).not.toContain("private-path")

      const skipped = structuredClone(ledger)
      skipped.behaviors[0].scenarios[0].evidence = "not-run"
      skipped.behaviors[0].scenarios[0].applicable = false
      skipped.behaviors[0].scenarios[0].reason = "not looked at"
      skipped.behaviors[0].scenarios[0].expected = ""
      skipped.behaviors[0].scenarios[0].observed = ""
      skipped.behaviors[0].scenarios[0].downstream = ""
      writeJson(ledgerPath, skipped)
      expect(python(["scripts/review-ledger.py", "check", ledgerPath]).stderr).toContain("omissions.coverage")

      const incident = structuredClone(review)
      incident.findings[0].explanation = "The live model replied this in production."
      writeJson(ledgerPath, ledger)
      writeJson(reviewPath, incident)
      expect(python(["scripts/review-ledger.py", "compare", ledgerPath, reviewPath]).stderr).toContain("evidence")
    } finally {
      removeOuts()
    }
  })

  test("consumer parity scoring rejects a missing-edit claim and credits a concrete regression", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const score = (variant: string, findings: unknown[]) => {
        const file = path.join(dir, `${variant}.json`)
        writeJson(file, { head: "local", outcome: findings.length ? "findings" : "clean", findings })
        const result = python(["scripts/review-eval.py", "score", "--case", "consumer-parity", "--variant", variant, "--review", file])
        expect(result.status, result.stderr).toBe(0)
        return JSON.parse(result.stdout)
      }
      const missingEdit = {
        id: "missing-edit", path: "adapters.py", line: 3,
        title: "Only legacy is fixed",
        explanation: "The modern adapter ignores the flag and is unchanged, so the fix is incomplete.",
        trigger: "Discovery leaves tunable false despite levels.",
        consequence: "Both supported clients must change.", evidence: "source",
      }
      const lostChoices = {
        id: "lost-choices", path: "adapters.py", line: 11,
        title: "Modern loses the explicit choices",
        explanation: "The modern adapter filters levels on the raw tunable flag, which can be false.",
        trigger: "Discovery supplies levels while tunable is false.",
        consequence: "The modern client receives an empty list and offers no choices.", evidence: "synthetic",
      }
      expect(score("preserved", [missingEdit]).falsePositives).toEqual([
        { finding: "missing-edit", claims: ["unchanged-consumer-already-correct"] },
      ])
      const detected = score("regressed", [lostChoices])
      expect(detected.detected).toEqual(["modern-choices-gated-on-legacy-flag"])
      expect(detected.falsePositives).toEqual([])
      expect(score("regressed", []).missed).toEqual(["modern-choices-gated-on-legacy-flag"])
      expect(score("preserved", []).falsePositives).toEqual([])
    } finally {
      removeOuts()
    }
  })

  test("ownership answer keys credit the causal claim and count it against the controls", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const score = (testCase: string, variant: string, findings: unknown[]) => {
        const file = path.join(dir, `${testCase}-${variant}.json`)
        writeJson(file, { head: "local", outcome: findings.length ? "findings" : "clean", findings })
        const result = python(["scripts/review-eval.py", "score", "--case", testCase, "--variant", variant, "--review", file])
        expect(result.status, result.stderr).toBe(0)
        return JSON.parse(result.stdout)
      }
      const leftAlive = {
        id: "left-alive", path: "runner.py", line: 17, title: "A finished check leaves its background processes running",
        explanation: "run() waits only for the leader; a descendant in the check's session stays alive.",
        trigger: "The check starts a background process and exits 0.",
        consequence: "The workspace is removed while that process is still running and writing.",
        evidence: "synthetic",
      }
      const leaderOnly = {
        id: "leader-only", path: "runner.py", line: 55, title: "Cancellation waits only for the leader",
        explanation: "On SIGINT the runner sends TERM to the session and waits for the direct child only.",
        trigger: "A descendant ignores TERM.", consequence: "It survives in the session after the runner exits.",
        evidence: "synthetic",
      }
      const service = {
        id: "service", path: "runner.py", line: 82, title: "The service is never stopped",
        explanation: "hand_off starts a service the runner does not stop.", trigger: "Pass --service.",
        consequence: "The service keeps running after the runner exits, an orphan.", evidence: "source",
      }
      expect(score("check-runner", "buggy", [leftAlive, leaderOnly]).detected).toEqual(["cancel-awaits-only-the-leader", "finished-check-leaves-owned-work"])
      expect(score("check-runner", "buggy", []).missed).toHaveLength(4)
      const secondSignal = {
        id: "second-signal", path: "runner.py", line: 22, title: "A second Ctrl-C during the grace wait skips the SIGKILL escalation",
        explanation: "The cleanup wait is interruptible; a KeyboardInterrupt there leaves the except block before killpg(SIGKILL).",
        trigger: "Press Ctrl-C twice while a descendant ignores TERM.", consequence: "The descendant survives and the workspace is removed under it.",
        evidence: "synthetic",
      }
      expect(score("check-runner", "buggy", [secondSignal]).detected).toEqual(["second-signal-abandons-settling"])
      expect(score("check-runner", "term", [{ ...secondSignal, line: 45 }]).detected).toEqual(["second-signal-abandons-settling"])
      const settledControl = score("check-runner", "fixed", [{ ...secondSignal, line: 44 }]).falsePositives
      expect(settledControl).toHaveLength(1)
      expect(settledControl[0].claims).toContain("second-signal-abandons-settling")
      const killedRunner = {
        id: "killed-runner", path: "runner.py", line: 100, title: "No cleanup when the runner is killed with SIGKILL",
        explanation: "If the runner itself receives SIGKILL, its descendants and workspace leak.", trigger: "kill -9 the runner.",
        consequence: "The workspace is never cleaned.", evidence: "source",
      }
      expect(score("check-runner", "fixed", [killedRunner]).falsePositives).toEqual([{ finding: "killed-runner", claims: ["cleanup-after-sigkill"] }])
      expect(score("check-runner", "term", [leaderOnly]).detected).toEqual(["cancel-awaits-only-the-leader"])
      expect(score("check-runner", "term", [{ ...leftAlive, line: 70, explanation: "After the check finishes normally a background descendant stays alive." }]).falsePositives).toHaveLength(1)
      expect(score("check-runner", "fixed", [leftAlive]).falsePositives).toEqual([{ finding: "left-alive", claims: ["owned-work-outlives-runner"] }])
      expect(score("check-runner", "transfer", [service]).falsePositives).toEqual([{ finding: "service", claims: ["transferred-service-left-running"] }])
      expect(score("check-runner", "fixed", []).falsePositives).toEqual([])

      const writer = {
        id: "writer", path: "exporter.py", line: 26, title: "A failed export leaves its writer thread blocked",
        explanation: "When a row raises ValueError, the sentinel is never queued and the writer is not joined.",
        trigger: "Export a row with NaN.", consequence: "The writer thread stays alive, blocked forever; each failure leaks one.",
        evidence: "synthetic",
      }
      expect(score("spool-export", "buggy", [writer]).detected).toEqual(["failed-export-leaves-writer"])
      expect(score("spool-export", "fixed", [writer]).falsePositives).toHaveLength(1)
    } finally {
      removeOuts()
    }
  })

  test("the scorer separates detection, misses, false positives, and unadjudicated findings", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const reviewPath = path.join(dir, "review.json")
      writeJson(reviewPath, {
        findings: [
          review.findings[0],
          {
            id: "vague",
            path: "sync_index.py",
            line: 24,
            title: "run looks odd",
            explanation: "The branch is hard to follow.",
            trigger: "A refresh runs.",
            consequence: "The output may be surprising.",
          },
          {
            id: "elsewhere",
            path: "indexlib/merge.py",
            line: 1,
            title: "merge allocates",
            explanation: "A new dict is allocated.",
            trigger: "merge is called.",
            consequence: "An extra allocation.",
          },
        ],
      })
      const scored = python(["scripts/review-eval.py", "score", "--case", "index-sync", "--variant", "buggy", "--review", reviewPath])
      expect(scored.status).toBe(0)
      const report = JSON.parse(scored.stdout)
      expect(report.detected).toEqual(["failed-refresh-skips-retry"])
      expect(report.missed).toEqual([])
      expect(report.partial).toEqual(["vague"])
      expect(report.unadjudicated).toEqual(["elsewhere"])
      expect(report.falsePositives).toEqual([])

      writeJson(reviewPath, { findings: [review.findings[0]] })
      const fixed = JSON.parse(python(["scripts/review-eval.py", "score", "--case", "index-sync", "--variant", "fixed", "--review", reviewPath]).stdout)
      expect(fixed.detected).toEqual([])
      expect(fixed.falsePositives[0].claims).toContain("failed-refresh-skips-retry")

      writeJson(reviewPath, {
        findings: [{
          id: "budget",
          path: "budget.py",
          line: 4,
          title: "Over-budget input is rejected",
          explanation: "accept raises ValueError when the sum exceeds the limit of 20.",
          trigger: "The parts sum to more than the budget.",
          consequence: "This rejection is incorrect and the request should succeed.",
        }],
      })
      const budget = JSON.parse(python(["scripts/review-eval.py", "score", "--case", "budget-reject", "--variant", "subject", "--review", reviewPath]).stdout)
      expect(budget.detected).toEqual([])
      expect(budget.falsePositives[0].claims).toContain("over-budget-rejection")
    } finally {
      removeOuts()
    }
  })

  test("the posted calibration review is classified without being a new review run", () => {
    const dir = outDir()
    fs.mkdirSync(dir)
    try {
      const reviewPath = path.join(dir, "review.json")
      writeJson(reviewPath, {
        findings: [
          {
            id: "short-list",
            path: "scripts/probe-cursor-image-input.ts",
            line: 164,
            title: "A short AvailableModels list clears image records and exits 0",
            explanation: "generate:images copies the committed record, deletes every id absent from the live list, then probes only ids that are missing or named with --model. An empty list therefore marks all 46 recorded ids stale. A list that contains only an already recorded id marks the other 45 stale. failures stays empty, so the script writes the reduced module and the process exits 0.",
            trigger: "AvailableModels returns 200 with no models, or with only ids that already have records.",
            consequence: "The release command looks successful and replaces the record with a smaller or empty map.",
          },
          {
            id: "quoted",
            path: "scripts/probe-cursor-image-input.ts",
            line: 53,
            title: "Quoting the probe instruction records a model as text-only",
            explanation: "Any other compacted reply that contains NO IMAGE returns false. A description that quotes that sentence is classified false. Reproduced with an artificial reply.",
            trigger: "The reply contains the letters NO IMAGE in order, including a quotation of the prompt.",
            consequence: "The catalog advertises text only.",
          },
          {
            id: "budget",
            path: "src/image-input.ts",
            line: 343,
            title: "A text follow-up fails when earlier images exceed the remaining budget",
            explanation: "extractCursorHistoryImages applies the combined budget. A decoded image that does not fit the remaining budget throws. Reproduced at a 2-byte budget: history extraction threw, Cursor provider image attachments exceed the 20 MiB limit.",
            trigger: "A later text message arrives whose history images do not fit the remaining budget.",
            consequence: "The follow-up fails before a Run opens.",
          },
          {
            id: "observed",
            path: "src/image-input-data.ts",
            line: 24,
            title: "One successful probe keeps the model advertised as image-capable",
            explanation: "The record stores true. The default probe does not retest an id that already has a record. A later manual series sometimes replied NO IMAGE.",
            trigger: "A user attaches an image after the single recorded success.",
            consequence: "The next default release probe will not change the record.",
          },
          {
            id: "gate",
            path: "scripts/probe-cursor-image-input.ts",
            line: 163,
            title: "The new image release check fails on an unrecorded model",
            explanation: "--check exits when any live id has no record. The only missing id is unrecorded. The command named that id and exited 1.",
            trigger: "The release image step runs while that id remains untested.",
            consequence: "generate:images exits 1 and the release procedure cannot be completed.",
          },
        ],
      })
      const report = JSON.parse(python(["scripts/review-eval.py", "score", "--case", "calibration", "--variant", "subject", "--review", reviewPath]).stdout)
      expect(report.detected).toContain("unusable-discovery-erases-records")
      expect(report.detected).toContain("quoted-refusal-is-decisive")
      expect(report.overbroad).toContain("unusable-discovery-erases-records")
      expect(report.missed).toContain("failed-refresh-skips-next-default")
      expect(report.missed).not.toContain("quoted-refusal-is-decisive")
      const claims = report.falsePositives.flatMap((item: { claims: string[] }) => item.claims)
      expect(claims).toContain("history-budget-rejection")
      expect(claims).toContain("observed-support-is-not-a-guarantee")
      expect(claims).toContain("untested-id-fails-the-release-gate")
      expect(report.evidenceMislabel).toEqual([])
    } finally {
      removeOuts()
    }
  })
})
