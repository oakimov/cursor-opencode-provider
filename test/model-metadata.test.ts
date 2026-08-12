import { describe, expect, it } from "bun:test"
import { buildCapabilityTable, buildContextTable } from "../scripts/generate-cursor-pricing.js"
import {
  getDocumentedCursorModelCapabilities,
  getDocumentedCursorModelContext,
  resolveCursorModelSupportsImages,
} from "../src/model-metadata.js"

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
    expect(buildCapabilityTable(markdown)).toEqual({
      "claude-sonnet-4": { supportsImages: false },
      "default": { supportsImages: false },
      "gpt-5.2": { supportsImages: true },
      "grok-4.5": { supportsImages: false },
      "grok-4.6": { supportsImages: false },
    })
  })

  it("exposes generated context metadata without mutable shared state", () => {
    const context = getDocumentedCursorModelContext("grok-4.5")
    expect(context).toEqual({ maxContext: 256_000 })
    context!.maxContext = 1
    expect(getDocumentedCursorModelContext("grok-4.5")).toEqual({ maxContext: 256_000 })
    expect(getDocumentedCursorModelContext("grok-4.6")).toEqual({ maxContext: 256_000 })
  })

  it("uses AvailableModels before docs and defaults unknown models to text", () => {
    expect(getDocumentedCursorModelCapabilities("gpt-5.2")).toEqual({ supportsImages: true })
    expect(resolveCursorModelSupportsImages("gpt-5.2")).toBe(true)
    expect(resolveCursorModelSupportsImages("gpt-5.2", false)).toBe(false)
    expect(resolveCursorModelSupportsImages("grok-4.5", true)).toBe(true)
    expect(resolveCursorModelSupportsImages("grok-4.6")).toBe(false)
    expect(resolveCursorModelSupportsImages("unknown-model")).toBe(false)
  })
})
