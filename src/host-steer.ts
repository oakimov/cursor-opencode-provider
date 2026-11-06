import { processShared } from "./process-shared.js"

// OpenCode 2 promotes a steer only at a step boundary, which a Cursor-side wait (AwaitShell) lacks.
export type HostSteer = { sessionID: string; inboxID: string; text: string }

export type EarlySteer = HostSteer & {
  injectionId: string
  /** The Cursor Run (`CursorSession.sessionId`) it was injected into, or the Run resumed from its checkpoint. */
  run: string
  delivered: boolean
  /** A checkpoint arrived after Cursor delivered it, so a Run resumed from that checkpoint holds it. */
  checkpointed: boolean
  /** Its Run reached `turn_ended` after delivering it, so the model has answered it. */
  answered: boolean
  /** OpenCode's own copy came after the step's tool results and was left out of the continuation. */
  promoted?: boolean
  /** Prompt boundary at which the host supplied its copy; distinct later replies do not match it. */
  hostTurn?: string
}

type HostSteerState = {
  listeners: Map<string, (steer: HostSteer) => boolean>
  injected: Map<string, EarlySteer[]>
  queued: Map<string, HostSteer>
  announced: Set<string>
}

const MAX_RECORDS_PER_SESSION = 32
const MAX_REMEMBERED = 256

// The plugin and the model can be separate copies of this module, and each plugin copy sees every event.
const state = processShared<HostSteerState>("host-steers.v1", () => ({
  listeners: new Map(),
  injected: new Map(),
  queued: new Map(),
  announced: new Set(),
}))

function remember<K>(entries: Map<K, unknown> | Set<K>, key: K): void {
  while (entries.size > MAX_REMEMBERED) {
    const oldest = entries.keys().next().value as K | undefined
    if (oldest === undefined || oldest === key) break
    entries.delete(oldest)
  }
}

/** undefined when another plugin copy already announced the steer. */
export function announceHostSteer(steer: HostSteer): boolean | undefined {
  if (state.announced.has(steer.inboxID)) return undefined
  state.announced.add(steer.inboxID)
  remember(state.announced, steer.inboxID)
  const listener = state.listeners.get(steer.sessionID)
  return listener ? listener(steer) : false
}

/** Remember a queued message, so a later switch to `steer` can announce it. */
export function rememberQueuedSteer(steer: HostSteer): void {
  if (state.announced.has(steer.inboxID)) return
  state.queued.delete(steer.inboxID)
  state.queued.set(steer.inboxID, steer)
  remember(state.queued, steer.inboxID)
}

export function takeQueuedSteer(inboxID: string): HostSteer | undefined {
  const steer = state.queued.get(inboxID)
  state.queued.delete(inboxID)
  return steer
}

export function listenForHostSteers(sessionID: string, listener: (steer: HostSteer) => boolean): () => void {
  state.listeners.set(sessionID, listener)
  return () => {
    if (state.listeners.get(sessionID) === listener) state.listeners.delete(sessionID)
  }
}

/** false when there is no room to track it; OpenCode's own copy then runs as usual. */
export function recordEarlySteer(steer: EarlySteer): boolean {
  const records = state.injected.get(steer.sessionID)
  if (records ? records.length >= MAX_RECORDS_PER_SESSION : state.injected.size >= MAX_REMEMBERED) return false
  state.injected.set(steer.sessionID, [...records ?? [], steer])
  return true
}

function keep(sessionID: string, records: EarlySteer[]): void {
  if (records.length === 0) state.injected.delete(sessionID)
  else state.injected.set(sessionID, records)
}

export function findEarlySteer(sessionID: string | undefined, injectionId: string): EarlySteer | undefined {
  return sessionID ? state.injected.get(sessionID)?.find((record) => record.injectionId === injectionId) : undefined
}

export function isEarlySteerTracked(sessionID: string, injectionId: string): boolean {
  return !!state.injected.get(sessionID)?.some((record) => record.injectionId === injectionId)
}

/** An injection Cursor never accepted. A promoted one stays, to be sent at `turn_ended`. */
export function forgetUndeliveredEarlySteer(sessionID: string, injectionId: string): void {
  keep(sessionID, (state.injected.get(sessionID) ?? [])
    .filter((record) => record.injectionId !== injectionId || record.delivered || record.promoted))
}

/** The host withdrew the message, so no copy of it will come. */
export function forgetEarlySteerOfInbox(sessionID: string, inboxID: string): void {
  keep(sessionID, (state.injected.get(sessionID) ?? []).filter((record) => record.inboxID !== inboxID))
}

/** true when the injection is an early steer. */
export function markEarlySteerDelivered(sessionID: string | undefined, injectionId: string | undefined): boolean {
  const record = sessionID && injectionId
    ? state.injected.get(sessionID)?.find((candidate) => candidate.injectionId === injectionId)
    : undefined
  if (record) record.delivered = true
  return !!record
}

export function markEarlySteersCheckpointed(sessionID: string | undefined, run: string): void {
  for (const record of (sessionID && state.injected.get(sessionID)) || []) {
    if (record.run === run && record.delivered) record.checkpointed = true
  }
}

/**
 * At `turn_ended`: a delivered steer is answered and waits for OpenCode's copy; one Cursor never took is
 * forgotten, so OpenCode's copy runs as an ordinary message. A promoted one has no copy left to come:
 * one Cursor never took is returned for a follow-up Run and stays, as sent, until a checkpoint holds it.
 * Answered receipts survive retries and are retired when a later Run finishes.
 */
export function settleEarlySteers(
  sessionID: string | undefined,
  run: string,
): { answered: number; undelivered: EarlySteer[]; leftToHost: number } {
  const records = sessionID ? state.injected.get(sessionID) : undefined
  if (!records) return { answered: 0, undelivered: [], leftToHost: 0 }
  let answered = 0
  let leftToHost = 0
  const undelivered: EarlySteer[] = []
  const kept = records.filter((record) => {
    if (record.run !== run) return !record.answered
    if (record.promoted) {
      if (record.delivered) {
        if (!record.answered) { record.answered = true; answered++ }
        return true
      }
      undelivered.push(record)
      record.delivered = true
      return true
    }
    if (!record.delivered) {
      leftToHost++
      return false
    }
    if (!record.answered) {
      record.answered = true
      answered++
    }
    return true
  })
  keep(sessionID!, kept)
  return { answered, undelivered, leftToHost }
}

/**
 * A failed Run's steers: those its checkpoint holds go to the Run resumed from it (`to`), and so does a
 * promoted one it does not hold, to be sent at that Run's `turn_ended`. The rest are forgotten, so
 * OpenCode's own copy of each runs as an ordinary message. A rebase (`to` undefined) seeds from host
 * history, which already holds a promoted copy.
 */
export function handOverEarlySteers(sessionID: string | undefined, from: string, to: string | undefined): void {
  const records = sessionID ? state.injected.get(sessionID) : undefined
  if (!records) return
  keep(sessionID!, records.filter((record) => {
    if (record.run !== from || record.answered) return true
    if (!to || (!record.checkpointed && !record.promoted)) return false
    record.run = to
    if (!record.checkpointed) record.delivered = false
    return true
  }))
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** The host may add `<system-reminder>` parts to a promoted copy; any other difference is another message. */
export function carriesSteer(message: string, text: string): boolean {
  return message.replace(SYSTEM_REMINDER, "").trim() === text.trim()
}

/** The record each message carries, or nothing unless every message carries one. */
export function matchEarlySteers(
  sessionID: string | undefined,
  messages: readonly string[],
  accept: (record: EarlySteer) => boolean,
): EarlySteer[] {
  const records = sessionID ? state.injected.get(sessionID) : undefined
  if (!records?.length || messages.length === 0) return []
  const candidates = [...records]
  const matched: EarlySteer[] = []
  for (const message of messages) {
    const index = candidates.findIndex((record) => accept(record) && carriesSteer(message, record.text))
    if (index === -1) return []
    matched.push(...candidates.splice(index, 1))
  }
  return matched
}

export function forgetEarlySteerRecords(sessionID: string, records: readonly EarlySteer[]): void {
  keep(sessionID, (state.injected.get(sessionID) ?? []).filter((record) => !records.includes(record)))
}

/**
 * A steer of a Run that ended without answering it (a stop, a failed recovery) that only host history
 * holds reliably: OpenCode placed it in its history (a checkpoint may hold it too, and resuming would
 * then send it twice), or a checkpoint holds it while OpenCode's copy is still to come.
 */
export function needsHostHistory(sessionID: string | undefined, openRun: string | undefined): boolean {
  return !!sessionID && !!state.injected.get(sessionID)?.some((record) =>
    !record.answered && record.run !== openRun && (record.promoted || record.checkpointed))
}

/** Keep answered receipts until the new turn succeeds, so a host retry still omits its copies. */
export function clearUnansweredEarlySteers(sessionID: string | undefined): void {
  if (sessionID) keep(sessionID, (state.injected.get(sessionID) ?? []).filter((record) => record.answered))
}

/** Private restart metadata, saved atomically with the checkpoint it describes. */
export function serializeEarlySteers(sessionID: string): string | undefined {
  const records = state.injected.get(sessionID)
  return records?.length ? JSON.stringify({ version: 1, records }) : undefined
}

export function restoreEarlySteers(sessionID: string, encoded: string | undefined): void {
  if (!encoded || state.injected.has(sessionID) || state.injected.size >= MAX_REMEMBERED) return
  let value: { version?: unknown; records?: unknown }
  try { value = JSON.parse(encoded) } catch { return }
  if (!value || value.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS_PER_SESSION) return
  const records: EarlySteer[] = []
  for (const record of value.records) {
    if (!record || record.sessionID !== sessionID
      || ![record.inboxID, record.injectionId, record.run, record.text].every((part) => typeof part === "string" && part.length > 0)
      || ![record.delivered, record.checkpointed, record.answered].every((part) => typeof part === "boolean")
      || ((record.checkpointed || record.answered) && !record.delivered)
      || (record.promoted !== undefined && typeof record.promoted !== "boolean")
      || (record.hostTurn !== undefined && (typeof record.hostTurn !== "string" || !/^[a-f0-9]{64}$/.test(record.hostTurn)))) return
    records.push({
      sessionID, inboxID: record.inboxID, injectionId: record.injectionId, run: record.run, text: record.text,
      delivered: record.delivered, checkpointed: record.checkpointed, answered: record.answered,
      ...(record.promoted !== undefined ? { promoted: record.promoted } : {}),
      ...(record.hostTurn !== undefined ? { hostTurn: record.hostTurn } : {}),
    })
  }
  if (records.length) state.injected.set(sessionID, records)
}

export function forgetEarlySteers(sessionID: string): void {
  state.injected.delete(sessionID)
  state.listeners.delete(sessionID)
}

export function resetHostSteersForTests(): void {
  state.listeners.clear()
  state.injected.clear()
  state.queued.clear()
  state.announced.clear()
}
