// Exercise the subject's built provider through localhost HTTP/2. Node is used
// so this check does not depend on the subject's Bun test order or test hooks.
import fs from "node:fs/promises"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const subject = path.resolve(process.argv[2] ?? process.cwd())
const load = (name) => import(pathToFileURL(path.join(subject, "dist", name + ".js")).href)
// Import before allocating owned state so an incompatible subject cannot leave
// a scratch directory behind before the cleanup scope is installed.
const { createCursor } = await load("index")
const models = await load("models")
const { MODEL_CACHE_SCHEMA_VERSION } = await load("shared")
const { setHostCacheDirOverride } = await load("context/paths")
const { settleRunSavesForTests } = await load("language-model")
const { sessionManager } = await load("session")
const { encodeMessage, decodeMessage } = await load("protocol/messages")
const { decodeFramePayload } = await load("protocol/framing")
const transport = await load("transport/connect")
const { resetAgentUrlCache } = await load("agent-url")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-model-cache-"))
const variables = ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "CURSOR_CLIENT_VERSION", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "PATH"]
const saved = new Map(variables.map(key => [key, process.env[key]]))
for (const key of variables) if (key !== "PATH") delete process.env[key]
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.CURSOR_CLIENT_VERSION = "cli-review-fixture"
const origin = "https://agentn.model-cache-review.cursor.sh"
const parameters = [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }]
const requests = []
const server = http2.createServer()
let client
let failed = false
const frame = (payload) => {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
server.on("stream", stream => {
  stream.on("error", () => {})
  stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
  let pending = Buffer.alloc(0)
  stream.on("data", chunk => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1)
      if (pending.length < 5 + length) break
      const message = decodeMessage("AgentClientMessage", decodeFramePayload({ flags: pending[0], payload: pending.subarray(5, 5 + length) }))
      pending = pending.subarray(5 + length)
      if (!message.run_request) continue
      requests.push(message.run_request.requested_model)
      stream.end(frame(encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 1 } } })))
    }
  })
})
try {
  if (process.platform === "darwin") {
    // Device discovery is external to this model-cache contract. Supply a
    // synthetic registry tool rather than requiring ioreg in the boundary.
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "ioreg"), '#!/bin/sh\nprintf \'IOPlatformUUID = "review-fixture"\\n\'\n', { mode: 0o755 })
    process.env.PATH = bin + path.delimiter + (saved.get("PATH") ?? "")
  }
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  client = http2.connect(`http://127.0.0.1:${server.address().port}`)
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject) })
  const directories = [path.join(root, "first"), path.join(root, "second")]
  const timestamp = new Date(1_800_000_000_000)
  const write = async (directory, max) => {
    const catalog = models.mapAvailableModelsResponse({ models: [{ name: "review-cache-fixture", variants: [{
      parameterValues: parameters, isMaxMode: max, isDefaultNonMaxConfig: true,
    }] }] })
    await models.writeCache(directory, { models: catalog, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
    await fs.utimes(models.cacheFilePath(directory), timestamp, timestamp)
  }
  await write(directories[0], true)
  await write(directories[1], false)
  const steps = [
    { id: "first-root", root: 0, expected: true },
    { id: "equal-time-other-root", root: 1, expected: false },
    { id: "warm-same-file", root: 1, expected: false },
    { id: "equal-time-replacement", root: 1, expected: true, update: true },
    { id: "replacement-false", root: 1, expected: false, update: false },
    { id: "missing-file", root: 1, expected: true, remove: true },
  ]
  for (const step of steps) {
    const directory = directories[step.root]
    if (step.update !== undefined) await write(directory, step.update)
    if (step.remove) await fs.unlink(models.cacheFilePath(directory))
    transport.cacheHttp2SessionForTests(origin, client)
    const model = createCursor({ name: "cursor", accessToken: "review-fixture-token", cacheDir: directory, agentBaseURL: origin }).languageModel("review-cache-fixture")
    const call = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      providerOptions: { cursor: { cursorVariantParameters: parameters } },
    }
    if (step.remove) {
      const count = requests.length
      let refused = false
      try { await model.doStream(call) }
      catch (error) { refused = /no cached variants/.test(String(error.cause ?? error)) }
      const correct = refused && requests.length === count
      console[correct ? "log" : "error"](`MODEL_CACHE_CONTRACT=${step.id}:${correct ? "passed" : "failed"} refused=${refused}`)
      if (!correct) failed = true
      continue
    }
    const { stream } = await model.doStream(call)
    for await (const part of stream) if (part.type === "error") throw part.error
    const request = requests.at(-1)
    const correct = request?.max_mode === step.expected && request?.model_id === "review-cache-fixture"
      && JSON.stringify(request?.parameters) === JSON.stringify(parameters)
    console[correct ? "log" : "error"](`MODEL_CACHE_CONTRACT=${step.id}:${correct ? "passed" : "failed"} expectedMax=${step.expected} observedMax=${request?.max_mode}`)
    if (!correct) failed = true
    await settleRunSavesForTests()
    sessionManager.dispose()
  }
  // Hold the first request after its metadata read, then let another root load
  // before releasing discovery. A shared mutable result would change its pick.
  await write(directories[0], true)
  await write(directories[1], false)
  resetAgentUrlCache()
  const originalFetch = globalThis.fetch
  let ready, release
  const discoveryReady = new Promise(resolve => { ready = resolve })
  const discoveryReply = new Promise(resolve => { release = resolve })
  let first
  const consume = async (result) => {
    for await (const part of (await result).stream) if (part.type === "error") throw part.error
  }
  try {
    globalThis.fetch = async input => {
      if (!String(input).includes("GetServerConfig")) throw new Error("Unexpected fixture fetch")
      ready()
      await discoveryReply
      return Response.json({ agentUrlConfig: { agentnUrl: origin } })
    }
    const options = { cursor: { cursorVariantParameters: parameters } }
    const call = { prompt: [{ role: "user", content: [{ type: "text", text: "concurrent fixture" }] }], providerOptions: options }
    const firstModel = createCursor({ name: "cursor", accessToken: "review-fixture-token", cacheDir: directories[0] }).languageModel("review-cache-fixture")
    first = firstModel.doStream(call)
    await Promise.race([discoveryReady, first.then(() => { throw new Error("Expected paused discovery") })])
    transport.cacheHttp2SessionForTests(origin, client)
    const second = createCursor({ name: "cursor", accessToken: "review-fixture-token", cacheDir: directories[1], agentBaseURL: origin }).languageModel("review-cache-fixture")
    await consume(second.doStream(call))
    const secondPick = requests.at(-1)
    release()
    await consume(first)
    const firstPick = requests.at(-1)
    const correct = secondPick?.max_mode === false && firstPick?.max_mode === true
      && [firstPick, secondPick].every(request => request?.model_id === "review-cache-fixture"
        && JSON.stringify(request?.parameters) === JSON.stringify(parameters))
    console[correct ? "log" : "error"](`MODEL_CACHE_CONTRACT=inflight-snapshot:${correct ? "passed" : "failed"} firstMax=${firstPick?.max_mode} secondMax=${secondPick?.max_mode}`)
    if (!correct) failed = true
  } finally {
    release()
    if (first) await consume(first).catch(() => {})
    globalThis.fetch = originalFetch
    resetAgentUrlCache()
  }
} finally {
  await settleRunSavesForTests()
  sessionManager.dispose()
  transport.closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise(resolve => server.close(resolve))
  setHostCacheDirOverride(undefined)
  await fs.rm(root, { recursive: true, force: true })
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
process.exitCode = failed ? 1 : 0
