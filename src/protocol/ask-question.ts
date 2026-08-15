/**
 * Cursor-native AskQuestion ⇄ OpenCode `question` translation.
 *
 * Cursor's AskQuestion is not a tool the client executes — the server raises an
 * `InteractionQuery` (`ask_question_interaction_query`, field 3) and blocks the
 * Run until the client answers with an `AskQuestionResult`. OpenCode has an
 * equivalent host tool (`question`), so the provider translates rather than
 * refusing: refusing made models narrate "the AskQuestion tool is unavailable"
 * and fall back to prose instead of ever calling the advertised host tool.
 *
 * Every rule below mirrors Cursor CLI, decompiled at
 * `~/Projects/cursor-mock-server/cursor/cli{,-local}`:
 *
 * - `src/utils/interaction-utils.ts` — `BU` (freeform option id), `Q7` (display
 *   options), `iX` (selection → success), `N$` (rejection + default reason).
 * - `chunk-7076/dist/ui.js` (`askQuestionInteractionQuery` case) and
 *   `subagent/subagent-prompt-handler.js` (`requestAskQuestion`) — the
 *   sync/async split and the exact rejection reasons.
 *
 * Keep the reason strings byte-identical to the CLI's: they reach the model as
 * tool feedback, and Cursor's server-side prompting is tuned against them.
 */

import { decodeMessageSparse } from "./messages.js"

/** Cursor's synthetic "type your own answer" option id (interaction-utils `BU`). */
export const FREEFORM_OPTION_ID = "__freeform_other__"

/**
 * `PendingExec.resultField` marking a held-open AskQuestion. It is not an
 * `ExecClientMessage` field: continuation dispatches on it to write an
 * InteractionResponse or a ConversationAction instead of an exec result.
 */
export const ASK_QUESTION_RESULT_FIELD = "ask_question_interaction_response"

/** Default rejection reason when the user skips (interaction-utils `N$`). */
export const SKIPPED_REASON = "Questions skipped by user"
/** Rejection used when the host dismisses the prompt (CLI `resolveAskQuestionPrompt`). */
export const DISMISSED_REASON = "Ask-question prompt dismissed"
export const MISSING_QUERY_REASON = "Missing ask-question query"
export const MISSING_ARGS_REASON = "Missing ask-question arguments"

/** OpenCode's `question` tool caps its short header label at 30 chars. */
const HEADER_MAX_LENGTH = 30

export type CursorAskQuestionOption = {
  id: string
  label: string
}

export type CursorAskQuestionItem = {
  id: string
  prompt: string
  options: CursorAskQuestionOption[]
  allowMultiple: boolean
}

export type CursorAskQuestionArgs = {
  title: string
  questions: CursorAskQuestionItem[]
  runAsync: boolean
}

export type DecodedAskQuestionQuery = {
  args: CursorAskQuestionArgs
  /**
   * The exact `AskQuestionArgs` sub-message bytes. Async completion echoes
   * `original_args` verbatim so fields this schema does not model survive.
   */
  rawArgs: Uint8Array
  toolCallId: string
}

/** `AskQuestionResult` oneof, shaped for `encodeMessage`. */
export type AskQuestionResultMessage = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Extract the raw bytes of `AskQuestionInteractionQuery.args` (#1) without
 * decoding. protobufjs hands back a decoded copy that would silently drop
 * unknown fields on re-encode; the async completion action must echo the
 * server's own bytes.
 */
function extractArgsBytes(queryBytes: Uint8Array): Uint8Array | undefined {
  let offset = 0
  while (offset < queryBytes.length) {
    let key = 0
    let shift = 0
    while (offset < queryBytes.length) {
      const byte = queryBytes[offset++]!
      key |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
      if (shift > 28) return undefined
    }
    const fieldNumber = key >>> 3
    const wireType = key & 7
    if (wireType === 2) {
      let length = 0
      let lengthShift = 0
      while (offset < queryBytes.length) {
        const byte = queryBytes[offset++]!
        length |= (byte & 0x7f) << lengthShift
        if ((byte & 0x80) === 0) break
        lengthShift += 7
        if (lengthShift > 28) return undefined
      }
      if (offset + length > queryBytes.length) return undefined
      if (fieldNumber === 1) return queryBytes.subarray(offset, offset + length)
      offset += length
    } else if (wireType === 0) {
      while (offset < queryBytes.length && (queryBytes[offset++]! & 0x80) !== 0) {
        // skip varint continuation bytes
      }
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 1) {
      offset += 8
    } else {
      return undefined
    }
  }
  return undefined
}

/**
 * Decode an `ask_question_interaction_query` body. Returns undefined when the
 * body carries no usable question set — the caller then rejects with the CLI's
 * own "missing" reason rather than bridging an empty prompt to the host.
 */
export function decodeAskQuestionQuery(
  queryBytes: Uint8Array,
): DecodedAskQuestionQuery | undefined {
  let decoded: Record<string, unknown>
  try {
    decoded = decodeMessageSparse("AskQuestionInteractionQuery", queryBytes)
  } catch {
    return undefined
  }
  const rawArgs = extractArgsBytes(queryBytes)
  const argsRecord = asRecord(decoded.args)
  if (!argsRecord || !rawArgs) return undefined

  const questions = Array.isArray(argsRecord.questions)
    ? argsRecord.questions.flatMap((raw): CursorAskQuestionItem[] => {
        const item = asRecord(raw)
        if (!item) return []
        const prompt = str(item.prompt)
        if (!prompt) return []
        const options = Array.isArray(item.options)
          ? item.options.flatMap((rawOption): CursorAskQuestionOption[] => {
              const option = asRecord(rawOption)
              if (!option) return []
              const label = str(option.label)
              if (!label) return []
              return [{ id: str(option.id), label }]
            })
          : []
        return [{
          id: str(item.id),
          prompt,
          options,
          allowMultiple: item.allow_multiple === true,
        }]
      })
    : []
  if (questions.length === 0) return undefined

  return {
    args: {
      title: str(argsRecord.title),
      questions,
      runAsync: argsRecord.run_async === true,
    },
    rawArgs,
    toolCallId: str(decoded.tool_call_id),
  }
}

/**
 * Cursor CLI drops a trailing catch-all option before rendering, because it
 * always appends its own freeform "Other" row (interaction-utils `Q7`).
 * OpenCode's `question` tool does the same thing via `custom` (default true,
 * and not settable from the tool schema), so the strip is required here too or
 * the user sees two "Other" entries for one question.
 */
export function isCatchAllOptionLabel(label: string): boolean {
  const normalized = label.toLowerCase().trim()
  return (
    normalized === "other"
    || normalized === "something else"
    || normalized.startsWith("other:")
    || normalized.startsWith("other -")
    || normalized.startsWith("other (")
    || normalized.startsWith("something else:")
    || normalized.startsWith("something else -")
    || normalized.startsWith("something else (")
  )
}

/** Options as Cursor would display them: trailing catch-all removed. */
export function displayOptions(question: CursorAskQuestionItem): CursorAskQuestionOption[] {
  const last = question.options.at(-1)
  if (last && isCatchAllOptionLabel(last.label)) return question.options.slice(0, -1)
  return question.options.slice()
}

function header(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return "Question"
  return trimmed.length > HEADER_MAX_LENGTH
    ? trimmed.slice(0, HEADER_MAX_LENGTH - 1).trimEnd() + "…"
    : trimmed
}

export type OpencodeQuestionInput = {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
  }>
}

/**
 * Build the OpenCode `question` tool input. `Question.Prompt` requires
 * `question`, `header`, and `options[{label, description}]`; Cursor options
 * carry no description, so it stays empty rather than being invented.
 */
export function askQuestionToolInput(args: CursorAskQuestionArgs): OpencodeQuestionInput {
  return {
    questions: args.questions.map((question) => ({
      question: question.prompt,
      header: header(args.title),
      options: displayOptions(question).map((option) => ({
        label: option.label,
        description: "",
      })),
      ...(question.allowMultiple ? { multiple: true } : {}),
    })),
  }
}

/** `AskQuestionResult{rejected}` — interaction-utils `N$`. */
export function rejectedResult(reason?: string): AskQuestionResultMessage {
  return { rejected: { reason: reason ?? SKIPPED_REASON } }
}

/** `AskQuestionResult{async}` — the immediate reply for `run_async` queries. */
export function asyncResult(): AskQuestionResultMessage {
  return { async: {} }
}

/**
 * Pull each question's answer text out of OpenCode's `question` tool output.
 *
 * The tool returns prose, not structured data (`metadata.answers` does not
 * cross the AI SDK boundary):
 *
 *   User has answered your questions: "<q1>"="<a, b>", "<q2>"="Unanswered". You
 *   can now continue with the user's answers in mind.
 *
 * The provider authored the question strings, so each answer is located by its
 * own `"<question>"="` anchor scanning forward — robust against commas, quotes
 * and `"="` inside question or answer text, and against duplicate questions.
 * Returns undefined for a question whose anchor is absent, which is treated as
 * unanswered rather than guessed at.
 */
export function parseAnswerSegments(
  questions: readonly CursorAskQuestionItem[],
  output: string,
): Array<string | undefined> {
  const answers: Array<string | undefined> = []
  let cursor = 0
  for (const question of questions) {
    const anchor = `"${question.prompt}"="`
    const start = output.indexOf(anchor, cursor)
    if (start < 0) {
      answers.push(undefined)
      continue
    }
    const valueStart = start + anchor.length
    // The value ends at the last quote before the next anchor (or the trailing
    // `. You can now continue…`). Searching backwards from the next anchor
    // keeps quoted text inside an answer intact.
    const nextAnchorStart = questions
      .map((other) => output.indexOf(`"${other.prompt}"="`, valueStart))
      .filter((index) => index > valueStart)
      .reduce((min, index) => (min < 0 || index < min ? index : min), -1)
    const searchEnd = nextAnchorStart >= 0 ? nextAnchorStart : output.length
    const valueEnd = output.lastIndexOf('"', searchEnd - 1)
    if (valueEnd < valueStart) {
      answers.push(undefined)
      continue
    }
    answers.push(output.slice(valueStart, valueEnd))
    cursor = valueEnd
  }
  return answers
}

/** OpenCode's placeholder for a question the user left blank. */
const UNANSWERED = "Unanswered"

/**
 * Map one question's answer labels back onto Cursor option ids.
 *
 * OpenCode returns labels, so a label that matches an option we sent becomes a
 * `selected_option_id`; anything else is the user's custom answer and becomes
 * `freeform_text`. Cursor CLI's `iX` substitutes the literal "Other" when the
 * freeform row was chosen without text, so an empty custom answer does too.
 */
export function answerForQuestion(
  question: CursorAskQuestionItem,
  segment: string | undefined,
): Record<string, unknown> {
  const answer: Record<string, unknown> = { question_id: question.id }
  if (segment === undefined || segment.trim().length === 0 || segment.trim() === UNANSWERED) {
    return answer
  }
  const byLabel = new Map(
    displayOptions(question).map((option) => [option.label.trim().toLowerCase(), option.id]),
  )
  const selected: string[] = []
  const custom: string[] = []
  // `multiple: true` answers arrive joined with ", " (question tool `formatted`).
  for (const piece of segment.split(", ")) {
    const label = piece.trim()
    if (!label) continue
    const optionId = byLabel.get(label.toLowerCase())
    if (optionId !== undefined) selected.push(optionId)
    else custom.push(label)
  }
  if (selected.length > 0) answer.selected_option_ids = selected
  if (custom.length > 0) answer.freeform_text = custom.join(", ")
  else if (selected.length === 0) answer.freeform_text = "Other"
  return answer
}

/**
 * Translate an OpenCode `question` tool result into an `AskQuestionResult`.
 *
 * A tool error means the host dismissed or failed the prompt — OpenCode's
 * `Question.RejectedError` is the dismissal path — so it maps to the CLI's
 * rejection rather than an empty success, which the model would read as "the
 * user answered nothing".
 */
export function askQuestionResultFromToolOutput(
  args: CursorAskQuestionArgs,
  output: string,
  isError: boolean,
): AskQuestionResultMessage {
  if (isError) {
    const reason = output.trim()
    return rejectedResult(reason.length > 0 ? reason : DISMISSED_REASON)
  }
  const segments = parseAnswerSegments(args.questions, output)
  return {
    success: {
      answers: args.questions.map((question, index) =>
        answerForQuestion(question, segments[index]),
      ),
    },
  }
}
