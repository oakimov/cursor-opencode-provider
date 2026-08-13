import { describe, expect, it } from "bun:test"
import { encodeMessage } from "../src/protocol/messages.js"
import {
  cursorContextUsageMetadata,
  decodeConversationTokenDetails,
} from "../src/protocol/token-details.js"

function checkpoint(): Uint8Array {
  return encodeMessage("ConversationStateStructure", {
    token_details: {
      used_tokens: 130_915,
      max_tokens: 256_000,
      breakdown: {
        total_used_tokens: 130_915,
        max_tokens: 256_000,
        categories: [
          {
            id: "system_prompt",
            label: "System prompt",
            estimated_tokens: 14_976,
            character_count: 59_904,
          },
          {
            id: "summarized_conversation",
            label: "Summarized conversation",
            estimated_tokens: 22_000,
          },
        ],
      },
    },
  })
}

describe("Cursor checkpoint tokenDetails", () => {
  it("decodes authoritative occupancy and its prompt-category breakdown", () => {
    expect(decodeConversationTokenDetails(checkpoint())).toEqual({
      usedTokens: 130_915,
      maxTokens: 256_000,
      breakdown: {
        totalUsedTokens: 130_915,
        maxTokens: 256_000,
        categories: [
          {
            id: "system_prompt",
            label: "System prompt",
            estimatedTokens: 14_976,
            characterCount: 59_904,
          },
          {
            id: "summarized_conversation",
            label: "Summarized conversation",
            estimatedTokens: 22_000,
          },
        ],
      },
    })
  })

  it("returns no data for absent or malformed field #5 without changing transport state", () => {
    const opaque = encodeMessage("ConversationStateStructure", {
      root_prompt_messages_json: ["opaque transport remains independent"],
    })
    const before = Uint8Array.from(opaque)
    expect(decodeConversationTokenDetails(opaque)).toBeUndefined()
    expect(opaque).toEqual(before)
    expect(decodeConversationTokenDetails(Uint8Array.from([0x28, 0x01]))).toBeUndefined()
  })

  it("derives display metadata from Cursor's context snapshot", () => {
    const details = decodeConversationTokenDetails(checkpoint())!
    expect(cursorContextUsageMetadata(details)).toEqual({
      contextUsageVersion: 2,
      source: "checkpoint-current-run",
      stale: false,
      usedTokens: 130_915,
      maxTokens: 256_000,
      remainingTokens: 125_085,
      usedPercent: 51.1,
      breakdown: details.breakdown,
    })
    expect(cursorContextUsageMetadata(details, "checkpoint-previous-turn")).toMatchObject({
      contextUsageVersion: 2,
      source: "checkpoint-previous-turn",
      stale: true,
      usedTokens: 130_915,
    })
  })
})
