import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import {
  conversationCacheDirectoryPath,
  conversationCacheFilePath,
  getPersistedConversation,
  loadPersistedConversation,
  persistConversation,
  resetConversationPersistenceForTests,
  waitForConversationMaintenanceForTests,
} from "../src/protocol/conversation-persistence.js"
import {
  hydrateConversationState,
  persistConversationState,
} from "../src/protocol/conversation-state.js"
import {
  bindConversationId,
  MAX_ACTIVE_CONVERSATION_BINDINGS,
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import {
  getCheckpoint,
  resetCheckpointsForTests,
  setCheckpoint,
  checkpointTokenDetails,
} from "../src/protocol/checkpoint.js"
import {
  getConversationBlob,
  resetConversationBlobsForTests,
  setConversationBlob,
} from "../src/protocol/blob-store.js"
import {
  getFrozenRequestContext,
  resetFrozenRequestContextsForTests,
  setFrozenRequestContext,
} from "../src/context/frozen.js"
import {
  confirmHistoryImagesAtTurnEnd,
  heldHistoryImageHashes,
  noteHistoryImageCheckpoint,
  noteHistoryImagesSent,
  runHistoryImages,
  snapshotHeldHistoryImagesForTests,
} from "../src/protocol/sent-history-images.js"
import { CONVERSATION_CACHE_TTL_MS } from "../src/shared.js"
import { recordSessionEditsGuidance, sessionEditsGuidance } from "../src/protocol/session-edits.js"
import { encodeMessage } from "../src/protocol/messages.js"
import {
  pump,
  resetTurnStateForTests,
  resolveTurnToolState,
  restoreTurnToolCatalog,
} from "../src/language-model.js"
import type { CursorSession, Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

const roots: string[] = []

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-conversation-cache-"))
  roots.push(root)
  return root
}

function clearMemory(): void {
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetConversationBlobsForTests()
  resetFrozenRequestContextsForTests()
  resetTurnStateForTests()
}

function turnEndedSession(root: string, checkpoint: Uint8Array | undefined): CursorSession {
  const payloads = [
    ...(checkpoint ? [encodeMessage("AgentServerMessage", { conversation_checkpoint_update: checkpoint })] : []),
    encodeMessage("AgentServerMessage", {
      interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
    }),
  ]
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
      : { done: true, value: undefined },
  }
  return sessionFixture({
    sessionId: "turn-ended-persistence",
    conversationId: "turn-ended-conversation",
    cacheDir: root,
    openCodeSessionId: "ses_turn_ended",
    stream: {
      write() {},
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
      isClosed: () => false,
      onTerminal: () => () => {},
    },
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { rules_info_complete: true },
    allowTools: true,
    usageEstimate: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
    },
    pumpActive: true,
    heartbeat: null,
  })
}

describe("conversation restart persistence", () => {
  beforeEach(clearMemory)

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  it("persists measured occupancy independently of the zero-token resume checkpoint", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_occupancy_restart"
    const conversationId = "conversation-occupancy-restart"
    // Independently specified protobuf #5: used_tokens=42, max_tokens=256.
    const measured = Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, 2)
    const terminal = Uint8Array.of(0x2a, 5, 8, 0, 16, 0x80, 2)
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, measured)
    setCheckpoint(conversationId, terminal)
    await persistConversationState(root, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    const file = conversationCacheFilePath(root, sessionKey)
    const raw = gunzipSync(await readFile(file))
    // Private cache field #18 (wire type 2) holds only the measured field #5.
    expect(raw.includes(Buffer.from([0x92, 1, measured.length, ...measured]))).toBe(true)
    clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(getCheckpoint(conversationId)).toEqual(terminal)
    expect(checkpointTokenDetails(conversationId, terminal)?.usedTokens).toBe(42)

    // Wrong wire type for #18 invalidates the snapshot rather than trusting it.
    await writeFile(file, gzipSync(Buffer.concat([raw, Buffer.from([0x90, 1, 1])])))
    clearMemory()
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("invalid")
  })

  it("stores confirmation metadata under the independently specified private field 21", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_guard_cache"
    const occupancyGuard = '{"version":1}'
    await persistConversation(root, {
      sessionKey, conversationId: "conv-guard-cache",
      blobs: [], requestContext: { rules_info_complete: true }, toolCatalog: [], postCompactionRebase: false, occupancyGuard,
    })
    const file = conversationCacheFilePath(root, sessionKey)
    const raw = gunzipSync(await readFile(file))
    // Independent protobuf tag: field21/wire2 = 0xaa 0x01; payload is 13 UTF-8 bytes.
    expect(raw.includes(Buffer.from([0xaa, 1, 13, ...Buffer.from(occupancyGuard)]))).toBe(true)
    clearMemory()
    expect((await loadPersistedConversation(root, sessionKey)).value?.occupancyGuard).toBe(occupancyGuard)
    // A wrong wire type must invalidate the snapshot rather than trusting the record.
    await writeFile(file, gzipSync(Buffer.concat([raw, Buffer.from([0xa8, 1, 1])])))
    clearMemory()
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("invalid")
  })

  it("persists whether a session edit deny was ever sent, so a restart adds no needless correction", async () => {
    const root = await cacheRoot()
    const requestContext = { rules_info_complete: true }
    const checkpoint = Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, 2)
    const save = async (sessionKey: string, conversationId: string, denied: boolean) => {
      restoreConversationBinding(sessionKey, conversationId)
      setCheckpoint(conversationId, checkpoint)
      recordSessionEditsGuidance(conversationId, denied)
      await persistConversationState(root, { sessionKey, conversationId, requestContext })
      return gunzipSync(await readFile(conversationCacheFilePath(root, sessionKey)))
    }
    // Private cache field #19 (varint): tag 0x98 0x01, value 1.
    const marker = Buffer.from([0x98, 1, 1])
    expect((await save("ses_never_denied", "conv-never-denied", false)).includes(marker)).toBe(false)
    expect((await save("ses_was_denied", "conv-was-denied", true)).includes(marker)).toBe(true)

    clearMemory()
    await hydrateConversationState(root, "ses_never_denied")
    await hydrateConversationState(root, "ses_was_denied")
    const carried = { carriesEarlierState: true }
    expect(sessionEditsGuidance("conv-never-denied", false, carried)).toBeUndefined()
    expect(sessionEditsGuidance("conv-was-denied", false, carried)).toBe(false)

    // Wrong wire type for #19 invalidates the snapshot rather than trusting it.
    const file = conversationCacheFilePath(root, "ses_was_denied")
    const raw = gunzipSync(await readFile(file))
    await writeFile(file, gzipSync(Buffer.concat([raw, Buffer.from([0x9a, 1, 0])])))
    clearMemory()
    expect((await loadPersistedConversation(root, "ses_was_denied")).status).toBe("invalid")
  })

  it("restores the complete resumable state after process memory is cleared", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_restart"
    const conversationId = "conversation-after-compaction"
    const checkpoint = Uint8Array.from([1, 2, 3, 255])
    const blobId = Uint8Array.from([10, 11, 12])
    const blobData = Uint8Array.from([0, 4, 8, 12])
    const requestContext = {
      tools: [{
        name: "opencode-read",
        tool_name: "read",
        provider_identifier: "opencode",
        input_schema: Uint8Array.from([123, 125]),
      }],
      env: { process_working_directory: "/tmp/project", workspace_paths: ["/tmp/project"] },
      rules_info_complete: true,
    }
    const toolCatalog = [{
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }]
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, checkpoint)
    setConversationBlob(conversationId, blobId, blobData)
    setFrozenRequestContext(conversationId, requestContext)
    await persistConversationState(root, {
      sessionKey,
      conversationId,
      requestContext,
      toolCatalog,
      hostAgent: "plan",
      systemPromptHash: "stable-prompt-hash",
    })

    clearMemory()
    const hydrated = await hydrateConversationState(root, sessionKey)
    expect(hydrated?.conversationId).toBe(conversationId)
    expect(hydrated?.toolCatalog).toEqual(toolCatalog)
    expect(hydrated?.hostAgent).toBe("plan")
    expect(hydrated?.systemPromptHash).toBe("stable-prompt-hash")
    restoreTurnToolCatalog(sessionKey, hydrated!.toolCatalog)
    // Host-empty lifecycle turns advertise [] (title / OC1 compaction). The
    // hydrated catalog is still available for the next nonempty turn.
    expect(await resolveTurnToolState({ sessionKey, incomingTools: [], isCompaction: false }))
      .toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({ sessionKey, incomingTools: [], isCompaction: true }))
      .toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({ sessionKey, incomingTools: toolCatalog, isCompaction: false }))
      .toEqual({ advertisedTools: toolCatalog, allowTools: true })
    expect(bindConversationId(sessionKey).conversationId).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toEqual(checkpoint)
    expect(getConversationBlob(conversationId, blobId)).toEqual(blobData)
    const restoredContext = getFrozenRequestContext(conversationId)
    expect(restoredContext).toMatchObject({ env: requestContext.env, rules_info_complete: true })
    expect(restoredContext?.tools).toBeUndefined()
  })

  it("keeps across a restart the history images the saved checkpoint holds", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_restart_images"
    const conversationId = "conversation-with-images"
    const checkpoint = Uint8Array.from([1])
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, checkpoint)
    const run = runHistoryImages()
    noteHistoryImagesSent(run, ["a", "b"])
    noteHistoryImageCheckpoint(run, sessionKey, conversationId, checkpoint)
    confirmHistoryImagesAtTurnEnd(run, sessionKey, conversationId, checkpoint)
    await persistConversationState(root, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })

    clearMemory()
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])
    await hydrateConversationState(root, sessionKey)
    expect([...heldHistoryImageHashes(sessionKey, conversationId, getCheckpoint(conversationId)!) ?? []]).toEqual(["a", "b"])
  })

  it("saves no history images beside a checkpoint that does not hold them", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_restart_images_mid_turn"
    const conversationId = "conversation-mid-turn"
    restoreConversationBinding(sessionKey, conversationId)
    const run = runHistoryImages()
    noteHistoryImagesSent(run, ["a"])
    noteHistoryImageCheckpoint(run, sessionKey, conversationId, Uint8Array.from([1]))
    confirmHistoryImagesAtTurnEnd(run, sessionKey, conversationId, Uint8Array.from([1]))
    // A save after Cursor moved on to a checkpoint nothing was confirmed for.
    setCheckpoint(conversationId, Uint8Array.from([2]))
    await persistConversationState(root, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })

    const saved = await getPersistedConversation(root, sessionKey)
    expect(saved?.sentImageHashes).toBeUndefined()
    expect(saved?.sentImagesCheckpoint).toBeUndefined()
    clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])
  })

  it("restores no history images from a snapshot written before they were saved with their checkpoint", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_old_snapshot"
    const conversationId = "conversation-old-snapshot"
    await persistConversation(root, {
      sessionKey,
      conversationId,
      checkpoint: Uint8Array.from([1]),
      blobs: [],
      requestContext: { rules_info_complete: true },
      toolCatalog: [],
      postCompactionRebase: false,
    })
    clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])

    // A hash list without the checkpoint it belongs to (field 16 alone) counts for nothing.
    const filePath = conversationCacheFilePath(root, sessionKey)
    const hash = Buffer.from("a".repeat(64))
    const field16 = Buffer.concat([Buffer.from([0x82, 0x01, hash.length]), hash])
    await writeFile(filePath, gzipSync(Buffer.concat([gunzipSync(await readFile(filePath)), field16])))
    clearMemory()
    expect((await getPersistedConversation(root, sessionKey))?.sentImageHashes).toBeUndefined()
    clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])
  })

  it("saves history image hashes on field 16 and their checkpoint on field 17", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_image_fields"
    const hashes = ["a".repeat(64), "b".repeat(64)]
    const checkpoint = "c".repeat(64)
    const text = (value: string) => [value.length, ...Buffer.from(value)]
    const fields = Buffer.from([
      0x82, 0x01, ...text(hashes[0]!), // sent_image_hashes #16
      0x82, 0x01, ...text(hashes[1]!), // sent_image_hashes #16
      0x8a, 0x01, ...text(checkpoint), // sent_images_checkpoint_sha256 #17
    ])
    const earlySteers = "early-steer-receipts"
    const lostRequest = "lost-request-record"
    const snapshot = {
      sessionKey,
      conversationId: "conversation-image-fields",
      checkpoint: Uint8Array.from([1]),
      blobs: [],
      requestContext: { rules_info_complete: true },
      toolCatalog: [],
      postCompactionRebase: false,
      earlySteers,
      lostRequest,
    }
    const filePath = conversationCacheFilePath(root, sessionKey)

    await persistConversation(root, { ...snapshot, sentImageHashes: hashes, sentImagesCheckpoint: checkpoint })
    const saved16and17 = gunzipSync(await readFile(filePath))
    expect(saved16and17.includes(fields)).toBe(true)
    expect(saved16and17.includes(Buffer.from([0x72, ...text(earlySteers)]))).toBe(true) // early_steers_json #14
    expect(saved16and17.includes(Buffer.from([0x7a, ...text(lostRequest)]))).toBe(true) // lost_request_json #15

    await persistConversation(root, snapshot)
    const withoutImages = gunzipSync(await readFile(filePath))
    expect(withoutImages.includes(fields)).toBe(false)
    await writeFile(filePath, gzipSync(Buffer.concat([withoutImages, fields])))
    clearMemory()
    const saved = await getPersistedConversation(root, sessionKey)
    expect(saved?.sentImageHashes).toEqual(hashes)
    expect(saved?.sentImagesCheckpoint).toBe(checkpoint)
    expect(saved?.earlySteers).toBe(earlySteers)
    expect(saved?.lostRequest).toBe(lostRequest)
  })

  it("keeps the older checkpoint's images when a turn ends without a checkpoint of its own", async () => {
    const root = await cacheRoot()
    const older = Uint8Array.from([4, 5])
    const session = turnEndedSession(root, undefined)
    const sessionKey = session.openCodeSessionId!
    restoreConversationBinding(sessionKey, session.conversationId)
    setCheckpoint(session.conversationId, older)
    const before = runHistoryImages()
    noteHistoryImagesSent(before, ["a"])
    noteHistoryImageCheckpoint(before, sessionKey, session.conversationId, older)
    confirmHistoryImagesAtTurnEnd(before, sessionKey, session.conversationId, older)
    session.historyImages = runHistoryImages(heldHistoryImageHashes(sessionKey, session.conversationId, older))
    noteHistoryImagesSent(session.historyImages, ["b"])
    await pump(session, {
      enqueue() {},
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

    const saved = await getPersistedConversation(root, sessionKey)
    expect(saved?.checkpoint).toEqual(older)
    expect(saved?.sentImageHashes).toEqual(["a"])
    clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect([...heldHistoryImageHashes(sessionKey, session.conversationId, older) ?? []]).toEqual(["a"])
  })

  it("takes the durable snapshot at the successful TurnEnded boundary", async () => {
    const root = await cacheRoot()
    const checkpoint = Uint8Array.from([7, 8, 9])
    const session = turnEndedSession(root, checkpoint)
    restoreConversationBinding(session.openCodeSessionId!, session.conversationId)
    session.postCompactionRebase = true
    session.hostAgent = "build"
    session.stableSystemPromptHash = "build-prompt-hash"
    session.toolCatalog = [{ name: "bash", inputSchema: { type: "object" } }]
    const parts: unknown[] = []
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) },
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

    clearMemory()
    const restored = await getPersistedConversation(root, "ses_turn_ended")
    expect(restored?.conversationId).toBe("turn-ended-conversation")
    expect(restored?.checkpoint).toEqual(checkpoint)
    expect(restored?.postCompactionRebase).toBe(true)
    expect(restored?.toolCatalog).toEqual(session.toolCatalog)
    expect(restored?.hostAgent).toBe("build")
    expect(restored?.systemPromptHash).toBe("build-prompt-hash")
    expect(parts.some((part: any) => part.type === "finish")).toBe(true)
  })

  it("does not migrate legacy JSON snapshots", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_legacy_json"
    const legacyPath = conversationCacheFilePath(root, sessionKey).replace(/\.pb\.gz$/, ".json")
    await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
    await writeFile(legacyPath, JSON.stringify({ schemaVersion: 2, conversation: {} }))

    await waitForConversationMaintenanceForTests(root)

    await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("missing")
  })

  it("does not let a late TurnEnded resurrect a superseded conversation", async () => {
    const root = await cacheRoot()
    restoreConversationBinding("ses_late", "current-conversation")
    await persistConversationState(root, {
      sessionKey: "ses_late",
      conversationId: "superseded-conversation",
      requestContext: { rules_info_complete: true },
    })
    expect(await getPersistedConversation(root, "ses_late")).toBeUndefined()
  })

  it("persists a reminted conversation after its recent binding is soft-evicted", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_evicted_remint"
    bindConversationId(sessionKey)
    const conversationId = bindConversationId(sessionKey, { reset: true }).conversationId
    const checkpoint = Uint8Array.from([7, 8, 9])
    setCheckpoint(conversationId, checkpoint)

    for (let i = 0; i < MAX_ACTIVE_CONVERSATION_BINDINGS; i++) {
      bindConversationId(`pressure-${i}`)
    }

    await persistConversationState(root, {
      sessionKey,
      conversationId,
      requestContext: { rules_info_complete: true },
    })
    clearMemory()
    const restored = await hydrateConversationState(root, sessionKey)
    expect(restored?.conversationId).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toEqual(checkpoint)
  })

  it("refreshes one session record instead of retaining its prior conversation id", async () => {
    const root = await cacheRoot()
    const now = 1_900_000_000_000
    const requestContext = { rules_info_complete: true }
    await persistConversation(root, {
      sessionKey: "ses_same",
      conversationId: "old-conversation",
      blobs: [],
      requestContext,
    }, now)
    await persistConversation(root, {
      sessionKey: "ses_same",
      conversationId: "new-conversation",
      checkpoint: Uint8Array.from([9]),
      blobs: [],
      requestContext,
    }, now + 1)

    const fileBytes = await readFile(conversationCacheFilePath(root, "ses_same"))
    expect([...fileBytes.subarray(0, 2)]).toEqual([0x1f, 0x8b])
    expect(gunzipSync(fileBytes)[0]).not.toBe("{".charCodeAt(0))
    clearMemory()
    expect(await getPersistedConversation(root, "ses_same")).toMatchObject({
      conversationId: "new-conversation",
      updatedAt: now + 1,
    })
  })

  it("prunes records older than 24 hours in maintenance but keeps the exact boundary", async () => {
    const staleRoot = await cacheRoot()
    const boundaryRoot = await cacheRoot()
    const writtenAt = 1_900_000_000_000
    const value = {
      sessionKey: "ses_age",
      conversationId: "aged-conversation",
      blobs: [],
      requestContext: { rules_info_complete: true },
    }
    await persistConversation(staleRoot, value, writtenAt)
    await persistConversation(boundaryRoot, value, writtenAt)

    clearMemory()
    await waitForConversationMaintenanceForTests(staleRoot, writtenAt + CONVERSATION_CACHE_TTL_MS + 1)
    expect((await loadPersistedConversation(staleRoot, value.sessionKey)).status).toBe("expired")
    await expect(stat(conversationCacheFilePath(staleRoot, value.sessionKey)))
      .rejects.toMatchObject({ code: "ENOENT" })

    clearMemory()
    await waitForConversationMaintenanceForTests(boundaryRoot, writtenAt + CONVERSATION_CACHE_TTL_MS)
    expect((await getPersistedConversation(boundaryRoot, value.sessionKey))?.conversationId)
      .toBe(value.conversationId)
    expect((await stat(conversationCacheFilePath(boundaryRoot, value.sessionKey))).isFile()).toBe(true)
  })

  it("serializes overlapping updates without losing either session", async () => {
    const root = await cacheRoot()
    const requestContext = { rules_info_complete: true }
    await Promise.all([
      persistConversation(root, {
        sessionKey: "ses_a",
        conversationId: "conversation-a",
        blobs: [],
        requestContext,
      }),
      persistConversation(root, {
        sessionKey: "ses_b",
        conversationId: "conversation-b",
        blobs: [],
        requestContext,
      }),
    ])

    clearMemory()
    expect((await getPersistedConversation(root, "ses_a"))?.conversationId).toBe("conversation-a")
    expect((await getPersistedConversation(root, "ses_b"))?.conversationId).toBe("conversation-b")
    const files = (await readdir(conversationCacheDirectoryPath(root)))
      .filter((name) => name.endsWith(".pb.gz"))
    expect(files).toHaveLength(2)
    expect(conversationCacheFilePath(root, "ses_a")).not.toBe(conversationCacheFilePath(root, "ses_b"))
  })

  it("does not lose an unrelated session written by another process with stale startup state", async () => {
    const root = await cacheRoot()
    const persistenceModule = new URL("../src/protocol/conversation-persistence.ts", import.meta.url).href
    const childScript = `
      const persistence = await import(${JSON.stringify(persistenceModule)})
      const root = ${JSON.stringify(root)}
      await persistence.getPersistedConversation(root, "ses_child")
      process.stdout.write("ready\\n")
      await new Promise((resolve) => process.stdin.once("data", resolve))
      await persistence.persistConversation(root, {
        sessionKey: "ses_child",
        conversationId: "conversation-child",
        blobs: [],
        requestContext: { rules_info_complete: true },
      })
    `
    const child = Bun.spawn([process.execPath, "-e", childScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    reader.releaseLock()
    expect(new TextDecoder().decode(ready.value)).toContain("ready")

    await persistConversation(root, {
      sessionKey: "ses_parent",
      conversationId: "conversation-parent",
      blobs: [],
      requestContext: { rules_info_complete: true },
    })
    child.stdin.write("continue\n")
    child.stdin.end()
    expect(await child.exited).toBe(0)

    clearMemory()
    expect((await getPersistedConversation(root, "ses_parent"))?.conversationId)
      .toBe("conversation-parent")
    expect((await getPersistedConversation(root, "ses_child"))?.conversationId)
      .toBe("conversation-child")
  })

  it("discards a corrupt session record and uses private permissions for its replacement", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_corrupt"
    const filePath = conversationCacheFilePath(root, sessionKey)
    await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
    await writeFile(filePath, "not protobuf gzip", "utf-8")
    await waitForConversationMaintenanceForTests(root)

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("invalid")
    await persistConversation(root, {
      sessionKey,
      conversationId: "replacement-conversation",
      blobs: [],
      requestContext: { rules_info_complete: true },
    })
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect((await stat(conversationCacheDirectoryPath(root))).mode & 0o777).toBe(0o700)
    }
  })
})
