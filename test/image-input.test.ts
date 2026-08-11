import { describe, expect, it } from "bun:test"
import { UnsupportedFunctionalityError } from "@ai-sdk/provider"
import {
  assertCursorUserImageSupport,
  extractCursorHistoryImages,
  extractCursorPromptImages,
  extractCursorUserImages,
  hasCursorUserImages,
} from "../src/image-input.js"

describe("Cursor image input", () => {
  it("decodes OpenCode data-URL image file parts", async () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
        {
          type: "file",
          filename: "/tmp/example.png",
          mediaType: "image/png",
          data: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
        },
      ],
    }
    expect(hasCursorUserImages(message)).toBe(true)
    const images = await extractCursorUserImages(message)

    expect(images).toEqual([{
      data: Uint8Array.from([1, 2, 3]),
      filename: "example.png",
      mimeType: "image/png",
    }])
  })

  it("accepts byte data and infers wildcard image types", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const images = await extractCursorUserImages({
      role: "user",
      content: [{ type: "file", mediaType: "image/*", data: png }],
    })
    expect(images[0]?.mimeType).toBe("image/png")
    expect(images[0]?.filename).toBe("image-1")
  })

  it("rejects non-image files instead of silently dropping them", async () => {
    const promise = extractCursorUserImages({
      role: "user",
      content: [{ type: "file", mediaType: "application/pdf", data: "AA==" }],
    })
    expect(promise).rejects.toBeInstanceOf(UnsupportedFunctionalityError)
  })

  it("keeps user-supplied images loud on unsupported models", () => {
    const lastUser = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: "AQID" }],
    }
    expect(() => assertCursorUserImageSupport(lastUser, false, "text-only-model"))
      .toThrow(UnsupportedFunctionalityError)
  })

  it("harvests tool-result file-data images without losing text siblings", async () => {
    const result = await extractCursorHistoryImages([
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "cursor_session_1",
          toolName: "screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "captured" },
              { type: "file-data", mediaType: "image/png", data: "AQID" },
            ],
          },
        }],
      },
    ], { supportsImages: true })

    expect(result.candidateCount).toBe(1)
    expect(result.images).toEqual([{
      data: Uint8Array.from([1, 2, 3]),
      filename: "image-1",
      mimeType: "image/png",
    }])
  })

  it("harvests assistant history file parts", async () => {
    const result = await extractCursorHistoryImages([
      {
        role: "assistant",
        content: [{
          type: "file",
          filename: "captures/browser.jpg",
          mediaType: "image/jpeg",
          data: Uint8Array.from([0xff, 0xd8, 0xff]),
        }],
      },
    ], { supportsImages: true })

    expect(result.images[0]).toEqual({
      data: Uint8Array.from([0xff, 0xd8, 0xff]),
      filename: "browser.jpg",
      mimeType: "image/jpeg",
    })
  })

  it("ignores non-image history media", async () => {
    const result = await extractCursorHistoryImages([
      {
        role: "tool",
        content: [{
          type: "tool-result",
          output: {
            type: "content",
            value: [{ type: "file-data", mediaType: "application/pdf", data: "AQID" }],
          },
        }],
      },
      {
        role: "assistant",
        content: [{ type: "file", mediaType: "application/pdf", data: "AQID" }],
      },
    ], { supportsImages: true })

    expect(result).toEqual({ images: [], hashes: [], candidateCount: 0, duplicateCount: 0 })
  })

  it("drops tool-produced images without decoding when the model is unsupported", async () => {
    const result = await extractCursorHistoryImages([
      {
        role: "tool",
        content: [{
          type: "tool-result",
          output: {
            type: "content",
            value: [{ type: "file-data", mediaType: "image/png", data: { invalid: true } }],
          },
        }],
      },
    ], { supportsImages: false })

    expect(result).toEqual({ images: [], hashes: [], candidateCount: 1, duplicateCount: 0 })
  })

  it("deduplicates history images by decoded content hash", async () => {
    const prompt = [{
      role: "tool",
      content: [{
        type: "tool-result",
        output: {
          type: "content",
          value: [{ type: "file-data", mediaType: "image/png", data: "AQID" }],
        },
      }],
    }]
    const first = await extractCursorHistoryImages(prompt, { supportsImages: true })
    const second = await extractCursorHistoryImages(prompt, {
      supportsImages: true,
      seenHashes: new Set(first.hashes),
    })

    expect(first.images).toHaveLength(1)
    expect(second.images).toEqual([])
    expect(second.duplicateCount).toBe(1)
  })

  it("enforces one combined byte budget across user and history images", async () => {
    const lastUser = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: "AQI=" }],
    }
    const prompt = [
      {
        role: "tool",
        content: [{
          type: "tool-result",
          output: {
            type: "content",
            value: [{ type: "file-data", mediaType: "image/png", data: "AwQ=" }],
          },
        }],
      },
      lastUser,
    ]

    expect(extractCursorPromptImages(prompt, lastUser, {
      supportsImages: true,
      maxBytes: 3,
    })).rejects.toBeInstanceOf(UnsupportedFunctionalityError)
  })
})
