import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, open, rm, stat, truncate, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import protobuf from "protobufjs"
import {
  MAX_CACHE_HEADER_INPUT_BYTES,
  parseConversationCacheHeader,
  readConversationCacheHeader,
} from "../src/protocol/conversation-cache-header.js"
import {
  conversationCacheDirectoryPath,
  conversationCacheFilePath,
  deletePersistedConversation,
  getPersistedConversation,
  getPersistedTurnProvenance,
  initializeConversationPersistence,
  loadPersistedConversation,
  persistConversation,
  resetConversationPersistenceForTests,
  retainedConversationSnapshotsForTests,
  setConversationPersistenceHookForTests,
  waitForConversationMaintenanceForTests,
} from "../src/protocol/conversation-persistence.js"
import { encodeMessage } from "../src/protocol/messages.js"
import { CONVERSATION_CACHE_SCHEMA_VERSION, CONVERSATION_CACHE_TTL_MS } from "../src/shared.js"

const roots: string[] = []
const sessionKey = "ses_maintenance"
const now = 1_900_000_000_000

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "cursor-maintenance-"))
  roots.push(value)
  await mkdir(conversationCacheDirectoryPath(value))
  return value
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function protobufSnapshot(updatedAt = now, conversationId = "conversation-current", checkpoint = Buffer.from([1, 2, 3])) {
  return protobuf.Writer.create()
    .uint32(8).uint32(CONVERSATION_CACHE_SCHEMA_VERSION)
    .uint32(18).string(sessionKey)
    .uint32(26).string(conversationId)
    .uint32(32).uint64(updatedAt)
    .uint32(42).bytes(checkpoint)
    .uint32(58).bytes(encodeMessage("RequestContext", { rules_info_complete: true }))
    .finish()
}

async function snapshot(cacheDir: string, bytes = gzipSync(protobufSnapshot())) {
  const filePath = conversationCacheFilePath(cacheDir, sessionKey)
  await writeFile(filePath, bytes)
  return filePath
}

async function child(script: string, input: unknown): Promise<string> {
  const childProcess = Bun.spawn([process.execPath, "-e", script], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  childProcess.stdin.write(JSON.stringify(input))
  childProcess.stdin.end()
  const [output, error, exitCode] = await Promise.all([
    new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited,
  ])
  expect(error).toBe("")
  expect(exitCode).toBe(0)
  return output
}

async function publishFromChild(filePath: string, bytes: Uint8Array) {
  await child(`
    const fs = await import("node:fs/promises")
    const { filePath, bytes } = JSON.parse(await Bun.stdin.text())
    await fs.writeFile(filePath + ".writer", Buffer.from(bytes, "base64"))
    await fs.rename(filePath + ".writer", filePath)
  `, { filePath, bytes: Buffer.from(bytes).toString("base64") })
}

afterAll(async () => {
  await Promise.all(roots.map((value) => rm(value, { recursive: true, force: true })))
})

describe("bounded conversation maintenance", () => {
  beforeEach(resetConversationPersistenceForTests)
  afterEach(resetConversationPersistenceForTests)

  it("returns a new session while unrelated maintenance is paused", async () => {
    const cacheDir = await root()
    const entered = deferred(), release = deferred()
    let decodes = 0
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase === "full-decode") decodes++
      if (phase === "maintenance-start") { entered.resolve(); await release.promise }
    })
    await initializeConversationPersistence(cacheDir, now)
    const maintenance = waitForConversationMaintenanceForTests(cacheDir, now)
    await entered.promise
    try {
      expect(await loadPersistedConversation(cacheDir, "ses_new", now)).toEqual({ status: "missing" })
      expect(decodes).toBe(0)
    } finally { release.resolve(); await maintenance }
  })

  it("never fully decodes unrelated fresh or expired payloads", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir, gzipSync(protobufSnapshot(now, "large", Buffer.alloc(4 * 1024 * 1024))))
    const expired = path.join(conversationCacheDirectoryPath(cacheDir), "expired.pb.gz")
    await writeFile(expired, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    let decodes = 0
    setConversationPersistenceHookForTests((phase) => { if (phase === "full-decode") decodes++ })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect(decodes).toBe(0)
    expect((await stat(filePath)).isFile()).toBe(true)
    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("large")
    expect(decodes).toBe(1)
  })

  it("uses persisted age when filesystem times disagree, including the exact TTL boundary", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS)))
    await utimes(filePath, 0, 0)
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await stat(filePath)).isFile()).toBe(true)
    resetConversationPersistenceForTests()
    await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    await utimes(filePath, new Date(now), new Date(now))
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("expired")
  })

  it("rejects expiry on demand before decompressing any body", async () => {
    const cacheDir = await root()
    await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1,
      "expired", Buffer.alloc(16 * 1024 * 1024))))
    let decodes = 0
    setConversationPersistenceHookForTests((phase) => { if (phase === "full-decode") decodes++ })
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("expired")
    expect(decodes).toBe(0)
  })

  it("keeps a fresh readable prefix but rejects its corrupt gzip body on hydration", async () => {
    const cacheDir = await root()
    const bytes = gzipSync(protobufSnapshot(now, "corrupt", Buffer.alloc(32 * 1024)))
    bytes[bytes.length - 8]! ^= 1
    const filePath = await snapshot(cacheDir, bytes)
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await stat(filePath)).isFile()).toBe(true)
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("invalid")
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves noncanonical protobuf order for full on-demand decoding", async () => {
    const cacheDir = await root()
    const bytes = protobuf.Writer.create()
      .uint32(18).string(sessionKey).uint32(8).uint32(CONVERSATION_CACHE_SCHEMA_VERSION)
      .uint32(32).uint64(now).uint32(26).string("noncanonical")
      .uint32(58).bytes(encodeMessage("RequestContext", { rules_info_complete: true })).finish()
    const filePath = await snapshot(cacheDir, gzipSync(bytes))
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await stat(filePath)).isFile()).toBe(true)
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("noncanonical")
  })

  it("does not accept conflicting metadata after a canonical prefix", async () => {
    const cacheDir = await root()
    const suffix = protobuf.Writer.create().uint32(32).uint64(now + 1).finish()
    await snapshot(cacheDir, gzipSync(Buffer.concat([protobufSnapshot(), suffix])))
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("invalid")
  })

  it("keeps unsupported schema during collection but rejects it on demand", async () => {
    const cacheDir = await root()
    const bytes = Uint8Array.from(protobufSnapshot())
    bytes[1] = CONVERSATION_CACHE_SCHEMA_VERSION + 1
    const filePath = await snapshot(cacheDir, gzipSync(bytes))
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await stat(filePath)).isFile()).toBe(true)
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("invalid")
  })

  it("rejects a wrong session key without restoring its checkpoint", async () => {
    const cacheDir = await root()
    await writeFile(conversationCacheFilePath(cacheDir, "ses_other"), gzipSync(protobufSnapshot()))
    expect((await loadPersistedConversation(cacheDir, "ses_other", now)).status).toBe("invalid")
  })

  it("rejects an oversized compressed file before attempting a full decode", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir)
    await truncate(filePath, 256 * 1024 * 1024 + 1)
    let decodes = 0
    setConversationPersistenceHookForTests((phase) => { if (phase === "full-decode") decodes++ })
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("invalid")
    expect(decodes).toBe(0)
  })

  it("preserves a fresh atomic replacement made before quarantine", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase === "before-quarantine") await publishFromChild(filePath, gzipSync(protobufSnapshot(now, "replacement")))
    })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    resetConversationPersistenceForTests()
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("replacement")
  })

  it("lets another process restore a fresh replacement while it is quarantined", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    const entered = deferred(), release = deferred()
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase === "before-quarantine") await publishFromChild(filePath, gzipSync(protobufSnapshot(now, "moved-fresh")))
      if (phase === "after-quarantine") { entered.resolve(); await release.promise }
    })
    const maintenance = waitForConversationMaintenanceForTests(cacheDir, now)
    await entered.promise
    try {
      const module = new URL("../src/protocol/conversation-persistence.ts", import.meta.url).href
      const restored = await child(`
        const { module, cacheDir, sessionKey, now } = JSON.parse(await Bun.stdin.text())
        const persistence = await import(module)
        const value = await persistence.getPersistedConversation(cacheDir, sessionKey, now)
        process.stdout.write(JSON.stringify(value?.conversationId))
      `, { module, cacheDir, sessionKey, now })
      expect(JSON.parse(restored)).toBe("moved-fresh")
    } finally { release.resolve(); await maintenance }
    resetConversationPersistenceForTests()
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("moved-fresh")
  })

  it("keeps a writer's live file when it publishes after quarantine", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase === "after-quarantine") await publishFromChild(filePath, gzipSync(protobufSnapshot(now, "live-writer")))
    })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    resetConversationPersistenceForTests()
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("live-writer")
  })

  it("recovers crash leftovers and deletes only expired immutable candidates", async () => {
    const cacheDir = await root()
    const filePath = conversationCacheFilePath(cacheDir, sessionKey)
    const directory = path.join(conversationCacheDirectoryPath(cacheDir), ".gc", path.basename(filePath))
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "fresh.snapshot"), gzipSync(protobufSnapshot(now, "crash-fresh")))
    await writeFile(path.join(directory, "expired.snapshot"), gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("crash-fresh")
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not delete a newer binding published by another process", async () => {
    const cacheDir = await root()
    await persistConversation(cacheDir, {
      sessionKey, conversationId: "owned", blobs: [], requestContext: { rules_info_complete: true },
    }, now)
    await publishFromChild(conversationCacheFilePath(cacheDir, sessionKey), gzipSync(protobufSnapshot(now, "new-binding")))
    await deletePersistedConversation(cacheDir, sessionKey, "owned")
    resetConversationPersistenceForTests()
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("new-binding")
  })

  it("tolerates a second collector finishing an already moved candidate", async () => {
    const cacheDir = await root()
    await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    const module = new URL("../src/protocol/conversation-persistence.ts", import.meta.url).href
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase === "after-quarantine") await child(`
        const { module, cacheDir, now } = JSON.parse(await Bun.stdin.text())
        const persistence = await import(module)
        await persistence.waitForConversationMaintenanceForTests(cacheDir, now)
      `, { module, cacheDir, now })
    })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).value).toBeUndefined()
  })

  it("does not treat an I/O/entry-type failure as permission to delete", async () => {
    const cacheDir = await root()
    const filePath = conversationCacheFilePath(cacheDir, sessionKey)
    await mkdir(filePath)
    await expect(loadPersistedConversation(cacheDir, sessionKey, now)).rejects.toThrow("not a regular file")
    expect((await stat(filePath)).isDirectory()).toBe(true)
  })

  it("does not retain full snapshots in memory after handing them out or writing them", async () => {
    const cacheDir = await root()
    await snapshot(cacheDir)
    let decodes = 0
    setConversationPersistenceHookForTests((phase) => { if (phase === "full-decode") decodes++ })
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("conversation-current")
    expect(await retainedConversationSnapshotsForTests()).toBe(0)
    expect(decodes).toBe(1)
    // A later reader gets the durable copy, not a process-lifetime clone.
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).value?.conversationId)
      .toBe("conversation-current")
    expect(decodes).toBe(2)
    await persistConversation(cacheDir, {
      sessionKey, conversationId: "written", checkpoint: new Uint8Array(1024 * 1024), blobs: [],
      requestContext: { rules_info_complete: true }, turnProvenance: "{}",
    }, now)
    expect(await retainedConversationSnapshotsForTests()).toBe(0)
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.checkpoint?.length).toBe(1024 * 1024)
    expect(await getPersistedTurnProvenance(cacheDir, sessionKey, now))
      .toEqual({ conversationId: "written", turnProvenance: "{}" })
    expect(decodes).toBe(3)
  })

  it("reports a durable snapshot that expired while only its metadata was held", async () => {
    const cacheDir = await root()
    await persistConversation(cacheDir, {
      sessionKey, conversationId: "idle", blobs: [], requestContext: { rules_info_complete: true },
    }, now)
    const later = now + CONVERSATION_CACHE_TTL_MS + 1
    expect(await loadPersistedConversation(cacheDir, sessionKey, later)).toEqual({ status: "expired" })
    expect(await getPersistedTurnProvenance(cacheDir, sessionKey, later)).toBeUndefined()
  })

  it("treats a quarantine removed after opendir as empty", async () => {
    const cacheDir = await root()
    const filePath = conversationCacheFilePath(cacheDir, sessionKey)
    const directory = path.join(conversationCacheDirectoryPath(cacheDir), ".gc", path.basename(filePath))
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "moved.snapshot"), gzipSync(protobufSnapshot(now, "moved")))
    // Bun reads a Dir lazily, so this removal surfaces from iteration, not opendir.
    setConversationPersistenceHookForTests(async (phase, opened) => {
      if (phase === "directory-opened" && opened === directory) await rm(directory, { recursive: true })
    })
    expect(await loadPersistedConversation(cacheDir, sessionKey, now)).toEqual({ status: "missing" })
  })

  it("collects a snapshot loaded by this process once it expires", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir)
    expect((await getPersistedConversation(cacheDir, sessionKey, now))?.conversationId).toBe("conversation-current")
    await waitForConversationMaintenanceForTests(cacheDir, now)
    expect((await stat(filePath)).isFile()).toBe(true)
    await waitForConversationMaintenanceForTests(cacheDir, now + CONVERSATION_CACHE_TTL_MS + 1)
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("retries quarantine when another collector removes the emptied directory", async () => {
    const cacheDir = await root()
    const filePath = await snapshot(cacheDir, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    const directory = path.join(conversationCacheDirectoryPath(cacheDir), ".gc", path.basename(filePath))
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase === "before-quarantine") await rm(directory, { recursive: true })
    })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("expired")
  })

  it("isolates one failing entry from the rest of the pass", async () => {
    const cacheDir = await root()
    const directory = conversationCacheDirectoryPath(cacheDir)
    const expired = gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1))
    await writeFile(path.join(directory, "a.pb.gz"), expired)
    await writeFile(path.join(directory, "b.pb.gz"), expired)
    let failed: string | undefined
    setConversationPersistenceHookForTests((phase, filePath) => {
      if (phase !== "before-quarantine" || failed) return
      failed = filePath
      throw new Error("injected entry failure")
    })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    const other = path.join(directory, path.basename(failed!) === "a.pb.gz" ? "b.pb.gz" : "a.pb.gz")
    expect((await stat(failed!)).isFile()).toBe(true)
    await expect(stat(other)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("ages previous-schema snapshots by their persisted timestamp", async () => {
    const cacheDir = await root()
    const directory = conversationCacheDirectoryPath(cacheDir)
    const previous = (updatedAt: number) => {
      const bytes = Uint8Array.from(protobufSnapshot(updatedAt))
      bytes[1] = CONVERSATION_CACHE_SCHEMA_VERSION - 1
      return gzipSync(bytes)
    }
    const expiredPath = path.join(directory, "previous-expired.pb.gz")
    await writeFile(expiredPath, previous(now - CONVERSATION_CACHE_TTL_MS - 1))
    const freshPath = await snapshot(cacheDir, previous(now))
    let decodes = 0
    setConversationPersistenceHookForTests((phase) => { if (phase === "full-decode") decodes++ })
    await waitForConversationMaintenanceForTests(cacheDir, now)
    await expect(stat(expiredPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(freshPath)).isFile()).toBe(true)
    expect((await loadPersistedConversation(cacheDir, sessionKey, now)).status).toBe("invalid")
    expect(decodes).toBe(0)
  })

  it("collects an orphaned writer temp file only after its persisted age expires", async () => {
    const cacheDir = await root()
    const directory = conversationCacheDirectoryPath(cacheDir)
    const base = path.basename(conversationCacheFilePath(cacheDir, sessionKey))
    const expiredTemp = path.join(directory, `.${base}.1.expired.tmp`)
    const freshTemp = path.join(directory, `.${base}.2.fresh.tmp`)
    const partialTemp = path.join(directory, `.${base}.3.partial.tmp`)
    await writeFile(expiredTemp, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)))
    await writeFile(freshTemp, gzipSync(protobufSnapshot(now)))
    await writeFile(partialTemp, gzipSync(protobufSnapshot(now - CONVERSATION_CACHE_TTL_MS - 1)).subarray(0, 4))
    await waitForConversationMaintenanceForTests(cacheDir, now)
    await expect(stat(expiredTemp)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(freshTemp)).isFile()).toBe(true)
    expect((await stat(partialTemp)).isFile()).toBe(true)
  })
})

describe("streaming snapshot metadata", () => {
  it("waits for fragmented varints and strings before accepting metadata", () => {
    const bytes = protobufSnapshot()
    let metadataEnd = 0
    for (let length = 0; length <= bytes.length; length++) {
      const result = parseConversationCacheHeader(bytes.subarray(0, length))
      if (result) {
        expect(result).toEqual({ status: "metadata", value: {
          schemaVersion: CONVERSATION_CACHE_SCHEMA_VERSION, sessionKey, conversationId: "conversation-current", updatedAt: now,
        } })
        metadataEnd = length
        break
      }
    }
    expect(metadataEnd).toBeGreaterThan(20)
    expect(metadataEnd).toBeLessThan(bytes.length)
  })

  it("stops a highly compressed payload and preserves handle ownership/offset", async () => {
    const cacheDir = await root()
    const bytes = gzipSync(protobufSnapshot(now, "bounded", Buffer.alloc(64 * 1024 * 1024)))
    const handle = await open(await snapshot(cacheDir, bytes), "r")
    try {
      expect(await readConversationCacheHeader(handle)).toMatchObject({ status: "metadata", value: { updatedAt: now } })
      expect(await handle.readFile()).toEqual(bytes)
    } finally { await handle.close() }
  })

  it("defers oversized metadata and compressed-header bounds without declaring corruption", async () => {
    const cacheDir = await root()
    const largeKey = protobuf.Writer.create().uint32(8).uint32(CONVERSATION_CACHE_SCHEMA_VERSION)
      .uint32(18).string("x".repeat(16 * 1024)).finish()
    let handle = await open(await snapshot(cacheDir, gzipSync(largeKey)), "r")
    try { expect(await readConversationCacheHeader(handle)).toEqual({ status: "indeterminate" }) }
    finally { await handle.close() }
    const gzip = gzipSync(protobufSnapshot())
    const header = Uint8Array.from(gzip.subarray(0, 10))
    header[3] = 8 // Optional gzip filename preceding deflate data.
    handle = await open(await snapshot(cacheDir, Buffer.concat([
      header, Buffer.alloc(MAX_CACHE_HEADER_INPUT_BYTES, 65), Buffer.from([0]), gzip.subarray(10),
    ])), "r")
    try { expect(await readConversationCacheHeader(handle)).toEqual({ status: "indeterminate" }) }
    finally { await handle.close() }
  })

  it("distinguishes truncated input and cancellation from usable metadata", async () => {
    const cacheDir = await root()
    const handle = await open(await snapshot(cacheDir, gzipSync(Buffer.from([8]))), "r")
    try {
      expect(await readConversationCacheHeader(handle)).toEqual({ status: "invalid" })
      const abort = new AbortController()
      abort.abort(new Error("test cancellation"))
      await expect(Promise.resolve().then(() => readConversationCacheHeader(handle, abort.signal)))
        .rejects.toThrow("test cancellation")
    } finally { await handle.close() }
  })
})
