import { encodeMessage } from "./messages.js"
import { encodeJsonAsValue, decodeStructEntriesToJson, readAllFields } from "./struct.js"
import { trace } from "../debug.js"
import { cursorExecVariantByRequestName } from "./exec-variants.js"
import type { CursorShellOutcome } from "../shell-timeout.js"

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

export type ToolServerIdentity = {
  /** Cursor MCP server id / provider_identifier (e.g. opencode, github). */
  server: string
  /** Bare tool name inside that server (Cursor McpArgs.tool_name). */
  toolName: string
  /** Full OpenCode tool id used for local execution (e.g. github_create_pull_request). */
  opencodeName: string
}

/** Match OpenCode's McpCatalog.sanitize for config server ids. */
export function sanitizeMcpServerId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Resolve an OpenCode tool id using known MCP server ids from merged config.
 * Unknown names remain under the synthetic default server: a flattened tool
 * name alone cannot distinguish plugin/custom tools from `<server>_<tool>`.
 */
export function resolveToolServerIdentity(
  opencodeName: string,
  defaultServer = "opencode",
  knownMcpServers: Iterable<string> = [],
): ToolServerIdentity {
  if (!opencodeName) {
    return { server: defaultServer, toolName: "mcp", opencodeName: "mcp" }
  }

  // Longest first handles configured ids where one is a prefix of another
  // (e.g. "git" and "git_hub"). OpenCode flattens with the sanitized id.
  const servers = [...new Set([...knownMcpServers].map(sanitizeMcpServerId).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  for (const server of servers) {
    const prefix = `${server}_`
    if (!opencodeName.startsWith(prefix) || opencodeName.length === prefix.length) continue
    return {
      server,
      toolName: opencodeName.slice(prefix.length),
      opencodeName,
    }
  }
  return { server: defaultServer, toolName: opencodeName, opencodeName }
}

/**
 * Convert opencode's per-turn tool list into Cursor `McpToolDefinition`
 * entries for `request_context.tools` (#7) and `AgentRunRequest.mcp_tools`.
 *
 * Builtins and unknown plugin/custom tools are advertised under the synthetic
 * default server (`opencode`). Tools whose prefixes match configured MCP
 * servers keep those server ids (`github`, …). Composite `name` is
 * `<server>-<bareTool>`; local execution still uses the full OpenCode id
 * reconstructed in `mcpRealToolName`.
 */
export function toolsToDescriptors(
  tools: OpencodeToolDef[],
  providerIdentifier = "opencode",
  knownMcpServers: Iterable<string> = [],
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const id = resolveToolServerIdentity(t.name, providerIdentifier, knownMcpServers)
    return {
      name: `${id.server}-${id.toolName}`,
      description: t.description ?? "",
      input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
      provider_identifier: id.server,
      tool_name: id.toolName,
    }
  })
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>
  }
  return { type: "object", properties: {} }
}

/**
 * Build the nested McpFileSystemOptions / McpMetaToolOptions shape used by
 * requestContext.#23 / #34. One `McpDescriptor` per resolved server (builtins
 * and unknown tools under the synthetic default; configured MCP tools under
 * their upstream server id).
 */
export function toolsToMcpDescriptors(
  tools: OpencodeToolDef[],
  providerIdentifier = "opencode",
  knownMcpServers: Iterable<string> = [],
): Array<Record<string, unknown>> {
  if (tools.length === 0) return []

  const order: string[] = []
  const byServer = new Map<string, Array<Record<string, unknown>>>()

  for (const t of tools) {
    const id = resolveToolServerIdentity(t.name, providerIdentifier, knownMcpServers)
    let list = byServer.get(id.server)
    if (!list) {
      list = []
      byServer.set(id.server, list)
      order.push(id.server)
    }
    list.push({
      tool_name: id.toolName,
      description: t.description ?? "",
      input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
    })
  }

  return order.map((server) => ({
    server_name: server,
    server_identifier: server,
    tools: byServer.get(server)!,
  }))
}

/**
 * @deprecated Prefer `buildRequestContext` from `../context/build.js`.
 * Kept as a sync tools-only fallback for unit tests that don't need collectors.
 */
export function buildLiveRequestContext(
  tools: OpencodeToolDef[],
  providerIdentifier = "opencode",
  knownMcpServers: Iterable<string> = [],
): Record<string, unknown> {
  const flat = toolsToDescriptors(tools, providerIdentifier, knownMcpServers)
  const nested = toolsToMcpDescriptors(tools, providerIdentifier, knownMcpServers)
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
  pi_read_args: "read",
  pi_bash_args: "bash",
  pi_edit_args: "edit",
  pi_write_args: "write",
  pi_grep_args: "grep",
  pi_find_args: "glob",
  pi_ls_args: "read",
  grep_args: "grep",
  ls_args: "read",
  delete_args: "bash",
  shell_stream_args: "bash",
  background_shell_spawn_args: "bash",
  subagent_args: "task",
  mcp_args: "mcp",
}

const opencodeToolToCursor: Record<string, string> = {
  read: "read_args",
  write: "write_args",
  grep: "grep_args",
  bash: "shell_stream_args",
  task: "subagent_args",
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

/** Required content fields where an empty string is meaningful (for example, truncating a file). */
const PRESERVE_EMPTY_STRING_KEYS = new Set([
  "content",
  "file_text",
  "fileText",
  "stream_content",
  "oldString",
  "old_string",
  "newString",
  "new_string",
])

export function mapExecServerToToolName(execField: string): string | undefined {
  return cursorToolToOpencode[execField]
}

export function mapToolNameToExecField(toolName: string): string | undefined {
  return opencodeToolToCursor[toolName]
}

// ── Extract exec args from ExecServerMessage ──

export type ParsedExecRequest = {
  id: number
  execId: string
  toolName: string
  args: Record<string, unknown>
  /** ExecClientMessage result field to reply with (matches the request variant). */
  resultField: string
  /** Typed error to return without asking OpenCode to execute invalid args. */
  localError?: string
  /** Original request values needed by typed Cursor result messages. */
  resultMetadata?: Record<string, unknown>
}

const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__"

export function parseExecServerMessage(
  msg: Record<string, unknown>,
): ParsedExecRequest | undefined {
  const id = msg.id as number | undefined
  if (id === undefined) return undefined

  // Find which args variant is set
  const execVariant = findOneOfVariant(msg, [
    "read_args", "write_args",
    "pi_read_args", "pi_bash_args", "pi_edit_args", "pi_write_args",
    "pi_grep_args", "pi_find_args", "pi_ls_args",
    "grep_args", "ls_args",
    "delete_args", "shell_stream_args", "background_shell_spawn_args", "mcp_args",
    "subagent_args",
  ])
  if (!execVariant) return undefined

  // Use the complete canonical request/result table. In particular, Pi request
  // fields #45..#51 pair with result fields #46..#52 rather than matching ids.
  const resultField = cursorExecVariantByRequestName(execVariant)?.resultName
  if (!resultField) return undefined
  const execId = (msg.exec_id as string) ?? ""

  if (execVariant === "background_shell_spawn_args") {
    const raw = (msg.background_shell_spawn_args as Record<string, unknown>) ?? {}
    const command = str(raw.command)
    const workingDirectory = str(raw.working_directory) ?? ""
    const args: Record<string, unknown> = {}
    if (command) args.command = buildBackgroundShellCommand(command)
    if (workingDirectory) args.workdir = workingDirectory
    return {
      id,
      execId,
      toolName: "bash",
      args,
      resultField,
      resultMetadata: { command: command ?? "", working_directory: workingDirectory },
      localError:
        raw.enable_write_shell_stdin_tool === true
          ? "Interactive background shells are not available through OpenCode's bash tool."
          : command
            ? undefined
            : "Cursor background shell request is missing a command.",
    }
  }

  if (execVariant === "subagent_args") {
    const raw = (msg.subagent_args as Record<string, unknown>) ?? {}
    const prompt = str(raw.prompt)
    const cursorSubagentType = str(raw.subagent_type)
    const subagentType = cursorSubagentType
      ? mapCursorSubagentTypeToOpenCode(cursorSubagentType)
      : undefined
    const args: Record<string, unknown> = {
      description: describeSubagentTask(prompt, subagentType),
      prompt: prompt ?? "",
      subagent_type: subagentType ?? "",
    }
    const resumeAgentId = str(raw.resume_agent_id)
    if (resumeAgentId) args.task_id = resumeAgentId
    // protobufjs materializes an absent proto3 optional bool as false in this
    // reflection schema. OpenCode's foreground default is already false, so
    // only forward the meaningful opt-in value.
    if (raw.run_in_background === true) args.background = true
    return {
      id,
      execId,
      toolName: "task",
      args,
      resultField,
      localError:
        prompt && cursorSubagentType
          ? undefined
          : "Cursor subagent request is missing a required prompt or subagent type.",
    }
  }

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

  if (execVariant === "pi_edit_args") {
    const raw = (msg.pi_edit_args as Record<string, unknown>) ?? {}
    const edits = Array.isArray(raw.edits) ? raw.edits : []
    const replacement = edits.length === 1 && edits[0] && typeof edits[0] === "object"
      ? edits[0] as Record<string, unknown>
      : undefined
    const path = str(raw.path)
    const oldString = replacement ? stringValue(replacement.old_text) : undefined
    const newString = replacement ? stringValue(replacement.new_text) : undefined
    const args: Record<string, unknown> = {}
    if (path) args.filePath = path
    if (oldString !== undefined) args.oldString = oldString
    if (newString !== undefined) args.newString = newString
    return {
      id,
      execId,
      toolName: "edit",
      args,
      resultField,
      localError:
        path && oldString && newString !== undefined
          ? undefined
          : "Cursor Pi edit cannot be represented safely: expected one non-empty replacement.",
    }
  }

  const toolName = cursorToolToOpencode[execVariant]
  if (!toolName) return undefined

  const mapped = mapCursorArgsToOpencode(
    toolName,
    (msg[execVariant] as Record<string, unknown>) ?? {},
    execVariant,
  )
  const resultMetadata = execVariant === "shell_stream_args"
    ? shellStreamResultMetadata((msg[execVariant] as Record<string, unknown>) ?? {})
    : undefined
  if (
    resultMetadata
    && resultMetadata.timeout_behavior !== 2
    && typeof resultMetadata.timeout_ms === "number"
  ) {
    // Cursor's protobuf default (timeout=0) means 30 seconds for an ordinary
    // foreground shell. OpenCode instead treats zero literally, so pass the
    // effective native value rather than the raw protobuf default.
    mapped.args.timeout = resultMetadata.timeout_ms
  }
  return {
    id,
    execId,
    toolName: mapped.toolName,
    args: mapped.args,
    resultField,
    ...(resultMetadata ? { resultMetadata } : {}),
  }
}

function shellStreamResultMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  const timeout = num(raw.timeout) ?? 0
  const timeoutBehavior = num(raw.timeout_behavior) ?? 0
  const hardTimeout = num(raw.hard_timeout)
  // Cursor CLI: a nonzero timeout is used verbatim. A zero foreground timeout
  // defaults to 30s; zero with background/hard-timeout semantics means an
  // immediate soft handoff governed by the separate hard deadline.
  const effectiveTimeout = timeout !== 0
    ? timeout
    : (timeoutBehavior === 2 || (hardTimeout !== undefined && hardTimeout > 0) ? 0 : 30_000)
  return {
    shell_stream: true,
    command: str(raw.command) ?? "",
    working_directory: str(raw.working_directory) ?? "",
    timeout_ms: effectiveTimeout,
    timeout_behavior: timeoutBehavior,
    ...(hardTimeout !== undefined && hardTimeout > 0 ? { hard_timeout_ms: hardTimeout } : {}),
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
    // Drop empty strings from optional protobuf defaults, but retain required
    // content fields where empty means a valid destructive edit/write.
    if (typeof v === "string" && v.length === 0 && !PRESERVE_EMPTY_STRING_KEYS.has(k)) continue
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
      const content = stringValue(cleaned.content) ?? stringValue(cleaned.file_text) ?? stringValue(cleaned.fileText)
      if (content !== undefined) args.content = content
      return { toolName: "write", args }
    }
    case "edit": {
      const args: Record<string, unknown> = {}
      const filePath = str(cleaned.filePath) ?? str(cleaned.path) ?? str(cleaned.file_path)
      if (filePath) args.filePath = filePath
      const oldString = stringValue(cleaned.oldString) ?? stringValue(cleaned.old_string)
      if (oldString !== undefined) args.oldString = oldString
      const newString = stringValue(cleaned.newString) ?? stringValue(cleaned.new_string)
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

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function describeSubagentTask(prompt?: string, subagentType?: string): string {
  const words = prompt?.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 5)
  if (words?.length) return words.join(" ")
  return `${subagentType || "Delegated"} task`
}

function mapCursorSubagentTypeToOpenCode(subagentType: string): string {
  // Cursor's built-in general agent uses a camelCase protocol identifier, and
  // its native Bugbot reviewer has no OpenCode-specific agent definition.
  // OpenCode `general` is the general-purpose equivalent; `explore` preserves
  // Bugbot's review-only/read-oriented semantics while retaining grep/read/bash.
  // Preserve every other value so `explore` and configured custom agents keep
  // their exact advertised names.
  if (subagentType === "generalPurpose") return "general"
  if (subagentType === "bugbot") return "explore"
  return subagentType
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * OpenCode's bash tool is foreground-only. Detach the requested command inside
 * that one foreground call and print a private marker containing the spawned
 * PID and log path. With stdin and all output redirected, the host shell can
 * return immediately instead of retaining OpenCode's tool pipe.
 */
function buildBackgroundShellCommand(command: string): string {
  return [
    'bg_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-bg.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
    "bg_pid=$!",
    `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
  ].join("\n")
}

/**
 * Map Cursor McpArgs back to the OpenCode tool id.
 * Prefers provider_identifier + bare tool_name (github + create_pull_request
 * → github_create_pull_request). Builtins under the default server stay bare.
 */
export function mcpRealToolName(
  mcpArgs: Record<string, unknown>,
  defaultServer = "opencode",
): string {
  const toolName = typeof mcpArgs.tool_name === "string" ? mcpArgs.tool_name : undefined
  const provider =
    typeof mcpArgs.provider_identifier === "string" ? mcpArgs.provider_identifier : undefined

  if (toolName) {
    if (provider && provider !== defaultServer) {
      // Already a full OpenCode id (legacy ads or model echo).
      if (toolName.startsWith(`${provider}_`)) return toolName
      return `${provider}_${toolName}`
    }
    return toolName
  }

  const name = typeof mcpArgs.name === "string" ? mcpArgs.name : ""
  const dash = name.indexOf("-")
  if (dash > 0) {
    const server = name.slice(0, dash)
    const bare = name.slice(dash + 1)
    if (server && bare) {
      if (server === defaultServer) return bare
      return `${server}_${bare}`
    }
  }
  return name || "mcp"
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
  /** Original request fields required by a typed result (background shell). */
  resultMetadata?: Record<string, unknown>
  /** Structured shell completion captured by the OpenCode plugin hook. */
  shellOutcome?: CursorShellOutcome
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
      if (input.shellOutcome?.kind === "backgrounded") {
        frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
          backgrounded: {
            shell_id: input.shellOutcome.shellId,
            command: input.shellOutcome.command,
            working_directory: input.shellOutcome.workingDirectory,
            pid: input.shellOutcome.pid,
            ms_to_wait: input.shellOutcome.msToWait,
            reason: input.shellOutcome.reason,
          },
        }))
      } else if (input.shellOutcome?.kind === "timeout") {
        frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
          // Native CLI represents timeout structurally. ShellAbortReason.TIMEOUT=2.
          exit: { code: 0, aborted: true, abort_reason: 2 },
        }))
      } else {
        const exitCode = input.shellOutcome?.kind === "exit"
          ? Math.max(0, Math.min(0xffff_ffff, input.shellOutcome.code))
          : 0
        frames.push(encodeShellStream(input.execId, input.executionTimeMs, {
          exit: { code: exitCode, aborted: false },
        }))
      }
    }
  } else {
    const clientMsg: Record<string, unknown> = {
      id: input.execId,
      local_execution_time_ms: input.executionTimeMs ?? 0,
    }
    clientMsg[resultField] = buildTypedExecResult(
      resultField,
      input.output,
      input.error,
      input.toolName,
      input.resultMetadata,
    )
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
  resultMetadata?: Record<string, unknown>,
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
    case "pi_read_result":
      if (error) return { error: { error } }
      return { success: { output: unwrapReadOutput(output) } }
    case "pi_bash_result":
    case "pi_edit_result":
    case "pi_grep_result":
    case "pi_find_result":
    case "pi_ls_result":
      if (error) return { error: { error } }
      return { success: { output } }
    case "delete_result":
      if (error) return { error: { path: "", error } }
      return { success: { path: "", deleted_file: "" } }
    case "background_shell_spawn_result": {
      const command = str(resultMetadata?.command) ?? ""
      const workingDirectory = str(resultMetadata?.working_directory) ?? ""
      if (error) return { error: { command, working_directory: workingDirectory, error } }
      const match = new RegExp(`${BACKGROUND_SHELL_MARKER}(\\d+):([^\\r\\n]+)`).exec(output)
      const pid = match ? Number(match[1]) : 0
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
        return {
          error: {
            command,
            working_directory: workingDirectory,
            error: "OpenCode did not return a valid background shell process id.",
          },
        }
      }
      return {
        success: {
          shell_id: pid,
          command,
          working_directory: workingDirectory,
          pid,
        },
      }
    }
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
    case "subagent_result": {
      const task = parseOpenCodeTaskOutput(output)
      if (error || task.state === "error") {
        return {
          error: {
            ...(task.agentId ? { agent_id: task.agentId } : {}),
            error: error ?? task.message ?? output,
          },
        }
      }
      return {
        success: {
          agent_id: task.agentId ?? "",
          ...(task.message !== undefined ? { final_message: task.message } : {}),
          tool_call_count: 0,
          // OpenCode marks an asynchronous launch as state="running". Cursor's
          // canonical USER_REQUEST enum value is 2; foreground/default is 0.
          background_reason: task.state === "running" ? 2 : 0,
        },
      }
    }
    default:
      // Unknown variant: best-effort success wrapper so the server sees a oneof.
      if (error) return { error: { error } }
      return { success: { content: output } }
  }
}

function parseOpenCodeTaskOutput(output: string): {
  agentId?: string
  state?: "running" | "completed" | "error"
  message?: string
} {
  // Attribute order is not guaranteed; accept id/state in either order and
  // ignore additional attributes OpenCode may emit on the <task> open tag.
  const open = /<task\b([^>]*)>/i.exec(output)
  if (!open) return { message: output }
  const attrs = open[1]
  const agentId = /\bid="([^"]+)"/i.exec(attrs)?.[1]
  const state = /\bstate="(running|completed|error)"/i.exec(attrs)?.[1] as
    | "running"
    | "completed"
    | "error"
    | undefined
  if (!agentId || !state) return { message: output }
  const tag = state === "error" ? "task_error" : "task_result"
  const body = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`, "i").exec(output)
  return {
    agentId,
    state,
    message: body?.[1] ?? output,
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

// ── Unknown exec diagnostics ──
//
// Request/result field numbers are not universally identical (the Pi range is
// offset by one), so unknown variants must never receive a guessed empty reply.
// The pump uses this raw detector to report schema drift and fail the Run.

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

/**
 * Answer Cursor's exec #36 MCP-state probe from the same descriptors advertised
 * in RequestContext. OpenCode remains the executor; this only confirms that the
 * provider's virtual MCP servers and their tools are available.
 */
export function buildMcpStateResult(
  execId: number,
  args: Record<string, unknown>,
  requestContext: Record<string, unknown>,
): Uint8Array {
  const requested = new Set(
    Array.isArray(args.server_identifiers)
      ? args.server_identifiers.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
  )
  const fsOptions = recordValue(requestContext.mcp_file_system_options)
  const nested = Array.isArray(fsOptions?.mcp_descriptors)
    ? fsOptions.mcp_descriptors.map(recordValue).filter((d): d is Record<string, unknown> => !!d)
    : []
  const descriptors = nested.length > 0 ? nested : descriptorsFromFlatTools(requestContext.tools)
  const flatTools = Array.isArray(requestContext.tools)
    ? requestContext.tools.map(recordValue).filter((tool): tool is Record<string, unknown> => !!tool)
    : []
  const servers = descriptors
    .filter((descriptor) => {
      const id = stringValue(descriptor.server_identifier)
      return requested.size === 0 || (id !== undefined && requested.has(id))
    })
    .map((descriptor) => {
      const serverIdentifier =
        stringValue(descriptor.server_identifier) ?? stringValue(descriptor.server_name) ?? ""
      const tools = Array.isArray(descriptor.tools)
        ? descriptor.tools
            .map(recordValue)
            .filter((tool): tool is Record<string, unknown> => !!tool)
            .map((tool) => mcpStateToolDefinition(serverIdentifier, tool, flatTools))
        : []
      return {
        server_name: stringValue(descriptor.server_name) ?? serverIdentifier,
        server_identifier: serverIdentifier,
        tools,
      }
    })

  return encodeMessage("AgentClientMessage", {
    exec_client_message: {
      id: execId,
      mcp_state_exec_result: { success: { servers } },
    },
  })
}

/**
 * Exec #36 uses McpToolDefinition, not the narrower McpToolDescriptor used by
 * RequestContext's filesystem/meta-tool catalogs. Rehydrate the full identity
 * from RequestContext.tools so Cursor's native get_mcp_tools can correlate the
 * discovered definition with the later provider_identifier/tool_name request.
 */
function mcpStateToolDefinition(
  serverIdentifier: string,
  descriptor: Record<string, unknown>,
  flatTools: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const toolName = stringValue(descriptor.tool_name) ?? ""
  const advertised = flatTools.find((tool) =>
    stringValue(tool.provider_identifier) === serverIdentifier
      && stringValue(tool.tool_name) === toolName
  )
  return {
    name: stringValue(advertised?.name) ?? `${serverIdentifier}-${toolName}`,
    description:
      stringValue(advertised?.description) ?? stringValue(descriptor.description) ?? "",
    input_schema: advertised?.input_schema ?? descriptor.input_schema,
    provider_identifier: serverIdentifier,
    tool_name: toolName,
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function descriptorsFromFlatTools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  const byServer = new Map<string, Array<Record<string, unknown>>>()
  for (const raw of value) {
    const tool = recordValue(raw)
    if (!tool) continue
    const server = stringValue(tool.provider_identifier) ?? "opencode"
    const tools = byServer.get(server) ?? []
    tools.push({
      tool_name: stringValue(tool.tool_name) ?? stringValue(tool.name) ?? "",
      description: stringValue(tool.description) ?? "",
      input_schema: tool.input_schema,
    })
    byServer.set(server, tools)
  }
  return [...byServer].map(([server, tools]) => ({
    server_name: server,
    server_identifier: server,
    tools,
  }))
}
