import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

// A sticky Cursor conversation only knows what Cursor itself produced. When the
// host answers a turn with another model (another provider, or another Cursor
// model) and then comes back, resuming the old checkpoint hides that work from
// Cursor and has been observed to end Runs with Connect `internal` errors.
// Remember what this provider emitted per OpenCode session so the next fresh
// Run can tell whether the host's latest assistant turn is ours.

const MAX_TOOL_CALL_IDS = 256
const MAX_TEXT_CHARS = 64 * 1024

export type TurnProvenance = {
  conversationId: string
  modelId?: string
  toolCallIds: string[]
  /** Whitespace-free concatenation of emitted text, newest last, bounded. */
  text: string
}

export type ForeignHistoryReason = "model-switch" | "foreign-assistant"

const provenanceBySession = new Map<string, TurnProvenance>()

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "")
}

function entryFor(sessionKey: string, conversationId: string, modelId?: string): TurnProvenance {
  const existing = provenanceBySession.get(sessionKey)
  if (existing && existing.conversationId === conversationId) {
    if (modelId) existing.modelId = modelId
    return existing
  }
  const fresh: TurnProvenance = { conversationId, modelId, toolCallIds: [], text: "" }
  provenanceBySession.set(sessionKey, fresh)
  return fresh
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
    const entry = entryFor(sessionKey, conversationId, modelId)
    entry.text = (entry.text + delta).slice(-MAX_TEXT_CHARS)
    return
  }
  if (part.type === "tool-call" && typeof part.toolCallId === "string" && part.toolCallId) {
    const entry = entryFor(sessionKey, conversationId, modelId)
    entry.toolCallIds.push(part.toolCallId)
    if (entry.toolCallIds.length > MAX_TOOL_CALL_IDS) {
      entry.toolCallIds.splice(0, entry.toolCallIds.length - MAX_TOOL_CALL_IDS)
    }
  }
}

/** Remember which Cursor model a Run on this conversation was opened with. */
export function recordRunModel(sessionKey: string, conversationId: string, modelId: string): void {
  entryFor(sessionKey, conversationId, modelId)
}

export function getTurnProvenance(sessionKey: string): TurnProvenance | undefined {
  const entry = provenanceBySession.get(sessionKey)
  return entry ? { ...entry, toolCallIds: [...entry.toolCallIds] } : undefined
}

export function restoreTurnProvenance(sessionKey: string, value: TurnProvenance): void {
  provenanceBySession.set(sessionKey, { ...value, toolCallIds: [...value.toolCallIds] })
}

export function clearTurnProvenance(sessionKey: string): void {
  provenanceBySession.delete(sessionKey)
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
        ? value.toolCallIds.filter((id): id is string => typeof id === "string").slice(-MAX_TOOL_CALL_IDS)
        : [],
      text: typeof value.text === "string" ? value.text.slice(-MAX_TEXT_CHARS) : "",
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
  if (text && entry.text.includes(text)) return undefined
  return "foreign-assistant"
}
