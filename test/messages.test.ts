import { describe, it, expect } from "bun:test"
import {
  encodeMessage,
  decodeMessage,
  decodeMessageSparse,
  getMessageTypes,
} from "../src/protocol/messages.js"
import { readAllFields } from "../src/protocol/struct.js"
import { mapAvailableModelsResponse } from "../src/models.js"

describe("message round-trip", () => {
  it("encodes system context injection at Cursor's declared wire fields", () => {
    const data = encodeMessage("ConversationAction", { inject_context_action: {
      injection_id: "i", expected_run_id: "r", system_context: { producer: "opencode", content: "note" },
    } })
    expect(Array.from(data)).toEqual([
      0x9a, 0x01, 0x18, // inject_context_action #19, 24 bytes
      0x0a, 0x01, 0x69, // injection_id #1
      0x12, 0x01, 0x72, // expected_run_id #2
      0x22, 0x10, // system_context #4, 16 bytes
      0x0a, 0x08, ...Buffer.from("opencode"), // producer #1
      0x12, 0x04, ...Buffer.from("note"), // content #2
    ])
  })

  it("encodes cancellation reason at the CLI's field number", () => {
    const data = encodeMessage("CancelAction", { reason: "host_plan_agent_handoff" })
    const fields = readAllFields(data)
    expect(fields).toHaveLength(1)
    expect(fields[0]?.fn).toBe(1)
    expect(fields[0]?.wt).toBe(2)
    expect(new TextDecoder().decode(fields[0]?.bytes)).toBe("host_plan_agent_handoff")
    expect(decodeMessage<any>("CancelAction", data).reason).toBe("host_plan_agent_handoff")
  })
  it("ParameterValue", () => {
    const msg = { id: "effort", value: "high" }
    const data = encodeMessage("ParameterValue", msg)
    const decoded = decodeMessage<{ id: string; value: string }>("ParameterValue", data)
    expect(decoded.id).toBe("effort")
    expect(decoded.value).toBe("high")
  })

  it("RequestedModel", () => {
    const msg = {
      model_id: "claude-opus-4-8",
      max_mode: false,
      parameters: [
        { id: "thinking", value: "false" },
        { id: "effort", value: "high" },
      ],
    }
    const data = encodeMessage("RequestedModel", msg)
    const decoded = decodeMessage<any>("RequestedModel", data)
    expect(decoded.model_id).toBe("claude-opus-4-8")
    expect(decoded.max_mode).toBe(false)
    expect(decoded.parameters).toHaveLength(2)
  })

  it("TextDeltaUpdate", () => {
    const data = encodeMessage("TextDeltaUpdate", { text: "Hello" })
    const decoded = decodeMessage<{ text: string }>("TextDeltaUpdate", data)
    expect(decoded.text).toBe("Hello")
  })

  it("ThinkingDeltaUpdate", () => {
    const data = encodeMessage("ThinkingDeltaUpdate", { text: "thinking..." })
    const decoded = decodeMessage<{ text: string }>("ThinkingDeltaUpdate", data)
    expect(decoded.text).toBe("thinking...")
  })

  it("TurnEnded", () => {
    const msg = { input_tokens: 100, output_tokens: 50, cache_read: 10, cache_write: 5, reasoning_tokens: 20 }
    const data = encodeMessage("TurnEnded", msg)
    const decoded = decodeMessage<any>("TurnEnded", data)
    expect(decoded.input_tokens).toBe(100)
    expect(decoded.output_tokens).toBe(50)
  })

  it("InteractionUpdate with text_delta", () => {
    const data = encodeMessage("InteractionUpdate", {
      text_delta: { text: "Hello" },
    })
    const decoded = decodeMessage<any>("InteractionUpdate", data)
    expect(decoded.text_delta?.text).toBe("Hello")
  })

  it("InteractionUpdate with thinking_delta", () => {
    const data = encodeMessage("InteractionUpdate", {
      thinking_delta: { text: "reasoning..." },
    })
    const decoded = decodeMessage<any>("InteractionUpdate", data)
    expect(decoded.thinking_delta?.text).toBe("reasoning...")
  })

  it("InteractionUpdate with turn_ended", () => {
    const data = encodeMessage("InteractionUpdate", {
      turn_ended: { input_tokens: 200, output_tokens: 100, cache_read: 0, cache_write: 0 },
    })
    const decoded = decodeMessage<any>("InteractionUpdate", data)
    expect(decoded.turn_ended?.input_tokens).toBe(200)
  })

  it("decodes live step_completed frames (uint64 step_id, not string)", () => {
    // Captured from /tmp/cursor-provider-debug.log — previously threw
    // "index out of range" because step_id was typed as string.
    const hex = "0a098a0106084910c0c610"
    const payload = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
    const asm = decodeMessage<any>("AgentServerMessage", payload)
    const sc = asm.interaction_update?.step_completed
    expect(sc).toBeDefined()
    // protobufjs may return Long/string for uint64; coerce for assert.
    expect(Number(sc.step_id)).toBe(73)
    expect(Number(sc.step_duration_ms)).toBe(271168)
  })

  it("ExecServerMessage with read_args", () => {
    const data = encodeMessage("ExecServerMessage", {
      id: 1,
      read_args: { path: "/test/file.txt", tool_call_id: "tool_abc" },
    })
    const decoded = decodeMessage<any>("ExecServerMessage", data)
    expect(decoded.id).toBe(1)
    expect(decoded.read_args?.path).toBe("/test/file.txt")
  })

  it("ExecClientMessage with read_result", () => {
    const data = encodeMessage("ExecClientMessage", {
      id: 1,
      local_execution_time_ms: 42,
      read_result: {
        success: {
          path: "/f",
          content: "file content",
          total_lines: 12,
          file_size: 120,
          truncated: false,
          range_applied: true,
        },
      },
    })
    const decoded = decodeMessage<any>("ExecClientMessage", data)
    expect(decoded.id).toBe(1)
    expect(decoded.read_result?.success?.content).toBe("file content")
    expect(decoded.read_result?.success).toMatchObject({
      total_lines: 12,
      file_size: 120,
      truncated: false,
      range_applied: true,
    })
    expect(decoded.local_execution_time_ms).toBe(42)
  })

  it("AgentClientMessage with run_request", () => {
    const data = encodeMessage("AgentClientMessage", {
      run_request: {
        conversation_id: "conv-123",
        requested_model: { model_id: "test-model", max_mode: false, parameters: [] },
      },
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request?.conversation_id).toBe("conv-123")
  })

  it("AgentServerMessage with interaction_update", () => {
    const data = encodeMessage("AgentServerMessage", {
      interaction_update: { text_delta: { text: "Hello" } },
    })
    const decoded = decodeMessage<any>("AgentServerMessage", data)
    expect(decoded.interaction_update?.text_delta?.text).toBe("Hello")
  })

  it("AgentServerMessage with exec_server_message", () => {
    const data = encodeMessage("AgentServerMessage", {
      exec_server_message: { id: 1, read_args: { path: "/readme.md", tool_call_id: "t1" } },
    })
    const decoded = decodeMessage<any>("AgentServerMessage", data)
    expect(decoded.exec_server_message?.id).toBe(1)
    expect(decoded.exec_server_message?.read_args?.path).toBe("/readme.md")
  })

  it("round-trips interaction_query #7 and interaction_response #6", () => {
    const serverData = encodeMessage("AgentServerMessage", {
      interaction_query: { id: 9, web_search_request_query: new Uint8Array() },
    })
    const query = decodeMessage<any>("AgentServerMessage", serverData).interaction_query
    expect(query.id).toBe(9)
    expect(query.web_search_request_query).toBeDefined()

    const clientData = encodeMessage("AgentClientMessage", {
      interaction_response: {
        id: 9,
        web_search_request_response: { rejected: { reason: "headless" } },
      },
    })
    const response = decodeMessage<any>("AgentClientMessage", clientData).interaction_response
    expect(response.id).toBe(9)
    expect(response.web_search_request_response?.rejected?.reason).toBe("headless")
  })

  it("AvailableModelsRequest", () => {
    // Should just be an empty message with no fields
    const data = encodeMessage("AvailableModelsRequest", {})
    expect(data.length).toBe(0)
    const decoded = decodeMessage<any>("AvailableModelsRequest", data)
    expect(decoded).toBeDefined()
  })

  it("decodes canonical AvailableModels fields before catalog mapping", () => {
    // Cursor CLI 2026.10.01: response names #1, models #2; max context #16;
    // variant parameters #1, label #2, max #3, default max #4, default base #5.
    // Constructed independently of this package's encoder from that descriptor.
    const hex = "0a0a746573742d6d6f64656c12330a0a746573742d6d6f64656c78e0a7128001c0843df2011b0a0d0a07636f6e746578741202316d12044c6f6e67180120012800"
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"))
    const decoded = decodeMessage<any>("AvailableModelsResponse", bytes)
    expect(decoded.model_names).toEqual(["test-model"])
    expect(decoded.models).toHaveLength(1)
    expect(decoded.models[0]).toMatchObject({
      name: "test-model",
      context_token_limit: 300_000,
      context_token_limit_for_max_mode: 1_000_000,
      variants: [{
        parameter_values: [{ id: "context", value: "1m" }],
        display_name: "Long",
        is_max_mode: true,
        is_default_max_config: true,
        is_default_non_max_config: false,
      }],
    })
    expect(mapAvailableModelsResponse(decoded)[0]).toMatchObject({
      id: "test-model",
      maxContextForMaxMode: 1_000_000,
      variants: [{
        displayName: "Long",
        parameterValues: [{ id: "context", value: "1m" }],
        isDefaultMax: true,
        isDefaultNonMax: false,
      }],
    })
    const encoded = encodeMessage("AvailableModelsResponse", decodeMessageSparse("AvailableModelsResponse", bytes))
    expect(Array.from(encoded)).toEqual(Array.from(bytes))
  })

  it("ClientHeartbeat", () => {
    const data = encodeMessage("ClientHeartbeat", {})
    expect(data.length).toBe(0)
  })

  it("Unknown type throws", () => {
    expect(() => encodeMessage("NonExistent", {})).toThrow()
    expect(() => decodeMessage("NonExistent", new Uint8Array(0))).toThrow()
  })
})

describe("canonical read-result wire fields", () => {
  it("encodes ReadSuccess range_applied on canonical field 8", () => {
    const data = encodeMessage("ReadSuccess", {
      path: "/f",
      content: "x",
      total_lines: 12,
      file_size: 120,
      range_applied: true,
    })
    expect(Array.from(data)).toEqual([
      0x0a, 0x02, 0x2f, 0x66, // path #1 = /f
      0x12, 0x01, 0x78, // content #2 = x
      0x18, 0x0c, // total_lines #3 = 12
      0x20, 0x78, // file_size #4 = 120
      0x40, 0x01, // range_applied #8 = true
    ])
  })
})

describe("canonical shell request and refusal result wire fields", () => {
  const text = (value: string) => [value.length, ...Buffer.from(value)]

  it("decodes ShellArgs description from canonical field 15", () => {
    const decoded = decodeMessage<Record<string, unknown>>("ShellArgs", Uint8Array.from([
      0x0a, ...text("ls"), // command #1
      0x68, 0x01, // timeout_behavior #13 = 1
      0x70, 0xe8, 0x07, // hard_timeout #14 = 1000
      0x7a, ...text("List files"), // description #15
    ]))
    expect(decoded.command).toBe("ls")
    expect(decoded.timeout_behavior).toBe(1)
    expect(decoded.hard_timeout).toBe(1000)
    expect(decoded.description).toBe("List files")
  })

  const rejected = [0x0a, ...text("/f"), 0x12, ...text("no")] // path #1, reason #2
  it.each([
    ["ReadResult", { rejected: { path: "/f", reason: "no" } }, [0x1a, rejected.length, ...rejected]], // rejected #3
    ["WriteResult", { rejected: { path: "/f", reason: "no" } }, [0x32, rejected.length, ...rejected]], // rejected #6
    ["DeleteResult", { rejected: { path: "/f", reason: "no" } }, [0x32, rejected.length, ...rejected]], // rejected #6
    ["LsResult", { rejected: { path: "/f", reason: "no" } }, [0x1a, rejected.length, ...rejected]], // rejected #3
    // permission_denied #4 { path #1, client_visible_error #2, is_readonly #3 }
    ["DeleteResult", { permission_denied: { path: "/f", client_visible_error: "no", is_readonly: true } },
      [0x22, 10, 0x0a, ...text("/f"), 0x12, ...text("no"), 0x18, 0x01]],
    // permission_denied #7 { command #1, working_directory #2, error #3 }
    ["ShellResult", { permission_denied: { command: "ls", working_directory: "/w", error: "no" } },
      [0x3a, 12, 0x0a, ...text("ls"), 0x12, ...text("/w"), 0x1a, ...text("no")]],
    // rejected #3 { reason #1, is_readonly #2 }
    ["McpResult", { rejected: { reason: "no", is_readonly: true } }, [0x1a, 6, 0x0a, ...text("no"), 0x10, 0x01]],
    // permission_denied #4 { error #1, is_readonly #2 }
    ["McpResult", { permission_denied: { error: "no", is_readonly: true } }, [0x22, 6, 0x0a, ...text("no"), 0x10, 0x01]],
  ])("encodes %s %j on its canonical fields", (type, value, expected) => {
    expect(Array.from(encodeMessage(type, value))).toEqual(expected)
  })
})

describe("MCP image result wire fields", () => {
  it("encodes an image item as McpToolResultContentItem #2 McpImageContent{data #1, mime_type #2}", () => {
    const bytes = encodeMessage("McpToolResultContentItem", {
      image: { data: Uint8Array.from([1, 2]), mime_type: "image/png" },
    })
    expect(Array.from(bytes)).toEqual([
      0x12, 0x0f, // image #2, 15 bytes
      0x0a, 0x02, 0x01, 0x02, // data #1
      0x12, 0x09, ...Buffer.from("image/png"), // mime_type #2
    ])
  })

  it("round-trips text and image items on McpSuccess", () => {
    const decoded = decodeMessage<any>("McpSuccess", encodeMessage("McpSuccess", {
      content: [
        { text: { text: "badge" } },
        { image: { data: Uint8Array.from([9]), mime_type: "image/png" } },
      ],
      is_error: false,
    }))
    expect(decoded.content[0].text.text).toBe("badge")
    expect(Uint8Array.from(decoded.content[1].image.data)).toEqual(Uint8Array.from([9]))
    expect(decoded.content[1].image.mime_type).toBe("image/png")
  })
})

describe("message schema accuracy", () => {
  it("all message types are resolvable", () => {
    const root = getMessageTypes()
    const types = [
      "TextDeltaUpdate", "ThinkingDeltaUpdate", "TurnEnded",
      "InteractionUpdate", "ExecServerMessage", "ExecClientMessage",
      "InteractionQuery", "InteractionResponse",
      "AgentRunRequest", "AgentClientMessage", "AgentServerMessage",
      "RequestedModel", "ParameterValue",
      "AvailableModelsRequest", "AvailableModelsResponse",
      "ClientHeartbeat",
      "ReadArgs", "ReadResult", "ShellArgs", "ShellStream",
      "McpArgs", "McpResult",
      "ConversationAction", "ConversationStateStructure",
    ]
    const unresolved = types.flatMap((name) => {
      const type = root.lookupType(name)
      if (!type?.fields) return [`${name} is not a message`]
      const count = Object.keys(type.fields).length
      const minimum = name === "ClientHeartbeat" || name === "AvailableModelsRequest" ? 0 : 1
      return count >= minimum ? [] : [`${name} has ${count} fields`]
    })
    expect(unresolved).toEqual([])
  })

  it("InteractionUpdate has all required oneof fields", () => {
    const root = getMessageTypes()
    const type = root.lookupType("InteractionUpdate")
    expect(type.oneofs).toHaveProperty("update")
    const fields = Object.keys(type.fields)
    const required = ["text_delta", "thinking_delta", "tool_call_started", "tool_call_completed", "partial_tool_call", "heartbeat", "turn_ended", "tool_requests_listed"]
    expect(required.filter(name => !fields.includes(name))).toEqual([])
  })

  it("InteractionUpdate decodes tool_requests_listed call_count", () => {
    // Independent CLI wire fixture: InteractionUpdate #27, uint32 count #1.
    const data = Uint8Array.of(0xda, 0x01, 0x02, 0x08, 0x03)
    const decoded = decodeMessage<any>("InteractionUpdate", data)
    expect(decoded.tool_requests_listed?.call_count).toBe(3)
  })

  it("decodes a zero count omitted from the ToolRequestsListedUpdate body", () => {
    const decoded = decodeMessage<any>("InteractionUpdate", Uint8Array.of(0xda, 0x01, 0x00))
    expect(decoded.tool_requests_listed?.call_count).toBe(0)
  })

  it("decodes CLI field 15 tool deltas without interpreting their nested content", () => {
    const decoded = decodeMessage<any>("InteractionUpdate", Uint8Array.of(
      0x7a, 0x07, 0x0a, 0x01, 0x61, 0x12, 0x02, 0x1a, 0x00,
    ))
    expect(decoded.tool_call_delta.call_id).toBe("a")
    expect(decoded.tool_call_delta.tool_call_delta).toEqual(Uint8Array.of(0x1a, 0x00))
  })

  it("ExecServerMessage has all tool variants", () => {
    const root = getMessageTypes()
    const type = root.lookupType("ExecServerMessage")
    const fields = Object.keys(type.fields)
    const required = [
      "read_args", "write_args", "grep_args", "ls_args", "delete_args", "mcp_args",
      "mcp_state_exec_args", "subagent_args", "shell_stream_args", "background_shell_spawn_args",
      "pi_write_args", "list_mcp_resources_exec_args", "read_mcp_resource_exec_args",
    ]
    expect(required.filter(name => !fields.includes(name))).toEqual([])
    expect(root.lookupType("ExecServerMessage").fields.list_mcp_resources_exec_args.id).toBe(17)
    expect(root.lookupType("ExecServerMessage").fields.read_mcp_resource_exec_args.id).toBe(18)
    expect(root.lookupType("ExecClientMessage").fields.list_mcp_resources_exec_result.id).toBe(17)
    expect(root.lookupType("ExecClientMessage").fields.read_mcp_resource_exec_result.id).toBe(18)
    expect(root.lookupType("ExecClientMessage").fields.mcp_state_exec_result.id).toBe(36)
    expect(root.lookupType("ExecClientMessage").fields.subagent_result.id).toBe(28)
    expect(root.lookupType("ExecClientMessage").fields.background_shell_spawn_result.id).toBe(16)
    expect(root.lookupType("ShellArgs").fields.timeout_behavior.id).toBe(13)
    expect(root.lookupType("ShellArgs").fields.hard_timeout.id).toBe(14)
    expect(root.lookupType("ShellStream").fields.backgrounded.id).toBe(7)
    expect(root.lookupType("ShellStreamExit").fields.abort_reason.id).toBe(5)
  })

  it("Agent messages expose the interaction request/reply fields", () => {
    const root = getMessageTypes()
    expect(root.lookupType("AgentServerMessage").fields.interaction_query.id).toBe(7)
    expect(root.lookupType("AgentClientMessage").fields.interaction_response.id).toBe(6)
  })

  it("uses the canonical read-todos filters and has no misleading MCP alias", () => {
    const root = getMessageTypes()
    const args = root.lookupType("ReadTodosArgs")
    expect(args.fields.status_filter).toMatchObject({ id: 1, type: "TodoStatus", repeated: true })
    expect(args.fields.id_filter).toMatchObject({ id: 2, type: "string", repeated: true })
    expect(root.lookupEnum("TodoStatus").values).toEqual({
      TODO_STATUS_UNSPECIFIED: 0,
      TODO_STATUS_PENDING: 1,
      TODO_STATUS_IN_PROGRESS: 2,
      TODO_STATUS_COMPLETED: 3,
      TODO_STATUS_CANCELLED: 4,
    })
    expect(root.get("McpToolDescriptor")).toBeNull()
  })

  it("encodes permission auto-run instructions as canonical messages", () => {
    const bytes = encodeMessage("RequestContext", {
      user_permissions_auto_run: { allow_instructions: ["safe command"] },
      project_permissions_auto_run: { block_instructions: ["destructive command"] },
    })
    const fields = readAllFields(bytes).filter((field) => field.fn === 46 || field.fn === 47)
    expect(fields.map((field) => [field.fn, field.wt])).toEqual([[46, 2], [47, 2]])
    const decoded = decodeMessage<any>("RequestContext", bytes)
    expect(decoded.user_permissions_auto_run.allow_instructions).toEqual(["safe command"])
    expect(decoded.project_permissions_auto_run.block_instructions).toEqual(["destructive command"])
  })

  it("encodes explicit native web capability disables on both RequestContext paths", () => {
    for (const typeName of ["RequestContext", "RequestContextPayload"]) {
      const bytes = encodeMessage(typeName, {
        web_search_enabled: false,
        web_fetch_enabled: false,
      })
      const fields = readAllFields(bytes).filter((field) => field.fn === 17 || field.fn === 24)
      expect(fields.map((field) => [field.fn, field.wt, field.varint])).toEqual([
        [17, 0, 0],
        [24, 0, 0],
      ])
      const decoded = decodeMessage<any>(typeName, bytes)
      expect(decoded.web_search_enabled).toBe(false)
      expect(decoded.web_fetch_enabled).toBe(false)
    }
  })
})

describe("MCP resource exec (fields 17/18)", () => {
  it("round-trips ListMcpResourcesExecArgs with server present and absent", () => {
    const withServer = decodeMessage<any>(
      "ListMcpResourcesExecArgs",
      encodeMessage("ListMcpResourcesExecArgs", { server: "everything" }),
    )
    expect(withServer.server).toBe("everything")
    const withoutServer = decodeMessage<any>(
      "ListMcpResourcesExecArgs",
      encodeMessage("ListMcpResourcesExecArgs", {}),
    )
    expect(withoutServer.server).toBe("")
  })

  it("round-trips a multi-resource ListMcpResourcesExecResult success, using the nested resource type", () => {
    const root = getMessageTypes()
    expect(root.lookupType("ListMcpResourcesExecResult_McpResource")).toBeDefined()
    expect(root.get("McpResource")).toBeNull()

    const bytes = encodeMessage("ListMcpResourcesExecResult", {
      success: {
        resources: [
          {
            uri: "demo://resource/static/document/1",
            name: "doc-1",
            description: "First document",
            mime_type: "text/markdown",
            server: "everything",
            annotations: { audience: "user" },
          },
          { uri: "demo://resource/static/document/2", server: "everything" },
        ],
      },
    })
    const decoded = decodeMessage<any>("ListMcpResourcesExecResult", bytes)
    expect(decoded.error).toBeUndefined()
    expect(decoded.success.resources).toHaveLength(2)
    expect(decoded.success.resources[0]).toMatchObject({
      uri: "demo://resource/static/document/1",
      name: "doc-1",
      description: "First document",
      mime_type: "text/markdown",
      server: "everything",
      annotations: { audience: "user" },
    })
    // Optional metadata absent on the second resource stays empty, not omitted.
    expect(decoded.success.resources[1]).toMatchObject({
      uri: "demo://resource/static/document/2",
      name: "",
      server: "everything",
    })
  })

  it("round-trips ListMcpResourcesExecResult error and rejected", () => {
    const error = decodeMessage<any>(
      "ListMcpResourcesExecResult",
      encodeMessage("ListMcpResourcesExecResult", { error: { error: "boom" } }),
    )
    expect(error.success).toBeUndefined()
    expect(error.error.error).toBe("boom")

    const rejected = decodeMessage<any>(
      "ListMcpResourcesExecResult",
      encodeMessage("ListMcpResourcesExecResult", { rejected: { reason: "denied" } }),
    )
    expect(rejected.success).toBeUndefined()
    expect(rejected.rejected.reason).toBe("denied")
  })

  it("round-trips ReadMcpResourceExecArgs including download_path and smart_mode_approval", () => {
    const bytes = encodeMessage("ReadMcpResourceExecArgs", {
      server: "everything",
      uri: "demo://resource/static/document/1",
      download_path: "/tmp/out.bin",
      tool_call_id: "call-1",
      smart_mode_approval: { request_id: "req-1", reason: "auto" },
    })
    const decoded = decodeMessage<any>("ReadMcpResourceExecArgs", bytes)
    expect(decoded).toMatchObject({
      server: "everything",
      uri: "demo://resource/static/document/1",
      download_path: "/tmp/out.bin",
      tool_call_id: "call-1",
      smart_mode_approval: { request_id: "req-1", reason: "auto" },
    })
  })

  it("round-trips ReadMcpResourceSuccess text content with the interleaved field order", () => {
    const type = getMessageTypes().lookupType("ReadMcpResourceSuccess")
    expect(Object.keys(type.fields).map((name) => type.fields[name]!.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    expect(type.oneofs).toHaveProperty("content")
    expect(type.oneofs.content!.fieldsArray.map((f) => f.name)).toEqual(["text", "blob"])

    const bytes = encodeMessage("ReadMcpResourceExecResult", {
      success: {
        uri: "demo://resource/static/document/1",
        name: "doc-1",
        mime_type: "text/markdown",
        text: "# Hello",
        annotations: { audience: "user" },
      },
    })
    const decoded = decodeMessage<any>("ReadMcpResourceExecResult", bytes)
    expect(decoded.error).toBeUndefined()
    expect(decoded.success).toMatchObject({
      uri: "demo://resource/static/document/1",
      name: "doc-1",
      mime_type: "text/markdown",
      text: "# Hello",
      annotations: { audience: "user" },
    })
  })

  it("round-trips ReadMcpResourceSuccess binary content (base64-decoded bytes)", () => {
    const blob = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const bytes = encodeMessage("ReadMcpResourceExecResult", {
      success: { uri: "demo://resource/img", mime_type: "image/png", blob },
    })
    const decoded = decodeMessage<any>("ReadMcpResourceExecResult", bytes)
    expect(new Uint8Array(decoded.success.blob)).toEqual(blob)
    // A field belonging to a oneof is absent, not defaulted, when a sibling
    // member (blob) was the one actually set on the wire.
    expect(decoded.success.text).toBeUndefined()
  })

  it("round-trips ReadMcpResourceExecResult error, not_found, and the rejected-without-uri quirk", () => {
    const error = decodeMessage<any>(
      "ReadMcpResourceExecResult",
      encodeMessage("ReadMcpResourceExecResult", {
        error: { uri: "demo://x", error: 'Server "x" not found' },
      }),
    )
    expect(error.success).toBeUndefined()
    expect(error.error).toMatchObject({ uri: "demo://x", error: 'Server "x" not found' })

    const notFound = decodeMessage<any>(
      "ReadMcpResourceExecResult",
      encodeMessage("ReadMcpResourceExecResult", { not_found: { uri: "demo://missing" } }),
    )
    expect(notFound.success).toBeUndefined()
    expect(notFound.not_found.uri).toBe("demo://missing")

    // Cursor's own executor sets only `reason` on rejected — `uri` (field 1)
    // is deliberately left empty. Never backfill it on encode.
    const rejected = decodeMessage<any>(
      "ReadMcpResourceExecResult",
      encodeMessage("ReadMcpResourceExecResult", { rejected: { reason: "User rejected MCP resource fetch" } }),
    )
    expect(rejected.success).toBeUndefined()
    expect(rejected.rejected.uri).toBe("")
    expect(rejected.rejected.reason).toBe("User rejected MCP resource fetch")
  })

  it("wires SmartModeApproval and OutputLocation as standalone messages", () => {
    const root = getMessageTypes()
    expect(root.lookupType("SmartModeApproval")).toBeDefined()
    expect(root.lookupType("OutputLocation")).toBeDefined()
    const decoded = decodeMessage<any>(
      "OutputLocation",
      encodeMessage("OutputLocation", { file_path: "/tmp/x", size_bytes: 10, line_count: 2 }),
    )
    expect(decoded).toMatchObject({ file_path: "/tmp/x", size_bytes: 10, line_count: 2 })
  })
})
