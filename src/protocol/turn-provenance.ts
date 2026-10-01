import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

// A sticky Cursor conversation only knows what Cursor itself produced. When the
// host answers a turn with another model (another provider, or another Cursor
// model) and then comes back, resuming the old checkpoint hides that work from
// Cursor and has been observed to end Runs with Connect `internal` errors.
// Remember what this provider emitted in its most recent step per OpenCode
// session so the next fresh Run can tell whether the host's latest assistant
// turn is ours.

/** Mirrors MAX_TURN_STATE_SESSIONS; evicted sessions re-hydrate from disk. */
export const MAX_PROVENANCE_SESSIONS = 256
// Per-session footprint stays small: a step is identified by its first tool
// call ids and the first 4 KiB of its text, which is enough to tell turns apart.
const MAX_TOOL_CALL_IDS = 64
const MAX_TEXT_CHARS = 4 * 1024

export type TurnProvenance = {
  conversationId: string
  modelId?: string
  /** Tool call ids emitted in the latest non-empty step. */
  toolCallIds: string[]
  /** Whitespace-free text emitted in the latest non-empty step (first 4 KiB). */
  text: string
}

export type ForeignHistoryReason = "model-switch" | "foreign-assistant"

type Entry = TurnProvenance & {
  /** A new host step began; its first content replaces the recorded step. */
  stepPending: boolean
}

const provenanceBySession = new Map<string, Entry>()

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "")
}

function touch(sessionKey: string, entry: Entry): Entry {
  provenanceBySession.delete(sessionKey)
  provenanceBySession.set(sessionKey, entry)
  while (provenanceBySession.size > MAX_PROVENANCE_SESSIONS) {
    const oldest = provenanceBySession.keys().next().value as string | undefined
    if (!oldest) break
    provenanceBySession.delete(oldest)
  }
  return entry
}

function entryFor(sessionKey: string, conversationId: string, modelId?: string): Entry {
  const existing = provenanceBySession.get(sessionKey)
  if (existing && existing.conversationId === conversationId) {
    if (modelId) existing.modelId = modelId
    return touch(sessionKey, existing)
  }
  return touch(sessionKey, { conversationId, modelId, toolCallIds: [], text: "", stepPending: false })
}

function contentEntry(sessionKey: string, conversationId: string, modelId?: string): Entry {
  const entry = entryFor(sessionKey, conversationId, modelId)
  if (entry.stepPending) {
    entry.stepPending = false
    entry.toolCallIds = []
    entry.text = ""
  }
  return entry
}

/**
 * Mark the start of one host step (one doStream). The previous step stays
 * recorded until this one emits content, because hosts drop empty assistant
 * turns from history.
 */
export function beginEmittedStep(sessionKey: string, conversationId: string, modelId?: string): void {
  entryFor(sessionKey, conversationId, modelId).stepPending = true
}

/** Record one stream part this provider handed to the host. */
export function recordEmittedPart(
  sessionKey: string,
  conversationId: string,
  modelId: string | undefined,
  part: { type: string; delta?: unknown; toolCallId?: unknown },
): void {
  if (part.type === "text-delta" && typeof part.delta === "string") {
    const delta = normalizeText(part.delta)
    if (!delta) return
    const entry = contentEntry(sessionKey, conversationId, modelId)
    if (entry.text.length < MAX_TEXT_CHARS) entry.text = (entry.text + delta).slice(0, MAX_TEXT_CHARS)
    return
  }
  if (part.type === "tool-call" && typeof part.toolCallId === "string" && part.toolCallId) {
    const entry = contentEntry(sessionKey, conversationId, modelId)
    if (entry.toolCallIds.length < MAX_TOOL_CALL_IDS) entry.toolCallIds.push(part.toolCallId)
  }
}

/** Remember which Cursor model a Run on this conversation was opened with. */
export function recordRunModel(sessionKey: string, conversationId: string, modelId: string): void {
  entryFor(sessionKey, conversationId, modelId)
}

export function getTurnProvenance(sessionKey: string): TurnProvenance | undefined {
  const entry = provenanceBySession.get(sessionKey)
  if (!entry) return undefined
  return {
    conversationId: entry.conversationId,
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    toolCallIds: [...entry.toolCallIds],
    text: entry.text,
  }
}

export function restoreTurnProvenance(sessionKey: string, value: TurnProvenance): void {
  touch(sessionKey, { ...value, toolCallIds: [...value.toolCallIds], stepPending: false })
}

export function resetTurnProvenanceForTests(): void {
  provenanceBySession.clear()
}

export function serializeTurnProvenance(value: TurnProvenance): string {
  return JSON.stringify(value)
}

export function parseTurnProvenance(raw: string): TurnProvenance | undefined {
  try {
    const value = JSON.parse(raw) as Partial<TurnProvenance>
    if (typeof value.conversationId !== "string" || !value.conversationId) return undefined
    return {
      conversationId: value.conversationId,
      ...(typeof value.modelId === "string" && value.modelId ? { modelId: value.modelId } : {}),
      toolCallIds: Array.isArray(value.toolCallIds)
        ? value.toolCallIds.filter((id): id is string => typeof id === "string").slice(0, MAX_TOOL_CALL_IDS)
        : [],
      text: typeof value.text === "string" ? value.text.slice(0, MAX_TEXT_CHARS) : "",
    }
  } catch {
    return undefined
  }
}

/**
 * Decide whether the host history moved past this Cursor conversation.
 * Returns undefined when there is no evidence either way (no record for this
 * conversation, or no assistant turn yet), so unknown state never forces a
 * rebase.
 */
export function detectForeignHistory(input: {
  sessionKey: string | undefined
  conversationId: string
  modelId: string
  prompt: LanguageModelV3CallOptions["prompt"]
}): ForeignHistoryReason | undefined {
  if (!input.sessionKey) return undefined
  const entry = provenanceBySession.get(input.sessionKey)
  if (!entry || entry.conversationId !== input.conversationId) return undefined
  if (entry.modelId && entry.modelId !== input.modelId) return "model-switch"

  let lastAssistant: (typeof input.prompt)[number] | undefined
  for (let i = input.prompt.length - 1; i >= 0; i--) {
    if (input.prompt[i]!.role === "assistant") {
      lastAssistant = input.prompt[i]
      break
    }
  }
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) return undefined

  const toolCallIds: string[] = []
  let text = ""
  for (const part of lastAssistant.content as unknown as Array<Record<string, unknown>>) {
    if (part.type === "tool-call" && typeof part.toolCallId === "string") toolCallIds.push(part.toolCallId)
    // Reasoning is excluded: hosts replay a different model's reasoning as
    // plain text, and our own reasoning is not recorded.
    if (part.type === "text" && typeof part.text === "string") text += normalizeText(part.text)
  }
  if (toolCallIds.length === 0 && !text) return undefined
  if (toolCallIds.some((id) => entry.toolCallIds.includes(id))) return undefined
  // Compare against the latest step only: a foreign "Done." must not match an
  // older Cursor turn that happened to contain the same words.
  if (text && entry.text && text.slice(0, MAX_TEXT_CHARS) === entry.text) return undefined
  return "foreign-assistant"
}
