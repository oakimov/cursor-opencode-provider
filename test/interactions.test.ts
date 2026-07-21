import { describe, expect, it } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  handleInteractionQuery,
  inspectInteractionQueryWire,
  UnsupportedInteractionQueryError,
} from "../src/protocol/interactions.js"
import { pump } from "../src/language-model.js"
import type { CursorSession, Frame } from "../src/session.js"

type InteractionCase = {
  field: number
  query: string
  response: string
  outcome: "rejected" | "acknowledged" | "failed"
  assertResult: (response: Record<string, any>) => void
}

const cases: InteractionCase[] = [
  {
    field: 2,
    query: "web_search_request_query",
    response: "web_search_request_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
  {
    field: 3,
    query: "ask_question_interaction_query",
    response: "ask_question_interaction_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.result?.rejected?.reason).toContain("question tool"),
  },
  {
    field: 4,
    query: "switch_mode_request_query",
    response: "switch_mode_request_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
  {
    field: 7,
    query: "create_plan_request_query",
    response: "create_plan_request_response",
    outcome: "acknowledged",
    assertResult: (r) => {
      expect(r.result?.success).toBeDefined()
      expect(r.result?.plan_uri).toBe("")
    },
  },
  {
    field: 8,
    query: "setup_vm_environment_args",
    response: "setup_vm_environment_result",
    outcome: "acknowledged",
    assertResult: (r) => expect(r.success).toBeDefined(),
  },
  {
    field: 9,
    query: "web_fetch_request_query",
    response: "web_fetch_request_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
  {
    field: 10,
    query: "pr_management_request_query",
    response: "pr_management_result",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
  {
    field: 11,
    query: "mcp_auth_request_query",
    response: "mcp_auth_request_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
  {
    field: 12,
    query: "generate_image_request_query",
    response: "generate_image_request_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
  {
    field: 13,
    query: "replace_env_args",
    response: "replace_env_result",
    outcome: "failed",
    assertResult: (r) => expect(r.failure?.error_message).toContain("not supported"),
  },
  {
    field: 14,
    query: "connect_scm_request_query",
    response: "connect_scm_request_response",
    outcome: "rejected",
    assertResult: (r) => expect(r.rejected?.reason).toContain("UI approval"),
  },
]

function queryPayload(query: string, id = 42): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_query: { id, [query]: new Uint8Array() },
  })
}

function writeVarint(out: number[], value: number): void {
  let remaining = value >>> 0
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  out.push(remaining)
}

function unknownQueryPayload(id: number, variantField: number): Uint8Array {
  const query: number[] = []
  writeVarint(query, (1 << 3) | 0)
  writeVarint(query, id)
  writeVarint(query, (variantField << 3) | 2)
  writeVarint(query, 0)

  const wrapper: number[] = []
  writeVarint(wrapper, (7 << 3) | 2)
  writeVarint(wrapper, query.length)
  wrapper.push(...query)
  return Uint8Array.from(wrapper)
}

describe("interaction query headless responses", () => {
  for (const tc of cases) {
    it(`replies to ${tc.query} with ${tc.response}`, () => {
      const payload = queryPayload(tc.query)
      const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
      const handled = handleInteractionQuery(query, payload)

      expect(handled.id).toBe(42)
      expect(handled.variantField).toBe(tc.field)
      expect(handled.variantName).toBe(tc.query)
      expect(handled.outcome).toBe(tc.outcome)

      const response = decodeMessage<any>("AgentClientMessage", handled.reply)
        .interaction_response
      expect(response.id).toBe(42)
      expect(response[tc.response]).toBeDefined()
      tc.assertResult(response[tc.response])
    })
  }

  it("treats an omitted proto3 default id as zero (live switch-mode shape)", () => {
    const payload = queryPayload("switch_mode_request_query", 0)
    expect(inspectInteractionQueryWire(payload)).toEqual({
      id: 0,
      variantField: 4,
      variantName: "switch_mode_request_query",
    })

    const query = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    const handled = handleInteractionQuery(query, payload)
    expect(handled.id).toBe(0)
    const response = decodeMessage<any>("AgentClientMessage", handled.reply)
      .interaction_response
    expect(response.id).toBe(0)
    expect(response.switch_mode_request_response?.rejected).toBeDefined()
  })

  it("detects a future unknown variant from raw bytes", () => {
    const payload = unknownQueryPayload(17, 99)
    expect(inspectInteractionQueryWire(payload)).toEqual({
      id: 17,
      variantField: 99,
      variantName: undefined,
    })
    const decoded = decodeMessage<any>("AgentServerMessage", payload).interaction_query
    expect(() => handleInteractionQuery(decoded, payload)).toThrow(UnsupportedInteractionQueryError)
  })
})

function fakeSession(payloads: Uint8Array[], writes: Uint8Array[]): CursorSession {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++] } }
      : { done: true, value: undefined },
  }
  return {
    sessionId: "interaction-test-session",
    conversationId: "interaction-test-conversation",
    stream: {
      write(data: Uint8Array) { writes.push(data) },
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    allowTools: false,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  }
}

describe("interaction query pump regression", () => {
  it("writes the response and continues to a later turn_ended", async () => {
    const writes: Uint8Array[] = []
    const parts: any[] = []
    let streamError: Error | undefined
    const session = fakeSession([
      queryPayload("switch_mode_request_query", 0),
      encodeMessage("AgentServerMessage", {
        interaction_update: { turn_ended: { input_tokens: 5, output_tokens: 2 } },
      }),
    ], writes)
    const controller = {
      enqueue(part: unknown) { parts.push(part) },
      error(error: Error) { streamError = error },
    } as ReadableStreamDefaultController<any>

    await pump(session, controller, { textId: "text", reasoningId: "reasoning" })

    expect(streamError).toBeUndefined()
    expect(writes).toHaveLength(1)
    const response = decodeMessage<any>("AgentClientMessage", writes[0]).interaction_response
    expect(response.id).toBe(0)
    expect(response.switch_mode_request_response?.rejected).toBeDefined()
    expect(parts.some((part) => part.type === "finish")).toBe(true)
  })

  it("errors and closes promptly for an unknown variant", async () => {
    const writes: Uint8Array[] = []
    let destroyed = false
    const session = fakeSession([unknownQueryPayload(91, 99)], writes)
    session.stream.destroy = () => { destroyed = true }
    const controller = {
      enqueue() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<any>

    await expect(
      pump(session, controller, { textId: "text", reasoningId: "reasoning" }),
    ).rejects.toMatchObject({
      name: "CursorProtocolError",
      code: "CURSOR_RUN_REQUEST_UNSUPPORTED",
    })

    expect(writes).toHaveLength(0)
    expect(destroyed).toBe(true)
  })
})
