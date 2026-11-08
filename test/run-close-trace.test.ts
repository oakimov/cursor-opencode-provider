import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// The debug switch is read once at module load, so each case runs a child
// process with tracing on against a local HTTP/2 server and reads its log.
// Node and Bun emit `aborted` for a local CANCEL reset of a stream whose
// request side is still open; that must not read as a remote abort. Bun 1.3
// (OpenCode 2.0's runtime) also emits `error` for it while the response is
// open; `BUN_1_3_CANCEL_ERROR` reproduces that order on newer runtimes.

const BUN_1_3_CANCEL_ERROR = `
const request = client.request.bind(client)
client.request = (...args) => {
  const stream = request(...args)
  const close = stream.close.bind(stream)
  stream.close = (code, callback) => {
    const open = !stream.closed && !stream.readableEnded
    close(code, callback)
    if (open && code === http2.constants.NGHTTP2_CANCEL) {
      stream.emit("error", new Error("Stream closed with error code NGHTTP2_CANCEL"))
    }
  }
  return stream
}
`

const CONNECT_MODULE = pathToFileURL(path.resolve(import.meta.dir, "../src/transport/connect.ts")).href

function childScript(onServerStream: string, run: string, clientSetup = ""): string {
  return `
import http2 from "node:http2"
import { bidiRunStream, cacheHttp2SessionForTests } from ${JSON.stringify(CONNECT_MODULE)}

const ORIGIN = "https://agentn.run-close-trace-test.cursor.sh"
const server = http2.createServer()
server.on("session", (session) => session.unref())
let arrived
const serverStream = new Promise((resolve) => { arrived = resolve })
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 })
  stream.on("error", () => {})
  stream.on("data", () => {})
  // One Connect frame: flags 0, length 1, payload 0x2a.
  stream.write(Uint8Array.of(0, 0, 0, 0, 1, 42))
  ${onServerStream}
  arrived(stream)
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
server.unref()
const client = http2.connect("http://127.0.0.1:" + server.address().port)
await new Promise((resolve, reject) => {
  client.once("connect", resolve)
  client.once("error", reject)
})
${clientSetup}
cacheHttp2SessionForTests(ORIGIN, client)

void (async () => {
${run}
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`
}

const OPEN_REQUEST = `
const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: controller?.signal })
run.write(new Uint8Array(10).fill(5))
await serverStream
await run.frames().next()
`

async function streamClosedTraces(
  script: string,
  { level = "1", match = /h2 stream (closed|error)/ }: { level?: string; match?: RegExp } = {},
): Promise<string[]> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-provider-close-trace-"))
  try {
    const file = path.join(directory, "run.ts")
    const log = path.join(directory, "debug.log")
    await fs.writeFile(file, script)
    const child = Bun.spawn([process.execPath, file], {
      env: {
        ...process.env,
        CURSOR_CLIENT_VERSION: "cli-close-trace-test",
        CURSOR_PROVIDER_DEBUG: level,
        CURSOR_PROVIDER_DEBUG_FILE: log,
      },
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 8_000)
    const code = await child.exited
    clearTimeout(timer)
    // The stream's `close` trace is written before its session lets the child exit.
    expect({ code, stderr: (await stderr).replace(/^\[cursor-provider\].*\n/gm, "") })
      .toEqual({ code: 0, stderr: "" })
    const lines = (await fs.readFile(log, "utf8")).split("\n")
    return lines.filter((line) => match.test(line)).map((line) => line.replace(/^\[[^\]]*\] /, ""))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

describe("Run stream close trace", () => {
  it("writes a line per received frame only at CURSOR_PROVIDER_DEBUG=2", async () => {
    const script = childScript("", `
const controller = undefined
${OPEN_REQUEST}
run.destroy()
`)
    const frames = (level: string) => streamClosedTraces(script, { level, match: /frame yield|h2 stream closed/ })
    expect(await frames("1")).toEqual(["h2 stream closed (status=200, local=true, err=none)"])
    expect(await frames("2")).toEqual([
      "frame yield: flags=0x0 payload=1B",
      "h2 stream closed (status=200, local=true, err=none)",
    ])
  }, 30_000)

  it("does not record a destroyed Run as aborted by remote", async () => {
    const traces = await streamClosedTraces(childScript("", `
const controller = undefined
${OPEN_REQUEST}
run.destroy()
`))
    expect(traces).toEqual(["h2 stream closed (status=200, local=true, err=none)"])
  }, 15_000)

  it("does not record a Run closed by its abort signal as aborted by remote", async () => {
    const traces = await streamClosedTraces(childScript("", `
const controller = new AbortController()
${OPEN_REQUEST}
controller.abort()
`))
    expect(traces).toEqual(["h2 stream closed (status=200, local=true, err=none)"])
  }, 15_000)

  for (const [label, close] of [
    ["run.destroy()", "run.destroy()"],
    ["run.end() then run.destroy()", "run.end()\nrun.destroy()"],
  ] as const) {
    it(`does not record Bun 1.3's error for our own CANCEL after ${label}`, async () => {
      const traces = await streamClosedTraces(childScript("", `
const controller = undefined
${OPEN_REQUEST}
${close}
`, BUN_1_3_CANCEL_ERROR))
      expect(traces).toEqual(["h2 stream closed (status=200, local=true, err=none)"])
    }, 15_000)
  }

  it("still records a reset from Cursor as a remote abort", async () => {
    const traces = await streamClosedTraces(childScript(
      `setTimeout(() => stream.close(http2.constants.NGHTTP2_CANCEL), 100)`,
      `
const controller = undefined
${OPEN_REQUEST}
`,
    ))
    // Node and Bun 1.4 report the reset as `aborted`; Bun 1.3 as a stream error.
    const closed = traces.filter((line) => line.startsWith("h2 stream closed"))
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatch(
      /^h2 stream closed \(status=200, local=false, err=(Cursor Run stream aborted by remote|Stream closed with error code NGHTTP2_CANCEL)\)$/,
    )
  }, 15_000)
})
