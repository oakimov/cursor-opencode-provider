import { describe, it, expect } from "bun:test"
import {
  buildTypedExecResult,
  mapCursorArgsToOpencode,
  parseExecServerMessage,
} from "../src/protocol/tools.js"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"

/** Shape of an opencode `read` result, including its trailing footer. */
function readEnvelope(lines: string[], footer: string, filePath = "big.ts"): string {
  const body = lines.map((line, i) => `${i + 1}: ${line}`).join("\n")
  return [
    `<path>${filePath}</path>`,
    `<type>file</type>`,
    "<content>\n" + body,
    "",
    footer,
    "</content>",
  ].join("\n")
}

const CAPPED_FOOTER = "(Output capped at 50 KB. Showing lines 1-2. Use offset=3 to continue.)"
const COMPLETE_FOOTER = "(End of file - total 2 lines)"

describe("read truncation is reported, not silently dropped", () => {
  it("adds a separate notice content item for a capped MCP read", () => {
    const output = readEnvelope(["alpha", "beta"], CAPPED_FOOTER)
    const result = buildTypedExecResult("mcp_result", output, undefined, "read") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(result.success.content).toHaveLength(2)
    // File content stays byte-exact so it can never be echoed into a write.
    expect(result.success.content[0].text.text).toBe("alpha\nbeta")
    const notice = result.success.content[1].text.text
    expect(notice).toContain("Partial read")
    expect(notice).toContain("offset=3")
    expect(notice).toContain("50 KB")
  })

  it("adds no notice when the read reached end of file", () => {
    const output = readEnvelope(["alpha", "beta"], COMPLETE_FOOTER)
    const result = buildTypedExecResult("mcp_result", output, undefined, "read") as {
      success: { content: unknown[] }
    }
    expect(result.success.content).toHaveLength(1)
  })

  it("leaves non-read MCP output untouched", () => {
    const result = buildTypedExecResult("mcp_result", "plain output", undefined, "grep") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(result.success.content).toHaveLength(1)
    expect(result.success.content[0].text.text).toBe("plain output")
  })

  it("reports a capped Pi read through structured truncation", () => {
    const output = readEnvelope(["alpha", "beta"], CAPPED_FOOTER)
    const result = buildTypedExecResult("pi_read_result", output, undefined, "read") as {
      success: { output: string; truncation?: Record<string, unknown> }
    }
    expect(result.success.output).toBe("alpha\nbeta")
    expect(result.success.truncation).toMatchObject({
      truncated: true,
      truncated_by: "bytes",
      output_lines: 2,
      max_bytes: 51200,
    })
  })

  it("omits Pi truncation for a complete read", () => {
    const output = readEnvelope(["alpha", "beta"], COMPLETE_FOOTER)
    const result = buildTypedExecResult("pi_read_result", output, undefined, "read") as {
      success: { truncation?: unknown }
    }
    expect(result.success.truncation).toBeUndefined()
  })

  it("round-trips PiReadExecSuccess.truncation on the wire", () => {
    const encoded = encodeMessage("PiReadExecResult", {
      success: {
        output: "alpha",
        truncation: { truncated: true, truncated_by: "bytes", output_lines: 1, max_bytes: 51200 },
      },
    })
    const decoded = decodeMessage<{
      success: { output: string; truncation: Record<string, unknown> }
    }>("PiReadExecResult", encoded)
    expect(decoded.success.output).toBe("alpha")
    expect(decoded.success.truncation).toMatchObject({ truncated: true, max_bytes: 51200 })
  })
})

describe("WriteArgs.file_bytes", () => {
  it("prefers file_bytes over file_text, as Cursor's own executor does", () => {
    const mapped = mapCursorArgsToOpencode("write", {
      path: "a.txt",
      file_text: "stale",
      file_bytes: new TextEncoder().encode("from bytes"),
    })
    expect(mapped.args).toEqual({ filePath: "a.txt", content: "from bytes" })
  })

  it("falls back to file_text when file_bytes is empty", () => {
    const mapped = mapCursorArgsToOpencode("write", {
      path: "a.txt",
      file_text: "from text",
      file_bytes: new Uint8Array(0),
    })
    expect(mapped.args).toEqual({ filePath: "a.txt", content: "from text" })
  })

  it("decodes an encoding_hint other than utf-8", () => {
    const mapped = mapCursorArgsToOpencode("write", {
      path: "a.txt",
      file_bytes: Uint8Array.from([0xe9, 0x74, 0x65]),
      encoding_hint: "latin1",
    })
    expect(mapped.args.content).toBe("éte")
  })

  it("decodes as utf-8 when the hint is unsupported", () => {
    const mapped = mapCursorArgsToOpencode("write", {
      path: "a.txt",
      file_bytes: new TextEncoder().encode("plain"),
      encoding_hint: "not-a-real-encoding",
    })
    expect(mapped.args.content).toBe("plain")
  })

  it("decodes a byte-encoded write off the wire", () => {
    const encoded = encodeMessage("WriteArgs", {
      path: "a.txt",
      file_bytes: new TextEncoder().encode("wire bytes"),
    })
    const decoded = decodeMessage<Record<string, unknown>>("WriteArgs", encoded)
    const parsed = parseExecServerMessage({ id: 3, write_args: decoded })
    expect(parsed?.toolName).toBe("write")
    expect(parsed?.args).toMatchObject({ filePath: "a.txt", content: "wire bytes" })
  })
})
