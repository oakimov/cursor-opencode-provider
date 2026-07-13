import { describe, it, expect } from "bun:test"
import { encodeFrame, decodeFramePayload, streamFrames, FLAG_GZIP } from "../src/protocol/framing.js"

describe("encodeFrame", () => {
  it("encodes a simple frame", () => {
    const payload = new Uint8Array([1, 2, 3])
    const frame = encodeFrame(0, payload)
    expect(frame[0]).toBe(0) // flags
    expect(frame[1]).toBe(0) // length high
    expect(frame[2]).toBe(0)
    expect(frame[3]).toBe(0)
    expect(frame[4]).toBe(3) // length low
    expect(frame.subarray(5)).toEqual(payload)
  })

  it("sets gzip flag when requested", () => {
    const payload = new Uint8Array([1, 2, 3])
    const frame = encodeFrame(FLAG_GZIP, payload)
    expect(frame[0]).toBe(FLAG_GZIP)
    // payload should be gzipped, longer than 3 bytes
    expect(frame.length).toBeGreaterThan(8)
  })
})

describe("decodeFramePayload", () => {
  it("returns payload as-is for unencoded frames", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const decoded = decodeFramePayload({ flags: 0, payload })
    expect(decoded).toEqual(payload)
  })

  it("decompresses gzipped payload", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5])
    const encoded = encodeFrame(FLAG_GZIP, original)
    const frame = Array.from(streamFrames(encoded))[0]
    const decoded = decodeFramePayload(frame)
    expect(decoded).toEqual(original)
  })
})

describe("streamFrames", () => {
  it("parses a single frame", () => {
    const payload = new Uint8Array([10, 20, 30])
    const data = encodeFrame(0, payload)
    const frames = Array.from(streamFrames(data))
    expect(frames).toHaveLength(1)
    expect(frames[0].flags).toBe(0)
    expect(frames[0].payload).toEqual(payload)
  })

  it("parses multiple frames in one buffer", () => {
    const p1 = new Uint8Array([1])
    const p2 = new Uint8Array([2, 2])
    const data = new Uint8Array([...encodeFrame(0, p1), ...encodeFrame(0, p2)])
    const frames = Array.from(streamFrames(data))
    expect(frames).toHaveLength(2)
    expect(frames[0].payload).toEqual(p1)
    expect(frames[1].payload).toEqual(p2)
  })

  it("handles split chunks (incomplete frame)", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const full = encodeFrame(0, payload)
    // Only give first 7 bytes (5 header + 2 payload) — incomplete
    const partial = full.subarray(0, 7)
    const frames = Array.from(streamFrames(partial))
    expect(frames).toHaveLength(0)
  })

  it("yields complete frame from buffer with trailing data", () => {
    const payload = new Uint8Array([1, 2, 3])
    const full = encodeFrame(0, payload)
    // Append extra byte
    const withExtra = new Uint8Array([...full, 99])
    const frames = Array.from(streamFrames(withExtra))
    expect(frames).toHaveLength(1)
    expect(frames[0].payload).toEqual(payload)
  })

  it("skips frames where length exceeds remaining buffer", () => {
    // Buffer with a valid frame followed by truncated frame
    const p1 = new Uint8Array([1, 2, 3])
    const f1 = encodeFrame(0, p1)

    // Second frame with header claiming 100 bytes but buffer is too short
    const partialHeader = new Uint8Array([0, 0, 0, 0, 100])
    const data = new Uint8Array([...f1, ...partialHeader])

    const frames = Array.from(streamFrames(data))
    expect(frames).toHaveLength(1)
    expect(frames[0].payload).toEqual(p1)
  })
})

describe("encodeFrame round-trip", () => {
  it("encode → streamFrames → decode gives original data", () => {
    const original = new TextEncoder().encode("Hello, Cursor!")
    const encoded = encodeFrame(0, original)
    const frames = Array.from(streamFrames(encoded))
    expect(frames).toHaveLength(1)

    const decoded = decodeFramePayload(frames[0])
    expect(decoded).toEqual(original)
    expect(new TextDecoder().decode(decoded)).toBe("Hello, Cursor!")
  })

  it("gzip round-trip", () => {
    const original = new TextEncoder().encode("x".repeat(1000))
    const encoded = encodeFrame(FLAG_GZIP, original)
    expect(encoded.length).toBeLessThan(original.length + 100) // gzip should compress

    const frames = Array.from(streamFrames(encoded))
    const decoded = decodeFramePayload(frames[0])
    expect(decoded).toEqual(original)
  })
})
