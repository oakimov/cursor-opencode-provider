import { describe, expect, it } from "bun:test"
import { buildContextTable } from "../scripts/generate-cursor-pricing.js"
import { getDocumentedCursorModelContext } from "../src/model-metadata.js"

describe("Cursor model context metadata", () => {
  it("parses and merges the published default and max context rows", () => {
    const markdown = `
| Model | Provider | Default context | Max context | Capabilities | Notes |
| --- | --- | --- | --- | --- | --- |
| Auto Cost | Cursor | - | - | Agent | - |
| [Claude 4 Sonnet](https://example.com/sonnet) | Anthropic | 200k | - | Agent | - |
| [Claude 4 Sonnet 1M](https://example.com/sonnet) | Anthropic | - | 1M | Agent | - |
| Composer 1 | Cursor | 200k | - | Agent | Hidden |
| Grok 4.5 | Cursor | 256k | - | Agent, Thinking | - |
| Grok 4.6 | Cursor | 256k | - | Agent, Thinking | 50% launch discount |
| GPT-5.2 | OpenAI | 272k | - | Agent, Thinking, Images | - |
`

    expect(buildContextTable(markdown)).toEqual({
      "claude-sonnet-4": {
        maxContext: 200_000,
        maxContextForMaxMode: 1_000_000,
      },
      "grok-4.5": { maxContext: 256_000 },
      "grok-4.6": { maxContext: 256_000 },
      "gpt-5.2": { maxContext: 272_000 },
    })
  })

  it("exposes generated context metadata without mutable shared state", () => {
    const context = getDocumentedCursorModelContext("grok-4.5")
    expect(context).toEqual({ maxContext: 256_000 })
    context!.maxContext = 1
    expect(getDocumentedCursorModelContext("grok-4.5")).toEqual({ maxContext: 256_000 })
    expect(getDocumentedCursorModelContext("grok-4.6")).toEqual({ maxContext: 256_000 })
  })
})
