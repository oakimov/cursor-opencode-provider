import { encodeMessage } from "./messages.js"
import { encodeJsonAsValue, decodeStructEntriesToJson, readAllFields } from "./struct.js"
import { trace } from "../debug.js"

// Exec variant field number whose reply is the server-initiated request_context
// probe (ExecServerMessage #10 → ExecClientMessage #10). request/result share a
// field number for every exec variant, so this is also the result field.
export const REQUEST_CONTEXT_RESULT_FIELD = 10

// ── opencode tool definitions → Cursor request_context descriptors ──

export type OpencodeToolDef = {
  name: string
  description?: string
  inputSchema?: unknown
}

/**
 * Convert opencode's per-turn tool list into Cursor `McpToolDefinition`
 * entries for `request_context.tools` (#7) and `AgentRunRequest.mcp_tools`.
 *
 * opencode tools are already namespaced (e.g. `read`, `grep`, or
 * `<server>_<tool>` for MCP). We advertise them all under a synthetic
 * `opencode` provider so Cursor routes their calls back to us as
 * `mcp_args` on the exec channel. The composite `name` is what the model
 * calls and what comes back as `McpArgs.name`.
 */
export function toolsToDescriptors(
  tools: OpencodeToolDef[],
  providerIdentifier = "opencode",
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: `${providerIdentifier}-${t.name}`,
    description: t.description ?? "",
    input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
    provider_identifier: providerIdentifier,
    tool_name: t.name,
  }))
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>
  }
  return { type: "object", properties: {} }
}

/**
 * Build the nested McpFileSystemOptions / McpMetaToolOptions shape used by
 * requestContext.#23 / #34. Groups every tool under one synthetic server so
 * Cursor's IDE-style decoder also sees the list.
 */
export function toolsToMcpDescriptors(
  tools: OpencodeToolDef[],
  providerIdentifier = "opencode",
): Array<Record<string, unknown>> {
  if (tools.length === 0) return []
  return [
    {
      server_name: providerIdentifier,
      server_identifier: providerIdentifier,
      tools: tools.map((t) => ({
        tool_name: t.name,
        description: t.description ?? "",
        input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
      })),
    },
  ]
}

/**
 * @deprecated Prefer `buildRequestContext` from `../context/build.js`.
 * Kept as a sync tools-only fallback for unit tests that don't need collectors.
 */
export function buildLiveRequestContext(
  tools: OpencodeToolDef[],
  providerIdentifier = "opencode",
): Record<string, unknown> {
  const flat = toolsToDescriptors(tools, providerIdentifier)
  const nested = toolsToMcpDescriptors(tools, providerIdentifier)
  const cwd = process.cwd()
  return {
    env: {
      os_version: process.platform,
      workspace_paths: [cwd],
      shell: process.env.SHELL || "/bin/bash",
      time_zone: "UTC",
      project_folder: cwd,
      process_working_directory: cwd,
    },
    tools: flat,
    mcp_file_system_options: {
      enabled: true,
      workspace_project_dir: cwd,
      mcp_descriptors: nested,
    },
    mcp_meta_tool_options: {
      enabled: true,
      mcp_descriptors: nested,
    },
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    mcp_file_system_info_complete: true,
    git_status_info_complete: true,
  }
}

// ── Cursor exec-variant → opencode tool name ──

// Native ExecServerMessage variants only (agent.v1). There is no edit_args or
// glob_args on the exec channel — Cursor's EditToolCall is display-only, and
// glob/edit from opencode are advertised as MCP tools and arrive as mcp_args.
//
// OpenCode has no `ls` / `delete` builtins: ls → read (dirs are readable),
// delete → bash `rm`. Arg key remapping happens in mapCursorArgsToOpencode.
const cursorToolToOpencode: Record<string, string> = {
  read_args: "read",
  write_args: "write",
  pi_write_args: "write",
  grep_args: "grep",
  ls_args: "read",
  delete_args: "bash",
  shell_stream_args: "bash",
  mcp_args: "mcp",
}

const opencodeToolToCursor: Record<string, string> = {
  read: "read_args",
  write: "write_args",
  grep: "grep_args",
  bash: "shell_stream_args",
  mcp: "mcp_args",
}

/** Cursor-only fields that must not be forwarded as OpenCode tool input. */
const CURSOR_INTERNAL_KEYS = new Set([
  "tool_call_id",
  "toolCallId",
  "exec_id",
  "span",
  "sandbox_policy",
  "requested_sandbox_policy",
  "smart_mode_approval",
  "smart_mode_approval_only",
  "skip_approval",
  "parsing_result",
  "classifier_result",
  "hook_approval_requirement",
  "conversation_id",
  "simple_commands",
  "has_input_redirect",
  "has_output_redirect",
  "is_background",
  "timeout_behavior",
  "hard_timeout",
  "close_stdin",
  "output_notification",
  "file_output_threshold_bytes",
  "return_file_content_after_write",
  "file_bytes",
  "encoding_hint",
  "ignore",
])

export function mapExecServerToToolName(execField: string): string | undefined {
  return cursorToolToOpencode[execField]
}

export function mapToolNameToExecField(toolName: string): string | undefined {
  return opencodeToolToCursor[toolName]
}

// Cursor exec-request variant → the ExecClientMessage result field the client
// must reply with. This is keyed off the REQUEST variant, not the opencode tool
// name, because an MCP call must always answer with `mcp_result` even though the
// resolved tool name (e.g. "read") looks like a built-in.
const execVariantToResultField: Record<string, string> = {
  read_args: "read_result",
  write_args: "write_result",
  // Pi write: args #48, result #49 (not the same field number).
  pi_write_args: "pi_write_result",
  grep_args: "grep_result",
  ls_args: "ls_result",
  delete_args: "delete_result",
  shell_stream_args: "shell_stream",
  mcp_args: "mcp_result",
}

const MCP_PREFIX = "opencode-"

// ── Extract exec args from ExecServerMessage ──

export type ParsedExecRequest = {
  id: number
  execId: string
  toolName: string
  args: Record<string, unknown>
  /** ExecClientMessage result field to reply with (matches the request variant). */
  resultField: string
}

export function parseExecServerMessage(
  msg: Record<string, unknown>,
): ParsedExecRequest | undefined {
  const id = msg.id as number | undefined
  if (id === undefined) return undefined

  // Find which args variant is set
  const execVariant = findOneOfVariant(msg, [
    "read_args", "write_args", "pi_write_args",
    "grep_args", "ls_args",
    "delete_args", "shell_stream_args", "mcp_args",
  ])
  if (!execVariant) return undefined

  const resultField = execVariantToResultField[execVariant]
  const execId = (msg.exec_id as string) ?? ""

  if (execVariant === "mcp_args") {
    // An MCP call to one of the tools we advertised. Resolve the real opencode
    // tool name (Cursor's model may have shortened "opencode-read" → "read") and
    // decode the argument map back into JSON for opencode to execute.
    const m = (msg.mcp_args as Record<string, unknown>) ?? {}
    const mapped = mapCursorArgsToOpencode(mcpRealToolName(m), decodeMcpArgs(m.args), "mcp_args")
    return {
      id,
      execId,
      toolName: mapped.toolName,
      args: mapped.args,
      resultField,
    }
  }

  const toolName = cursorToolToOpencode[execVariant]
  if (!toolName) return undefined

  const mapped = mapCursorArgsToOpencode(
    toolName,
    (msg[execVariant] as Record<string, unknown>) ?? {},
    execVariant,
  )
  return {
    id,
    execId,
    toolName: mapped.toolName,
    args: mapped.args,
    resultField,
  }
}

/**
 * Remap Cursor exec / MCP arg shapes onto OpenCode's Effect Schema keys.
 * Without this, OpenCode rejects calls with InvalidArgumentsError
 * (e.g. `path` instead of `filePath`, `file_text` instead of `content`).
 */
export function mapCursorArgsToOpencode(
  toolName: string,
  raw: Record<string, unknown>,
  execVariant?: string,
): { toolName: string; args: Record<string, unknown> } {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue
    if (CURSOR_INTERNAL_KEYS.has(k)) continue
    // Drop empty strings from optional protobuf defaults.
    if (typeof v === "string" && v.length === 0) continue
    cleaned[k] = v
  }

  // Native ls_args → OpenCode read (directory listing via read).
  if (execVariant === "ls_args") {
    const filePath = str(cleaned.path) ?? str(cleaned.filePath)
    return { toolName: "read", args: filePath ? { filePath } : {} }
  }

  // Native delete_args → bash rm (OpenCode has no delete builtin).
  if (execVariant === "delete_args") {
    const target = str(cleaned.path) ?? str(cleaned.filePath)
    return {
      toolName: "bash",
      args: target ? { command: `rm -f -- ${shellQuote(target)}` } : { command: "true" },
    }
  }

  switch (toolName) {
    case "read": {
      const args: Record<string, unknown> = {}
      const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path)
      if (filePath) args.filePath = filePath
      // Cursor often sends offset=0/limit=0 as protobuf defaults. OpenCode's
      // read treats limit=0 as "read zero lines" (empty content) — omit zeros.
      const offset = num(cleaned.offset)
      if (offset !== undefined && offset > 0) args.offset = offset
      const limit = num(cleaned.limit)
      if (limit !== undefined && limit > 0) args.limit = limit
      return { toolName: "read", args }
    }
    case "write": {
      const args: Record<string, unknown> = {}
      const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path)
      if (filePath) args.filePath = filePath
      const content = str(cleaned.content) ?? str(cleaned.file_text) ?? str(cleaned.fileText)
      if (content !== undefined) args.content = content
      return { toolName: "write", args }
    }
    case "edit": {
      const args: Record<string, unknown> = {}
      const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path)
      if (filePath) args.filePath = filePath
      const oldString = str(cleaned.oldString) ?? str(cleaned.old_string)
      if (oldString !== undefined) args.oldString = oldString
      const newString = str(cleaned.newString) ?? str(cleaned.new_string)
      if (newString !== undefined) args.newString = newString
      if (typeof cleaned.replaceAll === "boolean") args.replaceAll = cleaned.replaceAll
      return { toolName: "edit", args }
    }
    case "bash": {
      const args: Record<string, unknown> = {}
      const command = str(cleaned.command)
      if (command) args.command = command
      const workdir = str(cleaned.workdir) ?? str(cleaned.working_directory)
      if (workdir) args.workdir = workdir
      const timeout = num(cleaned.timeout)
      if (timeout !== undefined) args.timeout = timeout
      return { toolName: "bash", args }
    }
    case "grep": {
      const pattern = str(cleaned.pattern)
      const path = str(cleaned.path)
      const include = str(cleaned.include) ?? str(cleaned.glob)
      // Cursor's native Grep often arrives with an empty pattern + a glob
      // (e.g. "**/*") when the model is really listing files. OpenCode's grep
      // requires a non-empty string pattern — remap to glob instead of
      // forwarding a call that will fail and loop.
      if (!pattern) {
        const args: Record<string, unknown> = { pattern: include ?? "**/*" }
        if (path) args.path = path
        return { toolName: "glob", args }
      }
      const args: Record<string, unknown> = { pattern }
      if (path) args.path = path
      if (include) args.include = include
      return { toolName: "grep", args }
    }
    case "glob": {
      const args: Record<string, unknown> = {}
      const pattern = str(cleaned.pattern) ?? str(cleaned.glob_pattern) ?? str(cleaned.globPattern)
      if (pattern) args.pattern = pattern
      const path = str(cleaned.path) ?? str(cleaned.target_directory) ?? str(cleaned.targetDirectory)
      if (path) args.path = path
      return { toolName: "glob", args }
    }
    default:
      return { toolName, args: cleaned }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function mcpRealToolName(mcpArgs: Record<string, unknown>): string {
  const toolName = mcpArgs.tool_name as string | undefined
  if (toolName) return toolName
  const name = (mcpArgs.name as string) ?? ""
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name || "mcp"
}

function decodeMcpArgs(raw: unknown): Record<string, unknown> {
  if (!Array.isArray(raw)) return {}
  const entries = raw.map((a) => (typeof a === "string" ? b64ToBytes(a) : (a as Uint8Array)))
  try {
    return decodeStructEntriesToJson(entries)
  } catch {
    return {}
  }
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function findOneOfVariant(
  msg: Record<string, unknown>,
  candidates: string[],
): string | undefined {
  for (const key of candidates) {
    if (msg[key] !== undefined && msg[key] !== null) {
      return key
    }
  }
  return undefined
}

// ── Build ExecClientMessage for a tool result ──

export type ToolResultInput = {
  execId: number
  /** ExecClientMessage result field (from ParsedExecRequest.resultField). */
  resultField: string
  output: string
  error?: string
  executionTimeMs?: number
  /**
   * Resolved opencode tool name (read/write/grep/…). Gates read-envelope
   * unwrapping on the mcp_result path so non-read MCP output is never
   * rewritten. read_result is always a read, so it unwraps regardless.
   */
  toolName?: string
}

/**
 * Build one or more ExecClientMessage frames for a tool result.
 * Shell replies are a sequence of ShellStream oneofs under the same id —
 * Start → stdout/stderr → exit — then an ACM #5 stream_close so the server
 * knows the client finished streaming (CLI always sends this; without it
 * shell execs hang on heartbeats forever).
 */
export function buildExecClientMessages(input: ToolResultInput): Uint8Array[] {
  const resultField = input.resultField || "mcp_result"
  const frames: Uint8Array[] = []

  if (resultField === "shell_stream") {
    // Real clients always emit Start → Stdout/Stderr* → Exit (capture/tests).
    frames.push(encodeShellStream(input.execId, undefined, { start: {} }))
    if (input.error) {
      frames.push(encodeShellStream(input.execId, undefined, { stderr: { data: input.error } }))
      frames.push(encodeShellStream(input.execId, input.executionTimeMs, { exit: { code: 1, aborted: false } }))
    } else {
      if (input.output) {
        frames.push(encodeShellStream(input.execId, undefined, { stdout: { data: input.output } }))
      }
      frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
        exit: { code: 0, aborted: false },
      }))
    }
  } else {
    const clientMsg: Record<string, unknown> = {
      id: input.execId,
      local_execution_time_ms: input.executionTimeMs ?? 0,
    }
    clientMsg[resultField] = buildTypedExecResult(resultField, input.output, input.error, input.toolName)
    frames.push(
      encodeMessage("AgentClientMessage", {
        exec_client_message: clientMsg,
      }),
    )
  }

  // Always close the exec stream — mirrors CLI agent-exec after every handler.
  frames.push(buildExecStreamClose(input.execId))
  return frames
}

/** ACM #5 exec_client_control_message { stream_close { id } }. */
export function buildExecStreamClose(execId: number): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_control_message: {
      stream_close: { id: execId },
    },
  })
}

/**
 * Strip opencode's `read` envelope, leaving raw file content.
 *
 * opencode's read tool (opencode `tool/read.ts`) wraps content in an XML-ish
 * envelope its own models are trained on, but Cursor's are not:
 *   <path>{abs}</path>\n<type>file</type>\n<content>\n{N}: {line}\n…\n\n{footer}\n</content>
 * Forwarding that envelope verbatim made Cursor's model treat the wrapper as
 * literal file content and write `<path>`/`<content>` tags + `N:` line prefixes
 * back into files (silent corruption — the write still reports success; seen
 * across 8+ sessions, e.g. language-model.ts rewritten starting with
 * `<path>…</path>\n<type>file</type>\n<content>\n1: import fs…`).
 *
 * Returns the raw file body (line numbers + footer + `<system-reminder>` dropped).
 *
 * Deliberately exception-safe: if the expected envelope is absent — non-read
 * output, already-raw text, or a future opencode format change — it returns the
 * input unchanged, so a result is never broken and we never throw mid-turn.
 * Callers must still gate `mcp_result` on `toolName === "read"`; this helper
 * alone is not a tool-identity check.
 */
export function unwrapReadOutput(output: string): string {
  if (typeof output !== "string" || output.length === 0) return output
  // Require the full opencode read-envelope skeleton *before* `<content>`
  // (read.ts opens with <path>…</path>, <type>file</type>, <content>) so a
  // stray "<content>" later in tool chatter can't trigger unwrapping just
  // because path/type tags appear elsewhere in the payload.
  const contentHeaderIdx = output.indexOf("<content>")
  if (contentHeaderIdx === -1) return output
  const header = output.slice(0, contentHeaderIdx)
  const hasSkeleton =
    header.indexOf("<path>") !== -1 &&
    header.indexOf("<type>file</type>") !== -1
  if (!hasSkeleton) {
    // Saw "<content>" but not the read skeleton ahead of it — almost certainly
    // a non-read payload, or an opencode format drift. Surface it so drift
    // can't silently resurrect the wrapper-corruption bug, but still fail
    // safe (no mutate).
    trace("unwrapReadOutput: <content> present without leading <path>/<type>file> skeleton — leaving output unchanged (possible non-read payload or opencode read format drift)")
    return output
  }
  // Body starts right after "<content>\n". opencode emits one numbered line per
  // file line ("N: <line>"), then a blank, a "(…)" footer, and a standalone
  // "</content>". The body is a *contiguous run* of /^N: / lines — so we stop at
  // the first non-numbered line. Critically we do NOT search for a closing
  // "</content>" substring: a file line that literally contains "</content>"
  // is rendered as "N: </content>" (a body line), and a raw indexOf would
  // truncate the read there.
  let rest = output.slice(contentHeaderIdx + "<content>".length)
  if (rest.startsWith("\n")) rest = rest.slice(1)
  const raw: string[] = []
  for (const line of rest.split("\n")) {
    const m = /^(\d+):[ \t]?(.*)$/.exec(line)
    if (!m) break // blank / "(footer)" / "</content>" → end of body run
    // Strip only the leading "N: " prefix; a line that itself begins with
    // digits+colon keeps its content (we remove just the first match). Blank
    // file lines render as "N: " and are preserved (capture group is "").
    raw.push(m[2])
  }
  // Envelope confirmed but no numbered body → empty file. Return "" rather
  // than the envelope (the envelope is exactly what Cursor echoes into writes).
  return raw.join("\n")
}

/**
 * Map OpenCode tool text into the agent.v1 result oneof for each exec variant.
 * OpenCode returns free-form text; we wrap it in the minimal success shape the
 * server accepts (verified against agent.v1 wire captures).
 */
export function buildTypedExecResult(
  resultField: string,
  output: string,
  error?: string,
  toolName?: string,
): Record<string, unknown> {
  switch (resultField) {
    case "read_result":
      if (error) return { error: { path: "", error } }
      // Strip opencode's <path>/<content> envelope so Cursor's model receives
      // raw file content and can't echo the wrapper into subsequent writes.
      // reads route here only for native read_args; most arrive via mcp_result.
      const content = unwrapReadOutput(output)
      return {
        success: {
          path: extractPathTag(output) ?? "",
          content,
          total_lines: countLines(content),
        },
      }
    case "grep_result": {
      if (error) return { error: { error } }
      // Prefer files_with_matches: OpenCode glob/grep often returns path lists.
      // Content-mode GrepSuccess also works but needs GrepFileMatch nesting.
      const files = extractPathLines(output)
      const cwd = process.cwd()
      return {
        success: {
          pattern: "",
          path: cwd,
          output_mode: "files_with_matches",
          workspace_results: {
            [cwd]: {
              files: {
                files,
                total_files: files.length,
                client_truncated: false,
              },
            },
          },
        },
      }
    }
    case "write_result":
      if (error) return { error: { path: "", error } }
      return {
        success: {
          path: extractPathTag(output) ?? "",
          lines_created: countLines(output),
          file_size: output.length,
        },
      }
    case "pi_write_result":
      // PiWriteExecSuccess is just { output }; error is { error }.
      if (error) return { error: { error } }
      return { success: { output: output || "Wrote file successfully." } }
    case "delete_result":
      if (error) return { error: { path: "", error } }
      return { success: { path: "", deleted_file: "" } }
    case "ls_result": {
      if (error) return { error: { path: "", error } }
      const rootPath = process.cwd()
      const entries = extractPathLines(output)
      return {
        success: {
          directory_tree_root: {
            abs_path: rootPath,
            children_dirs: [],
            children_files: entries.map((name) => ({
              name: name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name,
            })),
            num_files: entries.length,
          },
        },
      }
    }
    case "mcp_result":
      if (error) return { error: { error } }
      // opencode built-ins (read/write/grep/…) are advertised as MCP tools, so
      // a read call returns through mcp_result. Scope the unwrap to toolName
      // "read" so a non-read MCP tool whose output merely contains a
      // "<content>"-like block is never rewritten.
      return {
        success: {
          content: [
            { text: { text: toolName === "read" ? unwrapReadOutput(output) : output } },
          ],
          is_error: false,
        },
      }
    default:
      // Unknown variant: best-effort success wrapper so the server sees a oneof.
      if (error) return { error: { error } }
      return { success: { content: output } }
  }
}

function extractPathTag(output: string): string | undefined {
  const m = output.match(/<path>([^<]+)<\/path>/)
  return m?.[1]
}

function extractPathLines(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean)
  // Prefer absolute / relative path-looking lines; fall back to all non-empty.
  const paths = lines.filter((l) => l.startsWith("/") || l.startsWith("./") || l.includes("/"))
  return (paths.length > 0 ? paths : lines).slice(0, 2000)
}

function countLines(s: string): number {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

function encodeShellStream(
  execId: number,
  executionTimeMs: number | undefined,
  shellStream: Record<string, unknown>,
): Uint8Array {
  const clientMsg: Record<string, unknown> = {
    id: execId,
    shell_stream: shellStream,
  }
  if (executionTimeMs !== undefined) {
    clientMsg.local_execution_time_ms = executionTimeMs
  }
  return encodeMessage("AgentClientMessage", {
    exec_client_message: clientMsg,
  })
}

// ── Map a Cursor tool call to the opencode tool-call struct ──

export function buildToolCallPart(
  execMsg: ParsedExecRequest,
  sessionId: string,
): { toolCallId: string; toolName: string; input: string } {
  // Tag the toolCallId with the originating session's id so the result-bearing
  // doStream call can disambiguate the Run stream — Cursor resets exec ids per
  // stream, so two concurrent conversations would otherwise collide on `id`.
  return {
    toolCallId: `cursor_${sessionId}_${execMsg.id}`,
    toolName: execMsg.toolName,
    // LanguageModelV3ToolCall.input is a *stringified* JSON object. The AI SDK
    // does `input.trim()` before JSON.parse; emitting a plain object crashes
    // with "input.trim is not a function" and the model retries forever.
    // OpenCode's processor then receives the parsed object from the SDK.
    input: JSON.stringify(execMsg.args ?? {}),
  }
}

// ── Extract exec id from tool call id ──

export function parseExecIdFromToolCallId(
  toolCallId: string,
): { sessionId: string; execId: number } | undefined {
  // Format: cursor_<sessionId>_<execId>. sessionId may itself contain
  // underscores (e.g. UUIDs), so anchor on the trailing _<digits>.
  const match = toolCallId.match(/^cursor_(.+)_(\d+)$/)
  if (!match) return undefined
  const execId = parseInt(match[2], 10)
  if (!Number.isFinite(execId)) return undefined
  return { sessionId: match[1], execId }
}

// ── Safety net: reply to exec variants we don't map to an opencode tool ──
//
// Cursor's real server sends server-initiated exec probes (request_context #10,
// and potentially diagnostics/smart-mode-classifier/etc.) that are NOT tool
// calls. opencode owns the tool loop, so these have no opencode tool to route
// to — but we MUST still reply on the Run stream or the server blocks forever
// (endless heartbeats, no response). For any unmapped variant we emit an empty
// result at the SAME field number (request/result field numbers are identical
// for every exec variant: read #7→#7, mcp #11→#11, request_context #10→#10…).

/**
 * Find the exec variant field number from the raw (gunzipped) AgentServerMessage
 * payload: peel field #2 (exec_server_message), then return the first
 * message-typed field that isn't id(#1)/exec_id(#15)/span_context(#19).
 * Returns undefined if there is no exec_server_message or no variant set.
 */
export function detectExecVariantField(agentServerPayload: Uint8Array): number | undefined {
  const execBytes = readAllFields(agentServerPayload).find((f) => f.fn === 2 && f.wt === 2)?.bytes
  if (!execBytes) return undefined
  for (const f of readAllFields(execBytes)) {
    if (f.wt !== 2) continue // message-typed only (wire type 2)
    if (f.fn === 1 || f.fn === 15 || f.fn === 19) continue
    return f.fn
  }
  return undefined
}

/** Build ExecClientMessage{1:id, <resultField>: empty} as raw bytes. */
export function buildRawEmptyExecReply(execId: number, resultField: number): Uint8Array {
  const inner: number[] = []
  writeVarintRaw(inner, (1 << 3) | 0) // field 1 (id), wire 0 (varint)
  writeVarintRaw(inner, execId >>> 0)
  writeVarintRaw(inner, (resultField << 3) | 2) // field N, wire 2 (length-delimited)
  writeVarintRaw(inner, 0) // empty submessage
  // Wrap as AgentClientMessage.exec_client_message (field #2).
  const acm: number[] = []
  writeVarintRaw(acm, (2 << 3) | 2)
  writeVarintRaw(acm, inner.length)
  for (const b of inner) acm.push(b)
  return new Uint8Array(acm)
}

function writeVarintRaw(out: number[], n: number): void {
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
}

/**
 * Encode exec #10 request_context_result from a prebuilt RequestContext payload.
 */
export function buildRequestContextResult(
  execId: number,
  requestContext: Record<string, unknown>,
): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    exec_client_message: {
      id: execId,
      request_context_result: {
        success: {
          request_context: requestContext,
        },
      },
    },
  })
}