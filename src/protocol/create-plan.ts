/**
 * Cursor-native CreatePlan → host-default plan file.
 *
 * Cursor raises `create_plan_request_query` (#7) with CreatePlanArgs and expects
 * a CreatePlanResult carrying `plan_uri`. Cursor CLI writes under
 * `~/.cursor/plans/*.plan.md` with YAML frontmatter; this provider deliberately
 * does **not** — plans must stay host-portable so switching models does not
 * strand users on Cursor-specific paths or frontmatter.
 *
 * Location mirrors OpenCode Session.plan shape, but the project-config segment
 * comes from {@link hostPlansDir} / {@link opencodeProjectConfigDirs}
 * (`.opencode` / `.mimocode` / `.kilo` / … via the path bridge), never a
 * hardcoded OpenCode-only directory name.
 *
 * Body is plain markdown (the same shape a plan-mode model would write with
 * `write`). Cursor YAML frontmatter is never emitted.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { hostPlansDir } from "../context/paths.js"
import { decodeMessageSparse } from "./messages.js"

const PLAN_ADJECTIVES = [
  "brave",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "curious",
  "eager",
  "gentle",
  "glowing",
  "happy",
  "hidden",
  "jolly",
  "kind",
  "lucky",
  "mighty",
  "misty",
  "neon",
  "nimble",
  "playful",
  "proud",
  "quick",
  "quiet",
  "shiny",
  "silent",
  "stellar",
  "sunny",
  "swift",
  "tidy",
  "witty",
] as const

const PLAN_NOUNS = [
  "cabin",
  "cactus",
  "canyon",
  "circuit",
  "comet",
  "eagle",
  "engine",
  "falcon",
  "forest",
  "garden",
  "harbor",
  "island",
  "knight",
  "lagoon",
  "meadow",
  "moon",
  "mountain",
  "nebula",
  "orchid",
  "otter",
  "panda",
  "pixel",
  "planet",
  "river",
  "rocket",
  "sailor",
  "squid",
  "star",
  "tiger",
  "wizard",
  "wolf",
] as const

export type CursorPlanTodo = {
  id: string
  content: string
  status: string
}

export type CursorCreatePlanArgs = {
  plan: string
  overview: string
  name: string
  isProject: boolean
  todos: CursorPlanTodo[]
}

export type DecodedCreatePlanQuery = {
  args: CursorCreatePlanArgs
  toolCallId: string
}

export type CreatePlanWriteResult =
  | { ok: true; planPath: string; planUri: string }
  | { ok: false; error: string }

/** omp-only host tool that stages Cursor CreatePlan content into native plan mode. */
export const CURSOR_PLAN_STAGE_TOOL = "cursor_plan_stage"

/** Held InteractionQuery continuation field for a native host plan stage. */
export const CREATE_PLAN_RESULT_FIELD = "create_plan_request_response"

export type CursorPlanStageInput = {
  plan_uri: string
  content: string
  title: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function mapTodoStatus(status: unknown): string {
  if (typeof status === "string") return status.toLowerCase()
  if (typeof status === "number") {
    // TodoStatus enum: PENDING=1, IN_PROGRESS=2, COMPLETED=3, CANCELLED=4
    switch (status) {
      case 2:
        return "in_progress"
      case 3:
        return "completed"
      case 4:
        return "cancelled"
      default:
        return "pending"
    }
  }
  return "pending"
}

function todoCheckbox(status: string): string {
  const s = status.toLowerCase()
  if (s === "completed" || s === "complete" || s === "done") return "[x]"
  if (s === "cancelled" || s === "canceled") return "[~]"
  return "[ ]"
}

/** Decode a `create_plan_request_query` body, or undefined when unusable. */
export function decodeCreatePlanQuery(
  queryBytes: Uint8Array,
): DecodedCreatePlanQuery | undefined {
  let decoded: Record<string, unknown>
  try {
    decoded = decodeMessageSparse("CreatePlanRequestQuery", queryBytes)
  } catch {
    return undefined
  }
  const args = asRecord(decoded.args)
  if (!args) return undefined

  const plan = str(args.plan)
  const overview = str(args.overview)
  const name = str(args.name)
  const todos = Array.isArray(args.todos)
    ? args.todos.flatMap((raw): CursorPlanTodo[] => {
        const item = asRecord(raw)
        if (!item) return []
        const content = str(item.content)
        if (!content) return []
        return [
          {
            id: str(item.id),
            content,
            status: mapTodoStatus(item.status),
          },
        ]
      })
    : []

  // Empty args: CLI acknowledges with empty plan_uri; treat as no write.
  if (!plan && !overview && !name && todos.length === 0) return undefined

  return {
    args: {
      plan,
      overview,
      name,
      isProject: args.is_project === true,
      todos,
    },
    toolCallId: str(decoded.tool_call_id),
  }
}

/** OpenCode-style adjective-noun slug (core/src/util/slug.ts). */
export function randomPlanSlug(seed = Date.now()): string {
  const adj = PLAN_ADJECTIVES[seed % PLAN_ADJECTIVES.length]!
  const noun = PLAN_NOUNS[Math.floor(seed / PLAN_ADJECTIVES.length) % PLAN_NOUNS.length]!
  return `${adj}-${noun}`
}

/** Slugify a human title into a filesystem-safe token. */
export function slugifyPlanName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return slug || randomPlanSlug()
}

/** Build omp's canonical session-local plan artifact payload. */
export function createPlanStageInput(args: CursorCreatePlanArgs): CursorPlanStageInput {
  const slug = slugifyPlanName(args.name)
  return {
    plan_uri: `local://${slug}-plan.md`,
    content: renderOpencodePlanMarkdown(args),
    title: slug,
  }
}


/**
 * Resolve the absolute plan file path via {@link hostPlansDir}.
 * Filename shape matches OpenCode Session.plan: `<created>-<slug>.md`.
 */
export function resolveHostPlanPath(
  workspaceRoot: string,
  name?: string,
  created: number = Date.now(),
): string {
  const slug = name?.trim() ? slugifyPlanName(name) : randomPlanSlug(created)
  return path.join(hostPlansDir(workspaceRoot), `${created}-${slug}.md`)
}

/** @deprecated Prefer {@link resolveHostPlanPath}. */
export const resolveOpencodePlanPath = resolveHostPlanPath

/**
 * Render plain markdown for the plan file. No Cursor YAML frontmatter.
 * Prefer `args.plan` as the body; prepend a title/overview when useful; append
 * a markdown checklist for todos.
 */
export function renderOpencodePlanMarkdown(args: CursorCreatePlanArgs): string {
  const parts: string[] = []
  const name = args.name.trim()
  const overview = args.overview.trim()
  const plan = args.plan.trim()

  // Cursor usually repeats the plan name as the body's own leading H1. Strip it
  // so the document keeps one title in the right place instead of opening with
  // the same heading twice (or with the overview stranded above it).
  const planLeadHeading = /^#\s+(.+?)\s*$/.exec(plan.split("\n", 1)[0] ?? "")?.[1]
  const planBody =
    name
    && planLeadHeading !== undefined
    && planLeadHeading.trim().toLowerCase() === name.toLowerCase()
      ? plan.slice(plan.indexOf("\n") + 1).trimStart()
      : plan

  if (name) {
    parts.push(`# ${name}`)
    parts.push("")
  }
  if (overview) {
    // Avoid duplicating overview when it already leads the plan body.
    if (!planBody || !planBody.startsWith(overview)) {
      parts.push(overview)
      parts.push("")
    }
  }
  if (planBody) {
    parts.push(planBody)
    if (!planBody.endsWith("\n")) parts.push("")
  }
  if (args.todos.length > 0) {
    if (parts.length > 0 && parts[parts.length - 1] !== "") parts.push("")
    parts.push("## Todos")
    parts.push("")
    for (const todo of args.todos) {
      parts.push(`- ${todoCheckbox(todo.status)} ${todo.content}`)
    }
    parts.push("")
  }

  const body = parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
  return body ? `${body}\n` : ""
}

/**
 * Write the plan under {@link hostPlansDir} and return a `file://` URI.
 * Empty / missing content is the caller's responsibility (empty plan_uri ack).
 */
export function writeOpencodePlanFile(
  args: CursorCreatePlanArgs,
  workspaceRoot: string,
  created: number = Date.now(),
): CreatePlanWriteResult {
  const markdown = renderOpencodePlanMarkdown(args)
  if (!markdown.trim()) {
    return { ok: false, error: "CreatePlan produced no plan content to write" }
  }
  const planPath = resolveHostPlanPath(workspaceRoot, args.name, created)
  try {
    mkdirSync(path.dirname(planPath), { recursive: true })
    writeFileSync(planPath, markdown, "utf-8")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to write plan file: ${message}` }
  }
  return {
    ok: true,
    planPath,
    planUri: pathToFileURL(planPath).href,
  }
}
