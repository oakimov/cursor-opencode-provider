import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Wire-level diagnostics. Opt in with CURSOR_PROVIDER_DEBUG=1 (or "true").
// Default path mirrors Cursor CLI: $TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log
// with directory mode 0o700 and file mode 0o600. Override with CURSOR_PROVIDER_DEBUG_FILE.
// Truncated once per process. Tokens / checksums should be redacted by callers.
const DEBUG_ENABLED =
  process.env.CURSOR_PROVIDER_DEBUG === "1" ||
  process.env.CURSOR_PROVIDER_DEBUG === "true"

let _traceInitialized = false
let _debugFile: string | undefined
let _debugFileUsesManagedDirectory = false

/** Resolve the debug log path (env override or per-uid tmpdir default). */
export function resolveDebugLogPath(): string {
  if (process.env.CURSOR_PROVIDER_DEBUG_FILE) {
    return process.env.CURSOR_PROVIDER_DEBUG_FILE
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid
  return path.join(os.tmpdir(), `cursor-provider-logs-${uid}`, `debug-${process.pid}.log`)
}

/**
 * Ensure the log directory is 0o700 and create/truncate the log file as 0o600.
 * Exported for tests; callers normally go through `trace`.
 */
export function ensureSecureDebugLog(
  filePath: string,
  options: { secureParent?: boolean } = {},
): void {
  const dir = path.dirname(filePath)
  const secureParent = options.secureParent ?? true
  fs.mkdirSync(dir, secureParent
    ? { recursive: true, mode: 0o700 }
    : { recursive: true })
  if (secureParent) {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Debug log directory is not a real directory: ${dir}`)
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Debug log directory is not owned by the current user: ${dir}`)
    }
    fs.chmodSync(dir, 0o700)
  }
  fs.writeFileSync(filePath, "", { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

export function trace(msg: string): void {
  if (!DEBUG_ENABLED) return
  try {
    if (!_debugFile) {
      _debugFileUsesManagedDirectory = !process.env.CURSOR_PROVIDER_DEBUG_FILE
      _debugFile = resolveDebugLogPath()
    }
    if (!_traceInitialized) {
      ensureSecureDebugLog(_debugFile, { secureParent: _debugFileUsesManagedDirectory })
      fs.writeFileSync(
        _debugFile,
        `--- cursor-provider debug (pid ${process.pid}) ${new Date().toISOString()} ---\n`,
        { mode: 0o600 },
      )
      _traceInitialized = true
    }
    fs.appendFileSync(_debugFile, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}
