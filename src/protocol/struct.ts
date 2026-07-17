// Minimal encoder for google.protobuf.Value / Struct / ListValue.
//
// Cursor's per-turn tool descriptors carry the tool `input_schema` (a JSON
// Schema object) as a `google.protobuf.Value` whose `struct_value` holds the
// schema — NOT a JSON string. Verified against a live capture
// (request_context #7 → McpToolDefinition #3):
//   2a 9a07  0a10 0a04 74797065 1208 1a06 6f626a656374 ...
//   = Value{#5 struct_value: Struct{#1 fields: {"type": Value{#3 string "object"}}}}
//
// Field numbers (well-known types):
//   Value:     1 null_value, 2 number_value(double), 3 string_value,
//              4 bool_value, 5 struct_value(Struct), 6 list_value(ListValue)
//   Struct:    1 fields (map<string, Value>) — each entry msg{1 key, 2 value}
//   ListValue: 1 values (repeated Value)

function writeVarint(out: number[], n: number): void {
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
}

function writeTag(out: number[], field: number, wire: number): void {
  writeVarint(out, (field << 3) | wire)
}

function writeLengthDelimited(out: number[], field: number, bytes: Uint8Array): void {
  writeTag(out, field, 2)
  writeVarint(out, bytes.length)
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}

function writeString(out: number[], field: number, str: string): void {
  writeLengthDelimited(out, field, new TextEncoder().encode(str))
}

function writeDouble(out: number[], field: number, num: number): void {
  writeTag(out, field, 1) // 64-bit
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, num, true) // little-endian
  const view = new Uint8Array(buf)
  for (let i = 0; i < 8; i++) out.push(view[i])
}

// ── Decoding (reverse): google.protobuf.Value bytes → JSON ──

export type RawField = { fn: number; wt: number; varint: number; bytes?: Uint8Array; i64?: Uint8Array }

function readVarintAt(b: Uint8Array, i: number): [number, number] {
  let r = 0, s = 0
  while (i < b.length) {
    const x = b[i++]
    r |= (x & 0x7f) << s
    if (!(x & 0x80)) break
    s += 7
  }
  return [r >>> 0, i]
}

/** Walk a protobuf message's top-level fields off the raw wire bytes. */
export function readAllFields(b: Uint8Array): RawField[] {
  let i = 0
  const out: RawField[] = []
  while (i < b.length) {
    let key: number
    ;[key, i] = readVarintAt(b, i)
    const fn = key >>> 3, wt = key & 7
    if (wt === 0) {
      let v: number
      ;[v, i] = readVarintAt(b, i)
      out.push({ fn, wt, varint: v })
    } else if (wt === 2) {
      let len: number
      ;[len, i] = readVarintAt(b, i)
      out.push({ fn, wt, varint: 0, bytes: b.subarray(i, i + len) })
      i += len
    } else if (wt === 1) {
      out.push({ fn, wt, varint: 0, i64: b.subarray(i, i + 8) })
      i += 8
    } else if (wt === 5) {
      i += 4 // i32 — not used by Value
    } else break
  }
  return out
}

function decodeStructBytes(b: Uint8Array): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const f of readAllFields(b)) {
    if (f.fn !== 1 || !f.bytes) continue // Struct.fields (map) entries
    const { key, valBytes } = readMapEntry(f.bytes)
    if (key !== undefined) obj[key] = valBytes ? decodeValueToJson(valBytes) : null
  }
  return obj
}

function decodeListBytes(b: Uint8Array): unknown[] {
  const arr: unknown[] = []
  for (const f of readAllFields(b)) {
    if (f.fn === 1 && f.bytes) arr.push(decodeValueToJson(f.bytes))
  }
  return arr
}

function readMapEntry(b: Uint8Array): { key?: string; valBytes?: Uint8Array } {
  let key: string | undefined
  let valBytes: Uint8Array | undefined
  for (const e of readAllFields(b)) {
    if (e.fn === 1 && e.bytes) key = new TextDecoder().decode(e.bytes)
    else if (e.fn === 2 && e.bytes) valBytes = e.bytes
  }
  return { key, valBytes }
}

/** Decode a google.protobuf.Value message (bytes) back into a JSON value. */
export function decodeValueToJson(bytes: Uint8Array): unknown {
  const fs = readAllFields(bytes)
  if (fs.length === 0) return null
  const f = fs[0]
  switch (f.fn) {
    case 1: return null // null_value
    case 2: return f.i64 ? new DataView(f.i64.buffer, f.i64.byteOffset, 8).getFloat64(0, true) : 0
    case 3: return f.bytes ? new TextDecoder().decode(f.bytes) : ""
    case 4: return f.varint !== 0
    case 5: return f.bytes ? decodeStructBytes(f.bytes) : {}
    case 6: return f.bytes ? decodeListBytes(f.bytes) : []
    default: return null
  }
}

/**
 * Decode a `map<string, Value>` field that was captured as repeated map-entry
 * messages (each `{1 key, 2 value}`) into a plain JSON object. Used for
 * `McpArgs.args`, which arrives as repeated field #2 on the wire.
 */
export function decodeStructEntriesToJson(entries: Uint8Array[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const entry of entries) {
    const { key, valBytes } = readMapEntry(entry)
    if (key !== undefined) obj[key] = valBytes ? decodeValueToJson(valBytes) : null
  }
  return obj
}

/** Encode an arbitrary JSON value as google.protobuf.Value bytes. */
export function encodeJsonAsValue(v: unknown): Uint8Array {
  const out: number[] = []
  if (v === null || v === undefined) {
    writeTag(out, 1, 0) // null_value = 0
    writeVarint(out, 0)
  } else if (typeof v === "number") {
    writeDouble(out, 2, v)
  } else if (typeof v === "boolean") {
    writeTag(out, 4, 0)
    writeVarint(out, v ? 1 : 0)
  } else if (typeof v === "string") {
    writeString(out, 3, v)
  } else if (Array.isArray(v)) {
    const lv: number[] = []
    for (const item of v) writeLengthDelimited(lv, 1, encodeJsonAsValue(item))
    writeLengthDelimited(out, 6, new Uint8Array(lv))
  } else if (typeof v === "object") {
    const st: number[] = []
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue
      const entry: number[] = []
      writeString(entry, 1, key)
      writeLengthDelimited(entry, 2, encodeJsonAsValue(val))
      writeLengthDelimited(st, 1, new Uint8Array(entry))
    }
    writeLengthDelimited(out, 5, new Uint8Array(st))
  } else {
    // Fallback: treat as null.
    writeTag(out, 1, 0)
    writeVarint(out, 0)
  }
  return new Uint8Array(out)
}
