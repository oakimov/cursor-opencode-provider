import { describe, it, expect } from "bun:test"
import { spanEndParts } from "../src/language-model.js"

describe("spanEndParts", () => {
  it("emits nothing when no spans are open", () => {
    expect(
      spanEndParts({
        textStarted: false,
        reasoningStarted: false,
        textId: "t",
        reasoningId: "r",
      }),
    ).toEqual([])
  })

  it("closes reasoning before text (required before finish)", () => {
    expect(
      spanEndParts({
        textStarted: true,
        reasoningStarted: true,
        textId: "text-1",
        reasoningId: "reasoning-1",
      }),
    ).toEqual([
      { type: "reasoning-end", id: "reasoning-1" },
      { type: "text-end", id: "text-1" },
    ])
  })

  it("closes only the open span", () => {
    expect(
      spanEndParts({
        textStarted: true,
        reasoningStarted: false,
        textId: "text-1",
        reasoningId: "reasoning-1",
      }),
    ).toEqual([{ type: "text-end", id: "text-1" }])

    expect(
      spanEndParts({
        textStarted: false,
        reasoningStarted: true,
        textId: "text-1",
        reasoningId: "reasoning-1",
      }),
    ).toEqual([{ type: "reasoning-end", id: "reasoning-1" }])
  })
})
