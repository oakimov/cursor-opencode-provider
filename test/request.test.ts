import { describe, it, expect } from "bun:test"
import { buildRunRequest, buildHeartbeat } from "../src/protocol/request.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { decodeFramePayload, streamFrames } from "../src/protocol/framing.js"
import { gunzipSync } from "node:zlib"

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
    const data = buildRunRequest({
      text: "hi",
      modelId: "m",
      conversationId: "c",
      tools: [
        { name: "read", description: "Read", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
        { name: "bash", description: "Shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
      ],
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

  it("packs prior user/assistant pairs into conversation_state.turns", () => {
    const data = buildRunRequest({
      text: "What next?",
      modelId: "m",
      conversationId: "conv-hist",
      history: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hi there" },
        { role: "user", text: "How are you?" },
        { role: "assistant", text: "Fine" },
      ],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.turns).toHaveLength(2)
    const t0 = cs.turns[0].agent_conversation_turn
    expect(t0.user_message.text).toBe("Hello")
    expect(t0.steps[0].assistant_message.text).toBe("Hi there")
    const t1 = cs.turns[1].agent_conversation_turn
    expect(t1.user_message.text).toBe("How are you?")
    expect(t1.steps[0].assistant_message.text).toBe("Fine")
    // Current user message is the live action, not a history turn.
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe("What next?")
  })

  it("omits incomplete trailing user-only history entries", () => {
    const data = buildRunRequest({
      text: "Current",
      modelId: "m",
      conversationId: "c",
      history: [
        { role: "user", text: "Orphan user" },
      ],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.turns ?? []).toHaveLength(0)
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
