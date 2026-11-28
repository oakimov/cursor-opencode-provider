import { describe, it, expect, beforeEach } from "bun:test"
import {
  setCheckpoint,
  getCheckpoint,
  clearCheckpoint,
  checkpointTokenDetails,
  getCheckpointOccupancy,
  restoreCheckpointOccupancy,
  resetCheckpointsForTests,
} from "../src/protocol/checkpoint.js"
import { buildRunRequest } from "../src/protocol/request.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"

describe("checkpoint store", () => {
  beforeEach(() => resetCheckpointsForTests())

  it("stores and returns opaque bytes by conversation id", () => {
    const bytes = Uint8Array.from([0x0a, 0x03, 0x61, 0x62, 0x63])
    setCheckpoint("conv-1", bytes)
    expect(getCheckpoint("conv-1")).toEqual(bytes)
    expect(getCheckpoint("conv-other")).toBeUndefined()
  })

  it("replaces on subsequent set (CLI handleCheckpoint)", () => {
    setCheckpoint("conv-1", Uint8Array.from([1]))
    setCheckpoint("conv-1", Uint8Array.from([2, 3]))
    expect(getCheckpoint("conv-1")).toEqual(Uint8Array.from([2, 3]))
  })

  it("copies bytes so later mutations of the source buffer do not corrupt the store", () => {
    const src = Uint8Array.from([9, 9, 9])
    setCheckpoint("conv-1", src)
    src[0] = 0
    expect(getCheckpoint("conv-1")![0]).toBe(9)
  })

  it("ignores empty bytes", () => {
    setCheckpoint("conv-1", new Uint8Array(0))
    expect(getCheckpoint("conv-1")).toBeUndefined()
  })

  it("clearCheckpoint removes an entry", () => {
    setCheckpoint("conv-1", Uint8Array.from([1]))
    clearCheckpoint("conv-1")
    expect(getCheckpoint("conv-1")).toBeUndefined()
  })
})

describe("checkpoint token details", () => {
  beforeEach(() => resetCheckpointsForTests())

  const withTokens = (usedTokens: number) => encodeMessage("ConversationStateStructure", {
    root_prompt_messages_json: [`state-${usedTokens}`],
    token_details: { used_tokens: usedTokens, max_tokens: 256_000 },
  })

  it("stores only the measured token field and ignores invalid restored metadata", () => {
    // Independent wire: opaque field #1, then #5 { used_tokens: 42, max_tokens: 256 }.
    const tokens = Uint8Array.from([0x2a, 5, 8, 42, 16, 0x80, 2])
    setCheckpoint("conv", Uint8Array.from([10, 1, 120, ...tokens]))
    expect(getCheckpointOccupancy("conv")).toEqual(tokens)
    for (const invalid of [Uint8Array.of(0x28, 1), Uint8Array.of(0x2a, 2, 8, 0)]) {
      restoreCheckpointOccupancy("conv", invalid)
      expect(getCheckpointOccupancy("conv")).toEqual(tokens)
    }
    resetCheckpointsForTests()
    restoreCheckpointOccupancy("conv", tokens)
    expect(checkpointTokenDetails("conv", withTokens(0))).toEqual({ usedTokens: 42, maxTokens: 256 })
  })

  it("reads the occupancy of the checkpoint being sent", () => {
    setCheckpoint("conv-1", withTokens(30_000))
    expect(checkpointTokenDetails("conv-1", withTokens(42_000))).toEqual({ usedTokens: 42_000, maxTokens: 256_000 })
  })

  it("keeps the last measured occupancy when the checkpoint reports zero tokens", () => {
    setCheckpoint("conv-1", withTokens(42_000))
    const terminal = withTokens(0)
    setCheckpoint("conv-1", terminal)
    expect(getCheckpoint("conv-1")).toEqual(terminal)
    expect(checkpointTokenDetails("conv-1", terminal)).toEqual({ usedTokens: 42_000, maxTokens: 256_000 })
    expect(checkpointTokenDetails("conv-other", terminal)).toEqual({ usedTokens: 0, maxTokens: 256_000 })
  })

  it("forgets a conversation's occupancy with its checkpoint", () => {
    setCheckpoint("conv-1", withTokens(42_000))
    clearCheckpoint("conv-1")
    expect(checkpointTokenDetails("conv-1", withTokens(0))).toEqual({ usedTokens: 0, maxTokens: 256_000 })
  })

  it("leaves a checkpoint without token details undecoded", () => {
    setCheckpoint("conv-1", withTokens(42_000))
    expect(checkpointTokenDetails("conv-1", Uint8Array.from([0x0a, 0x01, 0x61]))).toBeUndefined()
    expect(checkpointTokenDetails("conv-1", undefined)).toBeUndefined()
  })
})

describe("buildRunRequest checkpoint echo", () => {
  beforeEach(() => resetCheckpointsForTests())

  it("echoes opaque conversationState bytes instead of inventing a seed", () => {
    // Arbitrary opaque checkpoint payload (CLI blob-ref structure, not our seed).
    const checkpoint = Uint8Array.from([0x0a, 0x20, ...Array(32).fill(0xab)])
    const data = buildRunRequest({
      text: "follow up",
      modelId: "m",
      conversationId: "c",
      conversationState: checkpoint,
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const state = decoded.run_request.conversation_state as Uint8Array
    expect(Buffer.from(state)).toEqual(Buffer.from(checkpoint))
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "follow up",
    )
  })

  it("carries seed history as prepended user turns, never in root_prompt_messages_json", () => {
    const data = buildRunRequest({
      text: "hi",
      modelId: "m",
      conversationId: "c",
      history: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "noted" },
      ],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    // A client root prompt stops Cursor rendering RequestContext rules.
    expect(cs.root_prompt_messages_json ?? []).toEqual([])
    const action = decoded.run_request.action.user_message_action
    expect(action.user_message.text).toBe("hi")
    expect(action.prepend_user_messages.map((part: { text: string }) => part.text)).toEqual([
      "[Earlier conversation, part 1 of 2]\n<conversation_history>\n<user>\nearlier\n</user>\n</conversation_history>",
      "[Earlier conversation, part 2 of 2]\n<conversation_history>\n<assistant>\nnoted\n</assistant>\n</conversation_history>",
    ])
  })

  it("keeps a checkpointed Run's user text free of seed history", () => {
    const data = buildRunRequest({
      text: "follow up",
      modelId: "m",
      conversationId: "c",
      conversationState: Uint8Array.from([0x0a, 0x01, 0x7f]),
      history: [{ role: "user", content: "earlier" }],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe("follow up")
    expect(decoded.run_request.action.user_message_action.prepend_user_messages ?? []).toEqual([])
  })

  it("encodes checkpoint recovery as ResumeAction without replaying user text", () => {
    const checkpoint = Uint8Array.from([0x0a, 0x01, 0x7f])
    const data = buildRunRequest({
      text: "must not be replayed",
      modelId: "m",
      conversationId: "c",
      conversationState: checkpoint,
      action: "resume",
    })
    const runRequest = decodeMessage<any>("AgentClientMessage", data).run_request

    expect(runRequest.action.resume_action).toEqual({ request_context: null })
    expect(runRequest.action.user_message_action).toBeUndefined()
    expect(Buffer.from(runRequest.conversation_state)).toEqual(Buffer.from(checkpoint))
    expect(runRequest.conversation_id).toBe("c")
  })
})
