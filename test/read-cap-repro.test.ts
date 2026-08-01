import { describe, it, expect } from "bun:test"
import { buildTypedExecResult, unwrapReadOutput } from "../src/protocol/tools.js"

/**
 * Deterministic reproduction of the large-file data-loss chain reported as
 * "writing large files truncates at ~50 KB".
 *
 * The truncation is on the READ, not the write. OpenCode's read tool caps
 * output at `MAX_BYTES = 50 * 1024` (`packages/opencode/src/tool/read.ts:16`),
 * cutting on a whole-line boundary, and appends a footer saying so. The
 * provider strips the read envelope before handing content to Cursor — by
 * design, so the model cannot echo wrappers into a later write — which used to
 * discard that footer too. The model then believed a capped read was the whole
 * file, rewrote it from what it had, and everything past the cap was lost.
 *
 * Cursor's own CLI caps identically (`local-exec` `const io = 51200`) but never
 * silently: it annotates every capped payload and hands back a path to the full
 * output. These tests pin both halves — the exact cap arithmetic, and the fact
 * that the provider now re-states it.
 */

const MAX_BYTES = 50 * 1024

/** Fixed-width fixture line: exactly 63 bytes, so the cut point is exact. */
function fixtureLine(n: number): string {
  const id = String(n).padStart(4, "0")
  return `LINE ${id} ${".".repeat(44)} KEEP${id}`
}

/** ~75 KB fixture — same order of magnitude as the reported file. */
function buildFixture(totalLines = 1200): string[] {
  return Array.from({ length: totalLines }, (_, i) => fixtureLine(i + 1))
}

/**
 * Byte-for-byte port of opencode's read accumulation loop
 * (`tool/read.ts:162-173`) and its output envelope (`:338-351`).
 */
function opencodeRead(
  allLines: string[],
  filePath: string,
  opts: { limit?: number; offset?: number } = {},
): { output: string; keptLines: number; bytes: number } {
  const limit = opts.limit ?? 2000
  const offset = opts.offset ?? 1
  const raw: string[] = []
  let bytes = 0
  let cut = false
  let more = false

  for (let i = offset - 1; i < allLines.length; i++) {
    if (raw.length >= limit) {
      more = true
      break
    }
    const line = allLines[i]
    const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size <= MAX_BYTES) {
      raw.push(line)
      bytes += size
      continue
    }
    cut = true
    more = true
    break
  }

  let output = [`<path>${filePath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
  output += raw.map((line, i) => `${i + offset}: ${line}`).join("\n")
  const last = offset + raw.length - 1
  const next = last + 1
  if (cut) {
    output += `\n\n(Output capped at 50 KB. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`
  } else if (more) {
    output += `\n\n(Showing lines ${offset}-${last} of ${allLines.length}. Use offset=${next} to continue.)`
  } else {
    output += `\n\n(End of file - total ${allLines.length} lines)`
  }
  output += "\n</content>"
  return { output, keptLines: raw.length, bytes }
}

describe("opencode read cap arithmetic", () => {
  it("cuts a 75 KB fixture at exactly 800 lines / 51,199 bytes", () => {
    const fixture = buildFixture(1200)
    // 63 bytes per line, +1 for every newline after the first:
    //   63 + 64*(n-1) = 64n - 1  ->  n = 800 gives 51,199 (<= 51,200)
    //                                n = 801 gives 51,263 (>  51,200)
    expect(Buffer.byteLength(fixture[0], "utf8")).toBe(63)
    const { keptLines, bytes } = opencodeRead(fixture, "big.txt")
    expect(keptLines).toBe(800)
    expect(bytes).toBe(51_199)
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES)
  })

  it("lands just under the cap regardless of line width", () => {
    // The reported captures were 51,144 and 51,167 bytes — different totals for
    // different files, both under 51,200. That variation is the signature of a
    // whole-line cut, not a fixed byte slice.
    for (const width of [37, 63, 101, 250]) {
      const lines = Array.from({ length: 4000 }, () => "x".repeat(width))
      const { bytes } = opencodeRead(lines, "f.txt")
      expect(bytes).toBeLessThanOrEqual(MAX_BYTES)
      expect(bytes).toBeGreaterThan(MAX_BYTES - width - 1)
    }
  })

  it("returns a file under the cap intact", () => {
    // The reporter's 35.6 KB file survived; this is why.
    const fixture = buildFixture(500)
    const { output, keptLines } = opencodeRead(fixture, "small.txt")
    expect(keptLines).toBe(500)
    expect(output).toContain("(End of file - total 500 lines)")
  })
})

describe("the data loss this causes", () => {
  const fixture = buildFixture(1200)
  const { output } = opencodeRead(fixture, "big.txt")

  it("hands the model only the first 800 lines", () => {
    const content = unwrapReadOutput(output)
    const lines = content.split("\n")
    expect(lines).toHaveLength(800)
    expect(lines[0]).toBe(fixtureLine(1))
    expect(lines[799]).toBe(fixtureLine(800))
    // The tail the model never sees. A rewrite from this content deletes it.
    expect(content).not.toContain("KEEP1200")
    expect(fixture[1199]).toContain("KEEP1200")
  })

  it("strips the footer from the content stream", () => {
    // Deliberate: anything left in the content is echoed back into the next
    // write. The fix is to re-state the cap elsewhere, not to keep the footer.
    const content = unwrapReadOutput(output)
    expect(content).not.toContain("Output capped")
    expect(content).not.toContain("<content>")
  })
})

describe("the provider now reports the cap", () => {
  const fixture = buildFixture(1200)
  const capped = opencodeRead(fixture, "big.txt").output
  const complete = opencodeRead(buildFixture(500), "small.txt").output

  it("attaches a partial-read notice to a capped MCP read", () => {
    const result = buildTypedExecResult("mcp_result", capped, undefined, "read") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(result.success.content).toHaveLength(2)
    // Content item stays byte-exact — still safe to echo into a write.
    expect(result.success.content[0].text.text.split("\n")).toHaveLength(800)
    const notice = result.success.content[1].text.text
    expect(notice).toContain("NOT the complete file")
    expect(notice).toContain("offset=801")
    expect(notice).toContain("after line 800")
  })

  it("reports a capped Pi read structurally", () => {
    const result = buildTypedExecResult("pi_read_result", capped, undefined, "read") as {
      success: { truncation?: Record<string, unknown> }
    }
    expect(result.success.truncation).toMatchObject({
      truncated: true,
      truncated_by: "bytes",
      output_lines: 800,
      max_bytes: MAX_BYTES,
    })
  })

  it("appends the notice to a capped native read_result", () => {
    // This is the path live captures actually use: gpt-5.4-mini and grok-4.5
    // both read through Cursor's native read_args, not mcp_args. The
    // structured `truncated` flag alone did not stop models asserting that
    // partial content was the whole file.
    const result = buildTypedExecResult("read_result", capped, undefined, "read", {
      path: "big.txt",
    }) as { success: { content: string; truncated: boolean } }
    expect(result.success.truncated).toBe(true)
    expect(result.success.content).toContain("NOT the complete file")
    expect(result.success.content.split("\n")[0]).toBe(fixtureLine(1))
  })

  it("does not cry wolf on a deliberately paged read", () => {
    // An explicit offset/limit means the caller asked for a slice; only an
    // involuntary cap warrants the warning.
    const paged = opencodeRead(buildFixture(1200), "big.txt", { limit: 5 }).output
    const result = buildTypedExecResult("read_result", paged, undefined, "read", {
      path: "big.txt",
      offset: 1,
      limit: 5,
    }) as { success: { content: string } }
    expect(result.success.content).not.toContain("Partial read")
  })

  it("is not fooled by a file that quotes a read footer", () => {
    // This repository's own README and tests contain that sentence. Scanning
    // the whole envelope instead of just the footer would report a complete
    // read as truncated.
    const body = [
      "1: The read tool prints:",
      "2: (Output capped at 50 KB. Showing lines 1-2. Use offset=3 to continue.)",
      "3: ...and that is the end.",
    ].join("\n")
    const output = [
      "<path>doc.md</path>",
      "<type>file</type>",
      "<content>\n" + body,
      "",
      "(End of file - total 3 lines)",
      "</content>",
    ].join("\n")
    const result = buildTypedExecResult("mcp_result", output, undefined, "read") as {
      success: { content: unknown[] }
    }
    expect(result.success.content).toHaveLength(1)
  })

  it("stays silent for a complete read", () => {
    const mcp = buildTypedExecResult("mcp_result", complete, undefined, "read") as {
      success: { content: unknown[] }
    }
    expect(mcp.success.content).toHaveLength(1)
    const pi = buildTypedExecResult("pi_read_result", complete, undefined, "read") as {
      success: { truncation?: unknown }
    }
    expect(pi.success.truncation).toBeUndefined()
  })
})
