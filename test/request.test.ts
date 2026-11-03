import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { buildRunRequest, buildHeartbeat, buildExecHeartbeat } from "../src/protocol/request.js"
import { buildLiveRequestContext } from "../src/protocol/tools.js"
import { SYSTEM_INSTRUCTIONS_RULE_PATH, systemInstructionsRule } from "../src/context/build.js"
import { decodeMessage, decodeMessageSparse, encodeMessage, getMessageTypes } from "../src/protocol/messages.js"
import { readAllFields } from "../src/protocol/struct.js"
import { withTempHostCache } from "./host-cache.js"

const vendorRunRequest: {
  descriptor: string
  booleanWireVectors: Array<{ hex: string; value: boolean }>
} = JSON.parse(readFileSync(new URL("./fixtures/cursor-agent-run-request.vendor.json", import.meta.url), "utf8"))

describe("buildRunRequest", () => {
  it("matches the independent Cursor CLI descriptor for removed field 10 and optional boolean field 12", () => {
    const [name, ...declarations] = vendorRunRequest.descriptor.split("|")
    expect(name).toBe("AgentRunRequest")
    const fields = declarations.map(declaration => declaration.split(" "))
    expect(fields.some(([number]) => number === "10")).toBe(false)
    const exclusion = fields.find(([number]) => number === "12")
    expect(exclusion).toEqual(["12", "exclude_workspace_context", "8?"])

    const type = getMessageTypes().lookupType(name!)
    expect(type.fieldsById[10]).toBeUndefined()
    expect(type.fieldsById[12]).toMatchObject({ name: "exclude_workspace_context", type: "bool" })
  })

  it.each(vendorRunRequest.booleanWireVectors)("matches vendor-derived field 12 wire bytes $hex", ({ hex, value }) => {
    const wire = Buffer.from(hex, "hex")
    expect(readAllFields(wire)).toMatchObject([{ fn: 12, wt: 0, varint: Number(value) }])
    expect(decodeMessageSparse<{ exclude_workspace_context: boolean }>("AgentRunRequest", wire)).toEqual({ exclude_workspace_context: value })
    expect(Buffer.from(encodeMessage("AgentRunRequest", { exclude_workspace_context: value })).toString("hex")).toBe(hex)
  })

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

  it.each(["fresh", "followup", "resume"] as const)("omits retired field 10 and unused workspace-exclusion field 12 in a %s Run", action => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-fields",
      messageId: "message-fields",
      ...(action === "fresh" ? {} : { conversationState: Uint8Array.of(10, 1, 120) }),
      ...(action === "resume" ? { action: "resume" as const } : {}),
    })

    // Inspect raw fields independently of the hand-written AgentRunRequest schema.
    const runRequest = readAllFields(data).find((field) => field.fn === 1)?.bytes
    expect(runRequest).toBeDefined()
    const fieldNumbers = readAllFields(runRequest!).map((field) => field.fn)
    expect(fieldNumbers).not.toContain(10)
    expect(fieldNumbers).not.toContain(12)
  })

  it("sends the Cursor mode as UserMessage.mode (field 4, agent.v1.AgentMode)", () => {
    const userMessageFields = (data: Uint8Array) => {
      const field = (bytes: Uint8Array, fn: number) => readAllFields(bytes).find((f) => f.fn === fn)?.bytes
      // AgentClientMessage.run_request → action → user_message_action → user_message
      const userMessage = field(field(field(field(data, 1)!, 2)!, 1)!, 1)
      expect(userMessage).toBeDefined()
      return readAllFields(userMessage!)
    }
    const plan = userMessageFields(buildRunRequest({
      text: "Plan it",
      modelId: "test-model",
      conversationId: "conv-mode",
      mode: 3,
    }))
    expect(plan.find((f) => f.fn === 4)).toMatchObject({ wt: 0, varint: 3 })

    const unset = userMessageFields(buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-mode",
    }))
    expect(unset.some((f) => f.fn === 4)).toBe(false)
  })

  it("encodes image attachments in the live user selected context", () => {
    const data = buildRunRequest({
      text: "Describe this",
      images: [{
        data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        filename: "sample.png",
        mimeType: "image/png",
      }],
      modelId: "vision-model",
      conversationId: "conv-image",
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const image = decoded.run_request.action.user_message_action.user_message
      .selected_context.selected_images[0]
    expect(Array.from(image.data)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(image.path).toBe("sample.png")
    expect(image.mime_type).toBe("image/png")
    expect(image.uuid).toBeTruthy()
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

  it("sends conversation_group_id + run_id (CLI parity: run-agent.tsx headless.ts)", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-after-rebase",
      conversationGroupId: "stable-session-group",
      messageId: "msg-request-42",
    })
    const runRequest = readAllFields(data).find((field) => field.fn === 1)?.bytes
    expect(runRequest).toBeDefined()
    expect(readAllFields(runRequest!).some((field) => field.fn === 16)).toBe(true)
    expect(readAllFields(runRequest!).some((field) => field.fn === 25)).toBe(true)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.conversation_id).toBe("conv-after-rebase")
    expect(decoded.run_request.conversation_group_id).toBe("stable-session-group")
    expect(decoded.run_request.run_id).toBe("msg-request-42")
  })

  it("falls back to the conversation id when no group is supplied", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "standalone-conversation",
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.conversation_group_id).toBe("standalone-conversation")
  })

  it("does not populate AgentRunRequest #4 mcp_tools", () => {
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
    expect(decoded.run_request.mcp_tools?.mcp_tools ?? []).toHaveLength(0)
  })

  it("advertises slim tool names on LIVE request_context, not #7 or fs descriptors", () => withTempHostCache(async () => {
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
    expect(rc.web_search_enabled).toBe(false)
    expect(rc.web_fetch_enabled).toBe(false)
    expect(rc.tools ?? []).toHaveLength(0)
    expect(decoded.run_request.mcp_tools?.mcp_tools ?? []).toHaveLength(0)
    const fsOpts = rc.mcp_file_system_options
    expect(fsOpts.enabled).toBe(true)
    expect(fsOpts.mcp_descriptors ?? []).toHaveLength(0)
    const metaTools = rc.mcp_meta_tool_options.mcp_descriptors[0].tools
    expect(metaTools).toHaveLength(2)
    expect(metaTools.map((tool: { tool_name: string }) => tool.tool_name)).toEqual([
      "read",
      "bash",
    ])
    const metaBytes = encodeMessage("RequestContext", buildLiveRequestContext(tools))
    const metaOpts = readAllFields(metaBytes).find((field) => field.fn === 34)?.bytes
    const descriptor = readAllFields(metaOpts!).find((field) => field.fn === 2)?.bytes
    const tool = readAllFields(descriptor!).find((field) => field.fn === 5)?.bytes
    expect(readAllFields(tool!).map((field) => field.fn)).toEqual([1])
  }))

  it("splits LIVE mcp_meta descriptors by real MCP server", () => withTempHostCache(async () => {
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
      requestContext,
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const rc = decoded.run_request.action.user_message_action.request_context
    expect(rc.tools ?? []).toHaveLength(0)
    expect(rc.mcp_file_system_options.mcp_descriptors ?? []).toHaveLength(0)
    const descriptors = rc.mcp_meta_tool_options.mcp_descriptors
    expect(descriptors.map((d: any) => d.server_identifier)).toEqual([
      "opencode",
      "github",
      "brave",
    ])
    expect(descriptors[1].tools[0].tool_name).toBe("create_pull_request")
    expect(rc.mcp_meta_tool_options.mcp_descriptors).toHaveLength(3)
  }))

  it("sends an empty mcp_tools list when no tools are given", () => {
    const data = buildRunRequest({ text: "hi", modelId: "m", conversationId: "c" })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.mcp_tools?.mcp_tools ?? []).toHaveLength(0)
    expect(decoded.run_request.action.user_message_action.request_context?.tools ?? []).toHaveLength(0)
  })

  it("includes parameter values and max mode when provided", () => {
    const data = buildRunRequest({
      text: "Hi",
      modelId: "test-model",
      conversationId: "conv-2",
      maxMode: true,
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
    expect(decoded.run_request.requested_model?.max_mode).toBe(true)
  })

  it("delivers system context as a global rule, not custom_system_prompt or a seeded system message", () => {
    const data = buildRunRequest({
      text: "Hi",
      modelId: "test-model",
      conversationId: "conv-3",
      history: [{ role: "system", content: "You are a helpful assistant." }],
      requestContext: { rules: [systemInstructionsRule("You are a helpful assistant.")] },
    })

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    // The internal --system-prompt field must NOT be used — the server rejects
    // it for non-Anysphere accounts (`unknown option '--system-prompt'`).
    expect(decoded.run_request.custom_system_prompt || "").toBe("")
    // Cursor does not follow a client-seeded `system` root message.
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.root_prompt_messages_json ?? []).toEqual([])
    const rules = decoded.run_request.action.user_message_action.request_context.rules
    expect(rules).toEqual([{
      full_path: SYSTEM_INSTRUCTIONS_RULE_PATH,
      content: "You are a helpful assistant.",
      type: { global: {} },
    }])
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
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "What next?",
    )
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    // Prior turns live server-side by conversation_id; no seeded system entry.
    expect(cs.root_prompt_messages_json ?? []).toEqual([])
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

describe("buildExecHeartbeat", () => {
  // Expected bytes are derived by hand from Cursor CLI's own schema, not from
  // src/protocol/messages.ts: agent.proto has AgentClientMessage
  // `exec_client_control_message = 5`, ExecClientControlMessage `heartbeat = 3`
  // and ExecClientHeartbeat `uint32 id = 1`. The CLI sends
  // `{ case: "heartbeat", value: { id: <exec id> } }` every 3000 ms for each
  // exec it is running (decompiled CLI 2026.09.28). proto3 leaves a zero id out.
  it.each([
    [0, "2a021a00"],
    [7, "2a041a020807"],
    [300, "2a051a0308ac02"],
  ])("encodes exec id %d as the CLI's wire bytes", (execId, hex) => {
    expect(Buffer.from(buildExecHeartbeat(execId)).toString("hex")).toBe(hex)
  })
})
