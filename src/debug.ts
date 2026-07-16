import fs from "node:fs"

// Wire-level diagnostics. Opt in with CURSOR_PROVIDER_DEBUG=1 (or "true").
// Writes to CURSOR_PROVIDER_DEBUG_FILE (default /tmp/cursor-provider-debug.log).
// Truncated once per process. Tokens / checksums should be redacted by callers.
const DEBUG_ENABLED =
  process.env.CURSOR_PROVIDER_DEBUG === "1" ||
  process.env.CURSOR_PROVIDER_DEBUG === "true"
const DEBUG_FILE = process.env.CURSOR_PROVIDER_DEBUG_FILE || "/tmp/cursor-provider-debug.log"
let _traceInitialized = false

export function trace(msg: string): void {
  if (!DEBUG_ENABLED) return
  try {
    if (!_traceInitialized) {
      _traceInitialized = true
      fs.writeFileSync(
        DEBUG_FILE,
        `--- cursor-provider debug (pid ${process.pid}) ${new Date().toISOString()} ---\n`,
      )
    }
    fs.appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}
