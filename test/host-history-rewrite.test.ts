import { afterEach, expect, spyOn, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  acknowledgeHostHistoryRewrite, awaitHostHistoryRewrite, hasHostHistoryRewrite,
  MAX_CONSUMED_HOST_HISTORY_REWRITES, noteHostHistoryRewrite, resetHostHistoryRewritesForTests,
} from "../src/host-history-rewrite.js"
import {
  bindConversationId, MAX_ACTIVE_CONVERSATION_BINDINGS, peekConversationId, resetConversationBindingsForTests,
  sessionIdToUuid,
} from "../src/protocol/conversation-bind.js"
import {
  conversationCacheFilePath, getPersistedConversation, resetConversationPersistenceForTests,
  setConversationPersistenceHookForTests,
} from "../src/protocol/conversation-persistence.js"
import {
  hydrateConversationState, hydrateTurnProvenance, onCopyStateReplaced, persistConversationState, resetSnapshotGenerationsForTests,
  snapshotGenerationRecordsForTests,
} from "../src/protocol/conversation-state.js"
import { getTurnProvenance, resetTurnProvenanceForTests, restoreTurnProvenance } from "../src/protocol/turn-provenance.js"
import { dropLostRequest, hasLostRequest, rememberLostRequest } from "../src/lost-request.js"
import {
  recordSessionEditsGuidance, resetSessionEditsGuidanceForTests, sessionEditsGuidance,
} from "../src/protocol/session-edits.js"
import { clearCheckpoint, getCheckpoint, resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { encodeMessage } from "../src/protocol/messages.js"

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "cursor-module-graph-rewrite-"))
  roots.push(value)
  return value
}
afterEach(() => {
  resetHostHistoryRewritesForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetSnapshotGenerationsForTests()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})
/** The message a promise rejects with; bun-types types the `rejects` matchers as synchronous. */
const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("Expected the promise to reject")
}

test("a rewrite without saved Cursor state leaves restart free to build its full context", async () => {
  const cache = root()
  await noteHostHistoryRewrite(cache, "empty", "evt_empty")
  resetHostHistoryRewritesForTests()
  resetConversationPersistenceForTests()
  expect(await getPersistedConversation(cache, "empty")).toBeUndefined()
})

test("a failed receipt save fails the request barrier and can be retried", async () => {
  const cache = root()
  await persistConversationState(cache, { sessionKey: "retry", conversationId: peekConversationId("retry"),
    requestContext: { rules_info_complete: true } })
  setConversationPersistenceHookForTests(phase => {
    if (phase === "before-write") throw new Error("disk unavailable")
  })
  expect(await rejectionMessage(noteHostHistoryRewrite(cache, "retry", "evt_retry"))).toContain("disk unavailable")
  expect(await rejectionMessage(awaitHostHistoryRewrite(cache, "retry"))).toContain("disk unavailable")
  expect(hasHostHistoryRewrite(cache, "retry")).toBe(true)
  setConversationPersistenceHookForTests()
  expect(await awaitHostHistoryRewrite(cache, "retry")).toBe(true)
  expect((await getPersistedConversation(cache, "retry"))?.postCompactionRebase).toBe(true)
  acknowledgeHostHistoryRewrite(cache, "absent")
})

test("separate module graphs share committed receipts and fence late saves", async () => {
  const cache = root()
  const graph = root()
  cpSync(resolve(import.meta.dir, "../src"), join(graph, "src"), { recursive: true })
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(graph, "node_modules"), "dir")
  const other = await import(pathToFileURL(join(graph, "src/host-history-rewrite.ts")).href) as typeof import("../src/host-history-rewrite.js")
  const otherState = await import(pathToFileURL(join(graph, "src/protocol/conversation-state.ts")).href) as typeof import("../src/protocol/conversation-state.js")
  const otherBinding = await import(pathToFileURL(join(graph, "src/protocol/conversation-bind.ts")).href) as typeof import("../src/protocol/conversation-bind.js")
  const otherPersistence = await import(pathToFileURL(join(graph, "src/protocol/conversation-persistence.ts")).href) as typeof import("../src/protocol/conversation-persistence.js")
  expect(other.noteHostHistoryRewrite).not.toBe(noteHostHistoryRewrite)
  expect(otherState.persistConversationState).not.toBe(persistConversationState)
  expect(otherBinding.bindConversationId).not.toBe(bindConversationId)
  try {
    const sessionKey = "copies"
    const old = peekConversationId(sessionKey)
    await persistConversationState(cache, { sessionKey, conversationId: old, requestContext: { rules_info_complete: true } })
    await Promise.all([
      noteHostHistoryRewrite(cache, sessionKey, "evt_copies"),
      other.noteHostHistoryRewrite(cache, sessionKey, "evt_copies"),
      otherState.persistConversationState(cache, { sessionKey, conversationId: old, requestContext: { rules_info_complete: true }, runInProgress: true }),
    ])
    expect(await other.awaitHostHistoryRewrite(cache, sessionKey)).toBe(true)
    expect((await getPersistedConversation(cache, sessionKey))?.postCompactionRebase).toBe(true)
    const next = bindConversationId(sessionKey, { reset: true }).conversationId
    acknowledgeHostHistoryRewrite(cache, sessionKey)
    expect(otherBinding.peekConversationId(sessionKey)).toBe(next)
    await persistConversationState(cache, { sessionKey, conversationId: next, requestContext: { rules_info_complete: true } })
    await otherState.persistConversationState(cache, { sessionKey, conversationId: old, requestContext: { rules_info_complete: true }, runInProgress: true })
    expect((await getPersistedConversation(cache, sessionKey))?.conversationId).toBe(next)
    expect((await getPersistedConversation(cache, sessionKey))?.postCompactionRebase).toBe(false)
    await other.noteHostHistoryRewrite(cache, sessionKey, "evt_copies")
    expect(await awaitHostHistoryRewrite(cache, sessionKey)).toBe(false)
    await other.noteHostHistoryRewrite(cache, sessionKey, "evt_copies_second")
    expect(await awaitHostHistoryRewrite(cache, sessionKey)).toBe(true)
  } finally {
    otherPersistence.resetConversationPersistenceForTests()
  }
})

// A moved session, or a Location loaded again after an idle eviction, runs in a copy that never served it.
const otherGraph = async () => {
  const graph = root()
  cpSync(resolve(import.meta.dir, "../src"), join(graph, "src"), { recursive: true })
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(graph, "node_modules"), "dir")
  const load = (file: string) => import(pathToFileURL(join(graph, "src", file)).href)
  return {
    state: await load("protocol/conversation-state.ts") as typeof import("../src/protocol/conversation-state.js"),
    checkpoint: await load("protocol/checkpoint.ts") as typeof import("../src/protocol/checkpoint.js"),
    frozen: await load("context/frozen.ts") as typeof import("../src/context/frozen.js"),
    persistence: await load("protocol/conversation-persistence.ts") as typeof import("../src/protocol/conversation-persistence.js"),
    sessionEdits: await load("protocol/session-edits.ts") as typeof import("../src/protocol/session-edits.js"),
    provenance: await load("protocol/turn-provenance.ts") as typeof import("../src/protocol/turn-provenance.js"),
  }
}
const checkpointBytes = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 1, max_tokens: 2 } })
const evictBindings = () => {
  for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) bindConversationId(`busy-${index}`)
}

test("a module copy that never served the bound conversation restores its snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(checkpointBytes)
    expect(other.frozen.getFrozenRequestContext(conversationId)).toEqual({ rules_info_complete: true })
    // Each copy keeps its live state once it has served the conversation.
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy that wrote the latest snapshot keeps its live state after its own stores drop the conversation", async () => {
  const cache = root()
  const sessionKey = "evicted-locally"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    // A checkpoint dropped on purpose and a frozen context the LRU evicted leave nothing to recognize the copy by.
    clearCheckpoint(conversationId)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  } finally {
    resetCheckpointsForTests()
  }
})

test("a copy behind another copy's newer save restores it", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-back"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    setCheckpoint(conversationId, newer)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.replacesCopyState).toBe(true)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy at the latest snapshot waits for another copy's save still being written", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "queued-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    setConversationPersistenceHookForTests(async phase => { if (phase === "before-write") await gate })
    setCheckpoint(conversationId, newer)
    const save = persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let settled = false
    const hydrated = other.state.hydrateConversationState(cache, sessionKey).finally(() => { settled = true })
    await Bun.sleep(30)
    expect(settled).toBe(false)
    release()
    await save
    expect((await hydrated)?.replacesCopyState).toBe(true)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    release()
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy reading the snapshot while another copy saves a newer one restores the newer one", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "saved-during-read"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let saved = false
    other.persistence.setConversationPersistenceHookForTests(async phase => {
      if (phase !== "full-decode" || saved) return
      saved = true
      setCheckpoint(conversationId, newer)
      await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(saved).toBe(true)
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a returning copy takes the edit-deny record of the snapshot it restores", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "deny-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    recordSessionEditsGuidance(conversationId, false)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.sessionEdits.recordSessionEditsGuidance(conversationId, true)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await hydrateConversationState(cache, sessionKey))?.replacesCopyState).toBe(true)
    // The restored checkpoint holds the other copy's deny, so lifting it needs the no-deny note.
    expect(sessionEditsGuidance(conversationId, false, { carriesEarlierState: true })).toBe(false)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetSessionEditsGuidanceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind takes what is on disk, also a delete or a snapshot without provenance", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "behind"
  const conversationId = peekConversationId(sessionKey)
  const stale = { conversationId, toolCallIds: [], text: "Older answer", textWithReasoning: "Older answer" }
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    restoreTurnProvenance(sessionKey, stale)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.provenance.forgetTurnProvenance(sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(replaced).toEqual([sessionKey])
    restoreTurnProvenance(sessionKey, stale)
    await other.state.clearPersistedConversationState(cache, sessionKey)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(replaced).toEqual([sessionKey, sessionKey])
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy's own save requested during its read wins over the older snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "own-save-during-read"
  const conversationId = peekConversationId(sessionKey)
  const middle = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 5, max_tokens: 9 } })
  const own = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  let save: Promise<void> | undefined
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.checkpoint.setCheckpoint(conversationId, middle)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(phase => {
      if (phase !== "full-decode" || save) return
      setCheckpoint(conversationId, own)
      save = persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    await save
    expect(getCheckpoint(conversationId)).toEqual(own)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toEqual(own)
  } finally {
    setConversationPersistenceHookForTests()
    await save
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind leaves its state alone when its own request moves the binding during the read", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "rebound-during-read"
  const conversationId = peekConversationId(sessionKey)
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let next: string | undefined
    setConversationPersistenceHookForTests(phase => {
      if (phase === "full-decode" && !next) next = bindConversationId(sessionKey, { reset: true }).conversationId
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(next).toBeDefined()
    expect(replaced).toEqual([])
    expect(peekConversationId(sessionKey)).toBe(next!)
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("an unbound copy leaves a binding another request creates during its read alone", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "bound-during-unbound-read"
  const conversationId = peekConversationId(sessionKey)
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    evictBindings()
    let next: string | undefined
    setConversationPersistenceHookForTests(phase => {
      if (phase === "full-decode" && !next) next = bindConversationId(sessionKey, { reset: true }).conversationId
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(next).toBeDefined()
    expect(replaced).toEqual([])
    expect(peekConversationId(sessionKey)).toBe(next!)
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind drops its older checkpoint when its binding is evicted during the read", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "evicted-during-read"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let evicted = false
    setConversationPersistenceHookForTests(phase => {
      if (phase === "full-decode" && !evicted) {
        evicted = true
        evictBindings()
      }
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(evicted).toBe(true)
    expect(peekConversationId(sessionKey)).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind drops its older checkpoint when its binding is evicted while another copy's save fails", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "evicted-during-failed-save"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.persistence.setConversationPersistenceHookForTests(phase => {
      if (phase !== "before-write") return
      evictBindings()
      throw new Error("disk full")
    })
    const failing = rejectionMessage(other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } }))
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(await failing).toContain("disk full")
    expect(peekConversationId(sessionKey)).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy that gives up restoring drops its older checkpoint when its binding is evicted meanwhile", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "evicted-while-writing"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  let saves = 0
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(async phase => {
      if (phase !== "full-decode") return
      if (++saves === 3) evictBindings()
      await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(saves).toBe(3)
    expect(peekConversationId(sessionKey)).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a checkpoint another request receives while the binding changes during the read stays", async () => {
  const cache = root()
  const other = await otherGraph()
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  try {
    for (const evict of [false, true]) {
      const sessionKey = evict ? "evicted-then-checkpointed" : "reset-then-checkpointed"
      const conversationId = peekConversationId(sessionKey)
      setCheckpoint(conversationId, checkpointBytes)
      await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
      await other.state.hydrateConversationState(cache, sessionKey)
      await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
      let current: string | undefined
      setConversationPersistenceHookForTests(phase => {
        if (phase !== "full-decode" || current) return
        // The request binds the session again (or a reset rebinds it) and its Run receives a checkpoint.
        if (evict) evictBindings()
        current = evict ? conversationId : bindConversationId(sessionKey, { reset: true }).conversationId
        setCheckpoint(current, newer)
      })
      expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
      expect(getCheckpoint(current!)).toEqual(newer)
      setConversationPersistenceHookForTests()
    }
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind another copy's failed save does not refill its provenance from the older snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unsaved-provenance"
  const conversationId = peekConversationId(sessionKey)
  const stale = { conversationId, toolCallIds: [], text: "Older answer", textWithReasoning: "Older answer" }
  setCheckpoint(conversationId, checkpointBytes)
  try {
    restoreTurnProvenance(sessionKey, stale)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.persistence.setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })))
      .toContain("disk full")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    await hydrateTurnProvenance(cache, sessionKey)
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

test("no copy resumes an older snapshot while the latest save failed", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unsaved"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })))
      .toContain("disk full")
    setConversationPersistenceHookForTests()
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind another copy's failed save does not resume the older snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unsaved-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  other.checkpoint.setCheckpoint(conversationId, checkpointBytes)
  try {
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    other.persistence.setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })))
      .toContain("disk full")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
  }
})

test("a copy that served the conversation before drops its older checkpoint while another copy's latest save failed", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unsaved-after-return"
  const conversationId = peekConversationId(sessionKey)
  const middle = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 5, max_tokens: 9 } })
  const live = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.checkpoint.setCheckpoint(conversationId, middle)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    other.checkpoint.setCheckpoint(conversationId, live)
    other.persistence.setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })))
      .toContain("disk full")
    other.persistence.setConversationPersistenceHookForTests()
    // Neither the snapshot nor this copy's own checkpoint holds the turns the other copy ran: start from host history.
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
    expect(replaced).toEqual([sessionKey])
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(replaced).toEqual([sessionKey])
    // The copy whose save failed still holds the newest state.
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(live)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await hydrateConversationState(cache, sessionKey))?.replacesCopyState).toBe(true)
    expect(getCheckpoint(conversationId)).toEqual(live)
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind drops its older checkpoint when the latest snapshot is gone", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "deleted-after-return"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.clearPersistedConversationState(cache, sessionKey)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy that gives up restoring drops its older checkpoint", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "always-writing-after-return"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  let saves = 0
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(async phase => {
      if (phase !== "full-decode") return
      saves++
      await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(saves).toBe(3)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind leaves another copy's snapshot alone once the binding has moved past it", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-on-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  other.checkpoint.setCheckpoint(conversationId, checkpointBytes)
  try {
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    const next = bindConversationId(sessionKey, { reset: true }).conversationId
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
    expect(peekConversationId(sessionKey)).toBe(next)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
  }
})

test("a copy gives up restoring while another copy saves during every read", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "always-writing"
  const conversationId = peekConversationId(sessionKey)
  other.checkpoint.setCheckpoint(conversationId, checkpointBytes)
  let saves = 0
  try {
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    setConversationPersistenceHookForTests(async phase => {
      if (phase !== "full-decode") return
      saves++
      await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(saves).toBe(3)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
  }
})

test("a module copy leaves a snapshot alone once the binding has moved past it", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-on"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    const next = bindConversationId(sessionKey, { reset: true }).conversationId
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    expect(peekConversationId(sessionKey)).toBe(next)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("a module copy restoring a snapshot keeps process-shared state and a pending rewrite", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "moved-shared"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    rememberLostRequest({ sessionKey, conversationId, checkpoint: checkpointBytes, text: "Sent once" })
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    // Cursor kept the turn after the save; the snapshot's copy is stale.
    dropLostRequest(sessionKey)
    await noteHostHistoryRewrite(cache, sessionKey, "evt_moved")
    const restored = await other.state.hydrateConversationState(cache, sessionKey)
    expect(restored?.postCompactionRebase).toBe(true)
    expect(hasHostHistoryRewrite(cache, sessionKey)).toBe(true)
    expect(hasLostRequest(sessionKey)).toBe(false)
  } finally {
    dropLostRequest(sessionKey)
    other.persistence.resetConversationPersistenceForTests()
    resetCheckpointsForTests()
  }
})

test("snapshot generation records stay bounded and keep every bound session's record", async () => {
  const cache = root()
  const sessionKey = "bound-among-many"
  const conversationId = peekConversationId(sessionKey)
  const live = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index <= MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      expect(await hydrateConversationState(cache, `unbound-${index}`)).toBeUndefined()
    }
    expect(snapshotGenerationRecordsForTests()).toBe(MAX_ACTIVE_CONVERSATION_BINDINGS)
    // An evicted record would count this copy as behind and restore the older snapshot over its live checkpoint.
    setCheckpoint(conversationId, live)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toEqual(live)
  } finally {
    resetCheckpointsForTests()
  }
})

test("a copy whose snapshot record was evicted drops its older checkpoint while another copy's latest save failed", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "evicted-then-unsaved"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    // The session's binding and then its record are gone; the other copy rebinds it from disk.
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    other.persistence.setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })))
      .toContain("disk full")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy whose snapshot record was evicted drops its older checkpoint once another copy's newer snapshot is unreadable", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "evicted-then-unreadable"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    // The session's binding and then its record are gone; the other copy rebinds it from disk and saves a newer turn.
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    other.checkpoint.setCheckpoint(conversationId, newer)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    // Expiry or a decode failure loses that snapshot without a tracked write.
    writeFileSync(other.persistence.conversationCacheFilePath(cache, sessionKey), "not a snapshot")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(peekConversationId(sessionKey)).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy behind drops its older checkpoint once the snapshot another copy rebound the session from is unreadable", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "rebound-then-unreadable"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    other.checkpoint.setCheckpoint(conversationId, newer)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    // The record that saw the other copy's write is gone; the other copy rebinds the session from that snapshot.
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    writeFileSync(other.persistence.conversationCacheFilePath(cache, sessionKey), "not a snapshot")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy whose binding and record were evicted drops its older checkpoint when no snapshot rebinds the session", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unbound-then-unreadable"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    other.checkpoint.setCheckpoint(conversationId, newer)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    writeFileSync(other.persistence.conversationCacheFilePath(cache, sessionKey), "not a snapshot")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    // The next Run binds the session's default conversation id again.
    expect(peekConversationId(sessionKey)).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a copy holding the latest generation keeps its checkpoint when its binding was evicted and the snapshot is gone", async () => {
  const cache = root()
  const sessionKey = "unbound-latest"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) bindConversationId(`busy-${index}`)
    writeFileSync(conversationCacheFilePath(cache, sessionKey), "not a snapshot")
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toEqual(checkpointBytes)
  } finally {
    resetCheckpointsForTests()
  }
})

test("a copy behind drops its older checkpoint once another copy took up the session without a snapshot", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "adopted-cold-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    other.checkpoint.setCheckpoint(conversationId, newer)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    writeFileSync(other.persistence.conversationCacheFilePath(cache, sessionKey), "not a snapshot")
    // The other copy returns first, finds no snapshot, and its next Run binds the session again before saving.
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toBeUndefined()
    expect(peekConversationId(sessionKey)).toBe(conversationId)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("an unbound copy behind drops its older checkpoint while another copy's latest save failed, and that copy keeps its own", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unbound-then-unsaved"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect((await other.state.hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    other.checkpoint.setCheckpoint(conversationId, newer)
    other.persistence.setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })))
      .toContain("disk full")
    other.persistence.setConversationPersistenceHookForTests()
    // The binding is gone; the record of the failed save outlives the cap.
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
    expect(await other.state.hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(other.checkpoint.getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    other.persistence.setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("an unbound copy that gives up restoring drops its older checkpoint", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unbound-always-writing"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  let saves = 0
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) bindConversationId(`busy-${index}`)
    setConversationPersistenceHookForTests(async phase => {
      if (phase !== "full-decode") return
      saves++
      await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    })
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(saves).toBe(3)
    expect(getCheckpoint(conversationId)).toBeUndefined()
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("an unbound copy behind takes a snapshot without provenance over its own older state", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unbound-behind-provenance"
  const conversationId = peekConversationId(sessionKey)
  const stale = { conversationId, toolCallIds: [], text: "Older answer", textWithReasoning: "Older answer" }
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    restoreTurnProvenance(sessionKey, stale)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.provenance.forgetTurnProvenance(sessionKey)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
      bindConversationId(`busy-${index}`)
      expect(await hydrateConversationState(cache, `busy-${index}`)).toBeUndefined()
    }
    replaced.length = 0
    expect((await hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(replaced).toEqual([sessionKey])
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

test("an unbound copy behind takes the edit-deny record of the snapshot it restores", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unbound-deny-elsewhere"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  try {
    recordSessionEditsGuidance(conversationId, false)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    other.sessionEdits.recordSessionEditsGuidance(conversationId, true)
    await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    evictBindings()
    expect((await hydrateConversationState(cache, sessionKey))?.replacesCopyState).toBe(true)
    // The restored checkpoint holds the other copy's deny, so lifting it needs the no-deny note.
    expect(sessionEditsGuidance(conversationId, false, { carriesEarlierState: true })).toBe(false)
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetSessionEditsGuidanceForTests()
    resetCheckpointsForTests()
  }
})

test("an unbound copy behind another copy's delete drops its own older turn state", async () => {
  const cache = root()
  const other = await otherGraph()
  const sessionKey = "unbound-behind-delete"
  const conversationId = peekConversationId(sessionKey)
  const stale = { conversationId, toolCallIds: [], text: "Older answer", textWithReasoning: "Older answer" }
  const replaced: string[] = []
  onCopyStateReplaced(key => replaced.push(key))
  setCheckpoint(conversationId, checkpointBytes)
  try {
    restoreTurnProvenance(sessionKey, stale)
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    await other.state.hydrateConversationState(cache, sessionKey)
    await other.state.clearPersistedConversationState(cache, sessionKey)
    evictBindings()
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(getCheckpoint(conversationId)).toBeUndefined()
    expect(replaced).toEqual([sessionKey])
  } finally {
    other.persistence.resetConversationPersistenceForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

/** A new process: nothing of this one's per-session state survives, only the cache directory. */
const restartProcess = () => {
  resetSnapshotGenerationsForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetTurnProvenanceForTests()
  resetCheckpointsForTests()
}

test("a failed save invalidates the older snapshot even when directory allocation fails", async () => {
  const cache = root()
  const sessionKey = "full-disk-cleanup"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
  const noSpace = Object.assign(new Error("disk full"), { code: "ENOSPC" })
  const mkdir = spyOn(fsPromises, "mkdir").mockRejectedValue(noSpace)
  try {
    setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw noSpace
    })
    expect(await rejectionMessage(persistConversationState(cache, { sessionKey, conversationId,
      requestContext: { rules_info_complete: true } }))).toContain("disk full")
  } finally {
    mkdir.mockRestore()
    setConversationPersistenceHookForTests()
  }
  restartProcess()
  expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  expect(await getPersistedConversation(cache, sessionKey)).toBeUndefined()
})

test("a failed save also invalidates snapshot copies left in quarantine", async () => {
  const cache = root()
  const sessionKey = "failed-save-quarantine"
  const conversationId = peekConversationId(sessionKey)
  setCheckpoint(conversationId, checkpointBytes)
  await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
  const filePath = conversationCacheFilePath(cache, sessionKey)
  const directory = join(dirname(filePath), ".gc", basename(filePath))
  await fsPromises.mkdir(directory, { recursive: true })
  await fsPromises.copyFile(filePath, join(directory, "older.snapshot"))
  setConversationPersistenceHookForTests(phase => {
    if (phase === "before-write") throw new Error("disk full")
  })
  expect(await rejectionMessage(persistConversationState(cache, { sessionKey, conversationId,
    requestContext: { rules_info_complete: true } }))).toContain("disk full")
  restartProcess()
  expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  expect(await getPersistedConversation(cache, sessionKey)).toBeUndefined()
})

test("a copy behind drops stale state when snapshot reading throws, bound or unbound", async () => {
  const cache = root()
  const other = await otherGraph()
  try {
    for (const unbound of [false, true]) {
      const sessionKey = unbound ? "unbound-read-io-error" : "bound-read-io-error"
      const conversationId = peekConversationId(sessionKey)
      setCheckpoint(conversationId, checkpointBytes)
      await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
      await other.state.hydrateConversationState(cache, sessionKey)
      await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
      restoreTurnProvenance(sessionKey, { conversationId, toolCallIds: [], text: "Older", textWithReasoning: "Older" })
      if (unbound) evictBindings()
      setConversationPersistenceHookForTests(phase => {
        if (phase === "full-decode") throw Object.assign(new Error("snapshot read failed"), { code: "EIO" })
      })
      expect(await rejectionMessage(hydrateConversationState(cache, sessionKey))).toContain("snapshot read failed")
      expect(getCheckpoint(conversationId)).toBeUndefined()
      expect(getTurnProvenance(sessionKey)).toBeUndefined()
      setConversationPersistenceHookForTests()
    }
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

test("snapshot read failures preserve checkpoints a concurrent request received or this copy still owns", async () => {
  const cache = root()
  const other = await otherGraph()
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  try {
    for (const mode of ["latest", "received", "rebound"]) {
      const sessionKey = `read-failure-${mode}`
      const conversationId = peekConversationId(sessionKey)
      setCheckpoint(conversationId, checkpointBytes)
      await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
      await other.state.hydrateConversationState(cache, sessionKey)
      if (mode !== "latest") {
        await other.state.persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
      } else evictBindings()
      let current = conversationId
      setConversationPersistenceHookForTests(phase => {
        if (phase !== "full-decode") return
        if (mode === "rebound") current = bindConversationId(sessionKey, { reset: true }).conversationId
        if (mode !== "latest") setCheckpoint(current, newer)
        throw new Error("snapshot read failed")
      })
      expect(await rejectionMessage(hydrateConversationState(cache, sessionKey))).toContain("snapshot read failed")
      expect(getCheckpoint(current)).toEqual(mode === "latest" ? checkpointBytes : newer)
      setConversationPersistenceHookForTests()
    }
  } finally {
    setConversationPersistenceHookForTests()
    other.persistence.resetConversationPersistenceForTests()
    other.checkpoint.resetCheckpointsForTests()
    resetCheckpointsForTests()
  }
})

test("a restart after a failed save starts from host history instead of the older snapshot", async () => {
  const cache = root()
  const sessionKey = "restart-after-failed-save"
  const older = bindConversationId(sessionKey).conversationId
  const stale = { conversationId: older, toolCallIds: [], text: "Older answer", textWithReasoning: "Older answer" }
  setCheckpoint(older, checkpointBytes)
  try {
    restoreTurnProvenance(sessionKey, stale)
    await persistConversationState(cache, { sessionKey, conversationId: older, requestContext: { rules_info_complete: true } })
    // The failed save carries another conversation: whatever conversation the older snapshot holds goes.
    const current = bindConversationId(sessionKey, { reset: true }).conversationId
    setConversationPersistenceHookForTests(phase => {
      if (phase === "before-write") throw new Error("disk full")
    })
    expect(await rejectionMessage(persistConversationState(cache, { sessionKey, conversationId: current,
      requestContext: { rules_info_complete: true } }))).toContain("disk full")
    restartProcess()
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
    await hydrateTurnProvenance(cache, sessionKey)
    expect(getTurnProvenance(sessionKey)).toBeUndefined()
    expect(getCheckpoint(older)).toBeUndefined()
    expect(await getPersistedConversation(cache, sessionKey)).toBeUndefined()
  } finally {
    setConversationPersistenceHookForTests()
    resetTurnProvenanceForTests()
    resetCheckpointsForTests()
  }
})

test("a save queued behind a failed one is kept, also across a restart", async () => {
  const cache = root()
  const sessionKey = "save-after-failed-save"
  const conversationId = peekConversationId(sessionKey)
  const newer = encodeMessage("ConversationStateStructure", { token_details: { used_tokens: 7, max_tokens: 9 } })
  setCheckpoint(conversationId, checkpointBytes)
  try {
    await persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    let failed = false
    setConversationPersistenceHookForTests(phase => {
      if (phase !== "before-write" || failed) return
      failed = true
      throw new Error("disk full")
    })
    const failing = rejectionMessage(persistConversationState(cache, { sessionKey, conversationId,
      requestContext: { rules_info_complete: true } }))
    setCheckpoint(conversationId, newer)
    const landing = persistConversationState(cache, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    expect(await failing).toContain("disk full")
    await landing
    restartProcess()
    expect((await hydrateConversationState(cache, sessionKey))?.conversationId).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toEqual(newer)
  } finally {
    setConversationPersistenceHookForTests()
    resetCheckpointsForTests()
  }
})

test("at most the cap's worth of unbound failed-save records stay past the cap, also after concurrent saves", async () => {
  const cache = root()
  setConversationPersistenceHookForTests(phase => {
    if (phase === "before-write") throw new Error("disk full")
  })
  try {
    const failures = await Promise.all(Array.from({ length: 2 * MAX_ACTIVE_CONVERSATION_BINDINGS + 88 }, (_, index) => {
      const sessionKey = `failed-${index}`
      return rejectionMessage(persistConversationState(cache, { sessionKey, conversationId: sessionIdToUuid(sessionKey),
        requestContext: { rules_info_complete: true } }))
    }))
    expect(failures.every(message => message.includes("disk full"))).toBe(true)
    expect(snapshotGenerationRecordsForTests()).toBe(MAX_ACTIVE_CONVERSATION_BINDINGS)
  } finally {
    setConversationPersistenceHookForTests()
  }
})

test("snapshot generation records of bound sessions are kept past the cap", async () => {
  const cache = root()
  for (let index = 0; index < MAX_ACTIVE_CONVERSATION_BINDINGS; index++) {
    const sessionKey = `bound-${index}`
    bindConversationId(sessionKey)
    expect(await hydrateConversationState(cache, sessionKey)).toBeUndefined()
  }
  expect(snapshotGenerationRecordsForTests()).toBe(MAX_ACTIVE_CONVERSATION_BINDINGS)
  expect(await hydrateConversationState(cache, "unbound-late")).toBeUndefined()
  expect(snapshotGenerationRecordsForTests()).toBe(MAX_ACTIVE_CONVERSATION_BINDINGS + 1)
})

test("keeps a bounded set of consumed receipts and every pending one", async () => {
  const cache = root()
  const rewrites = () => (globalThis as Record<symbol, { rewrites: Map<string, { pending: boolean }> }>)[
    Symbol.for("cursor-opencode-provider.host-history-rewrite.v1")]!.rewrites
  await noteHostHistoryRewrite(cache, "waiting", "evt_waiting")
  const total = MAX_CONSUMED_HOST_HISTORY_REWRITES + 20
  for (let i = 0; i < total; i++) {
    await noteHostHistoryRewrite(cache, `consumed-${i}`, `evt_${i}`)
    acknowledgeHostHistoryRewrite(cache, `consumed-${i}`)
  }
  expect([...rewrites().values()].filter((rewrite) => !rewrite.pending)).toHaveLength(MAX_CONSUMED_HOST_HISTORY_REWRITES)
  expect(hasHostHistoryRewrite(cache, "waiting")).toBe(true)
  // The newest tombstone still absorbs a late copy of its event.
  await noteHostHistoryRewrite(cache, `consumed-${total - 1}`, `evt_${total - 1}`)
  expect(hasHostHistoryRewrite(cache, `consumed-${total - 1}`)).toBe(false)
})
