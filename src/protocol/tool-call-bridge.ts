import { mapCursorArgsToOpencode, mcpRealToolName } from "./tools.js"
import { decodeStructEntriesToJson } from "./struct.js"

/**
 * Cursor's interaction_update.tool_call_* carries a typed ToolCall oneof
 * (shell_tool_call, update_todos_tool_call, mcp_tool_call, …). Some of those
 * never become ExecServerMessage requests — Cursor completes them display-only
 * — so OpenCode would never see a tool-call unless we bridge them here.
 */

export type DisplayToolCall = {
  callId: string
  variant: string
  /** Preferred OpenCode tool id before advertisement checks. */
  preferredToolName: string
  args: Record<string, unknown>
  /** False when the Cursor call cannot be represented safely in OpenCode. */
  bridgeable?: boolean
}

export type BridgedOpenCodeToolCall = {
  toolName: string
  args: Record<string, unknown>
  callId: string
  variant: string
}

const TODO_STATUS: Record<number, string> = {
  0: "pending",
  1: "pending",
  2: "in_progress",
  3: "completed",
  4: "cancelled",
}

/** Cursor ToolCall oneof field → default OpenCode tool id. */
const VARIANT_TO_OPENCODE: Record<string, string> = {
  shell_tool_call: "bash",
  delete_tool_call: "bash",
  glob_tool_call: "glob",
  grep_tool_call: "grep",
  read_tool_call: "read",
  update_todos_tool_call: "todowrite",
  read_todos_tool_call: "todoread",
  edit_tool_call: "write",
  ls_tool_call: "read",
  mcp_tool_call: "mcp",
  create_plan_tool_call: "todowrite",
  web_search_tool_call: "websearch",
  task_tool_call: "task",
  ask_question_tool_call: "question",
  fetch_tool_call: "webfetch",
  web_fetch_tool_call: "webfetch",
  switch_mode_tool_call: "plan_enter",
  generate_image_tool_call: "generateimage",
  await_tool_call: "await",
  get_mcp_tools_tool_call: "get_mcp_tools",
  pi_read_tool_call: "read",
  pi_bash_tool_call: "bash",
  pi_edit_tool_call: "edit",
  pi_write_tool_call: "write",
  pi_grep_tool_call: "grep",
  pi_find_tool_call: "glob",
  pi_ls_tool_call: "read",
}

const TOOL_CALL_VARIANTS = Object.keys(VARIANT_TO_OPENCODE)

// ToolCallCompleted is a notification, not an execution request. Only mirror
// client-visible state whose authoritative final value is already present in
// the completed payload. Data-returning, interactive, and side-effecting calls
// must use an exec/interaction request channel where Cursor can receive their
// actual result.
const DISPLAY_STATE_MIRROR_VARIANTS = new Set([
  "update_todos_tool_call",
  "create_plan_tool_call",
])

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function findToolVariant(toolCall: Record<string, unknown>): string | undefined {
  for (const key of TOOL_CALL_VARIANTS) {
    if (toolCall[key] != null) return key
  }
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("_tool_call")) continue
    if (value && typeof value === "object") return key
  }
  return undefined
}

function mapTodoStatus(status: unknown): string {
  if (typeof status === "string" && status.length > 0) {
    const s = status.toLowerCase().replace(/^todo_status_/, "")
    if (s === "unspecified") return "pending"
    return s
  }
  if (typeof status === "number" && TODO_STATUS[status]) return TODO_STATUS[status]!
  return "pending"
}

function mapTodos(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return []
  return raw.map((item, index) => {
    const t = asRecord(item) ?? {}
    const content = typeof t.content === "string" ? t.content : ""
    const id =
      typeof t.id === "string" && t.id.length > 0
        ? t.id
        : `todo_${index + 1}`
    return {
      id,
      content,
      status: mapTodoStatus(t.status),
      priority: typeof t.priority === "string" && t.priority ? t.priority : "medium",
    }
  })
}

function unwrapArgs(variantPayload: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(variantPayload.args)
  return nested ?? variantPayload
}

/**
 * Decode a Cursor ToolCall oneof into a display tool call we can bridge.
 */
export function parseDisplayToolCall(
  callId: string,
  toolCall: Record<string, unknown> | undefined,
): DisplayToolCall | undefined {
  if (!toolCall || !callId) return undefined
  const variant = findToolVariant(toolCall)
  if (!variant) return undefined
  const payload = asRecord(toolCall[variant])
  if (!payload) return undefined

  const args = unwrapArgs(payload)

  if (variant === "mcp_tool_call") {
    const name = mcpRealToolName(args)
    let mcpArgs = asRecord(args.args) ?? {}
    if (Array.isArray(args.args)) {
      mcpArgs = decodeStructEntriesToJson(args.args as Uint8Array[])
    }
    return {
      callId,
      variant,
      preferredToolName: name,
      args: mcpArgs,
    }
  }

  if (variant === "update_todos_tool_call" || variant === "create_plan_tool_call") {
    const result = asRecord(payload.result)
    const success = asRecord(result?.success)
    const completedTodos = Array.isArray(success?.todos) ? success.todos : undefined
    const isMerge = variant === "update_todos_tool_call" && args.merge === true
    // OpenCode todowrite replaces the whole list. For Cursor merge updates,
    // only bridge when ToolCallCompleted includes the final merged list.
    const sourceTodos = completedTodos ?? (!isMerge ? args.todos : undefined)
    const todos = mapTodos(sourceTodos)
    if (variant === "create_plan_tool_call") {
      const overview = typeof args.overview === "string" ? args.overview.trim() : ""
      const plan = typeof args.plan === "string" ? args.plan.trim() : ""
      const name = typeof args.name === "string" ? args.name.trim() : ""
      if (overview || plan || name) {
        todos.unshift({
          id: "plan",
          content: [name && `Plan: ${name}`, overview, plan].filter(Boolean).join("\n").slice(0, 2000),
          status: "pending",
          priority: "high",
        })
      }
    }
    return {
      callId,
      variant,
      preferredToolName: "todowrite",
      args: { todos },
      bridgeable: variant === "create_plan_tool_call" ? todos.length > 0 : Array.isArray(sourceTodos),
    }
  }

  if (variant === "edit_tool_call") {
    const path = typeof args.path === "string" ? args.path : ""
    const content = typeof args.stream_content === "string" ? args.stream_content : undefined
    return {
      callId,
      variant,
      preferredToolName: "write",
      args: { path, content },
      bridgeable: path.length > 0 && content !== undefined,
    }
  }

  if (variant === "pi_edit_tool_call") {
    const path = typeof args.path === "string" ? args.path : ""
    const edits = Array.isArray(args.edits) ? args.edits : []
    const replacement = edits.length === 1 ? asRecord(edits[0]) : undefined
    const oldText = replacement?.old_text
    const newText = replacement?.new_text
    return {
      callId,
      variant,
      preferredToolName: "edit",
      args: { path, old_string: oldText, new_string: newText },
      bridgeable:
        path.length > 0 &&
        typeof oldText === "string" && oldText.length > 0 &&
        typeof newText === "string",
    }
  }

  if (variant === "task_tool_call") {
    const subagentType = openCodeSubagentType(args.subagent_type)
    const description = typeof args.description === "string" ? args.description : ""
    const prompt = typeof args.prompt === "string" ? args.prompt : ""
    const taskArgs: Record<string, unknown> = {
      description,
      prompt,
      subagent_type: subagentType,
    }
    if (typeof args.resume === "string" && args.resume) taskArgs.task_id = args.resume
    return {
      callId,
      variant,
      preferredToolName: "task",
      args: taskArgs,
      bridgeable: description.length > 0 && prompt.length > 0 && !!subagentType,
    }
  }

  if (variant === "ask_question_tool_call") {
    const title = typeof args.title === "string" ? args.title : ""
    const questions = Array.isArray(args.questions)
      ? args.questions.map((q) => {
          const qq = asRecord(q) ?? {}
          const prompt = typeof qq.prompt === "string" ? qq.prompt : ""
          const options = Array.isArray(qq.options)
            ? qq.options.map((o) => {
                const oo = asRecord(o) ?? {}
                return {
                  label: typeof oo.label === "string" ? oo.label : String(oo.id ?? ""),
                  description: typeof oo.description === "string" ? oo.description : "",
                }
              })
            : []
          return {
            question: prompt,
            header: (typeof qq.id === "string" && qq.id) || title || "Question",
            options,
            multiple: qq.allow_multiple === true,
          }
        })
      : []
    return {
      callId,
      variant,
      preferredToolName: "question",
      args: { questions },
    }
  }

  if (variant === "switch_mode_tool_call") {
    const target = typeof args.target_mode_id === "string" ? args.target_mode_id.toLowerCase() : ""
    const preferred =
      target.includes("plan") || target === "plan" ? "plan_enter" : "plan_exit"
    return {
      callId,
      variant,
      preferredToolName: preferred,
      // OpenCode plan_enter / plan_exit both advertise an empty input schema.
      args: {},
    }
  }

  if (variant === "delete_tool_call") {
    const path = typeof args.path === "string" ? args.path : ""
    return {
      callId,
      variant,
      preferredToolName: "bash",
      args: path ? { command: `rm -f -- ${shellQuote(path)}` } : { command: "true" },
    }
  }

  const preferred = VARIANT_TO_OPENCODE[variant] ?? variant.replace(/_tool_call$/, "")
  return {
    callId,
    variant,
    preferredToolName: preferred,
    args,
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Pick an advertised OpenCode tool for a display call, remapping args as needed.
 * Returns undefined when nothing compatible is advertised this turn.
 */
export function resolveBridgedOpenCodeToolCall(
  display: DisplayToolCall,
  advertised: Iterable<string>,
): BridgedOpenCodeToolCall | undefined {
  if (!DISPLAY_STATE_MIRROR_VARIANTS.has(display.variant)) return undefined
  if (display.bridgeable === false) return undefined
  const names = new Set([...advertised].filter(Boolean))
  if (names.size === 0) return undefined

  const candidates = candidateToolNames(display, names)
  for (const toolName of candidates) {
    if (!names.has(toolName)) continue
    const mapped = mapCursorArgsToOpencode(toolName, display.args)
    if (toolName === "todowrite") {
      mapped.args = {
        todos: mapTodos((display.args as { todos?: unknown }).todos ?? mapped.args.todos),
      }
    }
    return {
      toolName: mapped.toolName,
      args: mapped.args,
      callId: display.callId,
      variant: display.variant,
    }
  }
  return undefined
}

function candidateToolNames(display: DisplayToolCall, advertised: Set<string>): string[] {
  const out: string[] = []
  const add = (n: string) => {
    if (n && !out.includes(n)) out.push(n)
  }

  add(display.preferredToolName)

  if (display.variant === "create_plan_tool_call") add("todowrite")
  if (display.variant === "update_todos_tool_call") add("todowrite")
  if (display.variant === "read_todos_tool_call") add("todoread")
  if (display.variant === "ask_question_tool_call") add("question")
  if (display.variant === "web_search_tool_call") add("websearch")
  if (display.variant === "fetch_tool_call" || display.variant === "web_fetch_tool_call") {
    add("webfetch")
  }

  for (const name of advertised) {
    if (name.toLowerCase() === display.preferredToolName.toLowerCase()) add(name)
  }
  return out
}

/** Map only Cursor subagent variants with a safe OpenCode identity. */
function openCodeSubagentType(raw: unknown): string | undefined {
  const subtype = asRecord(raw)
  if (!subtype) return undefined
  const custom = asRecord(subtype.custom)
  if (typeof custom?.name === "string" && custom.name.length > 0) return custom.name
  if (subtype.explore != null) return "explore"
  return undefined
}

/** Advertised OpenCode tool ids from Cursor McpToolDefinition descriptors. */
export function advertisedToolNamesFromDescriptors(
  descriptors: Array<Record<string, unknown>>,
): string[] {
  const out: string[] = []
  for (const d of descriptors) {
    const toolName = typeof d.tool_name === "string" ? d.tool_name : undefined
    const provider = typeof d.provider_identifier === "string" ? d.provider_identifier : "opencode"
    if (!toolName) continue
    if (provider && provider !== "opencode") out.push(`${provider}_${toolName}`)
    else out.push(toolName)
  }
  return out
}


/** Walk a protobuf message and return top-level field numbers present. */
export function listProtobufFieldNumbers(buf: Uint8Array): number[] {
  const fields: number[] = []
  let i = 0
  while (i < buf.length) {
    let key = 0
    let shift = 0
    while (i < buf.length) {
      const byte = buf[i++]!
      key |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
      if (shift > 35) return fields
    }
    const field = key >>> 3
    const wire = key & 7
    fields.push(field)
    if (wire === 0) {
      // varint
      while (i < buf.length && (buf[i++]! & 0x80) !== 0) { /* consume */ }
    } else if (wire === 1) {
      i += 8
    } else if (wire === 2) {
      let len = 0
      shift = 0
      while (i < buf.length) {
        const byte = buf[i++]!
        len |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7
        if (shift > 35) return fields
      }
      i += len
    } else if (wire === 5) {
      i += 4
    } else {
      break
    }
    if (i > buf.length) break
  }
  return fields
}

/**
 * Extract nested bytes for path of field numbers (each must be wire type 2).
 * Returns undefined if any segment is missing.
 */
export function extractProtobufSubmessage(
  buf: Uint8Array,
  path: number[],
): Uint8Array | undefined {
  let cur: Uint8Array | undefined = buf
  for (const want of path) {
    if (!cur) return undefined
    let i = 0
    let found: Uint8Array | undefined
    while (i < cur.length) {
      let key = 0
      let shift = 0
      while (i < cur.length) {
        const byte = cur[i++]!
        key |= (byte & 0x7f) << shift
        if ((byte & 0x80) === 0) break
        shift += 7
        if (shift > 35) return undefined
      }
      const field = key >>> 3
      const wire = key & 7
      if (wire === 0) {
        while (i < cur.length && (cur[i++]! & 0x80) !== 0) { /* consume */ }
      } else if (wire === 1) {
        i += 8
      } else if (wire === 2) {
        let len = 0
        shift = 0
        while (i < cur.length) {
          const byte = cur[i++]!
          len |= (byte & 0x7f) << shift
          if ((byte & 0x80) === 0) break
          shift += 7
          if (shift > 35) return undefined
        }
        const slice = cur.subarray(i, i + len)
        i += len
        if (field === want) found = slice
      } else if (wire === 5) {
        i += 4
      } else {
        return undefined
      }
      if (i > cur.length) return undefined
    }
    cur = found
  }
  return cur
}

/**
 * Pull Cursor's tool_call_id out of a raw ExecServerMessage args variant so we
 * can correlate display tool_call_started with the authoritative exec path.
 */
export function extractExecDisplayCallId(execMsg: Record<string, unknown>): string | undefined {
  for (const key of [
    "read_args",
    "write_args",
    "pi_write_args",
    "grep_args",
    "ls_args",
    "delete_args",
    "shell_stream_args",
    "mcp_args",
  ]) {
    const args = asRecord(execMsg[key])
    if (!args) continue
    if (typeof args.tool_call_id === "string" && args.tool_call_id.length > 0) {
      return args.tool_call_id
    }
  }
  return undefined
}
