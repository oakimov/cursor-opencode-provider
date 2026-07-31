import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildAddFilePatch,
  buildUpdateFilePatch,
  planSubstringEdit,
} from "../src/protocol/apply-patch.js"
import {
  parseExecServerMessage,
  remapEditToolsForCatalog,
  buildTypedExecResult,
} from "../src/protocol/tools.js"
import {
  parseDisplayToolCall,
  resolveBridgedOpenCodeToolCall,
} from "../src/protocol/tool-call-bridge.js"

let workspace: string

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-apply-patch-"))
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe("apply_patch envelope synthesis", () => {
  it("writes whole file contents as an Add File hunk", () => {
    expect(buildAddFilePatch("src/a.ts", "one\ntwo\n")).toBe(
      ["*** Begin Patch", "*** Add File: src/a.ts", "+one", "+two", "*** End Patch"].join("\n"),
    )
  })

  it("does not emit a spurious blank line for a trailing newline", () => {
    expect(buildAddFilePatch("a.txt", "only\n")).toBe(
      ["*** Begin Patch", "*** Add File: a.txt", "+only", "*** End Patch"].join("\n"),
    )
    expect(buildAddFilePatch("a.txt", "only")).toBe(
      ["*** Begin Patch", "*** Add File: a.txt", "+only", "*** End Patch"].join("\n"),
    )
  })

  it("keeps content lines that look like patch markers", () => {
    // The parser only breaks on *unprefixed* markers, so `+`/`-` protect these.
    const content = "*** End Patch\n@@ not a header\n*** Add File: nope\n"
    expect(buildAddFilePatch("f.md", content)).toBe(
      [
        "*** Begin Patch",
        "*** Add File: f.md",
        "+*** End Patch",
        "+@@ not a header",
        "+*** Add File: nope",
        "*** End Patch",
      ].join("\n"),
    )
  })

  it("emits an empty-context chunk per update", () => {
    expect(
      buildUpdateFilePatch("a.ts", [{ oldLines: ["old"], newLines: ["new"] }]),
    ).toBe(
      ["*** Begin Patch", "*** Update File: a.ts", "@@", "-old", "+new", "*** End Patch"].join("\n"),
    )
  })
})

describe("planSubstringEdit", () => {
  it("expands a partial-line replacement to whole lines", () => {
    const plan = planSubstringEdit("const a = 1\nconst b = 2\n", "= 2", "= 3")
    expect(plan).toEqual({
      ok: true,
      chunks: [{ oldLines: ["const b = 2"], newLines: ["const b = 3"] }],
    })
  })

  it("handles a replacement spanning several lines", () => {
    const plan = planSubstringEdit("a\nb\nc\n", "b\nc", "x")
    expect(plan).toEqual({ ok: true, chunks: [{ oldLines: ["b", "c"], newLines: ["x"] }] })
  })

  it("refuses when the text is absent", () => {
    const plan = planSubstringEdit("a\n", "zzz", "y")
    expect(plan.ok).toBe(false)
  })

  it("refuses an ambiguous match rather than guessing", () => {
    const plan = planSubstringEdit("dup\ndup\n", "dup", "x")
    expect(plan).toMatchObject({ ok: false })
    expect((plan as { reason: string }).reason).toContain("2 times")
  })

  it("emits one chunk per occurrence for replaceAll", () => {
    const plan = planSubstringEdit("dup\nmid\ndup\n", "dup", "x", true)
    expect(plan).toEqual({
      ok: true,
      chunks: [
        { oldLines: ["dup"], newLines: ["x"] },
        { oldLines: ["dup"], newLines: ["x"] },
      ],
    })
  })
})

describe("remapEditToolsForCatalog", () => {
  const writeRequest = (filePath: string, content: string) =>
    parseExecServerMessage({ id: 7, write_args: { path: filePath, file_text: content } })!

  it("leaves the request alone when write is advertised", () => {
    const parsed = writeRequest("a.txt", "hi\n")
    remapEditToolsForCatalog(parsed, ["read", "write", "apply_patch"], workspace)
    expect(parsed.toolName).toBe("write")
    expect(parsed.args).toMatchObject({ filePath: "a.txt", content: "hi\n" })
  })

  it("leaves the request alone when apply_patch is not advertised", () => {
    const parsed = writeRequest("a.txt", "hi\n")
    remapEditToolsForCatalog(parsed, ["read", "bash"], workspace)
    // Still `write`, so the caller's unavailable-tool rejection applies.
    expect(parsed.toolName).toBe("write")
    expect(parsed.localError).toBeUndefined()
  })

  it("converts a native write into an Add File patch", () => {
    const parsed = writeRequest("a.txt", "hi\n")
    remapEditToolsForCatalog(parsed, ["read", "apply_patch"], workspace)
    expect(parsed.toolName).toBe("apply_patch")
    expect(parsed.resultField).toBe("write_result")
    expect(parsed.args).toEqual({
      patchText: ["*** Begin Patch", "*** Add File: a.txt", "+hi", "*** End Patch"].join("\n"),
    })
    expect(parsed.resultMetadata).toMatchObject({ path: "a.txt" })
  })

  it("converts a Pi edit into a minimal Update File patch", () => {
    fs.writeFileSync(path.join(workspace, "b.ts"), "const a = 1\nconst b = 2\n")
    const parsed = parseExecServerMessage({
      id: 8,
      pi_edit_args: { path: "b.ts", edits: [{ old_text: "= 2", new_text: "= 3" }] },
    })!
    remapEditToolsForCatalog(parsed, ["read", "apply_patch"], workspace)
    expect(parsed.toolName).toBe("apply_patch")
    expect(parsed.args).toEqual({
      patchText: [
        "*** Begin Patch",
        "*** Update File: b.ts",
        "@@",
        "-const b = 2",
        "+const b = 3",
        "*** End Patch",
      ].join("\n"),
    })
  })

  it("refuses an edit whose target cannot be read", () => {
    const parsed = parseExecServerMessage({
      id: 9,
      pi_edit_args: { path: "missing.ts", edits: [{ old_text: "a", new_text: "b" }] },
    })!
    remapEditToolsForCatalog(parsed, ["read", "apply_patch"], workspace)
    expect(parsed.toolName).toBe("apply_patch")
    expect(parsed.localError).toContain("could not be read")
  })

  it("refuses an ambiguous edit instead of patching the wrong line", () => {
    fs.writeFileSync(path.join(workspace, "c.ts"), "dup\ndup\n")
    const parsed = parseExecServerMessage({
      id: 10,
      pi_edit_args: { path: "c.ts", edits: [{ old_text: "dup", new_text: "x" }] },
    })!
    remapEditToolsForCatalog(parsed, ["read", "apply_patch"], workspace)
    expect(parsed.localError).toContain("must be unique")
  })

  it("reports the remapped path in the typed write result", () => {
    const result = buildTypedExecResult("write_result", "", undefined, "apply_patch", {
      path: "a.txt",
    })
    expect(result).toMatchObject({ success: { path: "a.txt" } })
  })
})

describe("display bridge", () => {
  it("leaves edit_tool_call to the exec channel", () => {
    // edit_tool_call is not a display-state mirror variant: Cursor follows it
    // with a real write_args exec request, which remapEditToolsForCatalog
    // handles. Bridging it here as well would apply the write twice.
    const display = parseDisplayToolCall("call-1", {
      edit_tool_call: { path: "d.txt", stream_content: "alpha\n" },
    })
    expect(display?.variant).toBe("edit_tool_call")
    expect(resolveBridgedOpenCodeToolCall(display!, ["read", "apply_patch"])).toBeUndefined()
  })
})
