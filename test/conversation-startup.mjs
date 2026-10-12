// Run after build with Node or Bun. No credentials, Cursor traffic or host state.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip, gzipSync } from "node:zlib"
import protobuf from "protobufjs"
import {
  conversationCacheDirectoryPath,
  conversationCacheFilePath,
  getPersistedConversation,
  loadPersistedConversation,
  resetConversationPersistenceForTests,
  setConversationPersistenceHookForTests,
  waitForConversationMaintenanceForTests,
} from "../dist/protocol/conversation-persistence.js"
import { CONVERSATION_CACHE_SCHEMA_VERSION } from "../dist/shared.js"
import { encodeMessage } from "../dist/protocol/messages.js"

const root = await mkdtemp(path.join(os.tmpdir(), "cursor-startup-check-"))
const directory = conversationCacheDirectoryPath(root)
const sessionKey = "ses_startup_restore"
const now = Date.now()
let server, timer
try {
  await mkdir(directory)
  const prefix = protobuf.Writer.create().uint32(8).uint32(CONVERSATION_CACHE_SCHEMA_VERSION)
    .uint32(18).string(sessionKey).uint32(26).string("startup-fixture").uint32(32).uint64(now).finish()
  const context = protobuf.Writer.create().uint32(58)
    .bytes(encodeMessage("RequestContext", { rules_info_complete: true })).finish()
  const checkpoint = randomBytes(1_855_000)
  const payload = Buffer.concat([
    prefix, protobuf.Writer.create().uint32(42).bytes(checkpoint).finish(), context,
  ])
  const compressed = gzipSync(payload, { level: 1 })
  const ownFile = conversationCacheFilePath(root, sessionKey)
  await writeFile(ownFile, compressed)
  for (let i = 1; i < 131; i++) await writeFile(path.join(directory, `fixture-${i}.pb.gz`), compressed)

  let fullDecodes = 0, beginMaintenance, releaseMaintenance
  const began = new Promise(resolve => { beginMaintenance = resolve })
  const gate = new Promise(resolve => { releaseMaintenance = resolve })
  setConversationPersistenceHookForTests(async phase => {
    if (phase === "full-decode") fullDecodes++
    if (phase === "maintenance-start") { beginMaintenance(); await gate }
  })
  const newStart = performance.now()
  assert.equal(await getPersistedConversation(root, "ses_startup_new", now), undefined)
  const newSessionMs = performance.now() - newStart
  const maintenance = waitForConversationMaintenanceForTests(root, now)
  await began
  assert.equal(fullDecodes, 0)
  assert.ok(newSessionMs < 750, `new session took ${newSessionMs} ms before cleanup`)

  // HTTP and a heartbeat remain responsive while the real collector runs.
  server = http.createServer((_request, response) => response.end("ready"))
  await new Promise(resolve => server.listen(0, "localhost", resolve))
  const address = server.address()
  const latencies = [], pending = []
  let previous = performance.now(), maxTimerGapMs = 0
  timer = setInterval(() => {
    const started = performance.now()
    maxTimerGapMs = Math.max(maxTimerGapMs, started - previous)
    previous = started
    pending.push(fetch(`http://localhost:${address.port}/health`).then(async response => {
      assert.equal(await response.text(), "ready")
      latencies.push(performance.now() - started)
    }))
  }, 10)
  const sweepStart = performance.now()
  releaseMaintenance()
  await maintenance
  const sweepMs = performance.now() - sweepStart
  const sweepMaxTimerGapMs = maxTimerGapMs
  maxTimerGapMs = 0
  previous = performance.now()
  const restoreStart = performance.now()
  const restored = await getPersistedConversation(root, sessionKey, now)
  const restoreMs = performance.now() - restoreStart
  await new Promise(resolve => setTimeout(resolve, 20))
  clearInterval(timer)
  timer = undefined
  await Promise.all(pending)
  assert.equal(fullDecodes, 1)
  assert.ok(latencies.length > 0)
  assert.ok(sweepMaxTimerGapMs < 750, `collector timer gap: ${sweepMaxTimerGapMs} ms`)
  assert.ok(maxTimerGapMs < 750, `restore timer gap: ${maxTimerGapMs} ms`)
  assert.ok(Math.max(...latencies) < 750, `collector HTTP gap: ${Math.max(...latencies)} ms`)
  assert.equal((await readdir(directory)).filter(name => name.endsWith(".pb.gz")).length, 131)

  assert.equal(restored.conversationId, "startup-fixture")
  assert.deepEqual(restored.checkpoint, new Uint8Array(checkpoint))
  assert.equal(fullDecodes, 1)
  assert.deepEqual(await readFile(ownFile), compressed)
  console.log(JSON.stringify({
    runtime: process.versions.bun ? "bun" : "node", files: 131,
    compressedBytes: compressed.length * 131,
    newSessionMs: +newSessionMs.toFixed(1), sweepMs: +sweepMs.toFixed(1),
    restoreMs: +restoreMs.toFixed(1), fullDecodes,
    maxTimerGapMs: +sweepMaxTimerGapMs.toFixed(1), restoreMaxTimerGapMs: +maxTimerGapMs.toFixed(1),
    maxHttpLatencyMs: +Math.max(...latencies).toFixed(1),
  }))

  // Exercise the production expanded-size guard without allocating the fixture
  // itself as one giant buffer. The foreground async gunzip must reject it.
  resetConversationPersistenceForTests()
  const oversizedKey = "ses_expanded_limit"
  const oversizedPrefix = protobuf.Writer.create().uint32(8).uint32(CONVERSATION_CACHE_SCHEMA_VERSION)
    .uint32(18).string(oversizedKey).uint32(26).string("too-large").uint32(32).uint64(now)
    .uint32(42).uint32(256 * 1024 * 1024 + 1).finish()
  const oversizedPath = conversationCacheFilePath(root, oversizedKey)
  await pipeline(Readable.from((async function* () {
    yield oversizedPrefix
    const chunk = Buffer.alloc(64 * 1024)
    for (let i = 0; i < 4096; i++) yield chunk
    yield Buffer.from([0])
    yield context
  })()), createGzip(), createWriteStream(oversizedPath))
  assert.equal((await loadPersistedConversation(root, oversizedKey, now)).status, "invalid")
  console.log(JSON.stringify({ expandedLimit: "passed" }))
} finally {
  if (timer) clearInterval(timer)
  resetConversationPersistenceForTests()
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await rm(root, { recursive: true, force: true })
}
