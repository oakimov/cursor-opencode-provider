import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildAddFilePatch,
  buildUpdateFilePatch,
  hostPatchTool,
  planSubstringEdit,
} from "../src/protocol/apply-patch.js"
import {
  OPENCODE_1_TOOL_DIALECT,
  OPENCODE_2_TOOL_DIALECT,
  parseExecServerMessage,
  remapCorrelatedEditWriteForCatalog,
  remapEditToolsForCatalog,
  buildTypedExecResult,
  type ParsedExecRequest,
} from "../src/protocol/tools.js"
import {
  parseDisplayToolCall,
  resolveBridgedOpenCodeToolCall,
} from "../src/protocol/tool-call-bridge.js"

let workspace: string

// Independent host contract for the envelopes emitted here. Add normalization
// and update line handling: OpenCode v1.18.31 tool/apply_patch.ts + patch/index.ts,
// and v2.0.28 tool/plugin/patch.ts + util/src/patch.ts. No synthesis helpers are
// shared with this interpreter, so payload assertions also verify file bytes.
function applyGeneratedPatch(patchText: string, source = "", tool = "apply_patch"): string {
  const lines = patchText.split("\n").map(line => tool === "patch" ? line.replace(/\r$/, "") : line)
  if (lines[1]!.startsWith("*** Add File:")) {
    const content = lines.slice(2, -1).map(line => line.slice(1)).join("\n")
    return content && !content.endsWith("\n") ? `${content}\n` : content
  }
  const original = source.split("\n")
  if (original.at(-1) === "") original.pop()
  const chunks: Array<{ old: string[]; next: string[] }> = []
  for (const line of lines.slice(2, -1)) {
    if (line === "@@") chunks.push({ old: [], next: [] })
    else if (line.startsWith("-")) chunks.at(-1)!.old.push(line.slice(1))
    else if (line.startsWith("+")) chunks.at(-1)!.next.push(line.slice(1))
  }
  let from = 0
  const replacements = chunks.map(chunk => {
    let at = original.length
    if (chunk.old.length) {
      at = original.findIndex((_, i) => i >= from && chunk.old.every((line, n) => original[i + n] === line))
      if (at === -1) throw new Error("Generated patch cannot match the original file")
      from = at + chunk.old.length
    } else if (tool === "apply_patch" && original.at(-1) === "") at--
    return { at, remove: chunk.old.length, next: chunk.next }
  })
  for (const replacement of replacements.reverse()) original.splice(replacement.at, replacement.remove, ...replacement.next)
  if (original.at(-1) !== "") original.push("")
  return original.join("\n")
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-apply-patch-"))
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe("apply_patch envelope synthesis", () => {
  it("writes whole file contents as an Add File hunk", () => {
    expect(buildAddFilePatch("src/a.ts", "one\ntwo\n")).toBe(
      ["*** Begin Patch", "*** Add File: src/a.ts", "+one", "+two", "+", "*** End Patch"].join("\n"),
    )
  })

  it("preserves the final newline and refuses an unterminated write", () => {
    expect(buildAddFilePatch("a.txt", "only\n")).toBe(
      ["*** Begin Patch", "*** Add File: a.txt", "+only", "+", "*** End Patch"].join("\n"),
    )
    expect(() => buildAddFilePatch("a.txt", "only")).toThrow("final newline")
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
        "+",
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
      patchText: ["*** Begin Patch", "*** Add File: a.txt", "+hi", "+", "*** End Patch"].join("\n"),
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

describe("correlated legacy edit writes", () => {
  it("converts Cursor's whole-file write into one targeted OpenCode edit", () => {
    fs.writeFileSync(path.join(workspace, "edit.txt"), "line one\nline two\nline three\nline four\n")
    const parsed = parseExecServerMessage({
      id: 11,
      write_args: {
        path: "edit.txt",
        file_text: "edited one\nedited two\nedited three\nline four\n",
      },
    })!

    expect(remapCorrelatedEditWriteForCatalog(parsed, ["read", "edit", "write"], "edit.txt", workspace)).toBe(true)
    expect(parsed).toMatchObject({
      toolName: "edit",
      resultField: "write_result",
      args: {
        filePath: "edit.txt",
        oldString: "line one\nline two\nline three\n",
        newString: "edited one\nedited two\nedited three\n",
      },
      resultMetadata: { path: "edit.txt" },
    })
  })

  it("uses unique adjacent context for a pure append", () => {
    fs.writeFileSync(path.join(workspace, "append.txt"), "same\ntail\n")
    const parsed = parseExecServerMessage({
      id: 12,
      write_args: { path: "append.txt", file_text: "same\ntail\nadded\n" },
    })!

    expect(remapCorrelatedEditWriteForCatalog(parsed, ["edit", "write"], "append.txt", workspace)).toBe(true)
    expect(parsed.args).toEqual({
      filePath: "append.txt",
      oldString: "tail\n",
      newString: "tail\nadded\n",
    })
  })

  it("feeds the targeted edit through an apply_patch-only catalog", () => {
    fs.writeFileSync(path.join(workspace, "patch.txt"), "before\nkeep\n")
    const parsed = parseExecServerMessage({
      id: 14,
      write_args: { path: "patch.txt", file_text: "after\nkeep\n" },
    })!

    expect(remapCorrelatedEditWriteForCatalog(parsed, ["read", "apply_patch"], "patch.txt", workspace)).toBe(true)
    remapEditToolsForCatalog(parsed, ["read", "apply_patch"], workspace)
    expect(parsed.toolName).toBe("apply_patch")
    expect(parsed.args).toEqual({
      patchText: [
        "*** Begin Patch",
        "*** Update File: patch.txt",
        "@@",
        "-before",
        "-keep",
        "+after",
        "+keep",
        "*** End Patch",
      ].join("\n"),
    })
  })

  it("leaves unadvertised, mismatched, and new-file writes unchanged", () => {
    const parsed = parseExecServerMessage({
      id: 13,
      write_args: { path: "new.txt", file_text: "new\n" },
    })!
    expect(remapCorrelatedEditWriteForCatalog(parsed, ["edit", "write"], "new.txt", workspace)).toBe(false)
    expect(remapCorrelatedEditWriteForCatalog(parsed, ["write"], "new.txt", workspace)).toBe(false)
    expect(remapCorrelatedEditWriteForCatalog(parsed, ["edit", "write"], "other.txt", workspace)).toBe(false)
    expect(parsed.toolName).toBe("write")
  })
})

describe("direct patch edit endings", () => {
  const call = (tool: string, patchText: string): ParsedExecRequest => ({
    id: 40, execId: "40", toolName: tool, args: { patchText }, resultField: "mcp_result",
  })

  it.each(["apply_patch", "patch"])("%s protects a CRLF source from LF-only direct hunks", tool => {
    const target = path.join(workspace, "direct.txt")
    const source = "one\r\ntwo\r\nthree\r\n\r\n"
    fs.writeFileSync(target, source)
    const parsed = call(tool, ["*** Begin Patch", `*** Update File: ${target}`, "@@", " one", "-two", "+TWO", " three", "*** End Patch"].join("\n"))
    remapEditToolsForCatalog(parsed, [tool, "read"], workspace)
    if (tool === "patch") {
      expect(parsed.localError).toContain("carriage return")
      expect(parsed.args).toEqual({})
    } else {
      expect(parsed.localError).toBeUndefined()
      expect(applyGeneratedPatch(parsed.args.patchText as string, source))
        .toBe("one\r\nTWO\r\nthree\r\n\r\n")
    }
    expect(parsed.resultField).toBe("mcp_result")
    expect(fs.readFileSync(target, "utf8")).toBe(source)
  })

  it("keeps newline state separate across moved, added and updated files", () => {
    fs.writeFileSync(path.join(workspace, "crlf.txt"), "old\r\n")
    fs.writeFileSync(path.join(workspace, "lf.txt"), "old\n")
    const parsed = call("apply_patch", ["*** Begin Patch", "*** Update File: crlf.txt", "*** Move to: moved.txt", "@@", "-old", "+new", "*** Add File: added.txt", "+new", "*** Update File: lf.txt", "@@", "-old", "+new", "*** End Patch"].join("\n"))
    remapEditToolsForCatalog(parsed, ["apply_patch"], workspace)
    expect(parsed.localError).toBeUndefined()
    expect(parsed.args.patchText).toContain("*** Move to: moved.txt\n@@\n-old\r\n+new\r\n*** Add File: added.txt\n+new\n*** Update File: lf.txt\n@@\n-old\n+new\n")
  })

  it.each(["apply_patch", "patch"])("%s leaves intentional Add File replacement endings unchanged", tool => {
    fs.writeFileSync(path.join(workspace, "target.txt"), "old\r\n")
    const patch = buildAddFilePatch("target.txt", "new\n", tool)
    const parsed = call(tool, patch)
    remapEditToolsForCatalog(parsed, [tool], workspace)
    expect(parsed.localError).toBeUndefined()
    expect(parsed.args.patchText).toBe(patch)
  })

  it("refuses direct CRLF Add File content on patch", () => {
    const parsed = call("patch", "*** Begin Patch\n*** Add File: new.txt\n+new\r\n*** End Patch")
    remapEditToolsForCatalog(parsed, ["patch"], workspace)
    expect(parsed.localError).toContain("carriage return")
    expect(parsed.args).toEqual({})
  })

  it("refuses mixed-ending direct updates rather than rewriting context lines", () => {
    fs.writeFileSync(path.join(workspace, "mixed.txt"), "one\ntwo\r\n")
    const parsed = call("apply_patch", "*** Begin Patch\n*** Update File: mixed.txt\n@@\n one\n-two\n+TWO\n*** End Patch")
    remapEditToolsForCatalog(parsed, ["apply_patch"], workspace)
    expect(parsed.localError).toContain("mixed line endings")
    expect(parsed.args).toEqual({})
  })

  it.each(["apply_patch", "patch"])("%s refuses a direct update of an unterminated file", tool => {
    fs.writeFileSync(path.join(workspace, "unterminated.txt"), "one\ntwo")
    const parsed = call(tool, "*** Begin Patch\n*** Update File: unterminated.txt\n@@\n-two\n+TWO\n*** End Patch")
    remapEditToolsForCatalog(parsed, [tool], workspace)
    expect(parsed.localError).toContain("final newline")
    expect(parsed.args).toEqual({})
  })

  it("leaves unavailable and malformed patch arguments to existing validation", () => {
    const parsed = call("apply_patch", "*** Begin Patch\n*** Update File: absent.txt\n@@\n-old\n+new\n*** End Patch")
    const original = { ...parsed.args }
    remapEditToolsForCatalog(parsed, ["read"], workspace)
    expect(parsed.args).toEqual(original)
    expect(parsed.localError).toBeUndefined()
    parsed.args = {}
    remapEditToolsForCatalog(parsed, ["apply_patch"], workspace)
    expect(parsed.args).toEqual({})
    expect(parsed.localError).toBeUndefined()
  })
})

describe.each([
  { host: "OpenCode 1.x", dialect: OPENCODE_1_TOOL_DIALECT, patchTool: "apply_patch", shell: "bash", pathKey: "filePath" },
  { host: "OpenCode 2", dialect: OPENCODE_2_TOOL_DIALECT, patchTool: "patch", shell: "shell", pathKey: "path" },
] as const)("$host patch catalog", ({ dialect, patchTool, shell, pathKey }) => {
  // Both majors' patch-tool gate: GPT models get the patch tool and lose `edit`/`write`; everyone else the reverse.
  const gptCatalog = ["read", shell, "glob", "grep", patchTool]
  const opusCatalog = ["read", shell, "glob", "grep", "edit", "write"]
  const writeRequest = (filePath: string, content: string) =>
    parseExecServerMessage({ id: 21, write_args: { path: filePath, file_text: content } }, dialect)!

  it.each(["", "\n", "\n\n", "a\n", "a\n\n", "a\n\n\n"])("preserves Add File content %j", content => {
    const parsed = writeRequest("new.txt", content)
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toBeUndefined()
    expect(applyGeneratedPatch(parsed.args.patchText as string, "", patchTool)).toBe(content)
  })

  it.each(["name\n*** Delete File: victim\n*** Add File: last", "name\r", "name\0", "name ", " name", "name\t"])(
    "refuses a path that cannot round-trip through a patch header: %j", target => {
      const parsed = writeRequest(target, "safe\n")
      remapEditToolsForCatalog(parsed, gptCatalog, workspace)
      expect(parsed.toolName).toBe(patchTool)
      expect(parsed.localError).toContain("target path")
      expect(parsed.args).toEqual({})
      expect(() => buildAddFilePatch(target, "safe\n")).toThrow("target path")
      expect(() => buildUpdateFilePatch(target, [{ oldLines: ["old"], newLines: ["new"] }])).toThrow("target path")
    },
  )

  it("rejects embedded newlines in Update File payload lines", () => {
    expect(() => buildUpdateFilePatch("safe.txt", [{
      oldLines: ["old"], newLines: ["new\n*** Delete File: victim"],
    }])).toThrow("payload line")
  })

  it("preserves internal path whitespace", () => {
    const parsed = writeRequest("a file.txt", "safe\n")
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toBeUndefined()
    expect(parsed.args.patchText).toContain("*** Add File: a file.txt\n")
  })

  it("refuses a whole-file write without a final newline", () => {
    const parsed = writeRequest("new.txt", "exact bytes")
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toContain("final newline")
    expect(parsed.args).toEqual({})
  })

  it("refuses repeated leading byte-order marks that the host would collapse", () => {
    const parsed = writeRequest("new.txt", "\uFEFF\uFEFFcontent\n")
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toContain("byte-order mark")
    expect(parsed.args).toEqual({})
  })

  it("refuses to report BOM removal when the host update preserves it", () => {
    const target = path.join(workspace, "bom.txt")
    fs.writeFileSync(target, "\uFEFFcontent\n")
    const parsed = parseExecServerMessage({ id: 23, pi_edit_args: {
      path: target, edits: [{ old_text: "\uFEFFcontent", new_text: "content" }],
    } }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toContain("byte-order mark")
    expect(parsed.args).toEqual({})
  })

  it("refuses a non-regular edit source without reading it", () => {
    const target = path.join(workspace, "directory")
    fs.mkdirSync(target)
    const parsed = parseExecServerMessage({ id: 23, pi_edit_args: {
      path: target, edits: [{ old_text: "a", new_text: "b" }],
    } }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toContain("regular file")
    expect(parsed.args).toEqual({})
  })

  it("preserves CRLF on apply_patch and refuses its lossy conversion on patch", () => {
    const parsed = writeRequest("new.txt", "one\r\ntwo\r\n")
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    if (patchTool === "patch") {
      expect(parsed.localError).toContain("carriage return")
      expect(parsed.args).toEqual({})
    } else {
      expect(parsed.localError).toBeUndefined()
      expect(applyGeneratedPatch(parsed.args.patchText as string, "", patchTool)).toBe("one\r\ntwo\r\n")
    }
  })

  it.each([
    ["a\nb\nc\n", "b", "x\n", "a\nx\n\nc\n"],
    ["a\n\nb\n", "a\n", "x\n", "x\n\nb\n"],
    ["a\nb\n", "b\n", "b\n\n", "a\nb\n\n"],
    ["a\nb\n\n", "a", "x", "x\nb\n\n"],
    ["a\nb\n", "a\nb\n", "\n", "\n"],
    ["a\nb\n", "a\nb\n", "", ""],
  ])("preserves replacement line boundaries: %j / %j -> %j", (source, oldText, newText, expected) => {
    const target = path.join(workspace, "line-boundaries.txt")
    fs.writeFileSync(target, source)
    const parsed = parseExecServerMessage({ id: 23, pi_edit_args: {
      path: target, edits: [{ old_text: oldText, new_text: newText }],
    } }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toBeUndefined()
    expect(applyGeneratedPatch(parsed.args.patchText as string, source, patchTool)).toBe(expected)
  })

  it("does not change existing CRLF endings on a correlated edit", () => {
    const target = path.join(workspace, "endings.txt")
    const source = "a\r\nb\r\nc\r\n"
    const desired = "A\r\nb\r\nc\r\n"
    fs.writeFileSync(target, source)
    const parsed = writeRequest(target, desired)
    remapCorrelatedEditWriteForCatalog(parsed, gptCatalog, target, workspace)
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    if (patchTool === "patch") {
      expect(parsed.localError).toContain("carriage return")
      expect(parsed.args).toEqual({})
    } else {
      expect(parsed.localError).toBeUndefined()
      expect(applyGeneratedPatch(parsed.args.patchText as string, source, patchTool)).toBe(desired)
    }
    expect(fs.readFileSync(target, "utf8")).toBe(source)
  })

  it.each([
    ["one\r\ntwo\r\nthree\r\n", "one\nTWO\nthree\n", "one\r\nTWO\r\nthree\r\n"],
    ["one\r\ntwo\r\nthree\r\n\r\n", "one\nTWO\nthree\n\n", "one\r\nTWO\r\nthree\r\n\r\n"],
    ["one\r\ntwo\r\nthree\r\n", "one\r\nTWO\nadded\nthree\r\n", "one\r\nTWO\r\nadded\r\nthree\r\n"],
    ["one\ntwo\nthree\n", "one\r\nTWO\r\nthree\r\n", "one\nTWO\nthree\n"],
  ])("keeps native edit newline semantics for a correlated write: %j -> %j", (source, incoming, expected) => {
    const target = path.join(workspace, "normalized-correlated.txt")
    fs.writeFileSync(target, source)
    const parsed = writeRequest(target, incoming)
    expect(remapCorrelatedEditWriteForCatalog(parsed, gptCatalog, target, workspace)).toBe(true)
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    if (patchTool === "patch") {
      expect(parsed.localError).toContain("carriage return")
      expect(parsed.args).toEqual({})
    } else {
      expect(parsed.localError).toBeUndefined()
      expect(applyGeneratedPatch(parsed.args.patchText as string, source, patchTool)).toBe(expected)
    }
    expect(fs.readFileSync(target, "utf8")).toBe(source)
  })

  it.each([
    ["one\ntwo", "ONE\nTWO", "ONE\r\nTWO\r\nthree\r\n"],
    ["two", "TWO\nadded", "one\r\nTWO\r\nadded\r\nthree\r\n"],
  ])("normalizes substring edit arguments to CRLF without creating mixed endings: %j", (oldText, newText, expected) => {
    const target = path.join(workspace, "normalized-substring.txt")
    const source = "one\r\ntwo\r\nthree\r\n"
    fs.writeFileSync(target, source)
    const parsed = parseExecServerMessage({ id: 23, pi_edit_args: {
      path: target, edits: [{ old_text: oldText, new_text: newText }],
    } }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    if (patchTool === "patch") {
      expect(parsed.localError).toContain("carriage return")
      expect(parsed.args).toEqual({})
    } else {
      expect(parsed.localError).toBeUndefined()
      expect(applyGeneratedPatch(parsed.args.patchText as string, source, patchTool)).toBe(expected)
    }
  })

  it("preserves untouched LF lines when a CRLF substring edit inserts a line", () => {
    const target = path.join(workspace, "mixed-source.txt")
    const source = "keep-lf\nold\r\nkeep-lf-again\n"
    fs.writeFileSync(target, source)
    const parsed = parseExecServerMessage({ id: 23, pi_edit_args: {
      path: target, edits: [{ old_text: "old", new_text: "new\nadded" }],
    } }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    if (patchTool === "patch") {
      expect(parsed.localError).toContain("carriage return")
    } else {
      expect(parsed.localError).toBeUndefined()
      expect(applyGeneratedPatch(parsed.args.patchText as string, source, patchTool))
        .toBe("keep-lf\nnew\r\nadded\r\nkeep-lf-again\n")
    }
  })

  it("retains intentional newline replacement for an uncorrelated whole-file write", () => {
    const target = path.join(workspace, "intentional-replacement.txt")
    fs.writeFileSync(target, "one\r\ntwo\r\n")
    const parsed = writeRequest(target, "one\nTWO\n")
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toBeUndefined()
    expect(applyGeneratedPatch(parsed.args.patchText as string, "one\r\ntwo\r\n", patchTool)).toBe("one\nTWO\n")
  })

  it("refuses an update that would add a final newline to an unterminated file", () => {
    const target = path.join(workspace, "unterminated.txt")
    fs.writeFileSync(target, "a\nb")
    const parsed = parseExecServerMessage({ id: 23, pi_edit_args: {
      path: target, edits: [{ old_text: "a", new_text: "A" }],
    } }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toContain("final newline")
    expect(parsed.args).toEqual({})
  })

  it("round-trips small substring edits including leading and trailing blank lines", () => {
    const failures: string[] = []
    for (const source of ["a\n", "\na\n", "\n", "\n\n", "a\n\n", "a\nb\n", "a\n\nb\n", "a\nb\n\n", "a\na\nb\n", "ab\ncd\n"]) {
      for (let offset = 0; offset < source.length; offset++) {
        for (let length = 1; length <= Math.min(4, source.length - offset); length++) {
          const oldText = source.slice(offset, offset + length)
          if (source.indexOf(oldText) !== source.lastIndexOf(oldText)) continue
          for (const newText of ["", "x", "x\n", "\n", "\n\n", "x\ny", "$&", "$$"]) {
            const expected = source.slice(0, offset) + newText + source.slice(offset + length)
            if (expected && !expected.endsWith("\n")) continue
            const plan = planSubstringEdit(source, oldText, newText)
            if (!plan.ok) {
              failures.push(`${JSON.stringify(source)} ${JSON.stringify(oldText)} -> ${JSON.stringify(newText)}: ${plan.reason}`)
              continue
            }
            const patch = buildUpdateFilePatch("file.txt", plan.chunks, patchTool)
            const actual = applyGeneratedPatch(patch, source, patchTool)
            if (actual !== expected) {
              failures.push(`${JSON.stringify(source)} ${JSON.stringify(oldText)} -> ${JSON.stringify(newText)}: ${JSON.stringify(actual)}`)
            }
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  it("resolves the host's patch tool name", () => {
    expect(hostPatchTool(new Set(gptCatalog))).toBe(patchTool)
    expect(hostPatchTool(new Set(opusCatalog))).toBeUndefined()
  })

  it("sends a GPT model's new file straight to the patch tool as an Add File hunk", () => {
    const target = path.join(workspace, "fresh.txt")
    const parsed = writeRequest(target, "alpha\nbeta\n")
    expect(parsed.args).toMatchObject({ [pathKey]: target })

    expect(remapCorrelatedEditWriteForCatalog(parsed, gptCatalog, target, workspace)).toBe(false)
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toBeUndefined()
    expect(parsed.toolName).toBe(patchTool)
    expect(parsed.resultField).toBe("write_result")
    expect(parsed.args).toEqual({
      patchText: ["*** Begin Patch", `*** Add File: ${target}`, "+alpha", "+beta", "+", "*** End Patch"].join("\n"),
    })
    expect(parsed.resultMetadata).toMatchObject({ path: target })
  })

  it("sends a GPT model's edit of an existing file to the patch tool as an Update File hunk", () => {
    const target = path.join(workspace, "existing.ts")
    fs.writeFileSync(target, "const a = 1\nconst b = 2\nconst c = 3\n")
    const parsed = writeRequest(target, "const a = 1\nconst b = 20\nconst c = 3\n")

    expect(remapCorrelatedEditWriteForCatalog(parsed, gptCatalog, target, workspace)).toBe(true)
    expect(parsed.args).toMatchObject({ [pathKey]: target })
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.localError).toBeUndefined()
    expect(parsed.toolName).toBe(patchTool)
    expect(parsed.args).toEqual({
      patchText: [
        "*** Begin Patch",
        `*** Update File: ${target}`,
        "@@",
        "-const b = 2",
        "-const c = 3",
        "+const b = 20",
        "+const c = 3",
        "*** End Patch",
      ].join("\n"),
    })
  })

  it("sends a GPT model's Pi edit to the patch tool", () => {
    const target = path.join(workspace, "pi.ts")
    fs.writeFileSync(target, "one\ntwo\n")
    const parsed = parseExecServerMessage({
      id: 22,
      pi_edit_args: { path: target, edits: [{ old_text: "two", new_text: "three" }] },
    }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.toolName).toBe(patchTool)
    expect(parsed.args).toEqual({
      patchText: ["*** Begin Patch", `*** Update File: ${target}`, "@@", "-two", "+three", "*** End Patch"].join("\n"),
    })
  })

  it("names the patch tool when a GPT request cannot be expressed as one", () => {
    const parsed = parseExecServerMessage({
      id: 23,
      pi_edit_args: { path: path.join(workspace, "missing.ts"), edits: [{ old_text: "a", new_text: "b" }] },
    }, dialect)!
    remapEditToolsForCatalog(parsed, gptCatalog, workspace)
    expect(parsed.toolName).toBe(patchTool)
    expect(parsed.localError).toContain(`cannot be expressed as a call to \`${patchTool}\``)
    expect(parsed.localError).toContain(`advertises \`${patchTool}\` instead of \`edit\`/\`write\``)
  })

  it("leaves Opus writes and edits on `write`/`edit`", () => {
    const fresh = writeRequest(path.join(workspace, "new.txt"), "x\n")
    expect(remapCorrelatedEditWriteForCatalog(fresh, opusCatalog, path.join(workspace, "new.txt"), workspace)).toBe(false)
    remapEditToolsForCatalog(fresh, opusCatalog, workspace)
    expect(fresh).toMatchObject({ toolName: "write", args: { [pathKey]: path.join(workspace, "new.txt"), content: "x\n" } })

    const target = path.join(workspace, "old.txt")
    fs.writeFileSync(target, "keep\nold\n")
    const edit = writeRequest(target, "keep\nnew\n")
    expect(remapCorrelatedEditWriteForCatalog(edit, opusCatalog, target, workspace)).toBe(true)
    remapEditToolsForCatalog(edit, opusCatalog, workspace)
    expect(edit).toMatchObject({ toolName: "edit", args: { [pathKey]: target, oldString: "old\n", newString: "new\n" } })
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
