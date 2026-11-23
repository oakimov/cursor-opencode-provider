import { appendWorkspaceRootGrounding } from "./workspace-grounding.js"

/**
 * Prefixes that can introduce a progress fragment. These are not complete
 * answers by themselves; `isProgressOnlyAssistantText` still requires a
 * fragment (no sentence punctuation) and, for most verbs, an inspection object.
 */
export const PROGRESS_ONLY_PATTERNS: readonly RegExp[] = [
  /^checking\b/i,
  /^inspecting\b/i,
  /^let me check\b/i,
  /^looking into\b/i,
  /^looking at\b/i,
  /^reviewing\b/i,
  /^scanning\b/i,
  /^verifying\b/i,
  /^examining\b/i,
  /^investigating\b/i,
]

const PREFIXES_WITH_OBJECT: readonly RegExp[] = [
  /^checking\b/i,
  /^inspecting\b/i,
  /^reviewing\b/i,
  /^scanning\b/i,
  /^verifying\b/i,
  /^examining\b/i,
  /^investigating\b/i,
]

const INSPECTION_OBJECT = /^(?:the|how|whether|if|for|on|this|that|it)\b/i
const MAX_PROGRESS_FRAGMENT_WORDS = 8

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function restAfterPrefix(text: string, prefix: string): string {
  return text.slice(prefix.length).trim()
}

/**
 * True only for a short progress *fragment* that ended the turn without tools.
 *
 * Complete answers that happen to start with a progress verb ("Looking at the
 * code, the bug is in X", "Reviewing this PR: LGTM") must not match. A trailing
 * ellipsis is allowed; any other `.!?`, colon, semicolon, or comma is not.
 * Inspection verbs also need an inspection object ("the workspace", "this PR"),
 * not copulas such as "is not needed".
 */
export function isProgressOnlyAssistantText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length > 240) return false
  if (/\n\s*\n/.test(trimmed)) return false
  const normalized = normalizeWhitespace(trimmed)
  const withoutEllipsis = normalized.replace(/(?:\.{3}|…)+\s*$/u, "").trim()
  if (!withoutEllipsis) return false
  if (/[.!?;:]/.test(withoutEllipsis)) return false
  if (withoutEllipsis.includes(",")) return false
  if (withoutEllipsis.split(" ").length > MAX_PROGRESS_FRAGMENT_WORDS) return false
  if (!PROGRESS_ONLY_PATTERNS.some((pattern) => pattern.test(withoutEllipsis))) return false

  const lower = withoutEllipsis.toLowerCase()
  if (lower.startsWith("let me check")) {
    return withoutEllipsis.length > "let me check".length
  }
  if (lower.startsWith("looking into") || lower.startsWith("looking at")) {
    const prefix = lower.startsWith("looking into") ? "looking into" : "looking at"
    return INSPECTION_OBJECT.test(restAfterPrefix(withoutEllipsis, prefix))
  }
  if (PREFIXES_WITH_OBJECT.some((pattern) => pattern.test(withoutEllipsis))) {
    const rest = withoutEllipsis.replace(/^\S+\s+/i, "")
    return INSPECTION_OBJECT.test(rest)
  }
  return false
}

export const PROGRESS_CONTINUATION_ENV = "CURSOR_PROGRESS_CONTINUATION"

const PROGRESS_CONTINUATION_OFF: ReadonlySet<string> = new Set(["0", "false", "off", "no"])

/**
 * The synthetic follow-up Run is on by default. `CURSOR_PROGRESS_CONTINUATION`
 * set to `0`, `false`, `off` or `no` (any case, surrounding whitespace ignored)
 * turns it off; any other value, including an empty one, leaves it on.
 */
export function progressContinuationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[PROGRESS_CONTINUATION_ENV]?.trim().toLowerCase()
  return value === undefined || !PROGRESS_CONTINUATION_OFF.has(value)
}

export function shouldContinueProgressOnlyTurn(input: {
  allowTools: boolean
  advertisedToolCount: number
  assistantText: string
  emittedHostTools: number
  continuationAttempts: number
  pendingExecs: number
}, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (
    progressContinuationEnabled(env) &&
    input.allowTools &&
    input.advertisedToolCount > 0 &&
    input.pendingExecs === 0 &&
    input.emittedHostTools === 0 &&
    input.continuationAttempts < 1 &&
    isProgressOnlyAssistantText(input.assistantText)
  )
}

export function progressOnlyContinuationPrompt(workspaceRoot?: string): string {
  const base =
    "Continue the same turn now. Your previous assistant message was only progress narration and ended without a tool call or a complete answer. Do not repeat the progress update. If evidence is still needed, call an available listed tool immediately; otherwise provide the complete user-facing answer now. Do not finish until the requested work or answer is complete."
  if (!workspaceRoot || !workspaceRoot.trim()) return base
  return appendWorkspaceRootGrounding(base, workspaceRoot)
}
