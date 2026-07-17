import { describe, it, expect } from "bun:test"
import { buildRunRequest, buildHeartbeat } from "../src/protocol/request.js"
import { buildLiveRequestContext } from "../src/protocol/tools.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { decodeFramePayload, streamFrames } from "../src/protocol/framing.js"
import { gunzipSync } from "node:zlib"
import { readAllFields } from "../src/protocol/struct.js"

describe("buildRunRequest", () => {
  it("produces a valid protobuf message", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-1",
    })

    // Should be non-empty valid bytes
    expect(data.length).toBeGreaterThan(10)

    // Decode and verify
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request).toBeDefined()
    const rr = decoded.run_request
    expect(rr.conversation_id).toBe("conv-1")
    expect(rr.action?.user_message_action?.user_message?.text).toBe("Hello")
    // The provider sends the concrete model id, never Cursor's "default" Auto.
    expect(rr.requested_model?.model_id).toBe("test-model")
  })

  it("does not populate selected_subagent_models from the available-model catalog", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-no-subagent-selection",
    })
    const runRequest = readAllFields(data).find((field) => field.fn === 1)?.bytes
    expect(runRequest).toBeDefined()
    expect(readAllFields(runRequest!).some((field) => field.fn === 14)).toBe(false)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.selected_subagent_models ?? []).toHaveLength(0)
  })

  it("does not fabricate a conversation_group_id from the conversation id", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-not-a-group",
    })
    const runRequest = readAllFields(data).find((field) => field.fn === 1)?.bytes
    expect(runRequest).toBeDefined()
    expect(readAllFields(runRequest!).some((field) => field.fn === 16)).toBe(false)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.conversation_id).toBe("conv-not-a-group")
    expect(decoded.run_request.conversation_group_id ?? "").toBe("")
  })

  it("injects opencode tools into AgentRunRequest #4 mcp_tools", () => {
    const data = buildRunRequest({
      text: "hi",
      modelId: "claude-opus-4-8",
      conversationId: "conv-tools",
      tools: [
        { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "grep", description: "Search", inputSchema: { type: "object" } },
      ],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const descriptors = decoded.run_request.mcp_tools?.mcp_tools
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0].name).toBe("opencode-read")
    expect(descriptors[0].tool_name).toBe("read")
    expect(descriptors[0].provider_identifier).toBe("opencode")
    expect(descriptors[0].description).toBe("Read a file")
    // input_schema is encoded as google.protobuf.Value bytes (non-empty)
    expect(descriptors[0].input_schema.length).toBeGreaterThan(0)
  })

  it("advertises tools on the LIVE request_context path (not only prewarm #4)", () => {
    const tools = [
      { name: "read", description: "Read", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
      { name: "bash", description: "Shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    ]
    const data = buildRunRequest({
      text: "hi",
      modelId: "m",
      conversationId: "c",
      tools,
      requestContext: buildLiveRequestContext(tools),
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const rc = decoded.run_request.action.user_message_action.request_context
    expect(rc).toBeDefined()
    // Flat list at RequestContext.tools (#7) — what the CLI historically used.
    expect(rc.tools).toHaveLength(2)
    expect(rc.tools[0].name).toBe("opencode-read")
    expect(rc.tools[0].tool_name).toBe("read")
    expect(rc.tools[0].input_schema.length).toBeGreaterThan(0)
    // Nested IDE path at #23 mcp_file_system_options.
    const fsOpts = rc.mcp_file_system_options
    expect(fsOpts.enabled).toBe(true)
    expect(fsOpts.mcp_descriptors).toHaveLength(1)
    expect(fsOpts.mcp_descriptors[0].server_identifier).toBe("opencode")
    expect(fsOpts.mcp_descriptors[0].tools).toHaveLength(2)
    expect(fsOpts.mcp_descriptors[0].tools[0].tool_name).toBe("read")
    // Meta-tool options (#34) also populated.
    expect(rc.mcp_meta_tool_options.mcp_descriptors[0].tools).toHaveLength(2)
  })

  it("splits LIVE mcp_descriptors by real MCP server", () => {
    const tools = [
      { name: "read", description: "Read", inputSchema: { type: "object" } },
      {
        name: "github_create_pull_request",
        description: "Open a PR",
        inputSchema: { type: "object" },
      },
      { name: "brave_web_search", description: "Search", inputSchema: { type: "object" } },
    ]
    const requestContext = buildLiveRequestContext(tools, "opencode", ["github", "brave"])
    const data = buildRunRequest({
      text: "hi",
      modelId: "m",
      conversationId: "c-split",
      tools,
      toolDescriptors: requestContext.tools as Array<Record<string, unknown>>,
      requestContext,
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const rc = decoded.run_request.action.user_message_action.request_context
    const flat = rc.tools
    expect(flat.map((t: any) => t.name)).toEqual([
      "opencode-read",
      "github-create_pull_request",
      "brave-web_search",
    ])
    expect(flat.map((t: any) => t.provider_identifier)).toEqual([
      "opencode",
      "github",
      "brave",
    ])
    const descriptors = rc.mcp_file_system_options.mcp_descriptors
    expect(descriptors.map((d: any) => d.server_identifier)).toEqual([
      "opencode",
      "github",
      "brave",
    ])
    expect(descriptors[1].tools[0].tool_name).toBe("create_pull_request")
    expect(rc.mcp_meta_tool_options.mcp_descriptors).toHaveLength(3)
  })

  it("sends an empty mcp_tools list when no tools are given", () => {
    const data = buildRunRequest({ text: "hi", modelId: "m", conversationId: "c" })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.mcp_tools?.mcp_tools ?? []).toHaveLength(0)
    expect(decoded.run_request.action.user_message_action.request_context?.tools ?? []).toHaveLength(0)
  })

  it("includes parameter values when provided", () => {
    const data = buildRunRequest({
      text: "Hi",
      modelId: "test-model",
      conversationId: "conv-2",
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "thinking", value: "true" },
      ],
    })

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const params = decoded.run_request.requested_model?.parameters
    expect(params).toHaveLength(2)
    expect(params[0].id).toBe("effort")
    expect(params[0].value).toBe("high")
  })

  it("delivers system prompt via conversation_state, not custom_system_prompt", () => {
    const data = buildRunRequest({
      text: "Hi",
      modelId: "test-model",
      conversationId: "conv-3",
      systemPrompt: "You are a helpful assistant.",
    })

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    // The internal --system-prompt field must NOT be used — the server rejects
    // it for non-Anysphere accounts (`unknown option '--system-prompt'`).
    expect(decoded.run_request.custom_system_prompt || "").toBe("")
    // System prompt rides in conversation_state.root_prompt_messages_json (#1)
    // as a JSON-encoded {"role":"system","content":...} message.
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    const msgs = cs.root_prompt_messages_json ?? []
    expect(msgs).toHaveLength(1)
    expect(JSON.parse(msgs[0])).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    })
  })

  it("generates a unique message_id each call", () => {
    const a = buildRunRequest({ text: "A", modelId: "m", conversationId: "c" })
    const b = buildRunRequest({ text: "B", modelId: "m", conversationId: "c" })
    const decA = decodeMessage<any>("AgentClientMessage", a)
    const decB = decodeMessage<any>("AgentClientMessage", b)
    const idA = decA.run_request.action.user_message_action.user_message.message_id
    const idB = decB.run_request.action.user_message_action.user_message.message_id
    expect(idA).not.toBe(idB)
  })

  it("sends live user text only (CLI-style; no client history replay)", () => {
    const data = buildRunRequest({
      text: "What next?",
      modelId: "m",
      conversationId: "conv-hist",
      systemPrompt: "Be brief.",
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "What next?",
    )
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    // System only in root_prompt — prior turns live server-side by conversation_id.
    const root = (cs.root_prompt_messages_json ?? []).map((s: string) => JSON.parse(s))
    expect(root).toEqual([{ role: "system", content: "Be brief." }])
    expect(cs.turns ?? []).toHaveLength(0)
  })

  it("omits root_prompt and turns when there is no system prompt", () => {
    const data = buildRunRequest({
      text: "Current",
      modelId: "m",
      conversationId: "c",
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.root_prompt_messages_json ?? []).toHaveLength(0)
    expect(cs.turns ?? []).toHaveLength(0)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "Current",
    )
  })
})

describe("buildHeartbeat", () => {
  it("produces an empty client_heartbeat message", () => {
    const data = buildHeartbeat()
    expect(data.length).toBeGreaterThan(0)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.client_heartbeat).toBeDefined()
  })
})
