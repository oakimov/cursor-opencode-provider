import { describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs/promises"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { bidiRunStream, closeCachedHttp2SessionsForTests, getSession } from "../src/transport/connect.js"

// Each case runs in a child process against a local HTTP/2 server whose own
// handles are unref'd, so only the client session can keep the process alive.
// The Runs go in an un-awaited function: Bun keeps a process alive while a
// top-level await is pending, which would hide an early unref.

const CONNECT_MODULE = pathToFileURL(path.resolve(import.meta.dir, "../src/transport/connect.ts")).href

const PRELUDE = `
import { randomBytes } from "node:crypto"
import http2 from "node:http2"
import { bidiRunStream, cacheHttp2SessionForTests } from ${JSON.stringify(CONNECT_MODULE)}

const ORIGIN = "https://agentn.session-exit-test.cursor.sh"
const server = http2.createServer()
server.on("session", (session) => session.unref())
const streams = []
const arrivals = []
// Resolves with the server side of the nth Run once it has arrived.
function serverStream(n) {
  if (streams.length >= n) return Promise.resolve(streams[n - 1])
  return new Promise((resolve) => arrivals.push({ n, resolve }))
}
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 })
  stream.on("error", () => {})
  stream.on("data", () => {})
  stream.on("end", () => stream.end())
  streams.push({ stream, closed: new Promise((resolve) => stream.once("close", resolve)) })
  onServerStream(stream, streams.length)
  for (const arrival of arrivals.filter((waiter) => waiter.n <= streams.length)) {
    arrivals.splice(arrivals.indexOf(arrival), 1)
    arrival.resolve(streams[arrival.n - 1])
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
server.unref()

const client = http2.connect("http://127.0.0.1:" + server.address().port)
await new Promise((resolve, reject) => {
  client.once("connect", resolve)
  client.once("error", reject)
})
cacheHttp2SessionForTests(ORIGIN, client)
`

function childScript(onServerStream: string, runs: string): string {
  return `${onServerStream}
${PRELUDE}
void (async () => {
${runs}
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`
}

// Two Runs one after the other; the second reuses the cached session after a
// ping. The process must exit once the last one has closed.
const SEQUENTIAL_RUNS = childScript(`function onServerStream() {}`, `
for (let turn = 1; turn <= 2; turn++) {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.end()
  await (await serverStream(turn)).closed
}
console.log("done")
`)

// Two overlapping Runs. The first closes; the second is answered only after an
// unref'd delay, so nothing but its own live stream keeps the process alive
// until the answer arrives.
const OVERLAPPING_RUNS = childScript(`
function onServerStream(stream, index) {
  if (index !== 2) return
  void serverStream(1).then((first) => first.closed).then(() => {
    setTimeout(() => {
      // One Connect frame: flags 0, length 1, payload 0x2a.
      stream.write(Uint8Array.of(0, 0, 0, 0, 1, 42))
    }, 200).unref()
  })
}`, `
const first = await bidiRunStream("token", { baseURL: ORIGIN })
const second = await bidiRunStream("token", { baseURL: ORIGIN })
first.end()
await (await serverStream(1)).closed
const frame = await second.frames().next()
console.log("second answered: " + frame.value?.payload[0])
second.end()
await (await serverStream(2)).closed
console.log("done")
`)

// A Run destroyed while its response is still open, once idle and once with a
// request write Cursor is not reading. The stream must close at once so the
// session is released; a plain close() never closes it.
const destroyedRun = (bytes: number, close: "destroy" | "end" | "end-then-destroy" = "destroy") => childScript(`function onServerStream(stream) { stream.pause() }`, `
const run = await bidiRunStream("token", { baseURL: ORIGIN })
run.write(new Uint8Array(randomBytes(${bytes})))
await serverStream(1)
await new Promise((resolve) => setTimeout(resolve, 200))
${close !== "destroy" ? "run.end()" : ""}
${close !== "end" ? "run.destroy()" : ""}
console.log("destroyed")
`)

async function runUntilExit(
  script: string,
  timeoutMs: number,
): Promise<{ exited: boolean; code: number | null; stdout: string; stderr: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-provider-session-exit-"))
  try {
    const file = path.join(directory, "run.ts")
    await fs.writeFile(file, script)
    const child = Bun.spawn([process.execPath, file], {
      env: { ...process.env, CURSOR_CLIENT_VERSION: "cli-session-exit-test" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    const outcome = await Promise.race([child.exited, timedOut])
    clearTimeout(timer)
    if (outcome === "timeout") child.kill()
    const code = await child.exited
    return {
      exited: outcome !== "timeout",
      code: outcome === "timeout" ? null : code,
      stdout: await stdout,
      stderr: await stderr,
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

describe("cached HTTP/2 session and process exit", () => {
  it("lets a process end once its last Run has finished", async () => {
    const result = await runUntilExit(SEQUENTIAL_RUNS, 8_000)
    expect(result).toMatchObject({ exited: true, code: 0, stdout: "done\n" })
  }, 15_000)

  it("keeps the process alive while a sibling Run is still open", async () => {
    const result = await runUntilExit(OVERLAPPING_RUNS, 8_000)
    expect(result).toMatchObject({ exited: true, code: 0, stdout: "second answered: 42\ndone\n" })
  }, 15_000)
})

describe("destroyed Run and process exit", () => {
  for (const [name, bytes] of [["idle", 10], ["with a blocked write", 3_000_000]] as const) {
    it(`lets a process end after a Run ${name} is destroyed`, async () => {
      const result = await runUntilExit(destroyedRun(bytes), 8_000)
      expect(result).toMatchObject({ exited: true, code: 0, stdout: "destroyed\n" })
    }, 15_000)
  }
})

describe("ended Run cleanup and process exit", () => {
  for (const [close, bytes] of [["end", 3_000_000], ["end-then-destroy", 10], ["end-then-destroy", 3_000_000]] as const) {
    it(`releases the session after ${close} with ${bytes} request bytes`, async () => {
      const result = await runUntilExit(destroyedRun(bytes, close), 8_000)
      expect(result).toMatchObject({ exited: true, code: 0, stdout: "destroyed\n" })
    }, 15_000)
  }
})

describe("cached HTTP/2 session ref", () => {
  it("unrefs a new session and refs it only while a ping or a Run holds it", async () => {
    const server = http2.createServer()
    const serverClosed: Array<Promise<void>> = []
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200 })
      stream.on("error", () => {})
      stream.on("data", () => {})
      stream.on("end", () => stream.end())
      serverClosed.push(new Promise((resolve) => stream.once("close", () => resolve())))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("expected TCP address")

    // The real connect path, pointed at the local plaintext server.
    const calls: string[] = []
    let callRecorded = () => {}
    const record = (call: string) => {
      calls.push(call)
      callRecorded()
    }
    const untilCalls = (count: number) => new Promise<void>((resolve) => {
      callRecorded = () => { if (calls.length >= count) resolve() }
      callRecorded()
    })
    const connected: http2.ClientHttp2Session[] = []
    const connect = http2.connect.bind(http2)
    const connectSpy = spyOn(http2, "connect").mockImplementation(((origin: string | URL) => {
      record(`connect ${String(origin)}`)
      const session = connect(`http://127.0.0.1:${address.port}`)
      const ref = session.ref.bind(session)
      const unref = session.unref.bind(session)
      session.ref = () => { record("ref"); ref() }
      session.unref = () => { record("unref"); unref() }
      connected.push(session)
      return session
    }) as typeof http2.connect)
    const keys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "CURSOR_CLIENT_VERSION"] as const
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    // A pinned version: resolving it otherwise fetches Cursor's installer and caches the result.
    process.env.CURSOR_CLIENT_VERSION = "cli-session-ref-test"
    resetClientVersionCache()
    const origin = "https://agentn.session-ref-test.cursor.sh"
    try {
      const session = await getSession(origin)
      expect(calls).toEqual([`connect ${origin}`, "unref"])
      expect(session).toBe(connected[0]!)

      const run = await bidiRunStream("token", { baseURL: origin })
      // Reuse ping: ref, then unref with no Run live. The Run then refs it.
      expect(calls.slice(2)).toEqual(["ref", "unref", "ref"])
      run.end()
      await Promise.all([serverClosed[0], untilCalls(6)])
      expect(calls.slice(5)).toEqual(["unref"])
      expect(connectSpy).toHaveBeenCalledTimes(1)
    } finally {
      connectSpy.mockRestore()
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      resetClientVersionCache()
      closeCachedHttp2SessionsForTests()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
