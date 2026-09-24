import { describe, it, expect } from "bun:test"
import protobuf from "protobufjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  mapExecServerToToolName,
  mapToolNameToExecField,
  mapCursorArgsToOpencode,
  parseExecServerMessage,
  buildExecClientMessages,
  buildToolCallPart,
  parseExecIdFromToolCallId,
  toolsToDescriptors,
  toolsToMcpDescriptors,
  resolveToolServerIdentity,
  mcpRealToolName,
  detectExecVariantField,
  buildRequestContextResult,
  buildMcpStateResult,
  buildTypedExecResult,
  unwrapReadOutput,
  buildCustomWebToolAliases,
  resolveCustomWebToolAlias,
  extractHostSubagentCatalog,
  mapCursorSubagentTypeToOpenCode,
  remapNativeSubagentForCatalog,
  preferCorrelatedTaskDescription,
  rejectPartialReadMutation,
  resolveCursorSubagentType,
  REQUEST_CONTEXT_RESULT_FIELD,
  isUriReadTarget,
  resolveReadTargetPath,
  buildListMcpResourcesFallback,
  buildReadMcpResourceFallback,
  CUSTOM_LIST_MCP_RESOURCES_TOOL,
  CUSTOM_READ_MCP_RESOURCE_TOOL,
  hostToolDialectFromTools,
  opencodePathArg,
  OPENCODE_2_TOOL_DIALECT,
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

/** Independent canonical agent.v1 ExecServerMessage #28 fixture. */
function canonicalSubagentExecMessage(): Uint8Array {
  const text = new TextEncoder()
  const args: number[] = []
  const exec: number[] = []
  const writeVarint = (out: number[], n: number) => {
    let v = n >>> 0
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7 }
    out.push(v)
  }
  const writeString = (out: number[], field: number, value: string) => {
    const bytes = text.encode(value)
    writeVarint(out, (field << 3) | 2)
    writeVarint(out, bytes.length)
    out.push(...bytes)
  }
  writeString(args, 1, "task-call-34")
  writeString(args, 2, "generalPurpose")
  writeString(args, 3, "cursor-model")
  writeString(args, 4, "Inspect recent logs and identify the root cause")
  writeString(args, 6, "ses_previous")
  writeVarint(args, (7 << 3) | 0); writeVarint(args, 1)
  writeVarint(exec, (1 << 3) | 0); writeVarint(exec, 34)
  writeVarint(exec, (28 << 3) | 2); writeVarint(exec, args.length); exec.push(...args)
  return Uint8Array.from(exec)
}

/** Independent canonical agent.v1 ExecServerMessage #16 fixture. */
function canonicalBackgroundShellExecMessage(): Uint8Array {
  const text = new TextEncoder()
  const args: number[] = []
  const exec: number[] = []
  const writeVarint = (out: number[], n: number) => {
    let v = n >>> 0
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7 }
    out.push(v)
  }
  const writeString = (out: number[], field: number, value: string) => {
    const bytes = text.encode(value)
    writeVarint(out, (field << 3) | 2)
    writeVarint(out, bytes.length)
    out.push(...bytes)
  }
  writeString(args, 1, "zig translate-c /tmp/tiny.c -lc")
  writeString(args, 2, "/tmp")
  writeString(args, 3, "shell-call-49")
  writeString(args, 7, "Run translate-c without blocking")
  writeVarint(exec, (1 << 3) | 0); writeVarint(exec, 49)
  writeVarint(exec, (16 << 3) | 2); writeVarint(exec, args.length); exec.push(...args)
  return Uint8Array.from(exec)
}

/** Decode only the exec #36 response using an independent canonical schema. */
function decodeCanonicalMcpStateResult(bytes: Uint8Array): any {
  const root = new protobuf.Root()
  root.add(new protobuf.Type("CanonicalMcpToolDefinition")
    .add(new protobuf.Field("name", 1, "string"))
    .add(new protobuf.Field("description", 2, "string"))
    .add(new protobuf.Field("input_schema", 3, "bytes"))
    .add(new protobuf.Field("provider_identifier", 4, "string"))
    .add(new protobuf.Field("tool_name", 5, "string")))
  root.add(new protobuf.Type("CanonicalMcpStateServer")
    .add(new protobuf.Field("server_name", 1, "string"))
    .add(new protobuf.Field("server_identifier", 2, "string"))
    .add(new protobuf.Field("tools", 5, "CanonicalMcpToolDefinition", "repeated")))
  root.add(new protobuf.Type("CanonicalMcpStateSuccess")
    .add(new protobuf.Field("servers", 1, "CanonicalMcpStateServer", "repeated")))
  root.add(new protobuf.Type("CanonicalMcpStateExecResult")
    .add(new protobuf.Field("success", 1, "CanonicalMcpStateSuccess")))
  root.add(new protobuf.Type("CanonicalExecClientMessage")
    .add(new protobuf.Field("id", 1, "uint32"))
    .add(new protobuf.Field("mcp_state_exec_result", 36, "CanonicalMcpStateExecResult")))
  root.add(new protobuf.Type("CanonicalAgentClientMessage")
    .add(new protobuf.Field("exec_client_message", 2, "CanonicalExecClientMessage")))
  return root.lookupType("CanonicalAgentClientMessage").decode(bytes) as any
}

describe("resolveToolServerIdentity", () => {
  it("keeps builtins under the default server", () => {
    expect(resolveToolServerIdentity("read")).toEqual({
      server: "opencode",
      toolName: "read",
      opencodeName: "read",
    })
    expect(resolveToolServerIdentity("todowrite")).toEqual({
      server: "opencode",
      toolName: "todowrite",
      opencodeName: "todowrite",
    })
  })

  it("uses only configured MCP server ids and prefers the longest match", () => {
    expect(resolveToolServerIdentity("github_create_pull_request", "opencode", ["github"])).toEqual({
      server: "github",
      toolName: "create_pull_request",
      opencodeName: "github_create_pull_request",
    })
    expect(resolveToolServerIdentity("my_server_lookup", "opencode", ["my", "my_server"])).toEqual({
      server: "my_server",
      toolName: "lookup",
      opencodeName: "my_server_lookup",
    })
  })

  it("keeps unknown underscore-containing custom tools under opencode", () => {
    expect(resolveToolServerIdentity("custom_helper")).toEqual({
      server: "opencode",
      toolName: "custom_helper",
      opencodeName: "custom_helper",
    })
  })
})

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

  it("preserves real MCP server identity on flat descriptors", () => {
    const d = toolsToDescriptors([
      { name: "read", description: "Read" },
      { name: "github_create_pull_request", description: "Open a PR" },
    ], "opencode", ["github"])
    const read = d.find((tool) => tool.tool_name === "read")
    const pr = d.find((tool) => tool.tool_name === "create_pull_request")
    expect(read?.provider_identifier).toBe("opencode")
    expect(read?.name).toBe("opencode-read")
    expect(pr?.provider_identifier).toBe("github")
    expect(pr?.name).toBe("github-create_pull_request")
  })

  it("defaults a missing schema to an empty object schema", () => {
    const d = toolsToDescriptors([{ name: "x" }])
    expect((d[0].input_schema as Uint8Array).length).toBeGreaterThan(0)
    expect(d[0].description).toBe("")
  })

  it("keeps collision-safe web aliases exact in Cursor's visible descriptor name", () => {
    const d = toolsToDescriptors([
      { name: "custom_websearch", description: "Search" },
      { name: "custom_webfetch", description: "Fetch" },
    ])
    expect(d.map((tool) => tool.name)).toEqual(["custom_websearch", "custom_webfetch"])
    expect(d.map((tool) => tool.tool_name)).toEqual(["custom_websearch", "custom_webfetch"])
  })

  it("emits descriptors in advertised order instead of sorting by name", () => {
    const d = toolsToDescriptors([
      { name: "read", description: "Read" },
      { name: "bash", description: "Shell" },
    ])
    expect(d.map((tool) => tool.tool_name)).toEqual(["read", "bash"])
  })
})

describe("custom web tool aliases", () => {
  it("aliases exact web tools and preserves their schemas", () => {
    const fetchSchema = { type: "object", properties: { url: { type: "string" } } }
    const catalog = buildCustomWebToolAliases([
      { name: "websearch", description: "Search", inputSchema: { type: "object" } },
      { name: "webfetch", description: "Fetch", inputSchema: fetchSchema },
      { name: "read", description: "Read" },
    ])
    expect(catalog.advertisedTools.map((tool) => tool.name)).toEqual([
      "custom_websearch",
      "custom_webfetch",
      "read",
    ])
    expect(catalog.advertisedTools[1]!.inputSchema).toBe(fetchSchema)
    expect(resolveCustomWebToolAlias("custom_websearch", catalog.aliases)).toBe("websearch")
    expect(resolveCustomWebToolAlias("custom_webfetch", catalog.aliases)).toBe("webfetch")
  })

  it("prefers OpenCode's exact websearch over an installed MCP search provider", () => {
    const catalog = buildCustomWebToolAliases([
      { name: "brave-search_brave_web_search", description: "Brave" },
      { name: "websearch", description: "OpenCode Web Search" },
    ])
    expect(catalog.aliases.get("custom_websearch")).toBe("websearch")
    expect(catalog.advertisedTools.map((tool) => tool.name)).toEqual([
      "brave-search_brave_web_search",
      "custom_websearch",
    ])
  })

  it("aliases one unique flattened MCP search tool", () => {
    const catalog = buildCustomWebToolAliases([
      { name: "brave-search_brave_web_search", description: "Search" },
      { name: "webfetch", description: "Fetch" },
    ])
    expect(catalog.aliases.get("custom_websearch")).toBe("brave-search_brave_web_search")
    expect(catalog.advertisedTools.some((tool) => tool.name === "custom_websearch")).toBe(true)
    const flat = toolsToDescriptors(catalog.advertisedTools, "opencode", ["brave-search"])
    expect(flat.find((tool) => tool.name === "custom_websearch")).toMatchObject({
      name: "custom_websearch",
      provider_identifier: "brave-search",
      tool_name: "custom_websearch",
    })
    const nested = toolsToMcpDescriptors(catalog.advertisedTools, "opencode", ["brave-search"])
    expect(nested.find((descriptor) => descriptor.server_identifier === "brave-search"))
      .toMatchObject({
      server_identifier: "brave-search",
      tools: [{ tool_name: "custom_websearch" }],
    })
    expect(
      resolveCustomWebToolAlias("brave-search_custom_websearch", catalog.aliases),
    ).toBe("brave-search_brave_web_search")
  })

  it("fails closed for ambiguous search providers and preserves an existing custom alias", () => {
    const ambiguous = buildCustomWebToolAliases([
      { name: "brave_brave_web_search" },
      { name: "other_web_search" },
      { name: "webfetch" },
    ])
    expect(ambiguous.aliases.has("custom_websearch")).toBe(false)
    expect(ambiguous.ambiguous.get("custom_websearch")).toEqual([
      "brave_brave_web_search",
      "other_web_search",
    ])
    expect(ambiguous.advertisedTools.slice(0, 2).map((tool) => tool.name)).toEqual([
      "brave_brave_web_search",
      "other_web_search",
    ])

    const customSearch = { name: "custom_websearch", description: "Plugin fallback" }
    const existing = buildCustomWebToolAliases([
      customSearch,
      { name: "brave_brave_web_search" },
    ])
    expect(existing.aliases.has("custom_websearch")).toBe(false)
    expect(existing.ambiguous.has("custom_websearch")).toBe(false)
    expect(existing.advertisedTools[0]).toEqual(customSearch)
    expect(resolveCustomWebToolAlias("custom_websearch", existing.aliases)).toBe(
      "custom_websearch",
    )
    expect(existing.advertisedTools.map((tool) => tool.name)).toEqual([
      "custom_websearch",
      "brave_brave_web_search",
    ])
  })

  it("aliases list_mcp_resources/read_mcp_resource to break the Cursor-native collision (Option B)", () => {
    const catalog = buildCustomWebToolAliases([
      { name: "list_mcp_resources", description: "List MCP resources" },
      { name: "read_mcp_resource", description: "Read an MCP resource" },
      { name: "list_mcp_resource_templates", description: "No Cursor field for this one" },
    ])
    expect(catalog.advertisedTools.map((tool) => tool.name)).toEqual([
      CUSTOM_LIST_MCP_RESOURCES_TOOL,
      CUSTOM_READ_MCP_RESOURCE_TOOL,
      "list_mcp_resource_templates",
    ])
    expect(resolveCustomWebToolAlias(CUSTOM_LIST_MCP_RESOURCES_TOOL, catalog.aliases)).toBe(
      "list_mcp_resources",
    )
    expect(resolveCustomWebToolAlias(CUSTOM_READ_MCP_RESOURCE_TOOL, catalog.aliases)).toBe(
      "read_mcp_resource",
    )

    const flat = toolsToDescriptors(catalog.advertisedTools)
    expect(flat.map((tool) => tool.name)).toContain(CUSTOM_LIST_MCP_RESOURCES_TOOL)
    expect(flat.map((tool) => tool.name)).toContain(CUSTOM_READ_MCP_RESOURCE_TOOL)
  })
})

describe("MCP resource exec typed fallback (fields 17/18, Option B)", () => {
  it("answers list_mcp_resources with an empty success", () => {
    const decoded = decodeMessage<any>(
      "AgentClientMessage",
      buildListMcpResourcesFallback(13),
    )
    expect(decoded.exec_client_message.id).toBe(13)
    expect(decoded.exec_client_message.list_mcp_resources_exec_result).toMatchObject({
      success: { resources: [] },
    })
  })

  it("answers read_mcp_resource with a server-not-found error, echoing uri", () => {
    const decoded = decodeMessage<any>(
      "AgentClientMessage",
      buildReadMcpResourceFallback(13, "everything", "demo://resource/static/document/1"),
    )
    expect(decoded.exec_client_message.id).toBe(13)
    expect(decoded.exec_client_message.read_mcp_resource_exec_result).toMatchObject({
      error: {
        uri: "demo://resource/static/document/1",
        error: 'Server "everything" not found',
      },
    })
  })
})

describe("toolsToMcpDescriptors", () => {
  it("splits mcp_descriptors by real server, builtins under opencode", () => {
    const d = toolsToMcpDescriptors([
      { name: "read", description: "Read" },
      { name: "github_create_pull_request", description: "Open a PR" },
      { name: "github_get_me", description: "Who am I" },
      { name: "brave_web_search", description: "Search" },
      { name: "bash", description: "Shell" },
    ], "opencode", ["github", "brave"])
    expect(d.map((x) => x.server_identifier)).toEqual(["opencode", "github", "brave"])
    expect(d[0].server_name).toBe("opencode")
    expect((d[0].tools as Array<{ tool_name: string }>).map((t) => t.tool_name)).toEqual([
      "read",
      "bash",
    ])
    expect((d[1].tools as Array<{ tool_name: string }>).map((t) => t.tool_name)).toEqual([
      "create_pull_request",
      "get_me",
    ])
    expect((d[2].tools as Array<{ tool_name: string }>).map((t) => t.tool_name)).toEqual([
      "web_search",
    ])
  })

  it("follows advertised order instead of sorting by name or server", () => {
    const tools = [
      { name: "read", description: "Read" },
      { name: "github_get_me", description: "Who am I" },
      { name: "bash", description: "Shell" },
    ]
    const d = toolsToMcpDescriptors(tools, "opencode", ["github"])
    expect(d.map((x) => x.server_identifier)).toEqual(["opencode", "github"])
    expect((d[0].tools as Array<{ tool_name: string }>).map((t) => t.tool_name)).toEqual([
      "read",
      "bash",
    ])
  })

  it("returns no descriptors for an empty tool list", () => {
    expect(toolsToMcpDescriptors([])).toEqual([])
  })
})

describe("mcpRealToolName", () => {
  it("reconstructs OpenCode MCP ids from provider + bare tool", () => {
    expect(
      mcpRealToolName({
        provider_identifier: "github",
        tool_name: "create_pull_request",
        name: "github-create_pull_request",
      }),
    ).toBe("github_create_pull_request")
  })

  it("keeps builtin tool_name bare under opencode", () => {
    expect(mcpRealToolName({ provider_identifier: "opencode", tool_name: "read" })).toBe("read")
  })

  it("falls back from composite name when tool_name is missing", () => {
    expect(mcpRealToolName({ name: "github-create_pull_request" })).toBe(
      "github_create_pull_request",
    )
    expect(mcpRealToolName({ name: "opencode-read" })).toBe("read")
  })

  it("does not double-prefix when tool_name is already namespaced", () => {
    expect(
      mcpRealToolName({
        provider_identifier: "github",
        tool_name: "github_create_pull_request",
      }),
    ).toBe("github_create_pull_request")
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
    expect(mapExecServerToToolName("background_shell_spawn_args")).toBe("bash")
  })
  it("maps mcp_args → mcp", () => {
    expect(mapExecServerToToolName("mcp_args")).toBe("mcp")
  })
  it("maps subagent_args → task", () => {
    expect(mapExecServerToToolName("subagent_args")).toBe("task")
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
  it("maps task → subagent_args", () => {
    expect(mapToolNameToExecField("task")).toBe("subagent_args")
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
  it("preserves empty write and replacement content", () => {
    expect(mapCursorArgsToOpencode("write", { path: "/empty.txt", content: "" })).toEqual({
      toolName: "write",
      args: { filePath: "/empty.txt", content: "" },
    })
    expect(
      mapCursorArgsToOpencode("edit", {
        path: "/a.ts",
        old_string: "remove me",
        new_string: "",
      }),
    ).toEqual({
      toolName: "edit",
      args: { filePath: "/a.ts", oldString: "remove me", newString: "" },
    })
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
  it("preserves an opaque textual edit input instead of dropping it", () => {
    const r = mapCursorArgsToOpencode("edit", {
      i: "Edit lines 1 and 3 at file start",
      input: "[/tmp/lines-1200.txt#9D54]\nPUT 1.=1:\n+EDITED line 1200\nPUT 3.=3:\n+EDITED K1 line 1198",
    })
    expect(r).toEqual({
      toolName: "edit",
      args: {
        input: "[/tmp/lines-1200.txt#9D54]\nPUT 1.=1:\n+EDITED line 1200\nPUT 3.=3:\n+EDITED K1 line 1198",
      },
    })
  })
})


describe("OpenCode 2 host tool dialect", () => {
  const oc2 = hostToolDialectFromTools([
    { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "write", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
    { name: "edit", inputSchema: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } } } },
    { name: "shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  ])

  it("detects path + shell from OpenCode 2.0 schemas", () => {
    expect(oc2).toEqual({ filePathKey: "path", shellTool: "shell" })
  })

  it("emits path not filePath for read/write/edit", () => {
    expect(mapCursorArgsToOpencode("read", { path: "/a.ts", offset: 10 }, undefined, oc2)).toEqual({
      toolName: "read",
      args: { path: "/a.ts", offset: 10 },
    })
    expect(mapCursorArgsToOpencode("write", { path: "/a.ts", file_text: "hi" }, undefined, oc2)).toEqual({
      toolName: "write",
      args: { path: "/a.ts", content: "hi" },
    })
    expect(mapCursorArgsToOpencode("write", { path: "/a.ts", contents: "hi" }, undefined, oc2)).toEqual({
      toolName: "write",
      args: { path: "/a.ts", content: "hi" },
    })
    expect(mapCursorArgsToOpencode("edit", { filePath: "/a.ts", old_string: "a", new_string: "b" }, undefined, oc2)).toEqual({
      toolName: "edit",
      args: { path: "/a.ts", oldString: "a", newString: "b" },
    })
  })

  it("maps bash to the advertised shell tool", () => {
    expect(mapCursorArgsToOpencode("bash", { command: "ls" }, undefined, oc2)).toEqual({
      toolName: "shell",
      args: { command: "ls" },
    })
  })

  it("forwards OpenCode execute Code Mode `{ code }` unchanged", () => {
    expect(mapCursorArgsToOpencode("execute", { code: "return 1 + 1" })).toEqual({
      toolName: "execute",
      args: { code: "return 1 + 1" },
    })
    expect(mapCursorArgsToOpencode("execute", { code: "return 1 + 1" }, "mcp_args", oc2)).toEqual({
      toolName: "execute",
      args: { code: "return 1 + 1" },
    })

    // OpenCode 2 keeps MCP tools inside Code Mode. The provider must send the
    // host's JavaScript through `execute` without treating the nested MCP name
    // as an absent direct AI SDK tool.
    const code = 'return await tools.context7["resolve-library-id"]({ libraryName: "react" })'
    const parsed = parseExecServerMessage({
      id: 42,
      mcp_args: {
        name: "opencode-execute",
        tool_name: "execute",
        provider_identifier: "opencode",
        args: [mcpArgEntry("code", code)],
      },
    }, oc2)
    expect(parsed?.toolName).toBe("execute")
    expect(parsed?.args).toEqual({ code })
    expect(buildToolCallPart(parsed!, "session")).toMatchObject({
      toolName: "execute",
      input: JSON.stringify({ code }),
    })
  })

  it("parses read_args onto path for OpenCode 2", () => {
    const result = parseExecServerMessage({
      id: 1,
      read_args: { path: "/test.txt", tool_call_id: "tc1" },
    }, oc2)
    expect(result!.args).toEqual({ path: "/test.txt" })
    expect(result!.args.filePath).toBeUndefined()
    expect(opencodePathArg(result!.args)).toBe("/test.txt")
  })

  it("falls back to path when only shell is advertised", () => {
    expect(hostToolDialectFromTools([{ name: "shell" }])).toEqual({
      filePathKey: "path",
      shellTool: "shell",
    })
  })

  it("falls back to defaultDialect when tools list is empty or opaque", () => {
    expect(hostToolDialectFromTools([], OPENCODE_2_TOOL_DIALECT)).toEqual({
      filePathKey: "path",
      shellTool: "shell",
    })
  })

  it("detects path from schema with parameters wrapper", () => {
    expect(hostToolDialectFromTools([{ name: "read", inputSchema: { parameters: { properties: { path: { type: "string" } } } } }])).toEqual({
      filePathKey: "path",
      shellTool: "bash",
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

  it("preserves the applied native read range for typed result metadata", () => {
    const result = parseExecServerMessage({
      id: 2,
      exec_id: "exec-2",
      read_args: { path: "/test.txt", offset: 175, limit: 40 },
    })
    expect(result!.args).toEqual({ filePath: "/test.txt", offset: 175, limit: 40 })
    expect(result!.resultMetadata).toEqual({ path: "/test.txt", offset: 175, limit: 40 })
  })

  it("parses write_args with filePath/content", () => {
    const result = parseExecServerMessage({
      id: 3,
      write_args: { path: "/out.txt", file_text: "hello", tool_call_id: "tc" },
    })
    expect(result!.toolName).toBe("write")
    expect(result!.args).toEqual({ filePath: "/out.txt", content: "hello" })
    expect(result!.resultField).toBe("write_result")
    expect(result!.resultMetadata).toEqual({ path: "/out.txt" })
  })

  it("parses pi_write_args as OpenCode write + pi_write_result", () => {
    const result = parseExecServerMessage({
      id: 48,
      pi_write_args: { path: "/out.txt", content: "hello pi" },
    })
    expect(result!.toolName).toBe("write")
    expect(result!.args).toEqual({ filePath: "/out.txt", content: "hello pi" })
    expect(result!.resultField).toBe("pi_write_result")
    expect(result!.resultMetadata).toEqual({ path: "/out.txt" })
  })

  it("decodes canonical field #28 and maps it to OpenCode task", () => {
    const esm = decodeMessage<any>("ExecServerMessage", canonicalSubagentExecMessage())
    const result = parseExecServerMessage(esm)
    expect(result).toMatchObject({
      id: 34,
      toolName: "task",
      resultField: "subagent_result",
      args: {
        // SubagentArgs has no description field; fallback is first 5 prompt words.
        description: "Inspect recent logs and identify",
        prompt: "Inspect recent logs and identify the root cause",
        subagent_type: "general",
        task_id: "ses_previous",
        background: true,
      },
    })
    expect(result?.localError).toBeUndefined()
  })

  it("prefers Cursor TaskToolCall description over the 5-word prompt fallback", () => {
    const esm = decodeMessage<any>("ExecServerMessage", canonicalSubagentExecMessage())
    const result = parseExecServerMessage(esm)!
    expect(result.args.description).toBe("Inspect recent logs and identify")

    preferCorrelatedTaskDescription(result, "Find auth root cause")
    expect(result.args.description).toBe("Find auth root cause")

    // Empty / whitespace must not wipe the existing fallback title.
    preferCorrelatedTaskDescription(result, "   ")
    expect(result.args.description).toBe("Find auth root cause")
  })

  it("decodes canonical field #16 with a self-contained background fallback", () => {
    const esm = decodeMessage<any>("ExecServerMessage", canonicalBackgroundShellExecMessage())
    const result = parseExecServerMessage(esm)
    expect(result).toMatchObject({
      id: 49,
      toolName: "bash",
      resultField: "background_shell_spawn_result",
      resultMetadata: {
        background_shell_spawn: true,
        command: "zig translate-c /tmp/tiny.c -lc",
        working_directory: "/tmp",
      },
      args: {
        workdir: "/tmp",
      },
    })
    expect(result?.args.command).toContain("nohup sh -c 'zig translate-c /tmp/tiny.c -lc'")
    expect(result?.args.command).toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(result?.localError).toBeUndefined()
  })

  it("rejects interactive background shells with a typed local error", () => {
    const result = parseExecServerMessage({
      id: 49,
      background_shell_spawn_args: {
        command: "python -i",
        enable_write_shell_stdin_tool: true,
      },
    })
    expect(result?.resultField).toBe("background_shell_spawn_result")
    expect(result?.localError).toContain("Interactive background shells")
  })

  it("rejects a subagent exec missing required OpenCode task fields", () => {
    const result = parseExecServerMessage({ id: 34, subagent_args: { prompt: "Inspect" } })
    expect(result?.toolName).toBe("task")
    expect(result?.resultField).toBe("subagent_result")
    expect(result?.localError).toContain("missing a required prompt or subagent type")
  })

  it("maps known Cursor subagent types and preserves compatible custom OpenCode names", () => {
    expect(mapCursorSubagentTypeToOpenCode("generalPurpose")).toBe("general")
    expect(mapCursorSubagentTypeToOpenCode("cursor-guide")).toBe("explore")
    expect(mapCursorSubagentTypeToOpenCode("best-of-n-runner")).toBe("general")
    expect(mapCursorSubagentTypeToOpenCode("bugbot")).toBe("explore")
    expect(mapCursorSubagentTypeToOpenCode("security-review")).toBe("explore")
    expect(mapCursorSubagentTypeToOpenCode("computer_use")).toBe("general")
    for (const subagentType of ["explore", "my-reviewer"]) {
      const result = parseExecServerMessage({
        id: 34,
        subagent_args: { prompt: "Inspect", subagent_type: subagentType },
      })
      expect(result?.args.subagent_type).toBe(subagentType)
    }
  })

  it("extracts subagents from the generated OpenCode Task catalog", () => {
    const catalog = extractHostSubagentCatalog([{
      name: "task",
      description: [
        "Delegate work to a subagent.",
        "Available agent types and the tools they have access to:",
        "- general: General-purpose work.",
        "- explore: Local codebase search.",
        "- scout: External docs and dependency source.",
      ].join("\n"),
      inputSchema: { type: "object", properties: { subagent_type: { type: "string" } } },
    }])

    expect(catalog).toEqual({
      executor: "task",
      agents: [
        { name: "general", description: "General-purpose work." },
        { name: "explore", description: "Local codebase search." },
        { name: "scout", description: "External docs and dependency source." },
      ],
      complete: true,
    })
  })

  it("prefers Task's structured subagent enum over prose", () => {
    const catalog = extractHostSubagentCatalog([{
      name: "task",
      description: [
        "Launch a subagent.",
        "Available agent types and the tools they have access to:",
        "- general: General work.",
        "- explore: Local search.",
        "- reviewer: Configured subagent.",
        "- all-mode-agent: Listed in prose but rejected by the enum.",
      ].join("\n"),
      inputSchema: {
        properties: {
          subagent_type: { type: "string", enum: ["general", "explore", "reviewer"] },
        },
      },
    }])

    expect(catalog.executor).toBe("task")
    expect(catalog.complete).toBe(true)
    expect(catalog.agents.map((agent) => agent.name)).toEqual(["general", "explore", "reviewer"])
  })

  it("resolves exact custom agents before semantic fallbacks", () => {
    const catalog = {
      executor: "task" as const,
      agents: ["general", "explore", "scout", "bugbot", "reviewer", "unspecified"]
        .map((name) => ({ name })),
      complete: true,
    }

    expect(resolveCursorSubagentType("reviewer", catalog)).toBe("reviewer")
    expect(resolveCursorSubagentType("bugbot", catalog)).toBe("bugbot")
    expect(resolveCursorSubagentType("cursor-guide", catalog)).toBe("scout")
    expect(resolveCursorSubagentType("explore", catalog)).toBe("explore")
    expect(resolveCursorSubagentType("unspecified", catalog)).toBe("general")
    expect(resolveCursorSubagentType("future-cursor-agent", catalog)).toBe("general")
  })

  it("does not invent a generic recipient when a complete catalog omits general", () => {
    expect(resolveCursorSubagentType("unspecified", {
      executor: "task",
      agents: [{ name: "explore" }],
      complete: true,
    })).toBeUndefined()
  })

  it("maps Cursor-native bugbot review tasks to OpenCode explore", () => {
    const result = parseExecServerMessage({
      id: 35,
      subagent_args: {
        prompt: "Review the uncommitted diff for correctness bugs",
        subagent_type: "bugbot",
        readonly: true,
      },
    })
    expect(result?.toolName).toBe("task")
    expect(result?.args).toMatchObject({
      prompt: "Review the uncommitted diff for correctness bugs",
      subagent_type: "explore",
    })
    expect(result?.localError).toBeUndefined()
  })

  it("keeps native subagent resume and background fields canonical", () => {
    const parsed = parseExecServerMessage({
      id: 35,
      subagent_args: {
        prompt: "Inspect the MCP import bridge",
        subagent_type: "bugbot",
        resume_agent_id: "task_previous",
        run_in_background: true,
      },
    })
    expect(parsed).toBeDefined()
    remapNativeSubagentForCatalog(parsed!, ["task", "read"])
    expect(parsed).toMatchObject({
      toolName: "task",
      resultField: "subagent_result",
      args: {
        description: "Inspect the MCP import bridge",
        prompt: "Inspect the MCP import bridge",
        subagent_type: "explore",
        task_id: "task_previous",
        background: true,
      },
    })
  })

  it("uses an enabled custom scout for Cursor guide requests", () => {
    const parsed = parseExecServerMessage({
      id: 36,
      subagent_args: {
        prompt: "Inspect upstream package documentation",
        subagent_type: "cursor-guide",
      },
    })
    remapNativeSubagentForCatalog(parsed!, ["task"], {
      executor: "task",
      agents: [{ name: "general" }, { name: "explore" }, { name: "scout" }],
      complete: true,
    })
    expect(parsed).toMatchObject({
      toolName: "task",
      args: { subagent_type: "scout" },
    })
  })

  it("extracts subagents from the OpenCode 2 subagent catalog", () => {
    const catalog = extractHostSubagentCatalog([{
      name: "subagent",
      description: [
        "Spawns an agent in a child session.",
        "Available subagents: - explore: Fast agent specialized for exploring codebases. - general: General-purpose agent.",
      ].join(" "),
      inputSchema: { type: "object", properties: { agent: { type: "string" } } },
    }])
    expect(catalog.executor).toBe("subagent")
    expect(catalog.complete).toBe(true)
    expect(catalog.agents.map((agent) => agent.name)).toEqual(["explore", "general"])
  })

  it("remaps native Cursor Task onto OpenCode 2 subagent args", () => {
    const parsed = parseExecServerMessage({
      id: 37,
      subagent_args: {
        prompt: "Inspect the MCP import bridge",
        subagent_type: "bugbot",
        resume_agent_id: "ses_previous",
        run_in_background: true,
      },
    })
    remapNativeSubagentForCatalog(parsed!, ["subagent", "read"], {
      executor: "subagent",
      agents: [{ name: "general" }, { name: "explore" }],
      complete: true,
    })
    expect(parsed).toMatchObject({
      toolName: "subagent",
      resultField: "subagent_result",
      args: {
        agent: "explore",
        description: "Inspect the MCP import bridge",
        prompt: "Inspect the MCP import bridge",
        sessionID: "ses_previous",
        background: true,
      },
    })
    expect(parsed!.args.subagent_type).toBeUndefined()
    expect(parsed!.args.task_id).toBeUndefined()
  })

  it("maps every canonical Pi exec request to its offset result field", () => {
    const cases = [
      {
        request: "pi_read_args",
        raw: { path: "/tmp/a.ts", offset: 2, limit: 10 },
        toolName: "read",
        args: { filePath: "/tmp/a.ts", offset: 2, limit: 10 },
        result: "pi_read_result",
      },
      {
        request: "pi_bash_args",
        raw: { command: "echo hi", timeout: 1.5 },
        toolName: "bash",
        args: { command: "echo hi", timeout: 1.5 },
        result: "pi_bash_result",
      },
      {
        request: "pi_edit_args",
        raw: { path: "/tmp/a.ts", edits: [{ old_text: "a", new_text: "b" }] },
        toolName: "edit",
        args: { filePath: "/tmp/a.ts", oldString: "a", newString: "b" },
        result: "pi_edit_result",
      },
      {
        request: "pi_grep_args",
        raw: { pattern: "needle", path: "/tmp", glob: "*.ts" },
        toolName: "grep",
        args: { pattern: "needle", path: "/tmp", include: "*.ts" },
        result: "pi_grep_result",
      },
      {
        request: "pi_find_args",
        raw: { pattern: "*.ts", path: "/tmp" },
        toolName: "glob",
        args: { pattern: "*.ts", path: "/tmp" },
        result: "pi_find_result",
      },
      {
        request: "pi_ls_args",
        raw: { path: "/tmp", limit: 20 },
        toolName: "read",
        args: { filePath: "/tmp", limit: 20 },
        result: "pi_ls_result",
      },
    ] as const

    for (const c of cases) {
      const parsed = parseExecServerMessage({ id: 45, [c.request]: c.raw })
      expect(parsed?.toolName, c.request).toBe(c.toolName)
      expect(parsed?.args, c.request).toEqual(c.args)
      expect(parsed?.resultField, c.request).toBe(c.result)
      expect(parsed?.localError, c.request).toBeUndefined()
    }
  })

  it("returns a typed local error for an unrepresentable multi-edit Pi request", () => {
    const parsed = parseExecServerMessage({
      id: 47,
      pi_edit_args: {
        path: "/tmp/a.ts",
        edits: [
          { old_text: "a", new_text: "b" },
          { old_text: "c", new_text: "d" },
        ],
      },
    })
    expect(parsed?.resultField).toBe("pi_edit_result")
    expect(parsed?.localError).toContain("cannot be represented safely")
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
    expect(result!.resultMetadata).toEqual({ pattern: "foo", path: "/src" })
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
    expect(result!.args).toEqual({ command: "ls", workdir: "/tmp", timeout: 30_000 })
    expect(result!.resultField).toBe("shell_stream")
  })

  it("maps shell_args to bash + shell_result, reusing the stream timeout defaults", () => {
    const result = parseExecServerMessage({
      id: 12,
      shell_args: { command: "ls", working_directory: "/tmp" },
    })
    expect(result!.toolName).toBe("bash")
    expect(result!.args).toEqual({ command: "ls", workdir: "/tmp", timeout: 30_000 })
    expect(result!.resultField).toBe("shell_result")
    expect(result!.resultMetadata).toMatchObject({
      shell_stream: true,
      command: "ls",
      working_directory: "/tmp",
      timeout_ms: 30_000,
      timeout_behavior: 0,
    })
  })

  it("preserves Cursor shell timeout policy and applies native zero defaults", () => {
    const foreground = parseExecServerMessage({
      id: 5,
      shell_stream_args: { command: "make test", timeout: 0, timeout_behavior: 0 },
    })
    expect(foreground!.args.timeout).toBe(30_000)
    expect(foreground!.resultMetadata).toEqual({
      shell_stream: true,
      command: "make test",
      working_directory: "",
      timeout_ms: 30_000,
      timeout_behavior: 0,
    })

    const background = parseExecServerMessage({
      id: 6,
      shell_stream_args: {
        command: "make test",
        working_directory: "/repo",
        timeout: 0,
        timeout_behavior: 2,
        hard_timeout: 120_000,
      },
    })
    expect(background!.args.timeout).toBe(0)
    expect(background!.resultMetadata).toMatchObject({
      timeout_ms: 0,
      timeout_behavior: 2,
      hard_timeout_ms: 120_000,
    })
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
    expect(parsed!.resultMetadata).toEqual({ path: "/README.md", offset: 1 })
  })

  it("preserves Pi read ranges for result truncation semantics", () => {
    const parsed = parseExecServerMessage({
      id: 12,
      pi_read_args: { path: "/src/a.ts", offset: 7, limit: 20 },
    })
    expect(parsed!.args).toEqual({ filePath: "/src/a.ts", offset: 7, limit: 20 })
    expect(parsed!.resultMetadata).toEqual({ path: "/src/a.ts", offset: 7, limit: 20 })
  })

  it("returns undefined when no exec variant found", () => {
    expect(parseExecServerMessage({ id: 1 })).toBeUndefined()
  })

  it("returns undefined without id", () => {
    expect(parseExecServerMessage({ read_args: { path: "/x" } })).toBeUndefined()
  })
})

describe("partial-read mutation safety", () => {
  const notice =
    "\n\n[Partial read: the content above is lines 1-1275, capped at the host's 50 KB output limit. " +
    "It is NOT the complete file. Continue with offset=1276 before acting on the whole file; " +
    "writing the content above back would delete everything after line 1275.]"

  it("rejects a write that echoes a partial-read notice", () => {
    const parsed = parseExecServerMessage({
      id: 1,
      write_args: { path: "/tmp/large.ts", file_text: `partial${notice}` },
    })!

    rejectPartialReadMutation(parsed)

    expect(parsed.localError).toContain("partial-read notice")
  })

  it("allows a targeted edit to modify text that quotes the notice", () => {
    const parsed = parseExecServerMessage({
      id: 2,
      pi_edit_args: {
        path: "/tmp/large.ts",
        edits: [{ old_text: "complete file", new_text: `partial${notice}` }],
      },
    })!

    rejectPartialReadMutation(parsed)

    expect(parsed.localError).toBeUndefined()
  })

  it("rejects an Add File patch that would overwrite a file with partial content", () => {
    const patchText = `*** Begin Patch\n*** Add File: /tmp/large.ts\n+partial${notice}\n*** End Patch`
    const wire = encodeMessage("ExecServerMessage", {
      id: 4,
      mcp_args: {
        name: "opencode-apply_patch",
        tool_name: "apply_patch",
        provider_identifier: "opencode",
        args: [mcpArgEntry("patchText", patchText)],
      },
    })
    const parsed = parseExecServerMessage(decodeMessage("ExecServerMessage", wire))!

    rejectPartialReadMutation(parsed)

    expect(parsed.localError).toContain("partial-read notice")
  })

  it("does not reject ordinary mutations", () => {
    const parsed = parseExecServerMessage({
      id: 3,
      write_args: { path: "/tmp/small.ts", file_text: "complete content" },
    })!

    rejectPartialReadMutation(parsed)

    expect(parsed.localError).toBeUndefined()
  })

  it("rejects a whole-file write sourced from a character-truncated line", () => {
    const shortened = `${"x".repeat(2000)}... (line truncated to 2000 chars)`
    const read = buildTypedExecResult(
      "read_result",
      `Read file /tmp/long.txt, lines 1-1\n1: ${shortened}`,
    ) as { success: { content: string } }
    const parsed = parseExecServerMessage({
      id: 5,
      write_args: { path: "/tmp/long.txt", file_text: read.success.content },
    })!

    rejectPartialReadMutation(parsed)

    expect(parsed.localError).toContain("byte-preserving read method")
  })
})

describe("buildExecClientMessages", () => {
  it("returns canonical SubagentSuccess from OpenCode task output", () => {
    const frames = buildExecClientMessages({
      execId: 34,
      resultField: "subagent_result",
      output: '<task id="ses_child" state="completed">\n<task_result>\nFound the cause.\n</task_result>\n</task>',
      toolName: "task",
    })
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.id).toBe(34)
    expect(ec.subagent_result.success).toMatchObject({
      agent_id: "ses_child",
      final_message: "Found the cause.",
      tool_call_count: 0,
      background_reason: 0,
    })
    expect(frames).toHaveLength(2)
  })

  it("returns canonical SubagentError from OpenCode task failure output", () => {
    const frames = buildExecClientMessages({
      execId: 35,
      resultField: "subagent_result",
      output: '<task id="ses_child" state="error">\n<task_error>\nAgent failed.\n</task_error>\n</task>',
      toolName: "task",
    })
    const result = decodeMessage<any>("AgentClientMessage", frames[0])
      .exec_client_message.subagent_result
    expect(result.error).toEqual({ agent_id: "ses_child", error: "Agent failed." })
    expect(result.success).toBeUndefined()
  })

  it("parses OpenCode task output when state precedes id", () => {
    const frames = buildExecClientMessages({
      execId: 36,
      resultField: "subagent_result",
      output: '<task state="completed" id="ses_child">\n<task_result>\nDone.\n</task_result>\n</task>',
      toolName: "task",
    })
    const success = decodeMessage<any>("AgentClientMessage", frames[0])
      .exec_client_message.subagent_result.success
    expect(success).toMatchObject({
      agent_id: "ses_child",
      final_message: "Done.",
      background_reason: 0,
    })
  })

  it("marks asynchronous OpenCode task launch as background USER_REQUEST", () => {
    const frames = buildExecClientMessages({
      execId: 37,
      resultField: "subagent_result",
      output: '<task id="ses_bg" name="explore" state="running">',
      toolName: "task",
    })
    const success = decodeMessage<any>("AgentClientMessage", frames[0])
      .exec_client_message.subagent_result.success
    expect(success).toMatchObject({
      agent_id: "ses_bg",
      background_reason: 2,
    })
  })

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

  it("echoes WriteArgs.path on WriteSuccess when host output has no path tag", () => {
    const parsed = parseExecServerMessage({
      id: 3,
      write_args: { path: "/tmp/agent-tools/spill.txt", file_text: "{}" },
    })!
    const frames = buildExecClientMessages({
      execId: parsed.id,
      resultField: parsed.resultField,
      output: "Successfully wrote 64891 bytes to /tmp/agent-tools/spill.txt",
      resultMetadata: parsed.resultMetadata,
    })
    const success = decodeMessage<any>("AgentClientMessage", frames[0])
      .exec_client_message.write_result.success
    expect(success.path).toBe("/tmp/agent-tools/spill.txt")
  })

  it("does not invent a WriteSuccess.path from tag-free host write prose", () => {
    const frames = buildExecClientMessages({
      execId: 3,
      resultField: "write_result",
      output: "Successfully wrote 64891 bytes to /tmp/agent-tools/spill.txt",
    })
    const success = decodeMessage<any>("AgentClientMessage", frames[0])
      .exec_client_message.write_result.success
    expect(success.path).toBe("")
  })

  it("falls back to a <path> tag when write result metadata has no path", () => {
    const frames = buildExecClientMessages({
      execId: 3,
      resultField: "write_result",
      output: "Wrote\n<path>/tagged.txt</path>",
    })
    const success = decodeMessage<any>("AgentClientMessage", frames[0])
      .exec_client_message.write_result.success
    expect(success.path).toBe("/tagged.txt")
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

  it("encodes all Pi result fields and closes each exec stream", () => {
    const fields = [
      "pi_read_result",
      "pi_bash_result",
      "pi_edit_result",
      "pi_grep_result",
      "pi_find_result",
      "pi_ls_result",
    ]
    for (const [index, resultField] of fields.entries()) {
      const execId = 45 + index
      const frames = buildExecClientMessages({ execId, resultField, output: `out-${resultField}` })
      expect(frames).toHaveLength(2)
      const ecm = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
      expect(ecm[resultField]?.success?.output, resultField).toBe(`out-${resultField}`)
      const close = decodeMessage<any>("AgentClientMessage", frames[1])
      expect(close.exec_client_control_message?.stream_close?.id, resultField).toBe(execId)
    }
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

  it("grounds path-only shell_stream stdout without rewriting structured text", () => {
    const frames = buildExecClientMessages({
      execId: 30,
      resultField: "shell_stream",
      output: ["src/a.ts:2", '{"path":"src/a.ts"}', "@scope/pkg"].join("\n"),
      resultMetadata: { working_directory: "pkg" },
      workspaceRoot: "/workspace/project",
    })
    const stdout = decodeMessage<any>("AgentClientMessage", frames[1]).exec_client_message
      .shell_stream.stdout.data
    expect(stdout).toBe([
      "/workspace/project/pkg/src/a.ts:2",
      '{"path":"src/a.ts"}',
      "@scope/pkg",
    ].join("\n"))
  })

  it("encodes shell_result success/timeout/failure for exec #2", () => {
    const success = buildExecClientMessages({
      execId: 2,
      resultField: "shell_result",
      output: "ok\n",
      resultMetadata: { command: "echo ok", working_directory: "/tmp" },
      shellOutcome: { kind: "exit", code: 0 },
    })
    expect(success).toHaveLength(2)
    const ok = decodeMessage<any>("AgentClientMessage", success[0]).exec_client_message
    expect(ok.shell_result.success).toMatchObject({
      command: "echo ok",
      working_directory: "/tmp",
      exit_code: 0,
      stdout: "ok\n",
    })
    expect(ok.shell_result.rejected).toBeUndefined()

    const timedOut = buildExecClientMessages({
      execId: 2,
      resultField: "shell_result",
      output: "partial\n",
      resultMetadata: { command: "sleep 60", working_directory: "/tmp" },
      shellOutcome: { kind: "timeout", timeoutMs: 30_000 },
    })
    const timeout = decodeMessage<any>("AgentClientMessage", timedOut[0]).exec_client_message
    expect(timeout.shell_result.timeout).toEqual({
      command: "sleep 60",
      working_directory: "/tmp",
      timeout_ms: 30_000,
    })

    const failed = buildExecClientMessages({
      execId: 2,
      resultField: "shell_result",
      output: "",
      error: "permission denied",
      resultMetadata: { command: "rm /etc/passwd", working_directory: "/tmp" },
    })
    const failure = decodeMessage<any>("AgentClientMessage", failed[0]).exec_client_message
    expect(failure.shell_result.failure).toMatchObject({
      command: "rm /etc/passwd",
      stderr: "permission denied",
      exit_code: 1,
      aborted: false,
    })
  })

  it("encodes Cursor-native shell timeout, background, and nonzero-exit states", () => {
    const timedOut = buildExecClientMessages({
      execId: 4,
      resultField: "shell_stream",
      output: "partial\n",
      shellOutcome: { kind: "timeout", timeoutMs: 30_000 },
    })
    const timeoutExit = decodeMessage<any>("AgentClientMessage", timedOut[2]).exec_client_message
    expect(timeoutExit.shell_stream.exit).toMatchObject({ code: 0, aborted: true, abort_reason: 2 })

    const backgrounded = buildExecClientMessages({
      execId: 5,
      resultField: "shell_stream",
      output: "started\n",
      shellOutcome: {
        kind: "backgrounded",
        shellId: 43210,
        pid: 43210,
        command: "make test",
        workingDirectory: "/repo",
        msToWait: 30_000,
        reason: 1,
      },
    })
    const handoff = decodeMessage<any>("AgentClientMessage", backgrounded[2]).exec_client_message
    expect(handoff.shell_stream.backgrounded).toEqual({
      shell_id: 43210,
      command: "make test",
      working_directory: "/repo",
      pid: 43210,
      ms_to_wait: 30_000,
      reason: 1,
    })

    const failed = buildExecClientMessages({
      execId: 6,
      resultField: "shell_stream",
      output: "failed\n",
      shellOutcome: { kind: "exit", code: 23 },
    })
    const failedExit = decodeMessage<any>("AgentClientMessage", failed[2]).exec_client_message
    expect(failedExit.shell_stream.exit).toMatchObject({ code: 23, aborted: false })
  })

  it("encodes a typed background shell spawn result and preserves request metadata", () => {
    const frames = buildExecClientMessages({
      execId: 49,
      resultField: "background_shell_spawn_result",
      output: "__CURSOR_BACKGROUND_SHELL__43210:/tmp/cursor-opencode-bg.ABC123\n",
      resultMetadata: {
        command: "zig translate-c /tmp/tiny.c -lc",
        working_directory: "/tmp",
      },
    })
    expect(frames).toHaveLength(2)
    const result = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(result.background_shell_spawn_result?.success).toEqual({
      shell_id: 43210,
      command: "zig translate-c /tmp/tiny.c -lc",
      working_directory: "/tmp",
      pid: 43210,
    })
    const close = decodeMessage<any>("AgentClientMessage", frames[1])
    expect(close.exec_client_control_message?.stream_close?.id).toBe(49)
  })

  it("prefers structured shellOutcome over markers for background shell spawn results", () => {
    const frames = buildExecClientMessages({
      execId: 50,
      resultField: "background_shell_spawn_result",
      // Markers already stripped from OpenCode-stored output after the plugin hook.
      output: "",
      resultMetadata: {
        command: "zig translate-c /tmp/tiny.c -lc",
        working_directory: "/tmp",
      },
      shellOutcome: {
        kind: "backgrounded",
        shellId: 43210,
        pid: 43210,
        command: "zig translate-c /tmp/tiny.c -lc",
        workingDirectory: "/tmp",
        msToWait: 0,
        reason: 1,
      },
    })
    const result = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(result.background_shell_spawn_result?.success).toEqual({
      shell_id: 43210,
      command: "zig translate-c /tmp/tiny.c -lc",
      working_directory: "/tmp",
      pid: 43210,
    })
  })

  it("returns a typed background spawn error when OpenCode produces no pid marker", () => {
    const result = buildTypedExecResult(
      "background_shell_spawn_result",
      "mktemp failed",
      undefined,
      "bash",
      { command: "sleep 10", working_directory: "/tmp" },
    )
    expect(result).toEqual({
      error: {
        command: "sleep 10",
        working_directory: "/tmp",
        error: "OpenCode did not return a valid background shell process id.",
      },
    })
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
      workspaceRoot: "/workspace/project",
    })
    expect(frames).toHaveLength(2)
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    const gs = ec.grep_result?.success
    expect(gs?.output_mode).toBe("files_with_matches")
    const wr = gs?.workspace_results
    expect(wr).toBeDefined()
    expect(Object.keys(wr)).toEqual(["/workspace/project"])
    expect(wr["/workspace/project"].files.files).toContain("/workspace/project/README.md")
  })

  it("does not stamp process.cwd into grep_result when workspaceRoot is known", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: "/proj/a.ts",
      workspaceRoot: "/proj",
    })
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    const keys = Object.keys(ec.grep_result?.success?.workspace_results ?? {})
    expect(keys).toEqual(["/proj"])
    expect(keys[0]).not.toBe(process.cwd())
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

// Real opencode read output (tool/read.ts): an XML envelope + `N: ` line
// prefixes + a footer, which Cursor's model is not trained on and echoes into
// writes. buildTypedExecResult must strip it down to raw file content.
const OPENCODE_READ_FULL = [
  "<path>/abs/file.ts</path>",
  "<type>file</type>",
  "<content>",
  "1: import fs from \"node:fs\"",
  "2: ",
  "3: const x = 1",
  "",
  "(End of file - total 3 lines)",
  "</content>",
].join("\n")

const OPENCODE_READ_PAGED = [
  "<path>/abs/big.ts</path>",
  "<type>file</type>",
  "<content>",
  "100: lineA",
  "101: lineB",
  "",
  "(Showing lines 100-101 of 500. Use offset=102 to continue.)",
  "</content>",
  "",
  "<system-reminder>",
  "loaded instruction text",
  "</system-reminder>",
].join("\n")

describe("unwrapReadOutput", () => {
  it("strips the envelope, line numbers, footer → raw file content", () => {
    expect(unwrapReadOutput(OPENCODE_READ_FULL)).toBe(
      "import fs from \"node:fs\"\n\nconst x = 1",
    )
  })

  it("preserves blank file lines (rendered as `N: `)", () => {
    expect(unwrapReadOutput(OPENCODE_READ_FULL)).toContain("\n\nconst x = 1")
  })

  it("handles offset/pagination footer + trailing <system-reminder>", () => {
    // system-reminder sits after </content> and must be excluded entirely.
    expect(unwrapReadOutput(OPENCODE_READ_PAGED)).toBe("lineA\nlineB")
  })

  it("strips only the first N: prefix on a line that itself contains digits+colon", () => {
    const out = [
      "<path>/x</path>", "<type>file</type>", "<content>",
      "1: 42: the answer",
      "", "(End of file - total 1 lines)", "</content>",
    ].join("\n")
    expect(unwrapReadOutput(out)).toBe("42: the answer")
  })

  it("does NOT truncate when a file line contains the literal </content> (Finding 1)", () => {
    // opencode renders such a line as "N: </content>". A naive indexOf("</content>")
    // would close early and drop the rest of the file. The structural parser
    // treats it as a body line.
    const out = [
      "<path>/x</path>", "<type>file</type>", "<content>",
      "1: before",
      "2: </content>",
      "3: after",
      "", "(End of file - total 3 lines)", "</content>",
    ].join("\n")
    expect(unwrapReadOutput(out)).toBe("before\n</content>\nafter")
  })

  it("does NOT truncate when a file line contains the literal <content>", () => {
    const out = [
      "<path>/x</path>", "<type>file</type>", "<content>",
      "1: a",
      "2: <content>",
      "3: b",
      "", "(End of file - total 3 lines)", "</content>",
    ].join("\n")
    expect(unwrapReadOutput(out)).toBe("a\n<content>\nb")
  })

  it("returns \"\" for an empty-file envelope (Finding 3), not the envelope", () => {
    const empty = [
      "<path>/x</path>", "<type>file</type>", "<content>",
      "", "(End of file - total 0 lines)", "</content>",
    ].join("\n")
    expect(unwrapReadOutput(empty)).toBe("")
  })

  it("is a no-op when <content> lacks the read skeleton (non-read / drift, Finding 4)", () => {
    // A non-read MCP payload that happens to mention "<content>" must not be rewritten.
    const trick = "here is a doc\n<content>\n1: fake\n</content>\nmore doc"
    expect(unwrapReadOutput(trick)).toBe(trick)
  })

  it("is a no-op when skeleton tags appear only after <content>", () => {
    // Path/type after the content header must not count — ordered check.
    const trick = [
      "<content>",
      "1: fake",
      "</content>",
      "<path>/x</path>",
      "<type>file</type>",
    ].join("\n")
    expect(unwrapReadOutput(trick)).toBe(trick)
  })

  it("is a no-op for non-envelope output (e.g. grep/bash text)", () => {
    const grep = "Found 2 matches\n/a.ts:\n  Line 3: foo"
    expect(unwrapReadOutput(grep)).toBe(grep)
  })

  it("is a no-op for already-raw / plain content", () => {
    expect(unwrapReadOutput("just plain text\nno envelope")).toBe("just plain text\nno envelope")
  })

  it("never throws on non-string / empty input", () => {
    expect(unwrapReadOutput("" as string)).toBe("")
    expect(unwrapReadOutput(undefined as unknown as string)).toBe(undefined)
  })

  it("strips an OpenCode 2 file page down to raw lines", () => {
    const out = [
      "Read file /abs/file.ts, lines 1-3",
      "1: import fs from \"node:fs\"",
      "2: ",
      "3: const x = 1",
    ].join("\n")
    expect(unwrapReadOutput(out)).toBe("import fs from \"node:fs\"\n\nconst x = 1")
  })

  it("strips an OpenCode 2 truncated page, including its continuation banner", () => {
    const out = [
      "Read file src/big.ts, lines 10-11",
      "10: lineA",
      "11: lineB",
      "[Output truncated. Continue reading with offset: 12]",
    ].join("\n")
    expect(unwrapReadOutput(out)).toBe("lineA\nlineB")
  })

  it("returns empty content for an OpenCode 2 empty file", () => {
    expect(unwrapReadOutput("Read file /abs/empty.ts, 0 lines")).toBe("")
  })

  it("keeps a file that only quotes an OpenCode 2 header", () => {
    const out = [
      "Read file /abs/notes.md, lines 1-1",
      "1: Read file /abs/other.ts, lines 1-1",
    ].join("\n")
    expect(unwrapReadOutput(out)).toBe("Read file /abs/other.ts, lines 1-1")
  })

  it("leaves a partial OpenCode 2 header unchanged", () => {
    const out = "Read file /abs/file.ts, lines 1-2\n1: only"
    expect(unwrapReadOutput(out)).toBe(out)
  })
})

describe("buildTypedExecResult read-envelope unwrap", () => {
  it("restores the trailing newline required by Cursor's exact edit handshake", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-read-terminator-"))
    const filePath = path.join(root, "edit.txt")
    try {
      fs.writeFileSync(filePath, "line one\nline two\n")
      const output = [
        `<path>${filePath}</path>`,
        "<type>file</type>",
        "<content>",
        "1: line one",
        "2: line two",
        "",
        "(End of file - total 2 lines)",
        "</content>",
      ].join("\n")
      const r = buildTypedExecResult(
        "read_result",
        output,
        undefined,
        "read",
        { path: filePath },
      ) as { success: { content: string } }
      expect(r.success.content).toBe("line one\nline two\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("read_result.content is raw content (no <path>/<content>/N: prefixes)", () => {
    const r = buildTypedExecResult("read_result", OPENCODE_READ_FULL) as {
      success: { path: string; content: string; total_lines: number }
    }
    expect(r.success.path).toBe("/abs/file.ts") // path still parsed from <path>
    expect(r.success.content).toBe("import fs from \"node:fs\"\n\nconst x = 1")
    expect(r.success.content).not.toContain("<path>")
    expect(r.success.content).not.toContain("<content>")
    expect(r.success.content).not.toMatch(/^\d+: /m)
    expect(r.success.total_lines).toBe(3)
  })

  it("returns full-file metadata for a bounded middle-of-file read", () => {
    const r = buildTypedExecResult(
      "read_result",
      OPENCODE_READ_PAGED,
      undefined,
      "read",
      { path: "/abs/big.ts", offset: 100, limit: 2 },
    ) as {
      success: {
        content: string
        total_lines: number
        file_size: number
        truncated: boolean
        range_applied: boolean
      }
    }
    expect(r.success).toMatchObject({
      content: "lineA\nlineB",
      total_lines: 500,
      file_size: 0,
      truncated: false,
      range_applied: true,
    })
  })

  it("keeps Cursor's 175/40 range distinct from the complete 1238-line file", () => {
    const body = Array.from({ length: 40 }, (_, index) => `${175 + index}: line ${175 + index}`)
    const output = [
      "<path>/abs/large.ts</path>",
      "<type>file</type>",
      "<content>",
      ...body,
      "",
      "(Showing lines 175-214 of 1238. Use offset=215 to continue.)",
      "</content>",
    ].join("\n")
    const r = buildTypedExecResult(
      "read_result",
      output,
      undefined,
      "read",
      { path: "/abs/large.ts", offset: 175, limit: 40 },
    ) as { success: { total_lines: number; truncated: boolean; range_applied: boolean } }
    expect(r.success).toMatchObject({
      total_lines: 1238,
      truncated: false,
      range_applied: true,
    })
  })

  it("marks implicit OpenCode pagination as truncation, not a Cursor range", () => {
    const firstPage = OPENCODE_READ_PAGED
      .replaceAll("100: lineA", "1: lineA")
      .replaceAll("101: lineB", "2: lineB")
      .replace("Showing lines 100-101", "Showing lines 1-2")
    const r = buildTypedExecResult(
      "read_result",
      firstPage,
      undefined,
      "read",
      { path: "/abs/big.ts" },
    ) as { success: { total_lines: number; truncated: boolean; range_applied: boolean } }
    expect(r.success).toMatchObject({
      total_lines: 500,
      truncated: true,
      range_applied: false,
    })
  })

  it("marks OpenCode's byte-capped output as truncated and recovers the full line count", () => {
    const packagePath = `${process.cwd()}/package.json`
    const capped = [
      `<path>${packagePath}</path>`,
      "<type>file</type>",
      "<content>",
      "1: partial",
      "",
      "(Output capped at 50KB. Showing lines 1-1. Use offset=2 to continue.)",
      "</content>",
    ].join("\n")
    const r = buildTypedExecResult(
      "read_result",
      capped,
      undefined,
      "read",
      { path: packagePath },
    ) as { success: { total_lines: number; truncated: boolean; range_applied: boolean } }
    expect(r.success.total_lines).toBeGreaterThan(1)
    expect(r.success).toMatchObject({ truncated: true, range_applied: false })
  })

  it("counts capped files incrementally across buffer boundaries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-read-line-count-"))
    const filePath = path.join(root, "large.txt")
    try {
      fs.writeFileSync(filePath, `${"a".repeat(64 * 1024)}\nb\nc`)
      const capped = [
        `<path>${filePath}</path>`,
        "<type>file</type>",
        "<content>",
        "1: partial",
        "",
        "(Output capped at 50KB. Showing lines 1-1. Use offset=2 to continue.)",
        "</content>",
      ].join("\n")
      const r = buildTypedExecResult(
        "read_result",
        capped,
        undefined,
        "read",
        { path: filePath },
      ) as { success: { total_lines: number; truncated: boolean } }
      expect(r.success).toMatchObject({ total_lines: 3, truncated: true })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a bounded range ending at EOF non-truncated", () => {
    const eofRange = [
      "<path>/abs/big.ts</path>",
      "<type>file</type>",
      "<content>",
      "499: penultimate",
      "500: final",
      "",
      "(End of file - total 500 lines)",
      "</content>",
    ].join("\n")
    const r = buildTypedExecResult(
      "read_result",
      eofRange,
      undefined,
      "read",
      { path: "/abs/big.ts", offset: 499, limit: 40 },
    ) as { success: { total_lines: number; truncated: boolean; range_applied: boolean } }
    expect(r.success).toMatchObject({
      total_lines: 500,
      truncated: false,
      range_applied: true,
    })
  })

  it("returns the actual byte size when the read path is available", () => {
    const packagePath = `${process.cwd()}/package.json`
    const r = buildTypedExecResult(
      "read_result",
      OPENCODE_READ_FULL.replace("/abs/file.ts", packagePath),
      undefined,
      "read",
      { path: packagePath },
    ) as { success: { file_size: number } }
    expect(r.success.file_size).toBeGreaterThan(0)
  })

  it("read_result empty file → content \"\" (no envelope echoed)", () => {
    const empty = [
      "<path>/x</path>", "<type>file</type>", "<content>",
      "", "(End of file - total 0 lines)", "</content>",
    ].join("\n")
    const r = buildTypedExecResult("read_result", empty) as {
      success: { content: string; total_lines: number; truncated: boolean; range_applied: boolean }
    }
    expect(r.success.content).toBe("")
    expect(r.success).toMatchObject({ total_lines: 0, truncated: false, range_applied: false })
  })

  it("mcp_result text is unwrapped for read-via-MCP when toolName=read", () => {
    const r = buildTypedExecResult("mcp_result", OPENCODE_READ_PAGED, undefined, "read") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(r.success.content[0].text.text).toBe("lineA\nlineB")
  })

  it("mcp_result text is left untouched for a non-read tool even if it looks enveloped (Finding 2)", () => {
    // A grep/context7 result that happens to embed an opencode-shaped block
    // must survive verbatim because toolName != read.
    const r = buildTypedExecResult("mcp_result", OPENCODE_READ_FULL, undefined, "brave_web_search") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(r.success.content[0].text.text).toBe(OPENCODE_READ_FULL)
  })

  it("mcp_result text is a no-op for plain non-read MCP output", () => {
    const r = buildTypedExecResult("mcp_result", "{\"ok\":true}") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(r.success.content[0].text.text).toBe("{\"ok\":true}")
  })

  it("end-to-end: read-via-MCP envelope → exec_client_message carries raw content", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "mcp_result",
      output: OPENCODE_READ_FULL,
      toolName: "read",
    })
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.mcp_result.success.content[0].text.text).toBe(
      "import fs from \"node:fs\"\n\nconst x = 1",
    )
  })
})

describe("OpenCode 2 read pages and grounded paths", () => {
  const truncated = [
    "Read file src/big.ts, lines 1-2",
    "1: lineA",
    "2: lineB",
    "[Output truncated. Continue reading with offset: 3]",
  ].join("\n")

  it("marks an unsolicited truncated page and absolutizes its path", () => {
    const r = buildTypedExecResult(
      "read_result",
      truncated,
      undefined,
      "read",
      undefined,
      undefined,
      "/workspace/project",
    ) as { success: { path: string; content: string; truncated: boolean; range_applied: boolean } }
    expect(r.success.path).toBe("/workspace/project/src/big.ts")
    expect(r.success.content.startsWith("lineA\nlineB\n\n")).toBe(true)
    expect(r.success.content).toContain("[Partial read:")
    expect(r.success.content).toContain("offset=3")
    expect(r.success.content).not.toContain("50 KB")
    expect(r.success.content).not.toMatch(/^Read file /)
    expect(r.success.content).not.toMatch(/^\d+: /m)
    expect(r.success).toMatchObject({ truncated: true, range_applied: false })
  })

  it("does not mark a complete OpenCode 2 file", () => {
    const output = [
      "Read file src/a.ts, lines 1-2",
      "1: hello",
      "2: world",
    ].join("\n")
    const r = buildTypedExecResult(
      "read_result",
      output,
      undefined,
      "read",
      undefined,
      undefined,
      "/workspace/project",
    ) as { success: { path: string; content: string; truncated: boolean } }
    expect(r.success.path).toBe("/workspace/project/src/a.ts")
    expect(r.success.content).toBe("hello\nworld")
    expect(r.success.truncated).toBe(false)
  })

  it("does not warn when the caller requested the returned range", () => {
    const ranged = truncated.replace("src/big.ts", "/abs/big.ts")
    const r = buildTypedExecResult(
      "read_result",
      ranged,
      undefined,
      "read",
      { path: "/abs/big.ts", offset: 1, limit: 2 },
    ) as { success: { content: string; truncated: boolean; range_applied: boolean } }
    expect(r.success.content).toBe("lineA\nlineB")
    expect(r.success).toMatchObject({ truncated: false, range_applied: true })
  })

  it("names the 50 KB cap when an unsolicited page stopped on the byte budget", () => {
    const line = "x".repeat(80)
    const count = 600
    const output = [
      `Read file /abs/big.ts, lines 1-${count}`,
      ...Array.from({ length: count }, (_, index) => `${index + 1}: ${line}`),
      `[Output truncated. Continue reading with offset: ${count + 1}]`,
    ].join("\n")
    const r = buildTypedExecResult("read_result", output, undefined, "read") as {
      success: { content: string; truncated: boolean }
    }
    expect(r.success.truncated).toBe(true)
    expect(r.success.content).toContain("capped at the host's 50 KB output limit")
    expect(r.success.content).toContain(`offset=${count + 1}`)
    expect(r.success.content).not.toMatch(/^\d+: /m)
  })

  it("keeps the OpenCode 2 notice out of the MCP file-content item", () => {
    const r = buildTypedExecResult(
      "mcp_result",
      truncated,
      undefined,
      "read",
      undefined,
      undefined,
      "/workspace/project",
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(r.success.content[0]?.text.text).toBe("lineA\nlineB")
    expect(r.success.content[1]?.text.text).toContain("[Partial read:")
    expect(r.success.content[1]?.text.text).toContain("offset=3")
  })

  it("resolves relative grep headers and drops the trailing colon", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: ["Found 1 matches", "src/foo.ts:", "  Line 1: hi"].join("\n"),
      workspaceRoot: "/workspace/project",
    })
    const ec = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
    expect(ec.grep_result.success.output_mode).toBe("content")
    expect(ec.grep_result.success.workspace_results["/workspace/project"].content.matches).toEqual([
      {
        file: "/workspace/project/src/foo.ts",
        matches: [{ line_number: 1, content: "hi" }],
      },
    ])
  })

  it("joins OpenCode 2 directory entries onto the listed directory", () => {
    const output = ["Read directory src, entries 1-2", "a.ts", "nested/"].join("\n")
    const read = buildTypedExecResult(
      "mcp_result",
      output,
      undefined,
      "read",
      undefined,
      undefined,
      "/workspace/project",
    ) as { success: { content: Array<{ text: { text: string } }> } }
    const text = read.success.content[0]?.text.text ?? ""
    expect(text).toContain("Read directory /workspace/project/src, entries 1-2")
    expect(text).toContain("/workspace/project/src/a.ts")
    expect(text).toContain(`/workspace/project/src/nested${path.sep}`)

    const frames = buildExecClientMessages({
      execId: 2,
      resultField: "ls_result",
      output,
      workspaceRoot: "/workspace/project",
    })
    const tree = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
      .ls_result.success.directory_tree_root
    expect(tree.abs_path).toBe("/workspace/project/src")
    expect(tree.children_files.map((file: { name: string }) => file.name)).toEqual(["a.ts"])
    expect(tree.children_dirs).toEqual([{
      abs_path: "/workspace/project/src/nested",
      children_dirs: [],
      children_files: [],
      num_files: 0,
    }])
    expect(tree.num_files).toBe(1)
  })

  it("absolutizes relative glob lines in MCP text", () => {
    const r = buildTypedExecResult(
      "mcp_result",
      "src/foo.ts\nREADME.md",
      undefined,
      "glob",
      undefined,
      undefined,
      "/workspace/project",
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(r.success.content[0]?.text.text).toBe(
      "/workspace/project/src/foo.ts\n/workspace/project/README.md",
    )
  })
})

describe("OpenCode 2 path and read edge cases", () => {
  const root = "/workspace/project"

  function filePage(filePath: string, lines: string[], nextOffset?: number, start = 1): string {
    const end = start + lines.length - 1
    const header = lines.length === 0
      ? `Read file ${filePath}, 0 lines`
      : `Read file ${filePath}, lines ${start}-${end}`
    const body = lines.map((line, index) => `${start + index}: ${line}`)
    const banner = nextOffset === undefined
      ? []
      : [`[Output truncated. Continue reading with offset: ${nextOffset}]`]
    return [header, ...body, ...banner].join("\n")
  }

  it("accepts CRLF, a tab after the line number, and a spaced continuation offset", () => {
    const output = [
      "Read file src/a.ts, lines 1-2",
      "1:\thello",
      "2: world",
      "[Output truncated. Continue reading with offset:  9]",
    ].join("\r\n")
    const r = buildTypedExecResult("read_result", output, undefined, "read", undefined, undefined, root) as {
      success: { path: string; content: string; truncated: boolean }
    }
    expect(r.success.path).toBe(`${root}/src/a.ts`)
    expect(r.success.content.startsWith("hello\nworld")).toBe(true)
    expect(r.success.content).toContain("offset=9")
    expect(r.success.truncated).toBe(true)
  })

  it("keeps a comma inside the file path", () => {
    const output = filePage("/tmp/a, b.ts", ["hi"])
    expect(unwrapReadOutput(output)).toBe("hi")
    const r = buildTypedExecResult("read_result", output) as { success: { path: string } }
    expect(r.success.path).toBe("/tmp/a, b.ts")
  })

  it("marks OpenCode 2's per-line character truncation even at EOF", () => {
    const shortened = `${"x".repeat(2000)}... (line truncated to 2000 chars)`
    const output = filePage("/abs/one-line.txt", [shortened])
    const native = buildTypedExecResult("read_result", output) as {
      success: { content: string; truncated: boolean }
    }
    expect(native.success.truncated).toBe(true)
    expect(native.success.content).toContain("OpenCode shortened line 1 to 2000 characters")
    expect(native.success.content).toContain("It is NOT the complete file")

    const mcp = buildTypedExecResult("mcp_result", output, undefined, "read") as {
      success: { content: Array<{ text: { text: string } }> }
    }
    expect(mcp.success.content[0]?.text.text).toBe(shortened)
    expect(mcp.success.content[1]?.text.text).toContain("byte-preserving read method")

    const pi = buildTypedExecResult("pi_read_result", output) as {
      success: { truncation: { truncated: boolean; truncated_by: string } }
    }
    expect(pi.success.truncation).toMatchObject({ truncated: true, truncated_by: "characters" })
  })

  it("does not treat a numbered truncation banner as a host cap", () => {
    const output = filePage("/abs/notes.md", ["[Output truncated. Continue reading with offset: 9]"])
    const r = buildTypedExecResult("read_result", output) as { success: { content: string; truncated: boolean } }
    expect(r.success.content).toBe("[Output truncated. Continue reading with offset: 9]")
    expect(r.success.truncated).toBe(false)
  })

  it("treats a complete tail page as finished", () => {
    const output = filePage("/abs/a.ts", ["a", "b"], undefined, 5)
    const r = buildTypedExecResult("read_result", output, undefined, "read", { path: "/abs/a.ts" }) as {
      success: { content: string; truncated: boolean; total_lines: number }
    }
    expect(r.success.content).toBe("a\nb")
    expect(r.success).toMatchObject({ truncated: false, total_lines: 6 })
  })

  it("names 50 KB only when a short page is close enough for the next line not to fit", () => {
    const underResult = buildTypedExecResult("read_result", filePage("/abs/a.ts", ["short"], 2)) as {
      success: { content: string }
    }
    expect(underResult.success.content).toContain("[Partial read:")
    expect(underResult.success.content).not.toContain("50 KB")

    // Seven maximum-width three-byte lines plus two ASCII lines fit, while one
    // more maximum-width line would exceed OpenCode 2's 50 KiB page budget.
    const cappedLines = [
      ...Array.from({ length: 7 }, () => "€".repeat(2000)),
      ...Array.from({ length: 2 }, () => "x".repeat(2000)),
    ]
    const cappedResult = buildTypedExecResult(
      "read_result",
      filePage("/abs/a.ts", cappedLines, cappedLines.length + 1),
      undefined,
      "read",
      { offset: 1, limit: 20 },
    ) as { success: { content: string; truncated: boolean } }
    expect(cappedResult.success.truncated).toBe(true)
    expect(cappedResult.success.content).toContain("50 KB")
  })

  it("does not warn when a requested range hits the 2,000-line stop exactly", () => {
    const lines = Array.from({ length: 2000 }, () => "x")
    const r = buildTypedExecResult(
      "read_result",
      filePage("/abs/a.ts", lines, 2001),
      undefined,
      "read",
      { offset: 1, limit: 2000 },
    ) as { success: { content: string; truncated: boolean } }
    expect(r.success.content).toBe(lines.join("\n"))
    expect(r.success.truncated).toBe(false)
  })

  it("warns on an unsolicited 2,000-line stop without calling it a byte cap", () => {
    const lines = Array.from({ length: 2000 }, () => "x")
    const r = buildTypedExecResult("read_result", filePage("/abs/a.ts", lines, 2001)) as {
      success: { content: string; truncated: boolean }
    }
    expect(r.success.truncated).toBe(true)
    expect(r.success.content).toContain("[Partial read:")
    expect(r.success.content).toContain("offset=2001")
    expect(r.success.content).not.toContain("50 KB")
  })

  it("honors offset metadata on an MCP read", () => {
    const output = filePage("/abs/a.ts", ["a", "b"], 3)
    const r = buildTypedExecResult(
      "mcp_result",
      output,
      undefined,
      "read",
      { offset: 1, limit: 2 },
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(r.success.content).toHaveLength(1)
    expect(r.success.content[0]?.text.text).toBe("a\nb")
  })

  it("absolutizes a relative read error path", () => {
    const r = buildTypedExecResult(
      "read_result",
      "",
      "missing",
      "read",
      { path: "src/a.ts" },
      undefined,
      root,
    ) as { error: { path: string; error: string } }
    expect(r.error).toEqual({ path: `${root}/src/a.ts`, error: "missing" })
  })

  it("resolves directory entries, keeps markers, and leaves unknown listings alone", () => {
    const listed = buildTypedExecResult(
      "mcp_result",
      ["Read directory src, entries 1-4", "./a.ts", "../b.ts", "nested/", "~/keep.ts"].join("\n"),
      undefined,
      "read",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    const text = listed.success.content[0]?.text.text ?? ""
    expect(text).toContain(`${root}/src/a.ts`)
    expect(text).toContain(`${root}/b.ts`)
    expect(text).toContain(`${root}/src/nested${path.sep}`)
    expect(text).toContain("~/keep.ts")

    const empty = buildTypedExecResult(
      "read_result",
      "Read directory src, 0 entries",
      undefined,
      "read",
      undefined,
      undefined,
      root,
    ) as { success: { path: string; content: string } }
    expect(empty.success.path).toBe(`${root}/src`)
    expect(empty.success.content).toBe(`Read directory ${root}/src, 0 entries`)

    const untouched = buildTypedExecResult(
      "mcp_result",
      "Read directory src, entries 1-1\na.ts",
      undefined,
      "read",
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(untouched.success.content[0]?.text.text).toBe("Read directory src, entries 1-1\na.ts")
  })

  it("keeps grep match previews and URLs out of the file list", () => {
    const frames = buildExecClientMessages({
      execId: 1,
      resultField: "grep_result",
      output: [
        "Found 1 matches (more matches available)",
        "/workspace/project/src/a.ts:",
        "  Line 1: see src/b.ts",
        "https://example.com/a:",
        "",
        "(Results are truncated. Consider using a more specific path or pattern.)",
      ].join("\n"),
      workspaceRoot: root,
    })
    const content = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
      .grep_result.success
    expect(content.output_mode).toBe("content")
    expect(content.workspace_results[root].content.matches).toEqual([
      {
        file: `${root}/src/a.ts`,
        matches: [{ line_number: 1, content: "see src/b.ts" }],
      },
    ])
    expect(content.workspace_results[root].content.client_truncated).toBe(true)
    expect(JSON.stringify(content)).not.toContain("https://example.com")

    const filesOnly = buildExecClientMessages({
      execId: 3,
      resultField: "grep_result",
      output: [
        "Found 100 matches (more matches available)",
        "src/a.ts:",
        "  Line 4: secret",
        "",
        "(Results are truncated. Consider using a more specific path or pattern.)",
      ].join("\n"),
      resultMetadata: { pattern: "secret", path: "src", output_mode: "files_with_matches" },
      workspaceRoot: root,
    })
    const listed = decodeMessage<any>("AgentClientMessage", filesOnly[0]).exec_client_message
      .grep_result.success
    expect(listed.output_mode).toBe("files_with_matches")
    expect(listed.pattern).toBe("secret")
    expect(listed.path).toBe("src")
    expect(listed.workspace_results[root].files.files).toEqual([`${root}/src/a.ts`])
    expect(listed.workspace_results[root].files.client_truncated).toBe(true)
    expect(listed.workspace_results[root].content).toBeUndefined()

    const none = buildExecClientMessages({
      execId: 2,
      resultField: "grep_result",
      output: "No matches found",
      workspaceRoot: root,
    })
    const empty = decodeMessage<any>("AgentClientMessage", none[0]).exec_client_message
      .grep_result.success.workspace_results[root].files.files
    expect(empty).toEqual([])
  })

  it("rewrites glob paths and leaves the truncation footer", () => {
    const r = buildTypedExecResult(
      "mcp_result",
      ["src/a.ts", "~/keep.ts", "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)"].join("\n"),
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(r.success.content[0]?.text.text).toBe(
      [
        `${root}/src/a.ts`,
        "~/keep.ts",
        "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)",
      ].join("\n"),
    )
  })

  it("flattens grouped glob listings to files only", () => {
    const output = [
      "README.md",
      "# src/",
      "a.ts",
      "## components/",
      "button.tsx",
      "# src/protocol/",
      "tools.ts",
      "# tests/",
      "",
      "Skipped missing paths: gone",
    ].join("\n")
    const found = buildTypedExecResult(
      "pi_find_result",
      output,
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(found.success.output).toBe(
      [
        `${root}/README.md`,
        `${root}/src/a.ts`,
        `${root}/src/components/button.tsx`,
        `${root}/src/protocol/tools.ts`,
        "",
        "Skipped missing paths: gone",
      ].join("\n"),
    )

    const listed = buildTypedExecResult(
      "grep_result",
      output,
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { workspace_results: Record<string, { files: { files: string[] } }> } }
    expect(listed.success.workspace_results[root]?.files.files).toEqual([
      `${root}/README.md`,
      `${root}/src/a.ts`,
      `${root}/src/components/button.tsx`,
      `${root}/src/protocol/tools.ts`,
    ])

    const flat = buildTypedExecResult(
      "pi_find_result",
      "src/\nsrc/a.ts",
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(flat.success.output).toBe([`${root}/src/`, `${root}/src/a.ts`].join("\n"))
  })

  it("drops grouping headers that would list directories beside their files", () => {
    const repro = [
      "# /tmp/glob-repro/",
      "afile.txt",
      "## empty/",
      "## onlydir/nested/",
      "main.log",
      "## dir-only-log/vendor-cli/",
      "main.log",
    ].join("\n")
    const found = buildTypedExecResult(
      "pi_find_result",
      repro,
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(found.success.output).toBe(
      [
        "/tmp/glob-repro/afile.txt",
        "/tmp/glob-repro/onlydir/nested/main.log",
        "/tmp/glob-repro/dir-only-log/vendor-cli/main.log",
      ].join("\n"),
    )

    const onlydir = buildTypedExecResult(
      "pi_find_result",
      ["# /tmp/glob-repro/onlydir/nested/", "main.log"].join("\n"),
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(onlydir.success.output).toBe("/tmp/glob-repro/onlydir/nested/main.log")

    const logs = buildTypedExecResult(
      "pi_find_result",
      ["# /opt/local/var/macports/logs/", "## foo/", "main.log", "## bar/", "main.log"].join("\n"),
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(logs.success.output).toBe(
      ["/opt/local/var/macports/logs/foo/main.log", "/opt/local/var/macports/logs/bar/main.log"].join("\n"),
    )

    const listed = buildTypedExecResult(
      "grep_result",
      ["# /tmp/glob-repro/dir-only-log/", "main.log"].join("\n"),
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { workspace_results: Record<string, { files: { files: string[] } }> } }
    expect(listed.success.workspace_results[root]?.files.files).toEqual([
      "/tmp/glob-repro/dir-only-log/main.log",
    ])

    const emptiesOnly = buildTypedExecResult(
      "pi_find_result",
      ["# /tmp/glob-repro/", "## empty/", "## also/"].join("\n"),
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(emptiesOnly.success.output).toBe("No files found")
  })

  it("does not turn a glob miss into a path back to the workspace", () => {
    const miss = "No files found matching pattern"
    const samples = [
      miss,
      ["# ../../../workspace/example-project/", miss].join("\n"),
      `../../../workspace/example-project/${miss}`,
      `# ../../../workspace/example-project/${miss}`,
    ]
    for (const output of samples) {
      const text = buildTypedExecResult(
        "pi_find_result",
        output,
        undefined,
        "glob",
        undefined,
        undefined,
        root,
      ) as { success: { output: string } }
      expect(text.success.output).toBe(miss)

      const mcp = buildTypedExecResult(
        "mcp_result",
        output,
        undefined,
        "glob",
        undefined,
        undefined,
        root,
      ) as { success: { content: Array<{ text: { text: string } }> } }
      expect(mcp.success.content[0]?.text.text).toBe(miss)

      const listed = buildTypedExecResult(
        "grep_result",
        output,
        undefined,
        "glob",
        undefined,
        undefined,
        root,
      ) as { success: { workspace_results: Record<string, { files: { files: string[] } }> } }
      expect(listed.success.workspace_results[root]?.files.files).toEqual([])
    }

    const outside = [
      "# /tmp/glob-repro/",
      "## empty/",
      "## full/",
      "a.txt",
      "## also/",
    ].join("\n")
    const dirs = buildTypedExecResult(
      "pi_find_result",
      outside,
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { output: string } }
    expect(dirs.success.output).toBe(
      ["/tmp/glob-repro/full/a.txt"].join("\n"),
    )
  })

  it("rewrites shell path tokens against the working directory and leaves prose", () => {
    const stdout = [
      "src/a.ts",
      "built src/a.ts ok",
      "https://example.com/a",
      "/abs/b.ts",
      "src/c.ts:12:3",
      "~/secret",
    ].join("\n")
    const r = buildTypedExecResult(
      "shell_result",
      stdout,
      undefined,
      "bash",
      { command: "ls", working_directory: "pkg" },
      undefined,
      root,
    ) as { success: { stdout: string } }
    expect(r.success.stdout).toBe(
      [
        `${root}/pkg/src/a.ts`,
        "built src/a.ts ok",
        "https://example.com/a",
        "/abs/b.ts",
        `${root}/pkg/src/c.ts:12:3`,
        "~/secret",
      ].join("\n"),
    )

    const pi = buildTypedExecResult("pi_bash_result", "src/a.ts", undefined, "bash", undefined, undefined, root) as {
      success: { output: string }
    }
    expect(pi.success.output).toBe(`${root}/src/a.ts`)
    const edit = buildTypedExecResult("pi_edit_result", "src/a.ts", undefined, "edit", undefined, undefined, root) as {
      success: { output: string }
    }
    expect(edit.success.output).toBe("src/a.ts")
  })

  it("leaves a broken OpenCode 2 page unchanged, including a byte-order mark on a valid one", () => {
    const broken = "Read file src/a.ts, lines 1-2\n1: only\n"
    expect(unwrapReadOutput(broken)).toBe(broken)
    const kept = buildTypedExecResult("read_result", broken, undefined, "read", undefined, undefined, root) as {
      success: { content: string; truncated: boolean }
    }
    expect(kept.success.content).toBe(broken)
    expect(kept.success.truncated).toBe(false)

    expect(unwrapReadOutput(`\uFEFF${filePage("/abs/a.ts", ["hi"])}`)).toBe("hi")
  })

  it("absolutizes an empty relative file and prefers metadata over the header path", () => {
    const empty = buildTypedExecResult(
      "read_result",
      "Read file src/empty.ts, 0 lines",
      undefined,
      "read",
      undefined,
      undefined,
      root,
    ) as { success: { path: string; content: string; truncated: boolean } }
    expect(empty.success).toMatchObject({
      path: `${root}/src/empty.ts`,
      content: "",
      truncated: false,
    })

    const preferred = buildTypedExecResult(
      "read_result",
      filePage("src/other.ts", ["hi"]),
      undefined,
      "read",
      { path: "src/a.ts" },
      undefined,
      `${root}/`,
    ) as { success: { path: string; content: string } }
    expect(preferred.success.path).toBe(`${root}/src/a.ts`)
    expect(preferred.success.content).toBe("hi")
  })

  it("uses the host-reported path for file metadata and newline recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-oc2-read-path-"))
    const actual = path.join(dir, "actual.txt")
    fs.writeFileSync(actual, "hello\n")
    try {
      const result = buildTypedExecResult(
        "read_result",
        filePage(actual, ["hello"]),
        undefined,
        "read",
        { path: path.join(dir, "requested.txt") },
      ) as { success: { path: string; content: string; file_size: number } }
      expect(result.success).toMatchObject({
        path: path.join(dir, "requested.txt"),
        content: "hello\n",
        file_size: 6,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a directory banner, foreign absolute entries, and refuses a blank-line listing", () => {
    const listed = buildTypedExecResult(
      "mcp_result",
      [
        "Read directory src, entries 1-3",
        "a.ts",
        "C:/Windows/a.ts",
        "\\\\server\\share\\b.ts",
        "[Output truncated. Continue reading with offset: 4]",
      ].join("\n"),
      undefined,
      "read",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(listed.success.content[0]?.text.text).toBe(
      [
        `Read directory ${root}/src, entries 1-3`,
        `${root}/src/a.ts`,
        "C:/Windows/a.ts",
        "\\\\server\\share\\b.ts",
        "[Output truncated. Continue reading with offset: 4]",
      ].join("\n"),
    )

    const broken = "Read directory src, entries 1-2\na.ts\n\nb.ts"
    const untouched = buildTypedExecResult(
      "mcp_result",
      broken,
      undefined,
      "read",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(untouched.success.content[0]?.text.text).toBe(broken)
  })

  it("absolutizes relative grep headers in both text and the file list", () => {
    const output = ["Found 1 matches", "src/a.ts:", "  Line 2: hi", "C:/keep.ts:"].join("\n")
    const text = buildTypedExecResult(
      "mcp_result",
      output,
      undefined,
      "grep",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(text.success.content[0]?.text.text).toBe(
      ["Found 1 matches", `${root}/src/a.ts:`, "  Line 2: hi", "C:/keep.ts:"].join("\n"),
    )

    const frames = buildExecClientMessages({
      execId: 3,
      resultField: "grep_result",
      output,
      workspaceRoot: root,
    })
    const matches = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
      .grep_result.success.workspace_results[root].content.matches
    expect(matches).toEqual([
      { file: `${root}/src/a.ts`, matches: [{ line_number: 2, content: "hi" }] },
    ])
  })

  it("leaves an empty glob and a Pi read's truncation flag accurate", () => {
    const none = buildTypedExecResult(
      "mcp_result",
      "No files found",
      undefined,
      "glob",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(none.success.content[0]?.text.text).toBe("No files found")

    const partial = buildTypedExecResult("pi_read_result", filePage("/abs/a.ts", ["a"], 2)) as {
      success: { output: string; truncation: { truncated: boolean; truncated_by: string } }
    }
    expect(partial.success.output).toBe("a")
    expect(partial.success.truncation).toMatchObject({ truncated: true, truncated_by: "lines" })

    const requested = buildTypedExecResult(
      "pi_read_result",
      filePage("/abs/a.ts", ["a"], 2),
      undefined,
      "read",
      { offset: 1, limit: 1 },
    ) as { success: { truncation?: unknown } }
    expect(requested.success.truncation).toBeUndefined()

    const whole = buildTypedExecResult("pi_read_result", filePage("/abs/a.ts", ["a"])) as {
      success: { output: string; truncation?: unknown }
    }
    expect(whole.success.output).toBe("a")
    expect(whole.success.truncation).toBeUndefined()
  })

  it("does not rewrite shell prose, bare names, or foreign absolute paths", () => {
    const stdout = ["README.md", "ok", "C:/src/a.ts", "C:/src/a.ts:12", "./src/b.ts"].join("\n")
    const r = buildTypedExecResult(
      "shell_result",
      stdout,
      undefined,
      "bash",
      { command: "ls", working_directory: "/tmp/work" },
      undefined,
      root,
    ) as { success: { stdout: string } }
    expect(r.success.stdout).toBe(
      ["README.md", "ok", "C:/src/a.ts", "C:/src/a.ts:12", "/tmp/work/src/b.ts"].join("\n"),
    )

    const failed = buildTypedExecResult(
      "shell_result",
      "src/a.ts",
      "nope",
      "bash",
      { command: "ls", working_directory: "/tmp/work" },
      undefined,
      root,
    ) as { failure: { stdout: string; stderr: string } }
    expect(failed.failure).toMatchObject({ stdout: "/tmp/work/src/a.ts", stderr: "nope" })

    const unrooted = buildTypedExecResult("shell_result", "src/a.ts") as { success: { stdout: string } }
    expect(unrooted.success.stdout).toBe("src/a.ts")
  })

  it("joins onto Windows directory headers and working directories without a second prefix", () => {
    const listed = buildTypedExecResult(
      "mcp_result",
      ["Read directory C:/proj, entries 1-3", "a.ts", "nested/", "../b.ts"].join("\n"),
      undefined,
      "read",
      undefined,
      undefined,
      root,
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(listed.success.content[0]?.text.text).toBe(
      ["Read directory C:/proj, entries 1-3", "C:/proj/a.ts", "C:/proj/nested/", "C:/b.ts"].join("\n"),
    )

    const backslash = buildTypedExecResult(
      "mcp_result",
      ["Read directory C:\\proj, entries 1-1", "a.ts"].join("\n"),
      undefined,
      "read",
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(backslash.success.content[0]?.text.text).toBe(
      ["Read directory C:\\proj, entries 1-1", "C:\\proj\\a.ts"].join("\n"),
    )

    const unc = buildTypedExecResult(
      "mcp_result",
      ["Read directory \\\\server\\share, entries 1-1", "a.ts"].join("\n"),
      undefined,
      "read",
    ) as { success: { content: Array<{ text: { text: string } }> } }
    expect(unc.success.content[0]?.text.text).toBe(
      ["Read directory \\\\server\\share, entries 1-1", "\\\\server\\share\\a.ts"].join("\n"),
    )

    const frames = buildExecClientMessages({
      execId: 4,
      resultField: "ls_result",
      output: ["Read directory C:/proj, entries 1-2", "a.ts", "nested/"].join("\n"),
      workspaceRoot: root,
    })
    const tree = decodeMessage<any>("AgentClientMessage", frames[0]).exec_client_message
      .ls_result.success.directory_tree_root
    expect(tree.abs_path).toBe("C:/proj")
    expect(tree.children_files.map((file: { name: string }) => file.name)).toEqual(["a.ts"])
    expect(tree.children_dirs[0]?.abs_path).toBe("C:/proj/nested")

    const shell = buildTypedExecResult(
      "shell_result",
      "./src/b.ts",
      undefined,
      "bash",
      { command: "ls", working_directory: "C:/work" },
      undefined,
      root,
    ) as { success: { stdout: string } }
    expect(shell.success.stdout).toBe("C:/work/src/b.ts")
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

  it("decodes canonical raw Pi request fields to their offset result fields", () => {
    const cases = [
      [45, "pi_read_result"],
      [46, "pi_bash_result"],
      [47, "pi_edit_result"],
      [48, "pi_write_result"],
      [49, "pi_grep_result"],
      [50, "pi_find_result"],
      [51, "pi_ls_result"],
    ] as const

    for (const [requestField, resultField] of cases) {
      const payload = asmWithExec(requestField)
      const decoded = decodeMessage<any>("AgentServerMessage", payload)
      const parsed = parseExecServerMessage(decoded.exec_server_message)
      expect(detectExecVariantField(payload), `request field #${requestField}`).toBe(requestField)
      expect(parsed?.resultField, `request field #${requestField}`).toBe(resultField)
    }
  })

  it("decodes field #36 as mcp_state and replies from advertised descriptors", () => {
    const args: number[] = []
    const server = new TextEncoder().encode("github")
    const writeVarint = (n: number) => {
      let v = n >>> 0
      while (v > 0x7f) { args.push((v & 0x7f) | 0x80); v >>>= 7 }
      args.push(v)
    }
    writeVarint((1 << 3) | 2)
    writeVarint(server.length)
    args.push(...server)

    const payload = asmWithExec(36, Uint8Array.from(args))
    const decoded = decodeMessage<any>("AgentServerMessage", payload)
    expect(detectExecVariantField(payload)).toBe(36)
    expect(decoded.exec_server_message.mcp_state_exec_args.server_identifiers).toEqual(["github"])

    const response = buildMcpStateResult(
      decoded.exec_server_message.id,
      decoded.exec_server_message.mcp_state_exec_args,
      {
        mcp_file_system_options: {
          mcp_descriptors: [
            {
              server_name: "opencode",
              server_identifier: "opencode",
              tools: [{ tool_name: "write", description: "Write" }],
            },
            {
              server_name: "github",
              server_identifier: "github",
              tools: [{ tool_name: "get_me", description: "Who am I" }],
            },
          ],
        },
      },
    )
    const result = decodeMessage<any>("AgentClientMessage", response)
      .exec_client_message.mcp_state_exec_result.success
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0].server_identifier).toBe("github")
    expect(result.servers[0].tools[0].name).toBe("github-get_me")
    expect(result.servers[0].tools[0].provider_identifier).toBe("github")
    expect(result.servers[0].tools[0].tool_name).toBe("get_me")
  })

  it("encodes MCP state tools with Cursor's canonical full definition shape", () => {
    const tools = [
      {
        name: "github_create_pull_request",
        description: "Open a pull request",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    ]
    const response = buildMcpStateResult(
      69,
      { server_identifiers: ["github"] },
      {
        tools: toolsToDescriptors(tools, "opencode", ["github"]),
        mcp_file_system_options: {
          mcp_descriptors: toolsToMcpDescriptors(tools, "opencode", ["github"]),
        },
      },
    )

    const decoded = decodeCanonicalMcpStateResult(response)
    const exec = decoded.exec_client_message
    expect(exec.id).toBe(69)
    const server = exec.mcp_state_exec_result.success.servers[0]
    expect(server.server_name).toBe("github")
    expect(server.server_identifier).toBe("github")
    expect(server.tools).toHaveLength(1)
    expect(server.tools[0].name).toBe("github-create_pull_request")
    expect(server.tools[0].description).toBe("Open a pull request")
    expect(server.tools[0].provider_identifier).toBe("github")
    expect(server.tools[0].tool_name).toBe("create_pull_request")
    expect(server.tools[0].input_schema.length).toBeGreaterThan(0)
  })

  it("buildRequestContextResult encodes a prebuilt request_context", () => {
    const descriptors = toolsToDescriptors([
      { name: "read", description: "Read", inputSchema: { type: "object" } },
    ])
    const bytes = buildRequestContextResult(9, {
      env: { workspace_paths: ["/tmp/ws"], shell: "/bin/zsh" },
      tools: descriptors,
      web_search_enabled: false,
      web_fetch_enabled: false,
      rules_info_complete: true,
    })
    const dec = decodeMessage<any>("AgentClientMessage", bytes)
    const rc = dec.exec_client_message.request_context_result.success.request_context
    expect(rc.env.workspace_paths).toEqual(["/tmp/ws"])
    expect(rc.tools).toHaveLength(1)
    expect(rc.tools[0].name).toBe("opencode-read")
    expect(rc.web_search_enabled).toBe(false)
    expect(rc.web_fetch_enabled).toBe(false)
  })
})

describe("isUriReadTarget", () => {
  it("treats scheme-addressed targets as the host's to resolve", () => {
    for (const target of [
      "resource://catalog/item",
      "custom+transport://service/action",
      "https://example.com/spec.json",
      "http://localhost:3000/x",
      "file:///etc/hosts",
      "attachment://1",
    ]) {
      expect(isUriReadTarget(target), target).toBe(true)
    }
  })

  it("keeps local paths — including Windows drive letters — on the filesystem path", () => {
    for (const target of [
      "README.md",
      "./src/index.ts",
      "/abs/path/file.ts",
      "~/notes.md",
      "C:\\Users\\me\\file.ts",
      "C:/Users/me/file.ts",
      "no-scheme:not-a-uri",
      "",
    ]) {
      expect(isUriReadTarget(target), target).toBe(false)
    }
  })

  it("does not prefix a Windows read target with the workspace", () => {
    expect(resolveReadTargetPath("C:/Users/me/file.ts", "/workspace/project")).toBe("C:/Users/me/file.ts")
    expect(resolveReadTargetPath("C:\\Users\\me\\file.ts", "/workspace/project")).toBe("C:\\Users\\me\\file.ts")
    expect(resolveReadTargetPath("\\\\server\\share\\b.ts", "/workspace/project")).toBe("\\\\server\\share\\b.ts")
    expect(resolveReadTargetPath("src/a.ts", "/workspace/project")).toBe("/workspace/project/src/a.ts")
  })
})
