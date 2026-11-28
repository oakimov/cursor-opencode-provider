/**
 * OpenCode 2 compaction through the session `compaction` hook.
 *
 * Setting `event.result` makes OpenCode skip its own model request and its
 * summary-template check (`fromHook`, upstream core `session/compaction.ts`).
 * The hook therefore asks this provider's own language model for Cursor's
 * summary (`summarize_action`) and hands the text back. The hook must never
 * throw: OpenCode registers promise hooks with `Effect.promise`, so a rejection
 * is a defect that crashes the step instead of failing the compaction. A
 * declined or failed hook instead marks the request, and the host's model call
 * that follows fails at once (see `compactionStream`).
 */

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider"

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Rec : undefined

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      const part = rec(item)
      return typeof part?.text === "string" ? part.text : ""
    }).filter(Boolean).join("\n")
  }
  return value === undefined ? "" : JSON.stringify(value)
}

/** An OpenCode 2 `ToolResultValue` as an AI SDK tool output. */
function toolOutput(result: unknown): Record<string, unknown> {
  const value = rec(result)
  switch (value?.type) {
    case "text": return { type: "text", value: textOf(value.value) }
    case "error": return { type: "error-text", value: textOf(value.value) }
    case "content": return { type: "text", value: textOf(value.value) }
    case "json": return { type: "json", value: value.value ?? null }
    default: return { type: "text", value: textOf(result) }
  }
}

/**
 * The hook's system parts and transcript (`@opencode/ai` messages) as an AI SDK
 * prompt, the shape the provider's Runs read. Text, reasoning, tool calls and
 * tool results carry over (tool results keep their `providerMetadata`, so a
 * recorded failure stays a failure). Media is not imported.
 */
export function hookPrompt(system: readonly unknown[] | undefined, messages: readonly unknown[] | undefined): LanguageModelV3Prompt {
  const prompt: Array<Record<string, unknown>> = []
  const systemText = (system ?? []).map((part) => textOf(rec(part)?.text ?? part)).filter(Boolean).join("\n\n")
  if (systemText) prompt.push({ role: "system", content: systemText })
  for (const item of messages ?? []) {
    const message = rec(item)
    const content = Array.isArray(message?.content) ? message.content.map(rec).filter((part): part is Rec => !!part) : []
    switch (message?.role) {
      case "system": {
        const text = content.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n")
        if (text) prompt.push({ role: "system", content: text })
        break
      }
      case "user": {
        const parts = content.filter((part) => part.type === "text" && typeof part.text === "string" && part.text)
          .map((part) => ({ type: "text", text: part.text }))
        if (parts.length) prompt.push({ role: "user", content: parts })
        break
      }
      case "assistant": {
        const parts = content.flatMap((part): Rec[] => {
          if (part.type === "text" && typeof part.text === "string" && part.text) return [{ type: "text", text: part.text }]
          if (part.type === "reasoning" && typeof part.text === "string" && part.text) return [{ type: "reasoning", text: part.text }]
          if (part.type === "tool-call" && typeof part.id === "string" && typeof part.name === "string") {
            return [{ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input ?? {} }]
          }
          return []
        })
        if (parts.length) prompt.push({ role: "assistant", content: parts })
        break
      }
      case "tool": {
        const parts = content.flatMap((part) => part.type === "tool-result" && typeof part.id === "string"
          ? [{
              type: "tool-result",
              toolCallId: part.id,
              toolName: typeof part.name === "string" ? part.name : "tool",
              output: toolOutput(part.result),
              ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
            }]
          : [])
        if (parts.length) prompt.push({ role: "tool", content: parts })
        break
      }
    }
  }
  return prompt as unknown as LanguageModelV3Prompt
}

const promptTokens = (tokens: unknown): number => {
  const t = rec(tokens)
  const cache = rec(t?.cache)
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0
  return n(t?.input) + n(cache?.read) + n(cache?.write)
}

/**
 * A background precompute summarizes only `messages.slice(0, anchor)`, where
 * the anchor is the latest assistant message with a measured prompt from this
 * provider (upstream core `session/compaction.ts`, `precompute`); a foreground
 * compaction summarizes them all. So the call is background exactly when that
 * message is missing from the hook's transcript. `undefined` when the session
 * context has no such message (nothing to tell them apart by).
 */
export function isBackgroundCompaction(
  hookMessages: readonly unknown[] | undefined,
  sessionMessages: readonly unknown[] | undefined,
  providerID: string,
): boolean | undefined {
  const anchor = [...(sessionMessages ?? [])].reverse().map(rec).find((message) =>
    message?.type === "assistant"
    && rec(message.model)?.providerID === providerID
    && !message.error
    && promptTokens(message.tokens) > 0)
  if (typeof anchor?.id !== "string") return undefined
  return !(hookMessages ?? []).some((message) => rec(message)?.id === anchor.id)
}

/** Id of the hook transcript's latest user message: the start of the turn in progress. */
export function currentTurnStartId(messages: readonly unknown[] | undefined): string | undefined {
  const user = [...(messages ?? [])].reverse().map(rec).find((message) => message?.role === "user" && typeof message.id === "string")
  return user?.id as string | undefined
}

/**
 * Run the provider's compaction through its language model and read back the
 * summary text and how it was made (`providerMetadata.cursor.compactionMode`).
 */
export async function summarizeThroughModel(
  language: Pick<LanguageModelV3, "doStream">,
  callOptions: LanguageModelV3CallOptions,
): Promise<{ summary: string; mode?: string }> {
  const { stream } = await language.doStream(callOptions)
  const reader = stream.getReader()
  let summary = ""
  let mode: string | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.type === "text-delta") summary += value.delta
    if (value.type === "error") throw value.error instanceof Error ? value.error : new Error(String(value.error))
    if (value.type === "finish") {
      const cursor = rec(rec(value.providerMetadata)?.cursor)
      if (typeof cursor?.compactionMode === "string") mode = cursor.compactionMode
    }
  }
  if (!summary.trim()) throw new Error("Cursor returned no summary")
  return { summary, ...(mode ? { mode } : {}) }
}
