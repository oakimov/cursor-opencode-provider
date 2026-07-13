import { describe, it, expect } from "bun:test"
import { encodeJsonAsValue, decodeValueToJson } from "../src/protocol/struct.js"

// Minimal google.protobuf.Value decoder for verification.
function readVarint(b: Uint8Array, i: number): [number, number] {
  let r = 0, s = 0
  while (true) {
    const x = b[i++]
    r |= (x & 0x7f) << s
    if (!(x & 0x80)) break
    s += 7
  }
  return [r >>> 0, i]
}

function fields(b: Uint8Array): Array<[number, number, Uint8Array | number]> {
  let i = 0
  const out: Array<[number, number, Uint8Array | number]> = []
  while (i < b.length) {
    let key: number
    ;[key, i] = readVarint(b, i)
    const fn = key >> 3, wt = key & 7
    if (wt === 0) {
      let v: number
      ;[v, i] = readVarint(b, i)
      out.push([fn, wt, v])
    } else if (wt === 2) {
      let ln: number
      ;[ln, i] = readVarint(b, i)
      out.push([fn, wt, b.subarray(i, i + ln)])
      i += ln
    } else if (wt === 1) {
      out.push([fn, wt, b.subarray(i, i + 8)])
      i += 8
    } else throw new Error("unsupported wire type " + wt)
  }
  return out
}

function decodeValue(b: Uint8Array): unknown {
  const fs = fields(b)
  if (fs.length === 0) return null
  const [fn, wt, v] = fs[0]
  if (fn === 1) return null
  if (fn === 2) return new DataView((v as Uint8Array).buffer, (v as Uint8Array).byteOffset, 8).getFloat64(0, true)
  if (fn === 3) return new TextDecoder().decode(v as Uint8Array)
  if (fn === 4) return (v as number) !== 0
  if (fn === 5) {
    // struct: field 1 repeated entries {1 key, 2 value}
    const obj: Record<string, unknown> = {}
    for (const [efn, , ev] of fields(v as Uint8Array)) {
      if (efn !== 1) continue
      const entry = fields(ev as Uint8Array)
      const key = new TextDecoder().decode(entry.find((x) => x[0] === 1)![2] as Uint8Array)
      const valBytes = entry.find((x) => x[0] === 2)?.[2] as Uint8Array | undefined
      obj[key] = valBytes ? decodeValue(valBytes) : null
    }
    return obj
  }
  if (fn === 6) {
    const arr: unknown[] = []
    for (const [lfn, , lv] of fields(v as Uint8Array)) {
      if (lfn === 1) arr.push(decodeValue(lv as Uint8Array))
    }
    return arr
  }
  return null
}

describe("encodeJsonAsValue", () => {
  it("wraps an object as struct_value (field 5)", () => {
    const bytes = encodeJsonAsValue({ type: "object" })
    expect(bytes[0]).toBe(0x2a) // (5 << 3) | 2
  })

  it("round-trips a JSON Schema object", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string", description: "the path" },
        count: { type: "number" },
        deep: { enabled: true, items: ["a", "b"] },
      },
      required: ["path"],
    }
    const decoded = decodeValue(encodeJsonAsValue(schema))
    expect(decoded).toEqual(schema)
  })

  it("round-trips scalars and null", () => {
    expect(decodeValue(encodeJsonAsValue("hi"))).toBe("hi")
    expect(decodeValue(encodeJsonAsValue(42))).toBe(42)
    expect(decodeValue(encodeJsonAsValue(true))).toBe(true)
    expect(decodeValue(encodeJsonAsValue(null))).toBe(null)
    expect(decodeValue(encodeJsonAsValue(["x", 1]))).toEqual(["x", 1])
  })
})

describe("decodeValueToJson (production decoder)", () => {
  it("round-trips a nested object through encode → decode", () => {
    const obj = {
      pattern: "TODO",
      limit: 5,
      nested: { enabled: true, tags: ["a", "b"], missing: null },
    }
    expect(decodeValueToJson(encodeJsonAsValue(obj))).toEqual(obj)
  })

  it("round-trips scalars", () => {
    expect(decodeValueToJson(encodeJsonAsValue("s"))).toBe("s")
    expect(decodeValueToJson(encodeJsonAsValue(3.5))).toBe(3.5)
    expect(decodeValueToJson(encodeJsonAsValue(false))).toBe(false)
    expect(decodeValueToJson(encodeJsonAsValue(null))).toBe(null)
  })
})
