import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import {
  conversationCacheDirectoryPath,
  conversationCacheFilePath,
  getPersistedConversation,
  initializeConversationPersistence,
  loadPersistedConversation,
  persistConversation,
  resetConversationPersistenceForTests,
} from "../src/protocol/conversation-persistence.js"
import {
  hydrateConversationState,
  persistConversationState,
} from "../src/protocol/conversation-state.js"
import {
  bindConversationId,
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import {
  getCheckpoint,
  resetCheckpointsForTests,
  setCheckpoint,
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
import { CONVERSATION_CACHE_TTL_MS } from "../src/shared.js"
import { encodeMessage } from "../src/protocol/messages.js"
import {
  pump,
  resetTurnStateForTests,
  resolveTurnToolState,
  restoreTurnToolCatalog,
} from "../src/language-model.js"
import type { CursorSession, Frame } from "../src/session.js"

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

function turnEndedSession(root: string, checkpoint: Uint8Array): CursorSession {
  const payloads = [
    encodeMessage("AgentServerMessage", { conversation_checkpoint_update: checkpoint }),
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
  return {
    sessionId: "turn-ended-persistence",
    conversationId: "turn-ended-conversation",
    cacheDir: root,
    openCodeSessionId: "ses_turn_ended",
    stream: {
      write() {},
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as CursorSession["stream"],
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
    expiresAt: Date.now() + 10_000,
  } as CursorSession
}

describe("conversation restart persistence", () => {
  beforeEach(clearMemory)

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
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
    })

    clearMemory()
    const hydrated = await hydrateConversationState(root, sessionKey)
    expect(hydrated?.conversationId).toBe(conversationId)
    expect(hydrated?.toolCatalog).toEqual(toolCatalog)
    restoreTurnToolCatalog(sessionKey, hydrated!.toolCatalog)
    // A hydrated catalog is re-advertised on every lifecycle turn so the
    // RequestContext keeps its shape and the prompt cache survives; execution
    // stays refused until a turn actually arrives with tools.
    expect(await resolveTurnToolState({ sessionKey, incomingTools: [], isCompaction: false }))
      .toEqual({ advertisedTools: toolCatalog, allowTools: false })
    expect(await resolveTurnToolState({ sessionKey, incomingTools: [], isCompaction: true }))
      .toEqual({ advertisedTools: toolCatalog, allowTools: false })
    expect(bindConversationId(sessionKey).conversationId).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toEqual(checkpoint)
    expect(getConversationBlob(conversationId, blobId)).toEqual(blobData)
    const restoredContext = getFrozenRequestContext(conversationId)
    expect(restoredContext).toMatchObject({ env: requestContext.env, rules_info_complete: true })
    expect(restoredContext?.tools).toBeUndefined()
  })

  it("takes the durable snapshot at the successful TurnEnded boundary", async () => {
    const root = await cacheRoot()
    const checkpoint = Uint8Array.from([7, 8, 9])
    const session = turnEndedSession(root, checkpoint)
    restoreConversationBinding(session.openCodeSessionId!, session.conversationId)
    session.postCompactionRebase = true
    session.toolCatalog = [{ name: "bash", inputSchema: { type: "object" } }]
    const parts: unknown[] = []
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) },
      error(error: unknown) { throw error },
    } as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

    clearMemory()
    const restored = await getPersistedConversation(root, "ses_turn_ended")
    expect(restored?.conversationId).toBe("turn-ended-conversation")
    expect(restored?.checkpoint).toEqual(checkpoint)
    expect(restored?.postCompactionRebase).toBe(true)
    expect(restored?.toolCatalog).toEqual(session.toolCatalog)
    expect(parts.some((part: any) => part.type === "finish")).toBe(true)
  })

  it("does not migrate legacy JSON snapshots", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_legacy_json"
    const legacyPath = conversationCacheFilePath(root, sessionKey).replace(/\.pb\.gz$/, ".json")
    await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
    await writeFile(legacyPath, JSON.stringify({ schemaVersion: 2, conversation: {} }))

    await initializeConversationPersistence(root)

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

  it("prunes records older than 24 hours at startup but keeps the exact boundary", async () => {
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
    await initializeConversationPersistence(staleRoot, writtenAt + CONVERSATION_CACHE_TTL_MS + 1)
    expect((await loadPersistedConversation(staleRoot, value.sessionKey)).status).toBe("expired")
    await expect(stat(conversationCacheFilePath(staleRoot, value.sessionKey)))
      .rejects.toMatchObject({ code: "ENOENT" })

    clearMemory()
    await initializeConversationPersistence(boundaryRoot, writtenAt + CONVERSATION_CACHE_TTL_MS)
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
    await initializeConversationPersistence(root)

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
