import { describe, it, expect } from "bun:test"
import { parseInteractionUpdate } from "../src/protocol/stream.js"
import { encodeMessage } from "../src/protocol/messages.js"

describe("parseInteractionUpdate", () => {
  it("parses text_delta", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_update: { text_delta: { text: "Hello world" } },
    })
    const event = parseInteractionUpdate(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe("text-delta")
    if (event!.type === "text-delta") {
      expect(event.text).toBe("Hello world")
    }
  })

  it("parses thinking_delta", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_update: { thinking_delta: { text: "reasoning..." } },
    })
    const event = parseInteractionUpdate(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe("reasoning-delta")
  })

  it("parses turn_ended", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_update: {
        turn_ended: { input_tokens: 100, output_tokens: 50, cache_read: 10, cache_write: 5 },
      },
    })
    const event = parseInteractionUpdate(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe("finish")
    if (event!.type === "finish") {
      expect(event.usage.input).toBe(100)
      expect(event.usage.output).toBe(50)
      expect(event.finishReason).toBe("stop")
    }
  })

  it("parses heartbeat (skipped)", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_update: { heartbeat: {} },
    })
    const event = parseInteractionUpdate(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe("heartbeat")
  })

  it("parses tool_call_started", () => {
    const payload = encodeMessage("AgentServerMessage", {
      interaction_update: {
        tool_call_started: {
          call_id: "tool_abc",
          tool_call: { call_id: "tool_abc", tool_name: "read", args: '{"path":"/test.txt"}' },
          model_call_id: "model_call_1",
        },
      },
    })
    const event = parseInteractionUpdate(payload)
    expect(event).not.toBeNull()
    expect(event!.type).toBe("tool-call-started")
  })

  it("returns null for non-interaction_update frames", () => {
    const payload = encodeMessage("AgentServerMessage", {
      exec_server_message: { id: 1, read_args: { path: "/x.txt", tool_call_id: "t1" } },
    })
    const event = parseInteractionUpdate(payload)
    expect(event).toBeNull()
  })
})


