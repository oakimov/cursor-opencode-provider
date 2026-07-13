import { describe, it, expect } from "bun:test"
import {
  mapExecServerToToolName,
  mapToolNameToExecField,
  mapCursorArgsToOpencode,
  parseExecServerMessage,
  buildExecClientMessages,
  buildToolCallPart,
  parseExecIdFromToolCallId,
  toolsToDescriptors,
  detectExecVariantField,
  buildRawEmptyExecReply,
  buildRequestContextResult,
  REQUEST_CONTEXT_RESULT_FIELD,
} from "../src/protocol/tools.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { encodeJsonAsValue } from "../src/protocol/struct.js"

// Build one McpArgs.args map entry: message { 1: key(string), 2: value(Value) }.
function mcpArgEntry(key: string, value: unknown): Uint8Array {
  const keyBytes = new TextEncoder().encode(key)
  const valBytes = encodeJsonAsValue(value)
  const out: number[] = []
  const writeVarint = (n: number) => { let v = n >>> 0; while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7 } out.push(v) }
  const writeLD = (field: number, b: Uint8Array) => { out.push((field << 3) | 2); writeVarint(b.length); for (const x of b) out.push(x) }
  writeLD(1, keyBytes)
  writeLD(2, valBytes)
  return new Uint8Array(out)
}

describe("toolsToDescriptors", () => {
  it("builds request_context descriptors with composite names", () => {
    const d = toolsToDescriptors([
      { name: "read", description: "Read a file", inputSchema: { type: "object" } },
    ])
    expect(d).toHaveLength(1)
    expect(d[0].name).toBe("opencode-read")
    expect(d[0].tool_name).toBe("read")
    expect(d[0].provider_identifier).toBe("opencode")
    expect(d[0].input_schema).toBeInstanceOf(Uint8Array)
    expect((d[0].input_schema as Uint8Array).length).toBeGreaterThan(0)
  })

  it("defaults a missing schema to an empty object schema", () => {
    const d = toolsToDescriptors([{ name: "x" }])
    expect((d[0].input_schema as Uint8Array).length).toBeGreaterThan(0)
    expect(d[0].description).toBe("")
  })
})

describe("mapExecServerToToolName", () => {
  it("maps read_args → read", () => {
    expect(mapExecServerToToolName("read_args")).toBe("read")
  })
  it("maps write_args → write", () => {
    expect(mapExecServerToToolName("write_args")).toBe("write")
  })
  it("maps grep_args → grep", () => {
    expect(mapExecServerToToolName("grep_args")).toBe("grep")
  })
  it("maps ls_args → read (OpenCode has no ls)", () => {
    expect(mapExecServerToToolName("ls_args")).toBe("read")
  })
  it("maps delete_args → bash (OpenCode has no delete)", () => {
    expect(mapExecServerToToolName("delete_args")).toBe("bash")
  })
  it("maps shell_stream_args → bash", () => {
    expect(mapExecServerToToolName("shell_stream_args")).toBe("bash")
  })
  it("maps mcp_args → mcp", () => {
    expect(mapExecServerToToolName("mcp_args")).toBe("mcp")
  })
  it("returns undefined for unknown", () => {
    expect(mapExecServerToToolName("unknown")).toBeUndefined()
  })
})

describe("mapToolNameToExecField", () => {
  it("maps read → read_args", () => {
    expect(mapToolNameToExecField("read")).toBe("read_args")
  })
  it("maps bash → shell_stream_args", () => {
    expect(mapToolNameToExecField("bash")).toBe("shell_stream_args")
  })
})

describe("mapCursorArgsToOpencode", () => {
  it("remaps read path → filePath and drops tool_call_id", () => {
    const r = mapCursorArgsToOpencode("read", { path: "/a.ts", tool_call_id: "tc", offset: 10 })
    expect(r).toEqual({ toolName: "read", args: { filePath: "/a.ts", offset: 10 } })
  })
  it("remaps write path/file_text → filePath/content", () => {
    const r = mapCursorArgsToOpencode("write", { path: "/a.ts", file_text: "hi" })
    expect(r).toEqual({ toolName: "write", args: { filePath: "/a.ts", content: "hi" } })
  })
  it("remaps shell working_directory → workdir", () => {
    const r = mapCursorArgsToOpencode("bash", {
      command: "ls",
      working_directory: "/tmp",
      timeout: 5000,
    })
    expect(r).toEqual({ toolName: "bash", args: { command: "ls", workdir: "/tmp", timeout: 5000 } })
  })
  it("remaps grep glob → include", () => {
    const r = mapCursorArgsToOpencode("grep", { pattern: "foo", path: "/src", glob: "*.ts" })
    expect(r).toEqual({ toolName: "grep", args: { pattern: "foo", path: "/src", include: "*.ts" } })
  })
  it("remaps empty-pattern grep (Cursor file-list Grep) → OpenCode glob", () => {
    // Live failure: grep_args { path, glob:"**/*" } with no pattern → OpenCode
    // crashed on pattern.trim / looped. Treat as glob.
    const r = mapCursorArgsToOpencode(
      "grep",
      { path: "/workspace/project", glob: "**/*" },
      "grep_args",
    )
    expect(r).toEqual({
      toolName: "glob",
      args: { pattern: "**/*", path: "/workspace/project" },
    })
  })
  it("remaps empty-pattern grep with no glob → glob **/*", () => {
    const r = mapCursorArgsToOpencode("grep", { path: "/src" }, "grep_args")
    expect(r).toEqual({ toolName: "glob", args: { pattern: "**/*", path: "/src" } })
  })
  it("remaps glob target_directory/glob_pattern", () => {
    const r = mapCursorArgsToOpencode("glob", {
      glob_pattern: "**/*.ts",
      target_directory: "/src",
    })
    expect(r).toEqual({ toolName: "glob", args: { pattern: "**/*.ts", path: "/src" } })
  })
  it("remaps edit old_string/new_string", () => {
    const r = mapCursorArgsToOpencode("edit", {
      path: "/a.ts",
      old_string: "a",
      new_string: "b",
    })
    expect(r).toEqual({
      toolName: "edit",
      args: { filePath: "/a.ts", oldString: "a", newString: "b" },
    })
  })
})

describe("parseExecServerMessage", () => {
  it("parses read_args with OpenCode filePath and read_result reply field", () => {
    const result = parseExecServerMessage({
      id: 1,
      exec_id: "exec-1",
      read_args: { path: "/test.txt", tool_call_id: "tc1" },
    })
    expect(result).toBeDefined()
    expect(result!.id).toBe(1)
    expect(result!.toolName).toBe("read")
    expect(result!.args).toEqual({ filePath: "/test.txt" })
    expect(result!.args.path).toBeUndefined()
    expect(result!.args.tool_call_id).toBeUndefined()
    expect(result!.resultField).toBe("read_result")
  })

  it("parses write_args with filePath/content", () => {
    const result = parseExecServerMessage({
      id: 3,
      write_args: { path: "/out.txt", file_text: "hello", tool_call_id: "tc" },
    })
    expect(result!.toolName).toBe("write")
    expect(result!.args).toEqual({ filePath: "/out.txt", content: "hello" })
    expect(result!.resultField).toBe("write_result")
  })

  it("parses pi_write_args as OpenCode write + pi_write_result", () => {
    const result = parseExecServerMessage({
      id: 48,
      pi_write_args: { path: "/out.txt", content: "hello pi" },
    })
    expect(result!.toolName).toBe("write")
    expect(result!.args).toEqual({ filePath: "/out.txt", content: "hello pi" })
    expect(result!.resultField).toBe("pi_write_result")
  })

  it("parses ls_args as OpenCode read", () => {
    const result = parseExecServerMessage({
      id: 8,
      ls_args: { path: "/src", tool_call_id: "tc" },
    })
    expect(result!.toolName).toBe("read")
    expect(result!.args).toEqual({ filePath: "/src" })
    expect(result!.resultField).toBe("ls_result")
  })

  it("parses delete_args as bash rm", () => {
    const result = parseExecServerMessage({
      id: 9,
      delete_args: { path: "/tmp/x", tool_call_id: "tc" },
    })
    expect(result!.toolName).toBe("bash")
    expect(result!.args.command).toBe("rm -f -- '/tmp/x'")
    expect(result!.resultField).toBe("delete_result")
  })

  it("parses grep_args", () => {
    const result = parseExecServerMessage({
      id: 2,
      grep_args: { pattern: "foo", path: "/src", tool_call_id: "tc2" },
    })
    expect(result!.toolName).toBe("grep")
    expect(result!.args).toEqual({ pattern: "foo", path: "/src" })
    expect(result!.resultField).toBe("grep_result")
  })

  it("parses empty-pattern grep_args as glob (live Grep loop regression)", () => {
    // Exact shape from OpenCode DB: path + include/glob, no pattern.
    const result = parseExecServerMessage({
      id: 0,
      grep_args: {
        path: "/workspace/project",
        glob: "**/*",
        tool_call_id: "tc",
      },
    })
    expect(result!.toolName).toBe("glob")
    expect(result!.args).toEqual({
      pattern: "**/*",
      path: "/workspace/project",
    })
    // Reply field still grep_result — Cursor asked for grep_args.
    expect(result!.resultField).toBe("grep_result")
  })

  it("maps shell_stream_args to bash + shell_stream reply with workdir", () => {
    const result = parseExecServerMessage({
      id: 4,
      shell_stream_args: { command: "ls", working_directory: "/tmp" },
    })
    expect(result!.toolName).toBe("bash")
    expect(result!.args).toEqual({ command: "ls", workdir: "/tmp" })
    expect(result!.resultField).toBe("shell_stream")
  })

  it("resolves the real MCP tool name and replies with mcp_result", () => {
    // mcp_args carries the composite name + bare tool_name; result is mcp_result.
    const result = parseExecServerMessage({
      id: 7,
      mcp_args: {
        name: "opencode-brave_web_search",
        tool_name: "brave_web_search",
        provider_identifier: "opencode",
        args: [],
      },
    })
    expect(result!.toolName).toBe("brave_web_search")
    expect(result!.resultField).toBe("mcp_result")
  })

  it("falls back to stripping the opencode- prefix when tool_name is absent", () => {
    const result = parseExecServerMessage({
      id: 8,
      mcp_args: { name: "opencode-read", args: [] },
    })
    expect(result!.toolName).toBe("read")
    expect(result!.resultField).toBe("mcp_result")
  })

  it("decodes mcp_args argument map and remaps to OpenCode keys", () => {
    // Build a wire-shaped mcp_args by round-tripping through the real encoder.
    const bytes = encodeMessage("ExecServerMessage", {
      id: 9,
      mcp_args: {
        name: "opencode-grep",
        tool_name: "grep",
        args: [mcpArgEntry("pattern", "TODO"), mcpArgEntry("path", "/src"), mcpArgEntry("glob", "*.ts")],
      },
    })
    const esm = decodeMessage<any>("ExecServerMessage", bytes)
    const parsed = parseExecServerMessage(esm)
    expect(parsed!.toolName).toBe("grep")
    expect(parsed!.args).toEqual({ pattern: "TODO", path: "/src", include: "*.ts" })
  })

  it("MCP empty-pattern grep remaps to glob and keeps mcp_result", () => {
    const bytes = encodeMessage("ExecServerMessage", {
      id: 11,
      mcp_args: {
        name: "opencode-grep",
        tool_name: "grep",
        args: [mcpArgEntry("path", "/src"), mcpArgEntry("glob", "**/*")],
      },
    })
    const esm = decodeMessage<any>("ExecServerMessage", bytes)
    const parsed = parseExecServerMessage(esm)
    expect(parsed!.toolName).toBe("glob")
    expect(parsed!.args).toEqual({ pattern: "**/*", path: "/src" })
    expect(parsed!.resultField).toBe("mcp_result")
    // And the stream part must be stringified for the AI SDK.
    const tc = buildToolCallPart(parsed!, "sess_test")
    expect(typeof tc.input).toBe("string")
    expect(JSON.parse(tc.input)).toEqual({ pattern: "**/*", path: "/src" })
  })

  it("remaps MCP read args path → filePath", () => {
    const bytes = encodeMessage("ExecServerMessage", {
      id: 10,
      mcp_args: {
        name: "opencode-read",
        tool_name: "read",
        args: [mcpArgEntry("path", "/README.md"), mcpArgEntry("offset", 1)],
      },
    })
    const esm = decodeMessage<any>("ExecServerMessage", bytes)
    const parsed = parseExecServerMessage(esm)
    expect(parsed!.toolName).toBe("read")
    expect(parsed!.args).toEqual({ filePath: "/README.md", offset: 1 })
  })

  it("returns undefined when no exec variant found", () => {
    expect(parseExecServerMessage({ id: 1 })).toBeUndefined()
  })

  it("returns undefined without id", () => {
    expect(parseExecServerMessage({ read_args: { path: "/x" } })).toBeUndefined()
  })
})

describe("buildExecClientMessages", () => {
  it("uses read_result success oneof (agent.v1), not flat content", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "read_result",
      output: "<path>/README.md</path>\nhello",
    })
    expect(frames).toHaveLength(2) // result + stream_close
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.id).toBe(1)
    expect(ec.read_result?.success?.content).toContain("hello")
    expect(ec.read_result?.success?.path).toBe("/README.md")
    expect(ec.read_result?.content).toBeUndefined()
  })

  it("includes read error as ReadError oneof", () => {
    const frames = buildExecClientMessages({
      execId: 2,
      resultField: "read_result",
      output: "",
      error: "File not found",
    })
    expect(frames).toHaveLength(2)
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.id).toBe(2)
    expect(ec.read_result?.error?.error).toBe("File not found")
    expect(ec.read_result?.success).toBeUndefined()
  })

  it("encodes pi_write_result success as { output }", () => {
    const frames = buildExecClientMessages({
      execId: 49,
      resultField: "pi_write_result",
      output: "Wrote file successfully.",
    })
    expect(frames).toHaveLength(2)
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.id).toBe(49)
    expect(ec.pi_write_result?.success?.output).toBe("Wrote file successfully.")
    expect(ec.write_result).toBeUndefined()
  })

  it("uses shell_stream Start→Stdout→Exit then stream_close for bash", () => {
    const frames = buildExecClientMessages({
      execId: 3,
      resultField: "shell_stream",
      output: "stdout output",
      executionTimeMs: 100,
    })
    expect(frames).toHaveLength(4)
    const start = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    const mid = decodeMessage<any>("AgentClientMessage", frames[1]).exec_client_message
    const end = decodeMessage<any>("AgentClientMessage", frames[2]).exec_client_message
    const close = decodeMessage<any>("AgentClientMessage", frames[3])
    expect(start.id).toBe(3)
    expect(start.shell_stream?.start).toBeDefined()
    expect(mid.shell_stream?.stdout?.data).toBe("stdout output")
    expect(end.shell_stream?.exit?.code).toBe(0)
    expect(close.exec_client_control_message?.stream_close?.id).toBe(3)
  })

  it("shell error replies with Start→Stderr→Exit then stream_close", () => {
    const frames = buildExecClientMessages({
      execId: 4,
      resultField: "shell_stream",
      output: "",
      error: "boom",
    })
    expect(frames).toHaveLength(4)
    const start = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    const mid = decodeMessage<any>("AgentClientMessage", frames[1]).exec_client_message
    const end = decodeMessage<any>("AgentClientMessage", frames[2]).exec_client_message
    const close = decodeMessage<any>("AgentClientMessage", frames[3])
    expect(start.shell_stream?.start).toBeDefined()
    expect(mid.shell_stream?.stderr?.data).toBe("boom")
    expect(end.shell_stream?.exit?.code).toBe(1)
    expect(close.exec_client_control_message?.stream_close?.id).toBe(4)
  })

  it("non-shell results also end with stream_close (CLI always closes)", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "read_result",
      output: "hi",
    })
    expect(frames).toHaveLength(2)
    const result = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    const close = decodeMessage<any>("AgentClientMessage", frames[1])
    expect(result.read_result?.success?.content).toBe("hi")
    expect(close.exec_client_control_message?.stream_close?.id).toBe(1)
  })

  it("routes MCP results to mcp_result success{content:[{text}]}", () => {
    const frames = buildExecClientMessages({ execId: 9, resultField: "mcp_result", output: "{}" })
    expect(frames).toHaveLength(2)
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.mcp_result?.success?.content?.[0]?.text?.text).toBe("{}")
    expect(ec.mcp_result?.content).toBeUndefined()
  })

  it("wraps grep/glob output as GrepSuccess files_with_matches", () => {
    const frames = buildExecClientMessages({
      execId: 0,
      resultField: "grep_result",
      output: "/workspace/project/README.md\n/workspace/project/src/index.ts",
    })
    expect(frames).toHaveLength(2)
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    const gs = ec.grep_result?.success
    expect(gs?.output_mode).toBe("files_with_matches")
    const wr = gs?.workspace_results
    expect(wr).toBeDefined()
    const keys = Object.keys(wr)
    expect(keys.length).toBe(1)
    expect(wr[keys[0]].files.files).toContain("/workspace/project/README.md")
  })
})

describe("mapCursorArgsToOpencode read zeros", () => {
  it("drops offset=0 and limit=0 so OpenCode reads the whole file", () => {
    const r = mapCursorArgsToOpencode("read", {
      path: "/README.md",
      offset: 0,
      limit: 0,
    })
    expect(r).toEqual({ toolName: "read", args: { filePath: "/README.md" } })
  })
})

describe("buildToolCallPart", () => {
  it("generates tool call part with cursor_ prefix and STRINGIFIED JSON input", () => {
    const result = buildToolCallPart({
      id: 5,
      execId: "",
      toolName: "read",
      args: { filePath: "/test.txt" },
      resultField: "read_result",
    }, "sess_test")
    expect(result.toolCallId).toBe("cursor_sess_test_5")
    expect(result.toolName).toBe("read")
    // LanguageModelV3ToolCall.input must be a string — AI SDK calls input.trim().
    expect(typeof result.input).toBe("string")
    expect(JSON.parse(result.input)).toEqual({ filePath: "/test.txt" })
  })

  it("stringifies empty args as {}", () => {
    const result = buildToolCallPart({
      id: 1,
      execId: "",
      toolName: "grep",
      args: {},
      resultField: "grep_result",
    }, "sess_test")
    expect(result.input).toBe("{}")
  })

  it("end-to-end: live Grep-loop payload survives AI SDK input.trim + OpenCode glob", () => {
    // Exact failure from OpenCode DB (ses_0b61d4b39ffe…):
    //   tool=grep input={path, include:"**/*"} error="K.input.trim is not a function"
    // Root cause was twofold: (1) object input instead of JSON string,
    // (2) empty-pattern native Grep forwarded as OpenCode grep.
    const bytes = encodeMessage("ExecServerMessage", {
      id: 0,
      grep_args: {
        path: "/workspace/project",
        glob: "**/*",
      },
    })
    const esm = decodeMessage<any>("ExecServerMessage", bytes)
    const parsed = parseExecServerMessage(esm)!
    expect(parsed.toolName).toBe("glob")
    expect(parsed.args.pattern).toBe("**/*")

    const tc = buildToolCallPart(parsed, "sess_test")
    // Simulate AI SDK: must be able to trim then JSON.parse.
    const trimmed = (tc.input as string).trim()
    const decoded = JSON.parse(trimmed)
    expect(decoded).toEqual({
      pattern: "**/*",
      path: "/workspace/project",
    })
    // OpenCode glob schema keys are present.
    expect(typeof decoded.pattern).toBe("string")
    expect(decoded.pattern.length).toBeGreaterThan(0)
  })
})

describe("parseExecIdFromToolCallId", () => {
  it("extracts sessionId and exec id from a tagged tool call id", () => {
    expect(parseExecIdFromToolCallId("cursor_sess_test_42")).toEqual({
      sessionId: "sess_test",
      execId: 42,
    })
  })

  it("returns undefined for non-cursor ids", () => {
    expect(parseExecIdFromToolCallId("tool_abc")).toBeUndefined()
  })
})

describe("exec safety net (unmapped variants)", () => {
  // Hand-build an AgentServerMessage{exec_server_message{...}} so we can test
  // detectExecVariantField against both schema-known and unmapped field numbers.
  function asmWithExec(execField: number, argsBytes = new Uint8Array(0)): Uint8Array {
    const wv = (buf: number[], n: number) => { let v = n >>> 0; while (v > 0x7f) { buf.push((v & 0x7f) | 0x80); v >>>= 7 } buf.push(v) }
    const exec: number[] = []
    wv(exec, (1 << 3) | 0); wv(exec, 42) // id = 42
    wv(exec, (execField << 3) | 2); wv(exec, argsBytes.length); for (const b of argsBytes) exec.push(b)
    const asm: number[] = []
    wv(asm, (2 << 3) | 2); wv(asm, exec.length); for (const b of exec) asm.push(b) // ASM #2 exec_server_message
    return new Uint8Array(asm)
  }

  it("detects request_context_args as field 10", () => {
    const payload = encodeMessage("AgentServerMessage", {
      exec_server_message: { id: 7, request_context_args: {} },
    })
    expect(detectExecVariantField(payload)).toBe(REQUEST_CONTEXT_RESULT_FIELD)
  })

  it("detects read_args as field 7", () => {
    const payload = encodeMessage("AgentServerMessage", {
      exec_server_message: { id: 7, read_args: { path: "/x" } },
    })
    expect(detectExecVariantField(payload)).toBe(7)
  })

  it("detects an unmapped variant (e.g. smart_mode_classifier #38) off raw bytes", () => {
    const payload = asmWithExec(38)
    expect(detectExecVariantField(payload)).toBe(38)
  })

  it("buildRawEmptyExecReply encodes id + empty result at the given field number", () => {
    const bytes = buildRawEmptyExecReply(5, 11) // mcp_result (#11) is in our schema
    const dec = decodeMessage<any>("AgentClientMessage", bytes)
    const ecm = dec.exec_client_message
    expect(ecm.id).toBe(5)
    expect(ecm.mcp_result).toBeDefined()
  })

  it("buildRequestContextResult encodes a prebuilt request_context", () => {
    const descriptors = toolsToDescriptors([
      { name: "read", description: "Read", inputSchema: { type: "object" } },
    ])
    const bytes = buildRequestContextResult(9, {
      env: { workspace_paths: ["/tmp/ws"], shell: "/bin/zsh" },
      tools: descriptors,
      rules_info_complete: true,
    })
    const dec = decodeMessage<any>("AgentClientMessage", bytes)
    const rc = dec.exec_client_message.request_context_result.success.request_context
    expect(rc.env.workspace_paths).toEqual(["/tmp/ws"])
    expect(rc.tools).toHaveLength(1)
    expect(rc.tools[0].name).toBe("opencode-read")
  })
})
