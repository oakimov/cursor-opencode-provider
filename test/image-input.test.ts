import { describe, expect, it } from "bun:test"
import { pathToFileURL } from "node:url"
import { UnsupportedFunctionalityError } from "@ai-sdk/provider"
import {
  extractCursorHistoryImages,
  extractCursorPromptImages,
  extractCursorToolResultImages,
  extractCursorUserImages,
} from "../src/image-input.js"

describe("tool-result images", () => {
  it("accepts AI SDK image-url parts with no mediaType", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const part = { type: "image-url", url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` }
    expect((await extractCursorToolResultImages([part])).images[0]?.data).toEqual(bytes)
    const history = [{ role: "tool", content: [{ type: "tool-result", output: { type: "content", value: [part] } }] }]
    expect((await extractCursorHistoryImages(history)).images[0]?.data).toEqual(bytes)
  })

  it("keeps decoding later images after a file attachment disappears", async () => {
    const result = await extractCursorToolResultImages([
      { type: "file", mediaType: "image/png", data: pathToFileURL("/nonexistent/cursor-review-image.png") },
      { type: "file-data", mediaType: "image/png", data: "AQID" },
    ])
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.data).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("recovers readable tool images when another historical attachment disappears", async () => {
    const history = [{ role: "tool", content: [{ type: "tool-result", output: { type: "content", value: [
      { type: "file", mediaType: "image/png", data: pathToFileURL("/nonexistent/cursor-review-image.png") },
      { type: "image-data", mediaType: "image/png", data: "AQID" },
    ] } }] }]
    const result = await extractCursorHistoryImages(history)
    expect(result.images).toHaveLength(1)
    expect(result.omittedCount).toBe(1)
  })

  it("honors cancellation even for inline tool media", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(extractCursorToolResultImages([
      { type: "file-data", mediaType: "image/png", data: "AQID" },
    ], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  })

  it("harvests every supported tool media shape on a recovery Run", async () => {
    const result = await extractCursorHistoryImages([{
      role: "tool", content: [{ type: "tool-result", output: {
        type: "content", value: [
          { type: "media", mediaType: "image/png", data: "AQID" },
          { type: "image-data", mediaType: "image/png", data: "BAUG" },
          { type: "file", mime: "image/png", uri: "data:image/png;base64,BwgJ" },
        ],
      } }],
    }])
    expect(result.images.map(image => [...image.data])).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
  })

  it("decodes historical OpenCode 1 caption URLs after a new user turn", async () => {
    const result = await extractCursorHistoryImages([
      { role: "user", content: [
        { type: "text", text: "Attached media from tool result:" },
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,AQID" },
      ] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ])
    expect(result.images[0]?.data).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("decodes the last media caption when a dead Run is rebased", async () => {
    const caption = { role: "user", content: [
      { type: "text", text: "Attached media from tool result:" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AQID" },
    ] }
    const result = await extractCursorPromptImages([caption], caption)
    expect(result.images[0]?.data).toEqual(Uint8Array.from([1, 2, 3]))
    expect(result.hashes).toHaveLength(1)
    const seenHistoryHashes = new Set(result.hashes)
    const repeated = await extractCursorPromptImages([caption], caption, { seenHistoryHashes })
    expect(repeated.images).toEqual([])
    expect(repeated.duplicateCount).toBe(1)
    const nextUser = { role: "user", content: [{ type: "text", text: "continue" }] }
    const nextTurn = await extractCursorPromptImages([caption, nextUser], nextUser, { seenHistoryHashes })
    expect(nextTurn.images).toEqual([])
    // Explicit attachments retain user intent even when their bytes were sent earlier.
    const explicit = { role: "user", content: [{ type: "file", mediaType: "image/png", data: "AQID" }] }
    expect((await extractCursorPromptImages([explicit], explicit, { seenHistoryHashes })).images).toHaveLength(1)
  })

  it("reports an explicit attachment's hash, so the next turn can skip it as history", async () => {
    const attached = { role: "user", content: [{ type: "text", text: "look" }, { type: "file", mediaType: "image/png", data: "AQID" }] }
    const sent = await extractCursorPromptImages([attached], attached)
    expect(sent.images).toHaveLength(1)
    expect(sent.hashes).toHaveLength(1)

    const nextUser = { role: "user", content: [{ type: "text", text: "and now?" }] }
    const next = await extractCursorPromptImages([attached, nextUser], nextUser, {
      seenHistoryHashes: new Set(sent.hashes),
    })
    expect(next.images).toEqual([])
    expect(next.duplicateCount).toBe(1)
  })

  it("deduplicates multiple detached caption parts in a recovery Run", async () => {
    const file = { type: "file", mediaType: "image/png", data: "AQID" }
    const caption = { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, file, file] }
    const result = await extractCursorPromptImages([caption], caption)
    expect(result.images).toHaveLength(1)
    expect(result.hashes).toHaveLength(1)
    expect(result.duplicateCount).toBe(1)
  })

  it("decodes host tool media and skips non-image or undecodable parts", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString("base64")
    const { images, hashes } = await extractCursorToolResultImages([
      { type: "file", mediaType: "image/png", data: `data:image/png;base64,${png}`, filename: "/work/badge.png" },
      { type: "file-data", mediaType: "image/png", data: png },
      // OpenCode 1 synthetic attachments carry the bytes on `url`, not `data`.
      { type: "file", mediaType: "image/png", url: `data:image/png;base64,${png}`, filename: "oc1.png" },
      // OpenCode 1 toModelOutput keeps attachments as `type: "media"`.
      { type: "media", mediaType: "image/png", data: png, filename: "oc1-media.png" },
      // OpenCode 2 host/MCP projection uses `mime` + `uri`.
      { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}`, filename: "oc2.png" },
      { type: "file", mediaType: "application/pdf", data: png },
      { type: "file", mediaType: "image/png", data: "not base64!" },
      { type: "text", text: "Image read successfully" },
    ])
    expect(images.map((image) => image.filename)).toEqual([
      "badge.png",
      "image-2",
      "oc1.png",
      "oc1-media.png",
      "oc2.png",
    ])
    expect(images.every((image) => image.mimeType === "image/png" && image.data.length === 9)).toBe(true)
    expect(hashes).toHaveLength(5)
    expect(new Set(hashes).size).toBe(1)
  })
})

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
    const images = await extractCursorUserImages(message)

    expect(images).toEqual([{
      data: Uint8Array.from([1, 2, 3]),
      filename: "example.png",
      mimeType: "image/png",
    }])
  })

  it("parses data-URL parameters in linear delimiter passes", async () => {
    const images = await extractCursorUserImages({
      role: "user",
      content: [{
        type: "file",
        mediaType: "image/png",
        data: "data:image/png;charset=utf-8;base64,AQID",
      }],
    })
    expect(images[0]?.data).toEqual(Uint8Array.from([1, 2, 3]))

    const malformed = extractCursorUserImages({
      role: "user",
      content: [{
        type: "file",
        mediaType: "image/png",
        data: `data:;${";".repeat(100_000)},AQID`,
      }],
    })
    expect(malformed).rejects.toBeInstanceOf(UnsupportedFunctionalityError)
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
    ])

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
    ])

    expect(result.images[0]).toEqual({
      data: Uint8Array.from([0xff, 0xd8, 0xff]),
      filename: "browser.jpg",
      mimeType: "image/jpeg",
    })
  })

  it("harvests historical user file images after a later text-only user turn", async () => {
    const prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "archive" },
          { type: "file", mediaType: "image/png", data: Uint8Array.from([1, 2, 3]) },
          { type: "file", mediaType: "image/png", data: Uint8Array.from([4, 5, 6]) },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "next turn" }],
      },
    ]

    const result = await extractCursorPromptImages(
      prompt,
      prompt[1] as Record<string, unknown>,
    )

    expect(result.images).toEqual([
      { data: Uint8Array.from([1, 2, 3]), filename: "image-1", mimeType: "image/png" },
      { data: Uint8Array.from([4, 5, 6]), filename: "image-2", mimeType: "image/png" },
    ])
    expect(result.hashes).toHaveLength(2)
  })

  it("keeps last-user images owned by user extraction when the same bytes also appear earlier", async () => {
    const bytes = Uint8Array.from([9, 8, 7])
    const lastUser = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: bytes }],
    }
    const prompt = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: bytes }],
      },
      lastUser,
    ]

    const result = await extractCursorPromptImages(prompt, lastUser)

    expect(result.images).toEqual([
      { data: bytes, filename: "image-1", mimeType: "image/png" },
    ])
    expect(result.duplicateCount).toBe(1)
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
    ])

    expect(result).toEqual({ images: [], hashes: [], duplicateCount: 0 })
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
    const first = await extractCursorHistoryImages(prompt)
    const second = await extractCursorHistoryImages(prompt, {
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
      maxBytes: 3,
    })).rejects.toBeInstanceOf(UnsupportedFunctionalityError)
  })
})
