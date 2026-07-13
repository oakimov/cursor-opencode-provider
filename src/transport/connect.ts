import { CURSOR_API_HOST, CURSOR_AGENT_HOST, CURSOR_CLIENT_VERSION, CONNECT_PROTOCOL_VERSION } from "../shared.js"
import { encodeFrame, streamFrames } from "../protocol/framing.js"
import { createCursorChecksumHeader } from "../protocol/checksum.js"
import { getDeviceIds } from "../protocol/device-id.js"
import http2 from "node:http2"
import fs from "node:fs"

const API_BASE = `https://${CURSOR_API_HOST}`
const AGENT = CURSOR_AGENT_HOST

// Wire-level diagnostics. Opt in with CURSOR_PROVIDER_DEBUG=1 (or "true").
// Writes to CURSOR_PROVIDER_DEBUG_FILE (default /tmp/cursor-provider-debug.log).
// Truncated once per process. Captures h2 response status, parsed frames, and
// stream errors. Tokens / checksums are redacted in header dumps.
const DEBUG_ENABLED =
  process.env.CURSOR_PROVIDER_DEBUG === "1" ||
  process.env.CURSOR_PROVIDER_DEBUG === "true"
const DEBUG_FILE = process.env.CURSOR_PROVIDER_DEBUG_FILE || "/tmp/cursor-provider-debug.log"
let _traceInitialized = false
export function trace(msg: string): void {
  if (!DEBUG_ENABLED) return
  try {
    if (!_traceInitialized) {
      _traceInitialized = true
      fs.writeFileSync(
        DEBUG_FILE,
        `--- cursor-provider debug (pid ${process.pid}) ${new Date().toISOString()} ---\n`,
      )
    }
    fs.appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch { /* ignore */ }
}
trace("connect.ts module loaded")

function buildBaseHeaders(token: string): Record<string, string> {
  const { machineId, macMachineId } = getDeviceIds()
  return {
    authorization: `Bearer ${token}`,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    "x-ghost-mode": "true",
    "x-request-id": crypto.randomUUID(),
  }
}

// ── Unary (AvailableModels) ──

export async function unaryAvailableModels(token: string): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/aiserver.v1.AiService/AvailableModels`
  const headers = buildBaseHeaders(token)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`AvailableModels failed: ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`)
  }

  return (await res.json()) as Record<string, unknown>
}

// ── Bidi (Run stream) ──

export type BidiStream = {
  write(msg: Uint8Array): void
  end(): void
  frames(): AsyncIterable<{ flags: number; payload: Uint8Array }>
  destroy(): void
}

// Cache http2 session per host (lazy connect)
let _http2Session: http2.ClientHttp2Session | null = null

function getSession(): Promise<http2.ClientHttp2Session> {
  if (_http2Session && !_http2Session.destroyed) {
    return Promise.resolve(_http2Session)
  }
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${AGENT}`)
    session.on("error", reject)
    session.on("connect", () => {
      _http2Session = session
      resolve(session)
    })
  })
}

export async function bidiRunStream(token: string, signal?: AbortSignal): Promise<BidiStream> {
  const session = await getSession()
  const headers = {
    ...buildBaseHeaders(token),
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
    "connect-accept-encoding": "gzip,br",
    // The CLI's streaming interceptor sets this on the bidi Run stream
    // (decompiled client.ts:1190). Without it Cursor may treat the stream as
    // non-streaming.
    "x-cursor-streaming": "true",
    "user-agent": "connect-es/1.6.1",
  }

  const stream = session.request(headers as unknown as http2.OutgoingHttpHeaders, {
    endStream: false,
  })

  let writable = true
  let closed = false
  let responseStatus = 0
  let responseHeaders: Record<string, unknown> = {}
  let streamError: Error | null = null

  // Capture the HTTP/2 response status/headers and any stream-level error.
  // Without this, a non-200 or RST_STREAM surfaces as a silent clean end
  // (frames() just stops) — which looks exactly like "no response, no error".
  stream.on("response", (h: Record<string, unknown>) => {
    responseHeaders = h
    responseStatus = h[":status"] !== undefined ? Number(h[":status"]) : 0
    trace(`h2 response: status=${responseStatus} headers=${JSON.stringify(stripPseudo(h))}`)
  })
  stream.on("error", (err: Error) => {
    streamError = err
    trace(`h2 stream error: ${err?.name}: ${err?.message}`)
  })
  stream.on("close", () => trace(`h2 stream closed (status=${responseStatus}, err=${streamError?.message ?? "none"})`))

  if (signal) {
    signal.addEventListener("abort", () => {
      if (!closed) {
        closed = true
        writable = false
        stream.close()
      }
    }, { once: true })
  }

  return {
    write(msg: Uint8Array) {
      if (!writable) throw new Error("Stream not writable")
      const frame = encodeFrame(0x00, msg)
      stream.write(frame)
    },
    end() {
      writable = false
      stream.end()
    },
    async *frames() {
      const buffer: Uint8Array[] = []

      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (closed) return

        buffer.push(new Uint8Array(buf))

        // Try to parse frames from accumulated data
        const merged = mergeBuffers(buffer)
        const parsed = Array.from(streamFrames(merged))

        if (parsed.length > 0) {
          const consumed = parsed.reduce((sum, f) => sum + 5 + f.payload.length, 0)

          // Only clear if we fully consumed all pending data
          if (consumed === merged.length) {
            buffer.length = 0
          } else {
            buffer.length = 0
            buffer.push(merged.subarray(consumed))
          }

          for (const frame of parsed) {
            trace(`frame yield: flags=0x${frame.flags.toString(16)} payload=${frame.payload.length}B`)
            yield frame
          }
        }
      }

      closed = true

      // Surface connection-level failures instead of ending silently. A
      // non-200, a Connect error in the trailers, or an RST_STREAM would
      // otherwise look like an empty successful response.
      if (streamError) throw streamError
      if (responseStatus !== 0 && responseStatus !== 200) {
        throw new Error(
          `Cursor Run HTTP ${responseStatus} ${JSON.stringify(stripPseudo(responseHeaders))}`,
        )
      }
      const grpcStatus = responseHeaders["grpc-status"]
      if (grpcStatus !== undefined && String(grpcStatus) !== "0") {
        throw new Error(
          `Cursor Run gRPC status ${grpcStatus}: ${responseHeaders["grpc-message"] ?? ""}`.trim(),
        )
      }
    },
    destroy() {
      if (!closed) {
        closed = true
        writable = false
        stream.close()
      }
    },
  }
}

function mergeBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0)
  if (buffers.length === 1) return buffers[0]
  const total = buffers.reduce((s, b) => s + b.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    merged.set(b, offset)
    offset += b.length
  }
  return merged
}

export function makeRequestId(): string {
  return crypto.randomUUID()
}

function stripPseudo(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(":")) {
      if (k === ":status") out[k] = v
      continue
    }
    if (k === "authorization" || k === "x-cursor-checksum") {
      out[k] = "<redacted>"
      continue
    }
    out[k] = v
  }
  return out
}
