import { afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEBUG_LOG_MAX_BYTES,
  DEBUG_LOG_KEEP_BYTES,
  DEBUG_LOG_TRIM_INTERVAL_MS,
  DEBUG_LOG_TRIM_LOCK_STALE_MS,
  DEBUG_LOG_ROTATE_BACKUPS,
  ensureSecureDebugLog,
  resolveDebugLevel,
  resolveDebugLogOptions,
  resolveDebugLogPath,
  rotateDebugLogIfOversized,
  trimDebugLogIfOversized,
} from "../src/debug.js"

const originalDebugFile = process.env.CURSOR_PROVIDER_DEBUG_FILE

let traceModule = 0

// Subprocess regressions exercise fresh hosts, but their coverage is not part
// of Bun's parent LCOV. Load a fresh, instrumented module for policy coverage.
async function withTrace(
  env: Record<string, string>,
  run: (file: string, load: () => Promise<typeof import("../src/debug.js")>) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-debug-instrumented-"))
  const settings = { CURSOR_PROVIDER_DEBUG: "1", CURSOR_PROVIDER_RECOVERY_DEBUG: "0",
    CURSOR_PROVIDER_DEBUG_LOG_MODE: "trim", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "",
    CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "", CURSOR_PROVIDER_DEBUG_FILE: path.join(root, "debug.log"), ...env }
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  try {
    Object.assign(process.env, settings)
    await run(settings.CURSOR_PROVIDER_DEBUG_FILE,
      () => import(`../src/debug.ts?retention-test-${++traceModule}`))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function withLog(run: (file: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-debug-maintenance-"))
  try {
    run(path.join(root, "debug.log"))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function traceInChild(script: string, env: Record<string, string> = {}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-debug-trace-"))
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import fs from "node:fs";
      import assert from "node:assert/strict";
      import { trace, DEBUG_LOG_MAX_BYTES, DEBUG_LOG_TRIM_INTERVAL_MS }
        from ${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts"))};
      const file = process.env.CURSOR_PROVIDER_DEBUG_FILE;
      function oversize() {
        fs.writeFileSync(file, "expired-record\\n");
        fs.truncateSync(file, DEBUG_LOG_MAX_BYTES + 1);
        fs.appendFileSync(file, "\\nrecent-record\\n");
      }
      ${script}
    `], {
      env: { ...process.env, CURSOR_PROVIDER_DEBUG: "1", CURSOR_PROVIDER_RECOVERY_DEBUG: "0",
        CURSOR_PROVIDER_DEBUG_LOG_MODE: "trim", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "", CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "",
        CURSOR_PROVIDER_DEBUG_FILE: path.join(root, "debug.log"), ...env },
      stdout: "ignore", stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

afterEach(() => {
  if (originalDebugFile === undefined) delete process.env.CURSOR_PROVIDER_DEBUG_FILE
  else process.env.CURSOR_PROVIDER_DEBUG_FILE = originalDebugFile
})

describe("numbered debug log rotation", () => {
  for (const siblingWrites of [false, true]) {
    it(`preserves the detached active file after an archive move fails (sibling=${siblingWrites})`, () => {
      withLog((file) => {
        const original = "incident\n"
        const sibling = "concurrent writer\n"
        const staged = path.join(`${file}.trim`, "active")
        fs.writeFileSync(file, original, { mode: 0o600 })
        fs.writeFileSync(`${file}.1`, "archive-1\n")
        fs.writeFileSync(`${file}.2`, "archive-2\n")
        const rename = fs.renameSync.bind(fs)
        const refused = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(from) === `${file}.2`) {
            if (siblingWrites) fs.writeFileSync(file, sibling, { mode: 0o600 })
            throw new Error("archive move refused")
          }
          return rename(from, to)
        })
        try {
          expect(() => rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 3 })).toThrow("archive move refused")
        } finally {
          refused.mockRestore()
        }
        expect(fs.readFileSync(file, "utf8")).toBe(siblingWrites ? sibling : original)
        expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("archive-1\n")
        expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("archive-2\n")
        if (siblingWrites) {
          expect(fs.readFileSync(staged, "utf8")).toBe(original)
          const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
          fs.utimesSync(`${file}.trim`, stale, stale)
          expect(rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 3 })).toBe(false)
          expect(fs.readFileSync(staged, "utf8")).toBe(original)
          expect(fs.readFileSync(file, "utf8")).toBe(sibling)
        } else {
          expect(fs.existsSync(`${file}.trim`)).toBe(false)
          expect(rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 3 })).toBe(true)
          expect(fs.readFileSync(`${file}.1`, "utf8")).toBe(original)
        }
      })
    })
  }

  it("recovers an abandoned owner marker without deleting unrelated lock contents", () => {
    withLog((file) => {
      fs.writeFileSync(file, "incident\n")
      const lock = `${file}.trim`
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, "owner-00000000-0000-4000-8000-000000000000"), "")
      const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
      fs.utimesSync(lock, stale, stale)
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1 })).toBe(false)
      expect(fs.existsSync(lock)).toBe(false)
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1 })).toBe(true)
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("incident\n")
    })
  })

  it("preserves all archives across repeated active-file rename failures", async () => {
    const warnings = spyOn(console, "error").mockImplementation(() => {})
    try {
      await withTrace({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "1024",
        CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "3" }, async (file, load) => {
        const logger = await load()
        fs.writeFileSync(file, "incident\n" + "x".repeat(2048), { mode: 0o600 })
        for (let index = 1; index <= 4; index++) fs.writeFileSync(`${file}.${index}`, `archive-${index}\n`)
        const rename = fs.renameSync.bind(fs)
        const busy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(from) === file) throw Object.assign(new Error("active log busy"), { code: "EBUSY" })
          return rename(from, to)
        })
        try {
          for (let attempt = 1; attempt <= 3; attempt++) {
            logger.trace(`rename-refused-${attempt}`)
            for (let index = 1; index <= 4; index++) {
              expect(fs.readFileSync(`${file}.${index}`, "utf8")).toBe(`archive-${index}\n`)
            }
            expect(fs.readFileSync(file, "utf8")).toContain(`rename-refused-${attempt}`)
            expect(fs.existsSync(`${file}.trim`)).toBe(false)
          }
        } finally {
          busy.mockRestore()
        }
        logger.trace("rotation-recovered")
        const archived = fs.readFileSync(`${file}.1`, "utf8")
        for (let attempt = 1; attempt <= 3; attempt++) expect(archived).toContain(`rename-refused-${attempt}`)
        expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("archive-1\n")
        expect(fs.readFileSync(`${file}.3`, "utf8")).toBe("archive-2\n")
        expect(fs.existsSync(`${file}.4`)).toBe(false)
        expect(fs.readFileSync(file, "utf8")).toContain("rotation-recovered")
      })
    } finally {
      warnings.mockRestore()
    }
  })

  it("does not reap a replacement lock while its owner is rotating", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-debug-lock-race-"))
    const file = path.join(root, "debug.log")
    const lock = `${file}.trim`
    const children: ReturnType<typeof Bun.spawn>[] = []
    const errors: Array<Promise<string>> = []
    const spawn = (role: "reaper" | "owner") => {
      const child = Bun.spawn([process.execPath, "-e", `
        import fs from "node:fs";
        import { rotateDebugLogIfOversized } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts"))};
        const file = process.argv[1], lock = file + ".trim";
        const lstat = fs.lstatSync.bind(fs);
        let observations = 0;
        fs.lstatSync = (target, ...args) => {
          const result = lstat(target, ...args);
          if (${JSON.stringify(role)} === "reaper" ? String(target) === lock && ++observations === 1
              : String(target) === file && ++observations === 2) {
            process.stdout.write("ready");
            fs.readSync(0, Buffer.alloc(1), 0, 1, null);
          }
          return result;
        };
        rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 3 });
      `, file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      children.push(child)
      errors.push(new Response(child.stderr).text())
      return child
    }
    const ready = async (child: ReturnType<typeof spawn>) => {
      const reader = child.stdout.getReader()
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready")
      } finally {
        reader.releaseLock()
      }
    }
    try {
      fs.writeFileSync(file, "incident\n")
      fs.mkdirSync(lock)
      const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
      fs.utimesSync(lock, stale, stale)
      const reaper = spawn("reaper")
      await ready(reaper)
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1 })).toBe(false)
      expect(fs.existsSync(lock)).toBe(false)
      const owner = spawn("owner")
      await ready(owner)
      reaper.stdin.end()
      expect(await reaper.exited).toBe(0)
      expect(fs.existsSync(lock)).toBe(true)
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1 })).toBe(false)
      owner.stdin.end()
      expect(await owner.exited).toBe(0)
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("incident\n")
      expect(fs.existsSync(lock)).toBe(false)
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.all(children.map(child => child.exited))
      await Promise.all(errors)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects invalid rotation limits before touching the active log", () => {
    withLog((file) => {
      fs.writeFileSync(file, "incident\n")
      for (const options of [{ maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: Infinity },
        { backups: 0 }, { backups: 101 }, { backups: 1.5 }]) {
        expect(() => rotateDebugLogIfOversized(file, options)).toThrow("Invalid debug log rotation")
        expect(fs.readFileSync(file, "utf8")).toBe("incident\n")
        expect(fs.readdirSync(path.dirname(file))).toEqual(["debug.log"])
      }
    })
  })

  for (const recoveryOnly of [false, true]) {
    it(`covers enabled rotation, reloads and failure recovery in process (recovery=${recoveryOnly})`, async () => {
      const warnings = spyOn(console, "error").mockImplementation(() => {})
      try {
        await withTrace({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "1024",
          CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "invalid-backup-count", CURSOR_PROVIDER_DEBUG: recoveryOnly ? "0" : "1",
          CURSOR_PROVIDER_RECOVERY_DEBUG: recoveryOnly ? "1" : "0" }, async (file, load) => {
          const first = await load()
          expect(first.isDebugEnabled()).toBe(!recoveryOnly)
          const prefix = recoveryOnly ? "recovery: " : ""
          fs.writeFileSync(file, "earlier incident\n" + "x".repeat(2048), { mode: 0o600 })
          first.trace(prefix + "first")
          expect(fs.readFileSync(`${file}.1`, "utf8").startsWith("earlier incident\n")).toBe(true)
          expect(fs.readFileSync(file, "utf8")).toContain(prefix + "first")
          const second = await load()
          expect(second.trace).not.toBe(first.trace)
          second.trace(prefix + "after-reload")
          let body = fs.readFileSync(file, "utf8")
          expect(body).toContain(prefix + "first")
          expect(body).toContain(prefix + "after-reload")
          expect(body).toContain("reinit=append")
          fs.appendFileSync(file, "x".repeat(2048))
          fs.mkdirSync(`${file}.1.blocked`)
          fs.renameSync(`${file}.1`, `${file}.2`)
          fs.renameSync(`${file}.1.blocked`, `${file}.1`)
          first.trace(prefix + "rotation-failed-but-appended")
          body = fs.readFileSync(file, "utf8")
          expect(body).toContain(prefix + "rotation-failed-but-appended")
          expect(fs.existsSync(`${file}.trim`)).toBe(false)
          fs.rmdirSync(`${file}.1`)
          second.trace(prefix + "retry-rotated")
          expect(fs.readFileSync(`${file}.1`, "utf8")).toContain(prefix + "rotation-failed-but-appended")
          expect(fs.readFileSync(file, "utf8")).toContain(prefix + "retry-rotated")
          expect(fs.statSync(file).mode & 0o777).toBe(0o600)
          expect(warnings.mock.calls.some(([message]) => String(message).includes("using 5"))).toBe(true)
          expect(warnings.mock.calls.some(([message]) => String(message).includes("invalid-backup-count"))).toBe(false)
        })
      } finally {
        warnings.mockRestore()
      }
    })
  }

  it("defaults to trim and validates opt-in rotation settings", () => {
    expect(resolveDebugLogOptions({})).toEqual({ mode: "trim", maxBytes: DEBUG_LOG_MAX_BYTES, backups: 5, warnings: [] })
    expect(DEBUG_LOG_ROTATE_BACKUPS).toBe(5)
    expect(resolveDebugLogOptions({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate" })).toEqual({ mode: "rotate", maxBytes: DEBUG_LOG_MAX_BYTES, backups: 5, warnings: [] })
    expect(resolveDebugLogOptions({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate",
      CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "1024", CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "3" }))
      .toEqual({ mode: "rotate", maxBytes: 1024, backups: 3, warnings: [] })
    expect(resolveDebugLogOptions({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "unknown" })).toMatchObject({ mode: "trim", warnings: [expect.stringContaining("using trim")] })
    for (const value of ["0", "-1", "1.5", "Infinity", "9007199254740992", "1e3", "bad"]) {
      const options = resolveDebugLogOptions({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate",
        CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: value, CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: value })
      expect(options).toMatchObject({ maxBytes: DEBUG_LOG_MAX_BYTES, backups: 5 })
      expect(options.warnings).toHaveLength(2)
    }
    expect(resolveDebugLogOptions({ CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "101" }).backups).toBe(5)
  })

  it("keeps complete archives in newest-first order and retires the oldest", () => {
    withLog((file) => {
      for (let index = 1; index <= 4; index++) {
        fs.writeFileSync(file, `incident-${index}\n`, { mode: 0o600 })
        expect(rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 3 })).toBe(true)
        const active = fs.readFileSync(file, "utf8")
        expect(active).toContain("debug: size-cap rotate")
        expect(active).not.toContain(`incident-${index}`)
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600)
      }
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("incident-4\n")
      expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("incident-3\n")
      expect(fs.readFileSync(`${file}.3`, "utf8")).toBe("incident-2\n")
      expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["debug.log", "debug.log.1", "debug.log.2", "debug.log.3"])
    })
  })

  it("leaves missing and undersized logs alone and rotates at the threshold", () => {
    withLog((file) => {
      expect(rotateDebugLogIfOversized(file, { maxBytes: 8 })).toBe(false)
      fs.writeFileSync(file, "1234567")
      expect(rotateDebugLogIfOversized(file, { maxBytes: 8 })).toBe(false)
      fs.appendFileSync(file, "8")
      expect(rotateDebugLogIfOversized(file, { maxBytes: 8 })).toBe(true)
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("12345678")
    })
  })

  it("removes excess numbered archives after reducing the count", () => {
    withLog((file) => {
      for (const suffix of ["", ".1", ".2", ".3", ".notes", ".01"]) fs.writeFileSync(`${file}${suffix}`, "keep\n")
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 1 })).toBe(true)
      expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["debug.log", "debug.log.01", "debug.log.1", "debug.log.notes"])
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("keep\n")
    })
  })

  it("replaces archive symlinks without changing their targets", () => {
    if (process.platform === "win32") return
    withLog((file) => {
      const target = `${file}.target`
      fs.writeFileSync(target, "untouched\n", { mode: 0o644 })
      fs.symlinkSync(target, `${file}.1`)
      fs.symlinkSync(target, `${file}.2`)
      fs.writeFileSync(file, "incident\n", { mode: 0o600 })
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1, backups: 2 })).toBe(true)
      expect(fs.lstatSync(`${file}.1`).isSymbolicLink()).toBe(false)
      expect(fs.existsSync(`${file}.2`)).toBe(false)
      expect(fs.readFileSync(target, "utf8")).toBe("untouched\n")
      expect(fs.statSync(target).mode & 0o777).toBe(0o644)
    })
  })

  it("skips a held lock and releases its lock when an archive is blocked", () => {
    withLog((file) => {
      fs.writeFileSync(file, "incident\n")
      fs.mkdirSync(`${file}.trim`)
      expect(rotateDebugLogIfOversized(file, { maxBytes: 1 })).toBe(false)
      fs.rmdirSync(`${file}.trim`)
      fs.mkdirSync(`${file}.1`)
      expect(() => rotateDebugLogIfOversized(file, { maxBytes: 1 })).toThrow("not a regular file")
      expect(fs.readFileSync(file, "utf8")).toBe("incident\n")
      expect(fs.existsSync(`${file}.trim`)).toBe(false)
    })
  })

  it("does not erase the active log when rename fails", () => {
    withLog((file) => {
      fs.writeFileSync(file, "incident\n")
      const rename = spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("rename refused") })
      try {
        expect(() => rotateDebugLogIfOversized(file, { maxBytes: 1 })).toThrow("rename refused")
      } finally {
        rename.mockRestore()
      }
      expect(fs.readFileSync(file, "utf8")).toBe("incident\n")
      expect(fs.existsSync(`${file}.trim`)).toBe(false)
    })
  })

  for (const recoveryOnly of [false, true]) {
    it(`rotates at startup and on subsequent writes without waiting an hour (recovery=${recoveryOnly})`, async () => {
      await traceInChild(`
        fs.writeFileSync(file, "earlier incident\\n" + "x".repeat(2048), { mode: 0o600 });
        const prefix = ${JSON.stringify(recoveryOnly ? "recovery: " : "")};
        trace(prefix + "first");
        assert(fs.readFileSync(file + ".1", "utf8").startsWith("earlier incident\\n"));
        assert(fs.readFileSync(file, "utf8").includes(prefix + "first"));
        fs.appendFileSync(file, "x".repeat(2048));
        trace(prefix + "second");
        assert(fs.readFileSync(file + ".2", "utf8").startsWith("earlier incident\\n"));
        assert(fs.readFileSync(file + ".1", "utf8").includes(prefix + "first"));
        assert(fs.readFileSync(file, "utf8").includes(prefix + "second"));
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      `, { CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "1024",
        CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "2", CURSOR_PROVIDER_DEBUG: recoveryOnly ? "0" : "1",
        CURSOR_PROVIDER_RECOVERY_DEBUG: recoveryOnly ? "1" : "0" })
    })
  }

  it("appends the triggering message after a rotation failure", async () => {
    await traceInChild(`
      oversize();
      fs.mkdirSync(file + ".1");
      trace("still-recorded");
      assert(fs.readFileSync(file, "utf8").includes("still-recorded"));
      assert(fs.statSync(file).size > DEBUG_LOG_MAX_BYTES);
      assert(!fs.existsSync(file + ".trim"));
    `, { CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate" })
  })

  it("keeps appending through module reloads and warns about invalid settings", async () => {
    await traceInChild(`
      const warnings = [];
      console.error = (message) => warnings.push(message);
      trace("before-reload");
      const copy = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts") + "?rotation-copy")});
      assert.notEqual(copy.trace, trace);
      copy.trace("after-reload");
      const body = fs.readFileSync(file, "utf8");
      assert(body.includes("before-reload"));
      assert(body.includes("after-reload"));
      assert(!fs.existsSync(file + ".1"));
      assert(warnings.some(message => message.includes("CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS") && message.includes("using 5")));
      assert(!warnings.some(message => message.includes("sensitive-invalid-value")));
    `, { CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "sensitive-invalid-value" })
  })

  it("creates the active file privately if the post-rename header write fails", async () => {
    await traceInChild(`
      trace("before-rotation");
      fs.appendFileSync(file, "x".repeat(2048));
      const append = fs.appendFileSync.bind(fs);
      fs.appendFileSync = (target, body, ...options) => {
        if (String(body).includes("debug: size-cap rotate")) {
          fs.appendFileSync = append;
          throw new Error("new header failed");
        }
        return append(target, body, ...options);
      };
      trace("after-header-failure");
      assert(fs.readFileSync(file + ".1", "utf8").includes("before-rotation"));
      assert(fs.readFileSync(file, "utf8").includes("after-header-failure"));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert(!fs.existsSync(file + ".trim"));
    `, { CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "1024" })
  })

  it("keeps the first message if another writer rotates during initialization", async () => {
    await traceInChild(`
      fs.writeFileSync(file, "prior incident\\n", { mode: 0o600 });
      const close = fs.closeSync.bind(fs);
      let moved = false;
      fs.closeSync = (fd) => {
        const result = close(fd);
        if (!moved) {
          moved = true;
          fs.renameSync(file, file + ".1");
        }
        return result;
      };
      trace("first-message-survived");
      assert.equal(fs.readFileSync(file + ".1", "utf8"), "prior incident\\n");
      assert(fs.readFileSync(file, "utf8").includes("first-message-survived"));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    `, { CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate" })
  })

  it("retains messages from concurrent provider processes sharing a path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-debug-writers-"))
    const file = path.join(root, "shared.log")
    const children: ReturnType<typeof Bun.spawn>[] = []
    const errors: Array<Promise<string>> = []
    try {
      const gates = ["a", "b"].map(async (writer) => {
        const child = Bun.spawn([process.execPath, "-e", `
          import { trace } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts"))};
          process.stdout.write("ready");
          await Bun.stdin.text();
          for (let i = 0; i < 100; i++) trace("writer-${writer}-" + String(i).padStart(3, "0"));
        `], { env: { ...process.env, CURSOR_PROVIDER_DEBUG: "1", CURSOR_PROVIDER_DEBUG_FILE: file,
          CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "1024",
          CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "100" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
        children.push(child)
        errors.push(new Response(child.stderr).text())
        const reader = child.stdout.getReader()
        const ready = await reader.read()
        expect(new TextDecoder().decode(ready.value)).toBe("ready")
        reader.releaseLock()
        return child
      })
      const ready = await Promise.all(gates)
      for (const child of ready) child.stdin.end()
      expect(await Promise.all(ready.map(child => child.exited))).toEqual([0, 0])
      const files = fs.readdirSync(root)
      expect(files).not.toContain("shared.log.trim")
      const records = files.map(name => fs.readFileSync(path.join(root, name), "utf8")).join("\n")
      const messages = records.match(/writer-[ab]-\d{3}/g) ?? []
      expect(messages).toHaveLength(200)
      expect(new Set(messages).size).toBe(200)
      for (const name of files) expect(fs.statSync(path.join(root, name)).mode & 0o777).toBe(0o600)
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.all(children.map(child => child.exited))
      await Promise.all(errors)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("debug log paths / modes (F9)", () => {
  it("covers the shared hourly trim schedule and a failed check in process", async () => {
    let clock = Date.now()
    const now = spyOn(Date, "now").mockImplementation(() => clock)
    const warnings = spyOn(console, "error").mockImplementation(() => {})
    try {
      await withTrace({}, async (file, load) => {
        const first = await load()
        first.trace("initial")
        fs.writeFileSync(file, "expired-record\n")
        fs.truncateSync(file, DEBUG_LOG_MAX_BYTES + 1)
        fs.appendFileSync(file, "\nrecent-record\n")
        first.trace("before-hour")
        const second = await load()
        second.trace("after-reload")
        clock += DEBUG_LOG_TRIM_INTERVAL_MS - 1
        first.trace("still-before-hour")
        expect(fs.statSync(file).size).toBeGreaterThan(DEBUG_LOG_MAX_BYTES)
        clock += 1
        second.trace("after-hour")
        const body = fs.readFileSync(file, "utf8")
        expect(body.startsWith("recent-record\n")).toBe(true)
        for (const message of ["before-hour", "after-reload", "still-before-hour", "after-hour"]) {
          expect(body).toContain(message)
        }
        expect(body.match(/debug: size-cap trim/g)).toHaveLength(1)
        clock += DEBUG_LOG_TRIM_INTERVAL_MS
        const rename = fs.renameSync.bind(fs)
        const lock = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(to) === `${file}.trim`) throw new Error("lock creation refused")
          return rename(from, to)
        })
        try {
          first.trace("maintenance-failed-but-appended")
          expect(lock).toHaveBeenCalledTimes(1)
        } finally {
          lock.mockRestore()
        }
        expect(fs.readFileSync(file, "utf8")).toContain("maintenance-failed-but-appended")
        expect(fs.existsSync(`${file}.trim`)).toBe(false)
      })
    } finally {
      now.mockRestore()
      warnings.mockRestore()
    }
  })

  it("keeps recent diagnostics when starting with an oversized override", async () => {
    await traceInChild(`
      oversize();
      trace("after-restart");
      const log = fs.readFileSync(file, "utf8");
      assert(log.startsWith("recent-record\\n"));
      assert(log.includes("debug: size-cap trim"));
      assert(log.includes("after-restart"));
      assert(log.includes("reinit=append"));
      assert(!fs.existsSync(file + ".trim"));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    `)
  })

  it("checks hourly on writes and shares the cadence across module reloads", async () => {
    await traceInChild(`
      let clock = Date.now();
      Date.now = () => clock;
      trace("initial");
      oversize();
      trace("before-hour");
      const copy = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts") + "?maintenance-copy")});
      assert.notEqual(copy.trace, trace);
      copy.trace("reloaded-copy");
      assert(fs.statSync(file).size > DEBUG_LOG_MAX_BYTES);
      clock += DEBUG_LOG_TRIM_INTERVAL_MS - 1;
      trace("still-before-hour");
      assert(fs.statSync(file).size > DEBUG_LOG_MAX_BYTES);
      clock += 1;
      copy.trace("after-hour");
      const log = fs.readFileSync(file, "utf8");
      assert(log.startsWith("recent-record\\n"));
      assert(log.includes("before-hour"));
      assert(log.includes("reloaded-copy"));
      assert(log.includes("still-before-hour"));
      assert(log.includes("after-hour"));
      assert.equal(log.split("debug: size-cap trim").length - 1, 1);
    `)
  })

  it("still appends when maintenance fails", async () => {
    await traceInChild(`
      oversize();
      const rename = fs.renameSync.bind(fs);
      fs.renameSync = (from, to) => {
        if (String(to).endsWith(".trim")) throw new Error("maintenance denied");
        return rename(from, to);
      };
      trace("maintenance-failed-but-appended");
      assert(fs.readFileSync(file, "utf8").includes("maintenance-failed-but-appended"));
      assert(fs.statSync(file).size > DEBUG_LOG_MAX_BYTES);
    `)
  })

  it("recycles recovery-only logs with the same policy", async () => {
    await traceInChild(`
      oversize();
      trace("payload-must-not-appear");
      assert(fs.statSync(file).size > DEBUG_LOG_MAX_BYTES);
      trace("recovery: after-restart");
      const log = fs.readFileSync(file, "utf8");
      assert(log.startsWith("recent-record\\n"));
      assert(log.includes("recovery: after-restart"));
      assert(!log.includes("payload-must-not-appear"));
    `, { CURSOR_PROVIDER_DEBUG: "0", CURSOR_PROVIDER_RECOVERY_DEBUG: "1" })
  })

  it("logs recovery metadata without enabling payload traces", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-recovery-log-"))
    const file = path.join(root, "recovery.log")
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        import { trace } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts"))};
        trace("wire payload must not appear");
        trace("recovery: interrupted sessionId=test pending=0");
      `], { env: { ...process.env, CURSOR_PROVIDER_DEBUG: "0", CURSOR_PROVIDER_RECOVERY_DEBUG: "1", CURSOR_PROVIDER_DEBUG_FILE: file },
        stdout: "ignore", stderr: "pipe" })
      expect(await child.exited).toBe(0)
      const log = fs.readFileSync(file, "utf8")
      expect(log).toContain("recovery: interrupted sessionId=test pending=0")
      expect(log).not.toContain("wire payload")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it("defaults under per-uid cursor-provider-logs dir", () => {
    delete process.env.CURSOR_PROVIDER_DEBUG_FILE
    const uid = typeof process.getuid === "function" ? process.getuid() : process.pid
    const resolved = resolveDebugLogPath()
    expect(resolved).toBe(
      path.join(os.tmpdir(), `cursor-provider-logs-${uid}`, `debug-${process.pid}.log`),
    )
  })

  it("honors CURSOR_PROVIDER_DEBUG_FILE override", () => {
    process.env.CURSOR_PROVIDER_DEBUG_FILE = "/tmp/custom-cursor-provider.debug"
    expect(resolveDebugLogPath()).toBe("/tmp/custom-cursor-provider.debug")
  })

  it("creates per-user dir 0o700 and log file 0o600", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-test-"))
    const dir = path.join(root, "cursor-provider-logs-test")
    const file = path.join(dir, "debug.log")
    try {
      ensureSecureDebugLog(file)
      const dirMode = fs.statSync(dir).mode & 0o777
      const fileMode = fs.statSync(file).mode & 0o777
      expect(dirMode).toBe(0o700)
      expect(fileMode).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not change permissions on an override path's parent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-override-test-"))
    const file = path.join(root, "debug.log")
    try {
      fs.chmodSync(root, 0o755)
      ensureSecureDebugLog(file, { secureParent: false })
      expect(fs.statSync(root).mode & 0o777).toBe(0o755)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a symlink in place of the managed debug directory", () => {
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-symlink-test-"))
    const target = path.join(root, "target")
    const linkedDir = path.join(root, "managed")
    try {
      fs.mkdirSync(target)
      fs.symlinkSync(target, linkedDir)
      expect(() => ensureSecureDebugLog(path.join(linkedDir, "debug.log"))).toThrow(
        "not a real directory",
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not wipe an existing log on ensureSecureDebugLog", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-preserve-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "prior EMITTED tool-call\n", { mode: 0o600 })
      ensureSecureDebugLog(file, { secureParent: false })
      expect(fs.readFileSync(file, "utf8")).toBe("prior EMITTED tool-call\n")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("follows OpenCode's 50/25 MiB hourly retention policy", () => {
    expect(DEBUG_LOG_MAX_BYTES).toBe(50 * 1024 * 1024)
    expect(DEBUG_LOG_KEEP_BYTES).toBe(25 * 1024 * 1024)
    expect(DEBUG_LOG_TRIM_INTERVAL_MS).toBe(60 * 60 * 1000)
    expect(DEBUG_LOG_TRIM_LOCK_STALE_MS).toBe(5 * 60 * 1000)
  })

  it("rejects invalid trim limits without changing the log", () => {
    withLog((file) => {
      fs.writeFileSync(file, "incident\n")
      for (const options of [{ maxBytes: 0 }, { maxBytes: Infinity }, { maxBytes: 1.5 },
        { keepBytes: 0 }, { keepBytes: -1 }, { keepBytes: 1.5 }, { maxBytes: 10, keepBytes: 10 }]) {
        expect(() => trimDebugLogIfOversized(file, options)).toThrow("0 < keepBytes < maxBytes")
        expect(fs.readFileSync(file, "utf8")).toBe("incident\n")
        expect(fs.readdirSync(path.dirname(file))).toEqual(["debug.log"])
      }
    })
  })

  it("preserves a nonempty abandoned lock and the active log", () => {
    withLog((file) => {
      fs.writeFileSync(file, "old\ncut\nretained\n")
      const lock = `${file}.trim`
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, "owner"), "still owned")
      const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
      fs.utimesSync(lock, stale, stale)
      expect(trimDebugLogIfOversized(file, { maxBytes: 16, keepBytes: 11 })).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("old\ncut\nretained\n")
      expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe("still owned")
    })
  })

  it("preserves a populated replacement at the final stale-lock removal", () => {
    withLog((file) => {
      fs.writeFileSync(file, "incident\n")
      const lock = `${file}.trim`
      const marker = path.join(lock, "owner-00000000-0000-4000-8000-000000000001")
      fs.mkdirSync(lock)
      const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
      fs.utimesSync(lock, stale, stale)
      const rmdir = fs.rmdirSync.bind(fs)
      const remove = spyOn(fs, "rmdirSync").mockImplementationOnce((target) => {
        expect(String(target)).toBe(lock)
        rmdir(lock)
        fs.mkdirSync(lock)
        fs.writeFileSync(marker, "new owner")
        return rmdir(lock)
      })
      try {
        expect(rotateDebugLogIfOversized(file, { maxBytes: 1 })).toBe(false)
      } finally {
        remove.mockRestore()
      }
      expect(fs.readFileSync(marker, "utf8")).toBe("new owner")
      expect(fs.readFileSync(file, "utf8")).toBe("incident\n")
    })
  })

  it("leaves undersized logs alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-under-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "keep me\n", { mode: 0o600 })
      expect(trimDebugLogIfOversized(file, { maxBytes: 1024, keepBytes: 512 })).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("keep me\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves missing files and logs exactly at the threshold alone", () => {
    withLog((file) => {
      const limits = { maxBytes: 32, keepBytes: 16 }
      expect(trimDebugLogIfOversized(file, limits)).toBe(false)
      fs.writeFileSync(file, "x".repeat(32))
      expect(trimDebugLogIfOversized(file, limits)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("x".repeat(32))
      expect(fs.readdirSync(path.dirname(file))).toEqual(["debug.log"])
    })
  })

  it("scans long lines and copies multiple chunks without corrupting UTF-8", () => {
    withLog((file) => {
      const tail = "recent 😄\n".repeat(18000)
      const original = `expired\n${"x".repeat(150000)}\n${tail}`
      fs.writeFileSync(file, original)
      expect(trimDebugLogIfOversized(file, {
        maxBytes: Buffer.byteLength(original) - 1,
        keepBytes: Buffer.byteLength(tail) + 100000,
      })).toBe(true)
      const body = fs.readFileSync(file, "utf8")
      expect(body.startsWith(tail)).toBe(true)
      expect(body.slice(tail.length)).toMatch(/^\[.*\] debug: size-cap trim .*\n$/)
    })
  })

  it("drops an oversized partial line instead of retaining a broken record", () => {
    withLog((file) => {
      fs.writeFileSync(file, "x".repeat(100))
      expect(trimDebugLogIfOversized(file, { maxBytes: 50, keepBytes: 25 })).toBe(true)
      expect(fs.readFileSync(file, "utf8")).toMatch(/^\[.*\] debug: size-cap trim .*keptBytes=0 /)
    })
  })

  it("skips a live trimmer and recovers an abandoned lock on a later check", () => {
    withLog((file) => {
      const original = "old\ncut\nretained\n"
      const limits = { maxBytes: 16, keepBytes: 11 }
      fs.writeFileSync(file, original)
      fs.mkdirSync(`${file}.trim`)
      expect(trimDebugLogIfOversized(file, limits)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe(original)
      expect(fs.existsSync(`${file}.trim`)).toBe(true)
      const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
      fs.utimesSync(`${file}.trim`, stale, stale)
      expect(trimDebugLogIfOversized(file, limits)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe(original)
      expect(fs.existsSync(`${file}.trim`)).toBe(false)
      expect(trimDebugLogIfOversized(file, limits)).toBe(true)
      expect(fs.existsSync(`${file}.trim`)).toBe(false)
    })
  })

  it("does not remove a symlink masquerading as a stale trim lock", () => {
    if (process.platform === "win32") return
    withLog((file) => {
      fs.writeFileSync(file, "old\ncut\nretained\n")
      const target = `${file}.target`
      fs.mkdirSync(target)
      const stale = new Date(Date.now() - DEBUG_LOG_TRIM_LOCK_STALE_MS - 1000)
      fs.utimesSync(target, stale, stale)
      fs.symlinkSync(target, `${file}.trim`)
      expect(trimDebugLogIfOversized(file, { maxBytes: 16, keepBytes: 11 })).toBe(false)
      expect(fs.lstatSync(`${file}.trim`).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(target)).toBe(true)
      expect(fs.readFileSync(file, "utf8")).toBe("old\ncut\nretained\n")
    })
  })

  it("releases the handle and lock after a read failure without erasing the log", () => {
    withLog((file) => {
      const original = "old\ncut\nretained\n"
      fs.writeFileSync(file, original)
      const read = spyOn(fs, "readSync").mockImplementationOnce(() => { throw new Error("read failed") })
      const close = spyOn(fs, "closeSync")
      try {
        expect(() => trimDebugLogIfOversized(file, { maxBytes: 16, keepBytes: 11 })).toThrow("read failed")
        expect(close).toHaveBeenCalledTimes(1)
        expect(fs.existsSync(`${file}.trim`)).toBe(false)
      } finally {
        read.mockRestore()
        close.mockRestore()
      }
      expect(fs.readFileSync(file, "utf8")).toBe(original)
      expect(trimDebugLogIfOversized(file, { maxBytes: 16, keepBytes: 11 })).toBe(true)
    })
  })

  it("keeps recent complete UTF-8 lines and existing append handles in place", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-trim-"))
    const file = path.join(root, "debug.log")
    const tail = "recent α\nnewest β\n"
    const original = `discarded\ncut-me\n${tail}`
    let appender: number | undefined
    try {
      fs.writeFileSync(file, original, { mode: 0o600 })
      appender = fs.openSync(file, "a")
      const inode = fs.statSync(file).ino
      expect(trimDebugLogIfOversized(file, {
        maxBytes: Buffer.byteLength(original) - 1, keepBytes: Buffer.byteLength(tail) + 3,
      })).toBe(true)
      fs.writeSync(appender, "held appender\n")
      const body = fs.readFileSync(file, "utf8")
      expect(body.startsWith(tail)).toBe(true)
      expect(body).not.toContain("discarded")
      expect(body).not.toContain("cut-me")
      expect(body).toContain("debug: size-cap trim")
      expect(body).toContain(`keptBytes=${Buffer.byteLength(tail)}`)
      expect(body.endsWith("held appender\n")).toBe(true)
      expect(fs.statSync(file).ino).toBe(inode)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(root)).toEqual(["debug.log"])
    } finally {
      if (appender !== undefined) fs.closeSync(appender)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("debug log levels", () => {
  type Debug = typeof import("../src/debug.js")
  /** A fresh module copy at this level, writing to its own file, in this process. */
  const atLevel = async (level: string, run: (debug: Debug, file: string) => void | Promise<void>,
    env: Record<string, string> = {}) => {
    const announce = spyOn(console, "error").mockImplementation(() => {})
    try {
      await withTrace({ CURSOR_PROVIDER_DEBUG: level, ...env }, async (file, load) => run(await load(), file))
    } finally {
      announce.mockRestore()
    }
  }
  /** Messages after the timestamp and any module-copy tag, without the module's own `debug:` lines. */
  const messages = (file: string) => fs.readFileSync(file, "utf8").split("\n")
    .map((line) => line.match(/^\[[^\]]+\] (?:#\d+ )?(.*)$/)?.[1])
    .filter((line): line is string => line !== undefined && !line.startsWith("debug: "))
  const toolLines = (file: string) => messages(file).filter((line) => line.startsWith("tools=a"))
  const traceAll = (debug: Debug) => {
    debug.trace("plain line")
    debug.traceVerbose("pump frame: verbose only")
    for (const list of ["a", "a", "b", "a"]) {
      debug.traceOncePerLog(`tools:${list}`, `tools=${list} [full ${list}]`, `tools=${list}`)
    }
  }

  it("reads CURSOR_PROVIDER_DEBUG as level 0, 1 or 2", () => {
    expect(resolveDebugLevel("1")).toBe(1)
    expect(resolveDebugLevel("true")).toBe(1)
    expect(resolveDebugLevel("2")).toBe(2)
    expect(resolveDebugLevel("verbose")).toBe(2)
    for (const off of [undefined, "", "0", "false", "3", "TRUE"]) expect(resolveDebugLevel(off)).toBe(0)
  })

  it("keeps per-frame lines for level 2 and writes a repeated list in full once at level 1", async () => {
    await atLevel("1", (debug, file) => {
      traceAll(debug)
      expect(messages(file)).toEqual(["plain line", "tools=a [full a]", "tools=a", "tools=b [full b]", "tools=a"])
    })
    await atLevel("verbose", (debug, file) => {
      traceAll(debug)
      expect(messages(file)).toEqual([
        "plain line", "pump frame: verbose only", "tools=a [full a]", "tools=a [full a]", "tools=b [full b]", "tools=a [full a]",
      ])
    })
    await atLevel("0", (debug, file) => {
      traceAll(debug)
      expect(fs.existsSync(file)).toBe(false)
    })
  })

  it("evicts the least recently used key past 4096", async () => {
    await atLevel("1", (debug, file) => {
      const once = (key: string) => debug.traceOncePerLog(key, `${key} full`, `${key} brief`)
      for (let i = 0; i < 4096; i++) once(`k${i}`)
      once("k0")
      once("k4096")
      once("k0")
      once("k1")
      expect(messages(file).slice(-4)).toEqual(["k0 brief", "k4096 full", "k0 brief", "k1 full"])
    })
  })

  it("writes the full line again when the first one could not be written", async () => {
    await atLevel("1", (debug, file) => {
      const once = () => debug.traceOncePerLog("tools:a", "tools=a [full]", "tools=a")
      debug.trace("start")
      fs.chmodSync(file, 0o400)
      once()
      fs.chmodSync(file, 0o600)
      once()
      once()
      // Root ignores the read-only mode, so the first line may get through there.
      expect(messages(file)).toEqual(process.getuid?.() === 0
        ? ["start", "tools=a [full]", "tools=a", "tools=a"]
        : ["start", "tools=a [full]", "tools=a"])
    })
  })

  // A child: language-model.ts writes through this process's own debug module, which is off here.
  it("logs extractTools' name list once per list at level 1 and every time at level 2", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-extract-tools-"))
    const runLevel = (level: string, file: string, script: string) => Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, CURSOR_PROVIDER_DEBUG: level, CURSOR_PROVIDER_RECOVERY_DEBUG: "0", CURSOR_PROVIDER_DEBUG_FILE: file,
        CURSOR_PROVIDER_DEBUG_LOG_MODE: "trim", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "", CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "" },
    })
    const script = `
      import { extractTools } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/language-model.ts"))}
      const tool = (name) => ({ type: "function", name, inputSchema: { type: "object" } })
      const call = (...names) => extractTools({ tools: names.map(tool) })
      call("read", "edit")
      call("read", "edit")
      call("read", "edit", "shell")
      call("read", "edit")
    `
    try {
      const tools = (level: string) => {
        const file = path.join(root, `level-${level}.log`)
        expect(runLevel(level, file, script).exitCode).toBe(0)
        return messages(file).filter((line) => line.startsWith("extractTools:"))
      }
      const one = tools("1")
      expect(one.map((line) => line.replace(/tools=[0-9a-f]{12}/, "tools=H"))).toEqual([
        "extractTools: 2 incoming → 2 advertised tools=H [read,edit]",
        "extractTools: 2 incoming → 2 advertised tools=H",
        "extractTools: 3 incoming → 3 advertised tools=H [read,edit,shell]",
        "extractTools: 2 incoming → 2 advertised tools=H",
      ])
      const hashes = one.map((line) => line.match(/tools=([0-9a-f]{12})/)![1])
      expect(hashes[0]).toBe(hashes[1]!)
      expect(hashes[0]).toBe(hashes[3]!)
      expect(hashes[2]).not.toBe(hashes[0]!)
      expect(tools("2").every((line) => line.endsWith("]"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("writes a list in full again in the file a rotation starts", async () => {
    await atLevel("1", (debug, file) => {
      for (let i = 0; i < 60; i++) {
        debug.traceOncePerLog("tools:a", `tools=a [full] ${i} ${"z".repeat(60)}`, `tools=a ${i} ${"z".repeat(60)}`)
      }
      for (const part of [`${file}.1`, file]) {
        const lines = messages(part)
        expect(lines.length).toBeGreaterThan(1)
        expect(lines[0]).toStartWith("tools=a [full] ")
        expect(lines.slice(1).every((line) => !line.includes("[full]"))).toBe(true)
      }
    }, { CURSOR_PROVIDER_DEBUG_LOG_MODE: "rotate", CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES: "2000", CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS: "1" })
  })

  it("writes a list in full again after a trim", async () => {
    let clock = Date.now()
    const now = spyOn(Date, "now").mockImplementation(() => clock)
    try {
      await atLevel("1", (debug, file) => {
        const once = () => debug.traceOncePerLog("tools:a", "tools=a [full]", "tools=a")
        once()
        once()
        fs.writeFileSync(file, "expired-record\n")
        fs.truncateSync(file, DEBUG_LOG_MAX_BYTES + 1)
        fs.appendFileSync(file, "\nrecent-record\n")
        clock += DEBUG_LOG_TRIM_INTERVAL_MS
        once()
        once()
        const log = fs.readFileSync(file, "utf8").split("\n")
        expect(log[0]).toBe("recent-record")
        expect(log[1]).toMatch(/debug: size-cap trim/)
        expect(log.slice(2, 4).map((line) => line.replace(/^\[[^\]]+\] (?:#\d+ )?/, ""))).toEqual(["tools=a [full]", "tools=a"])
      })
    } finally {
      now.mockRestore()
    }
  })

  it("writes a list in full again after another process rotates, trims or replaces the file, and every 10 minutes", async () => {
    let clock = Date.now()
    const now = spyOn(Date, "now").mockImplementation(() => clock)
    try {
      await atLevel("1", (debug, file) => {
        const twice = () => {
          debug.traceOncePerLog("tools:a", "tools=a [full]", "tools=a")
          debug.traceOncePerLog("tools:a", "tools=a [full]", "tools=a")
        }
        twice()
        expect(toolLines(file)).toEqual(["tools=a [full]", "tools=a"])
        // Rotated: a new file at the path.
        fs.renameSync(file, `${file}.1`)
        twice()
        expect(toolLines(file)).toEqual(["tools=a [full]", "tools=a"])
        // Trimmed in place to less than it held.
        fs.truncateSync(file, 0)
        twice()
        expect(toolLines(file)).toEqual(["tools=a [full]", "tools=a"])
        // Trimmed in place and grown back past its old size: only its first bytes changed.
        fs.writeFileSync(file, `[2026-01-01T00:00:00.000Z] kept tail\n${"x".repeat(fs.statSync(file).size)}\n`)
        twice()
        expect(toolLines(file)).toEqual(["tools=a [full]", "tools=a"])
        // Replaced by a copy on another inode with the same bytes.
        fs.copyFileSync(file, `${file}.copy`)
        fs.renameSync(`${file}.copy`, file)
        twice()
        expect(toolLines(file)).toEqual(["tools=a [full]", "tools=a", "tools=a [full]", "tools=a"])
        clock += 10 * 60 * 1000 - 1
        twice()
        expect(toolLines(file).slice(4)).toEqual(["tools=a", "tools=a"])
        clock += 1
        twice()
        expect(toolLines(file).slice(6)).toEqual(["tools=a [full]", "tools=a"])
      })
    } finally {
      now.mockRestore()
    }
  })
})
