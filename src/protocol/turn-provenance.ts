import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

// A sticky Cursor conversation only knows what Cursor itself produced. When the
// host answers a turn with another model (another provider or a local model)
// and then comes back, resuming the old checkpoint hides that work from Cursor.
// A direct switch between two Cursor models is not foreign history: like the
// Cursor CLI, the next Run resumes the same conversation with the new model.
// Remember what this provider emitted in its most recent step per OpenCode
// session so the next fresh Run can tell whether the host's latest assistant
// turn is ours.

/** Mirrors MAX_TURN_STATE_SESSIONS; evicted sessions re-hydrate from disk. */
export const MAX_PROVENANCE_SESSIONS = 256
// Per-session footprint stays small: a step is identified by its first tool
// call ids and the first 4 KiB of its text (and of its reasoning plus text),
// which is enough to tell turns apart.
const MAX_TOOL_CALL_IDS = 64
const MAX_TEXT_CHARS = 4 * 1024

export type TurnProvenance = {
  conversationId: string
  /** Tool call ids emitted in the latest non-empty step. */
  toolCallIds: string[]
  /** Whitespace-free text emitted in the latest non-empty step (first 4 KiB). */
  text: string
  /**
   * Whitespace-free reasoning and text of the same step in emission order
   * (first 4 KiB). OpenCode 1.x replays a previous model's reasoning as text
   * parts after a model switch (`session/message-v2.ts` `differentModel`), and
   * OpenCode 2 does the same for an assistant message that ended in error.
   */
  textWithReasoning: string
}

export type ForeignHistoryReason = "foreign-assistant"

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

function entryFor(sessionKey: string, conversationId: string): Entry {
  const existing = provenanceBySession.get(sessionKey)
  if (existing && existing.conversationId === conversationId) return touch(sessionKey, existing)
  return touch(sessionKey, { conversationId, toolCallIds: [], text: "", textWithReasoning: "", stepPending: false })
}

function appendCapped(value: string, delta: string): string {
  return value.length < MAX_TEXT_CHARS ? (value + delta).slice(0, MAX_TEXT_CHARS) : value
}

function contentEntry(sessionKey: string, conversationId: string): Entry {
  const entry = entryFor(sessionKey, conversationId)
  if (entry.stepPending) {
    entry.stepPending = false
    entry.toolCallIds = []
    entry.text = ""
    entry.textWithReasoning = ""
  }
  return entry
}

/**
 * Mark the start of one host step (one doStream). The previous step stays
 * recorded until this one emits content, because hosts drop empty assistant
 * turns from history.
 */
export function beginEmittedStep(sessionKey: string, conversationId: string): void {
  entryFor(sessionKey, conversationId).stepPending = true
}

/** Record one stream part this provider handed to the host. */
export function recordEmittedPart(
  sessionKey: string,
  conversationId: string,
  part: { type: string; delta?: unknown; toolCallId?: unknown },
): void {
  if ((part.type === "text-delta" || part.type === "reasoning-delta") && typeof part.delta === "string") {
    const delta = normalizeText(part.delta)
    if (!delta) return
    const entry = contentEntry(sessionKey, conversationId)
    entry.textWithReasoning = appendCapped(entry.textWithReasoning, delta)
    if (part.type === "text-delta") entry.text = appendCapped(entry.text, delta)
    return
  }
  if (part.type === "tool-call" && typeof part.toolCallId === "string" && part.toolCallId) {
    const entry = contentEntry(sessionKey, conversationId)
    if (entry.toolCallIds.length < MAX_TOOL_CALL_IDS) entry.toolCallIds.push(part.toolCallId)
  }
}

/**
 * Bind provenance to the conversation a Run was opened on. A reminted
 * conversation starts with an empty record, so it never inherits the previous
 * conversation's steps.
 */
export function trackTurnProvenance(sessionKey: string, conversationId: string): void {
  entryFor(sessionKey, conversationId)
}

export function getTurnProvenance(sessionKey: string): TurnProvenance | undefined {
  const entry = provenanceBySession.get(sessionKey)
  if (!entry) return undefined
  return {
    conversationId: entry.conversationId,
    toolCallIds: [...entry.toolCallIds],
    text: entry.text,
    textWithReasoning: entry.textWithReasoning,
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
      toolCallIds: Array.isArray(value.toolCallIds)
        ? value.toolCallIds.filter((id): id is string => typeof id === "string").slice(0, MAX_TOOL_CALL_IDS)
        : [],
      text: typeof value.text === "string" ? value.text.slice(0, MAX_TEXT_CHARS) : "",
      textWithReasoning: typeof value.textWithReasoning === "string"
        ? value.textWithReasoning.slice(0, MAX_TEXT_CHARS)
        : "",
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
  prompt: LanguageModelV3CallOptions["prompt"]
}): ForeignHistoryReason | undefined {
  if (!input.sessionKey) return undefined
  const entry = provenanceBySession.get(input.sessionKey)
  if (!entry || entry.conversationId !== input.conversationId) return undefined

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
  let textWithReasoning = ""
  for (const part of lastAssistant.content as unknown as Array<Record<string, unknown>>) {
    if (part.type === "tool-call" && typeof part.toolCallId === "string") toolCallIds.push(part.toolCallId)
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
      const normalized = normalizeText(part.text)
      textWithReasoning += normalized
      if (part.type === "text") text += normalized
    }
  }
  // A turn carrying only typed reasoning gives no evidence either way.
  if (toolCallIds.length === 0 && !text) return undefined
  if (toolCallIds.some((id) => entry.toolCallIds.includes(id))) return undefined
  // Compare against the latest step only: a foreign "Done." must not match an
  // older Cursor turn that happened to contain the same words. Same model: the
  // host keeps our reasoning typed, so its text parts match our text. After a
  // model switch OpenCode 1.x replays that reasoning as text parts in place,
  // so the turn matches our reasoning and text in emission order instead.
  if (entry.text && text.slice(0, MAX_TEXT_CHARS) === entry.text) return undefined
  if (entry.textWithReasoning && textWithReasoning.slice(0, MAX_TEXT_CHARS) === entry.textWithReasoning) {
    return undefined
  }
  return "foreign-assistant"
}
