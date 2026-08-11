import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeMessage } from "./messages.js"
import { encodeJsonAsValue, decodeStructEntriesToJson, readAllFields } from "./struct.js"
import { buildEnv } from "../context/env.js"
import { ensureOpencodeProjectDir } from "../context/paths.js"
import { trace, traceRequestContextPaths } from "../debug.js"
import { cursorExecVariantByRequestName } from "./exec-variants.js"
import {
  APPLY_PATCH_TOOL,
  buildAddFilePatch,
  buildUpdateFilePatch,
  planSubstringEdit,
} from "./apply-patch.js"
import {
  BACKGROUND_SHELL_MARKER,
  buildBackgroundShellCommand,
  type CursorShellOutcome,
} from "../shell-timeout.js"

// Exec variant field number whose reply is the server-initiated request_context
// probe (ExecServerMessage #10 → ExecClientMessage #10). request/result share a
// field number for every exec variant, so this is also the result field.
export const REQUEST_CONTEXT_RESULT_FIELD = 10

// ── opencode tool definitions → Cursor request_context descriptors ──

export type OpencodeToolDef = {
  name: string
  description?: string
  inputSchema?: unknown
  /** Original flattened identity when `name` is a Cursor-facing alias. */
  sourceName?: string
}

export const CUSTOM_WEBSEARCH_TOOL = "custom_websearch"
export const CUSTOM_WEBFETCH_TOOL = "custom_webfetch"

/** Cursor-facing alias → exact host tool name accepted by the AI SDK call. */
export type ToolAliasRegistry = ReadonlyMap<string, string>

export type AliasedToolCatalog = {
  advertisedTools: OpencodeToolDef[]
  aliases: ToolAliasRegistry
  ambiguous: ReadonlyMap<string, string[]>
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
    const id = resolveToolServerIdentity(t.sourceName ?? t.name, providerIdentifier, knownMcpServers)
    const collisionSafeWebAlias =
      t.name === CUSTOM_WEBSEARCH_TOOL || t.name === CUSTOM_WEBFETCH_TOOL
    return {
      // Keep the collision-safe public name exact. Prefixing it with the
      // synthetic default server weakens the distinction from Cursor-native
      // web tools in the model-visible catalog.
      name: collisionSafeWebAlias ? t.name : `${id.server}-${id.toolName}`,
      description: t.description ?? "",
      input_schema: encodeJsonAsValue(normalizeInputSchema(t.inputSchema)),
      provider_identifier: id.server,
      tool_name: t.sourceName ? t.name : id.toolName,
    }
  })
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>
  }
  return { type: "object", properties: {} }
}

type WebAliasRule = {
  alias: string
  exact: readonly string[]
  suffixes: readonly string[]
}

const WEB_ALIAS_RULES: readonly WebAliasRule[] = [
  {
    alias: CUSTOM_WEBSEARCH_TOOL,
    exact: ["websearch", "web_search"],
    suffixes: ["_web_search", "-web_search", "_websearch", "-websearch"],
  },
  {
    alias: CUSTOM_WEBFETCH_TOOL,
    exact: ["webfetch", "web_fetch"],
    suffixes: ["_web_fetch", "-web_fetch", "_webfetch", "-webfetch"],
  },
]

/**
 * Give collision-prone web capabilities names Cursor will not confuse with its
 * native UI-bound WebSearch/WebFetch interactions. Exact host tools win; a
 * flattened MCP suffix is accepted only when it identifies one unique tool.
 */
export function buildCustomWebToolAliases(tools: OpencodeToolDef[]): AliasedToolCatalog {
  const aliases = new Map<string, string>()
  const ambiguous = new Map<string, string[]>()
  const replacements = new Map<string, string>()

  for (const rule of WEB_ALIAS_RULES) {
    // A host/plugin may already expose the collision-safe public name. Keep it
    // authoritative instead of hiding it behind a second mapping.
    if (tools.some((tool) => tool.name === rule.alias)) continue

    const exact = tools.filter((tool) => rule.exact.includes(tool.name.toLowerCase()))
    const candidates = exact.length > 0
      ? exact
      : tools.filter((tool) => {
          const name = tool.name.toLowerCase()
          return rule.suffixes.some((suffix) => name.endsWith(suffix))
        })

    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous.set(rule.alias, candidates.map((tool) => tool.name))
      continue
    }

    const original = candidates[0]!.name
    aliases.set(rule.alias, original)
    replacements.set(original, rule.alias)
  }

  return {
    advertisedTools: tools.map((tool) => {
      const alias = replacements.get(tool.name)
      return alias ? { ...tool, name: alias, sourceName: tool.name } : { ...tool }
    }),
    aliases,
    ambiguous,
  }
}

export function resolveCustomWebToolAlias(
  toolName: string,
  aliases: ToolAliasRegistry | undefined,
): string {
  const direct = aliases?.get(toolName)
  if (direct) return direct
  for (const [alias, original] of aliases ?? []) {
    if (toolName.endsWith(`_${alias}`)) return original
  }
  return toolName
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
    const id = resolveToolServerIdentity(t.sourceName ?? t.name, providerIdentifier, knownMcpServers)
    let list = byServer.get(id.server)
    if (!list) {
      list = []
      byServer.set(id.server, list)
      order.push(id.server)
    }
    list.push({
      tool_name: t.sourceName ? t.name : id.toolName,
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
  const ctx: Record<string, unknown> = {
    env: buildEnv(cwd),
    tools: flat,
    mcp_file_system_options: {
      enabled: true,
      workspace_project_dir: ensureOpencodeProjectDir(cwd),
      mcp_descriptors: nested,
    },
    mcp_meta_tool_options: {
      enabled: true,
      mcp_descriptors: nested,
    },
    web_search_enabled: false,
    web_fetch_enabled: false,
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    mcp_file_system_info_complete: true,
    git_status_info_complete: true,
  }
  traceRequestContextPaths("buildLiveRequestContext", ctx)
  return ctx
}

// ── Cursor exec-variant → opencode tool name ──

// Native ExecServerMessage variants only (agent.v1). There is no edit_args or
// glob_args on the exec channel — Cursor's EditToolCall is display-only, and
// glob/edit from opencode are advertised as MCP tools and arrive as mcp_args.
//
// Design note (F11): Cursor has native delete / background-shell tools; OpenCode
// does not. This provider intentionally remaps:
//   - delete_args → bash `rm -f -- <quoted-path>`
//   - background_shell_spawn_args → bash (original command; plugin wraps nohup)
// Permissions still flow through OpenCode's advertised `bash` tool. Soft-
// background / detached children can outlive the OpenCode tool call; leftover
// process cleanup is left to the user / OS. Arg key remapping happens below.
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
  // WriteArgs #4. A request for WriteSuccess.file_content_after_write, which we
  // do not populate; harmless to omit, but it is not tool input.
  "return_file_content_after_write",
  "ignore",
])
// WriteArgs #5/#6 are deliberately NOT internal: `file_bytes` carries the file
// content itself whenever Cursor sends it instead of `file_text` (its own
// LocalWriteExecutor prefers bytes when non-empty), and `encoding_hint` is how
// that payload is decoded. The `write` mapping consumes both explicitly.

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

const CURSOR_SUBAGENT_TYPE_TO_OPENCODE: Record<string, string> = {
  generalPurpose: "general",
  "general-purpose": "general",
  general_purpose: "general",
  general: "general",
  unspecified: "general",
  "cursor-guide": "explore",
  cursor_guide: "explore",
  "best-of-n-runner": "general",
  best_of_n_runner: "general",
  bash: "general",
  shell: "general",
  debug: "general",
  computer_use: "general",
  computerUse: "general",
  browser_use: "general",
  browserUse: "general",
  media_review: "general",
  mediaReview: "general",
  watch_video: "general",
  watchVideo: "general",
  vm_setup_helper: "general",
  vmSetupHelper: "general",
  explore: "explore",
  bugbot: "explore",
  "security-review": "explore",
  security_review: "explore",
}

export type HostSubagentDefinition = {
  name: string
  description?: string
}

export type HostSubagentCatalog = {
  executor?: "task" | "actor"
  agents: HostSubagentDefinition[]
  /** True when the host tool supplied its complete, permission-filtered catalog. */
  complete: boolean
}

const SUBAGENT_CATALOG_MARKER = "Available agent types and the tools they have access to:"

function parseSubagentDescriptionCatalog(description: string | undefined): {
  found: boolean
  agents: HostSubagentDefinition[]
} {
  if (!description) return { found: false, agents: [] }
  const marker = description.indexOf(SUBAGENT_CATALOG_MARKER)
  if (marker < 0) return { found: false, agents: [] }

  const agents: HostSubagentDefinition[] = []
  const lines = description.slice(marker + SUBAGENT_CATALOG_MARKER.length).split(/\r?\n/)
  let started = false
  for (const line of lines) {
    const match = line.match(/^\s*-\s+([^:]+):\s*(.*)$/)
    if (!match) {
      if (started && line.trim()) break
      continue
    }
    started = true
    const name = match[1]!.trim().replace(/^`|`$/g, "")
    if (!name) continue
    const agentDescription = match[2]!.trim()
    agents.push({
      name,
      ...(agentDescription ? { description: agentDescription } : {}),
    })
  }
  return { found: true, agents }
}

function subagentTypeEnumValues(schema: unknown): string[] {
  const out = new Set<string>()
  const seen = new Set<object>()
  const visit = (value: unknown, propertyName?: string): void => {
    if (!value || typeof value !== "object") return
    if (seen.has(value as object)) return
    seen.add(value as object)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, propertyName)
      return
    }

    const record = value as Record<string, unknown>
    if (propertyName === "subagent_type" && Array.isArray(record.enum)) {
      for (const item of record.enum) {
        if (typeof item === "string" && item) out.add(item)
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, key)
  }
  visit(schema)
  return [...out]
}

/** Extract the current host's permission-filtered Task/Actor recipient catalog. */
export function extractHostSubagentCatalog(tools: OpencodeToolDef[]): HostSubagentCatalog {
  const executorTool = tools.find((tool) => tool.name === "actor") ??
    tools.find((tool) => tool.name === "task")
  if (!executorTool) return { agents: [], complete: true }

  const described = parseSubagentDescriptionCatalog(executorTool.description)
  const enumNames = subagentTypeEnumValues(executorTool.inputSchema)
  const descriptions = new Map(described.agents.map((agent) => [agent.name, agent.description]))
  // MiMo's Actor enum is stricter than its prose catalog (`mode: subagent`
  // rather than every non-primary agent), so structured names are authoritative.
  const names = new Set(
    enumNames.length > 0 ? enumNames : described.agents.map((agent) => agent.name),
  )
  return {
    executor: executorTool.name as "task" | "actor",
    agents: [...names].map((name) => ({
      name,
      ...(descriptions.get(name) ? { description: descriptions.get(name) } : {}),
    })),
    complete: enumNames.length > 0 || described.found,
  }
}

const GENERIC_CURSOR_SUBAGENT_TYPES = new Set([
  "generalPurpose",
  "general-purpose",
  "general_purpose",
  "general",
  "unspecified",
])

function cursorSubagentCandidates(subagentType: string): string[] {
  if (GENERIC_CURSOR_SUBAGENT_TYPES.has(subagentType)) return ["general"]
  if (subagentType === "cursor-guide" || subagentType === "cursor_guide") {
    return ["scout", "explore", "general"]
  }
  if (
    subagentType === "explore" ||
    subagentType === "bugbot" ||
    subagentType === "security-review" ||
    subagentType === "security_review"
  ) {
    return ["explore", "general"]
  }
  return ["general"]
}

/** Resolve a Cursor subtype against the agents the host can spawn this turn. */
export function resolveCursorSubagentType(
  subagentType: string,
  catalog?: HostSubagentCatalog,
): string | undefined {
  const available = new Set(catalog?.agents.map((agent) => agent.name) ?? [])

  // Explicit host/custom names win. `unspecified` and general aliases are
  // intentionally excluded so they always select the host's generic agent.
  if (!GENERIC_CURSOR_SUBAGENT_TYPES.has(subagentType) && available.has(subagentType)) {
    return subagentType
  }

  const candidates = cursorSubagentCandidates(subagentType)
  for (const candidate of candidates) {
    if (available.has(candidate)) return candidate
  }
  if (catalog?.complete) return undefined
  return candidates[0]
}

/**
 * Cursor's native Task/subagent protocol uses Cursor-owned subtype names while
 * OpenCode-family hosts execute named agents. Map known Cursor built-ins to
 * the closest host agent and preserve unknown values so user-defined OpenCode
 * agents can still be called by exact name.
 */
export function mapCursorSubagentTypeToOpenCode(subagentType: string): string {
  return CURSOR_SUBAGENT_TYPE_TO_OPENCODE[subagentType] ?? subagentType
}

/** Resolve a native Cursor subagent request to this turn's executor and catalog. */
export function remapNativeSubagentForCatalog(
  parsed: ParsedExecRequest,
  advertisedToolNames: Iterable<string>,
  catalog?: HostSubagentCatalog,
): void {
  if (parsed.resultField !== "subagent_result" || parsed.toolName !== "task") return
  const advertised = new Set(advertisedToolNames)
  const executor = advertised.has("actor") ? "actor" : advertised.has("task") ? "task" : undefined
  if (!executor) return

  const description = str(parsed.args.description) ?? ""
  const prompt = str(parsed.args.prompt) ?? ""
  const cursorSubagentType = str(parsed.resultMetadata?.cursor_subagent_type) ??
    str(parsed.args.subagent_type) ?? ""
  const subagentType = resolveCursorSubagentType(cursorSubagentType, catalog)
  if (!subagentType) {
    const available = catalog?.agents.map((agent) => agent.name).join(", ") || "none"
    parsed.localError =
      `Cursor subagent '${cursorSubagentType}' has no compatible host agent. ` +
      `Available subagents: ${available}.`
    return
  }

  const resumeAgentId = str(parsed.args.task_id)
  parsed.toolName = executor
  if (executor === "task") {
    parsed.args = {
      description,
      prompt,
      subagent_type: subagentType,
      ...(resumeAgentId ? { task_id: resumeAgentId } : {}),
      ...(parsed.args.background === true ? { background: true } : {}),
    }
    return
  }
  parsed.args = {
    operation: {
      action: parsed.args.background === true ? "spawn" : "run",
      description,
      prompt,
      subagent_type: subagentType,
      ...(resumeAgentId ? { actor_id: resumeAgentId } : {}),
    },
  }
}

/** Matches Cursor's own pre-write read threshold (`local-exec` 52428800). */
const MAX_EDIT_SOURCE_BYTES = 50 * 1024 * 1024

type WholeFileEditReplacement = {
  oldString: string
  newString: string
}

/** Return the number of non-overlapping occurrences, stopping after ambiguity. */
function replacementOccurrenceCount(source: string, needle: string): number {
  if (!needle) return 0
  const first = source.indexOf(needle)
  if (first === -1) return 0
  return source.indexOf(needle, first + needle.length) === -1 ? 1 : 2
}

function previousLineStart(source: string, start: number): number {
  if (start <= 0) return 0
  const before = source[start - 1] === "\n" ? start - 2 : start - 1
  return source.lastIndexOf("\n", before) + 1
}

function followingLineEnd(source: string, end: number): number {
  if (end >= source.length) return source.length
  const newline = source.indexOf("\n", end)
  return newline === -1 ? source.length : newline + 1
}

/**
 * Collapse a whole-file replacement into one unique, line-bounded substring
 * edit. Cursor's legacy edit executor computes a complete new file internally;
 * OpenCode's `edit` tool instead wants old/new substrings.
 */
function planWholeFileEdit(source: string, target: string): WholeFileEditReplacement | undefined {
  if (!source || source === target) return undefined

  let prefix = 0
  const shared = Math.min(source.length, target.length)
  while (prefix < shared && source[prefix] === target[prefix]) prefix++

  let suffix = 0
  while (
    suffix < source.length - prefix
    && suffix < target.length - prefix
    && source[source.length - suffix - 1] === target[target.length - suffix - 1]
  ) suffix++

  const sourceChangeEnd = source.length - suffix
  const targetChangeEnd = target.length - suffix
  let start = prefix === 0 ? 0 : source.lastIndexOf("\n", prefix - 1) + 1
  let end = sourceChangeEnd >= source.length
    ? source.length
    : followingLineEnd(source, sourceChangeEnd)

  // A pure insertion can initially select no source text. Include an adjacent
  // line because OpenCode edit deliberately rejects an empty oldString.
  if (start === end) {
    if (start > 0) start = previousLineStart(source, start)
    else end = followingLineEnd(source, end)
  }

  const replacement = (): WholeFileEditReplacement => ({
    oldString: source.slice(start, end),
    newString:
      source.slice(start, prefix)
      + target.slice(prefix, targetChangeEnd)
      + source.slice(sourceChangeEnd, end),
  })

  let result = replacement()
  while (replacementOccurrenceCount(source, result.oldString) !== 1) {
    const priorStart = start
    const priorEnd = end
    if (start > 0) start = previousLineStart(source, start)
    if (end < source.length) end = followingLineEnd(source, end)
    if (start === priorStart && end === priorEnd) return undefined
    result = replacement()
  }
  return result
}

/**
 * Preserve a legacy Cursor edit's intent when its internal executor follows
 * `edit_tool_call` with a whole-file `write_args` request.
 *
 * The result field intentionally remains `write_result`: that is the response
 * Cursor is awaiting even though OpenCode executes the mutation via `edit`.
 */
export function remapCorrelatedEditWriteForCatalog(
  parsed: ParsedExecRequest,
  advertisedToolNames: Iterable<string>,
  editPath: string,
  workspaceRoot?: string,
): boolean {
  if (parsed.resultField !== "write_result" || parsed.toolName !== "write") return false
  const advertised = new Set(advertisedToolNames)
  if (!advertised.has("edit") && !advertised.has(APPLY_PATCH_TOOL)) return false

  const filePath = str(parsed.args.filePath)
  const content = stringValue(parsed.args.content)
  if (!filePath || content === undefined || !editPath) return false

  const root = workspaceRoot ?? process.cwd()
  const absolute = path.resolve(root, filePath)
  if (absolute !== path.resolve(root, editPath)) return false

  let source: string
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile() || stat.size > MAX_EDIT_SOURCE_BYTES) return false
    if (Buffer.byteLength(content, "utf8") > MAX_EDIT_SOURCE_BYTES) return false
    source = fs.readFileSync(absolute, "utf8")
  } catch {
    // Missing targets are creations and must stay writes. Other read failures
    // also fall back to the original host permission path without guessing.
    return false
  }

  const replacement = planWholeFileEdit(source, content)
  if (!replacement) return false
  parsed.toolName = "edit"
  parsed.args = {
    filePath,
    oldString: replacement.oldString,
    newString: replacement.newString,
  }
  parsed.resultMetadata = { ...parsed.resultMetadata, path: filePath }
  return true
}

/**
 * Express a native Cursor write/edit as `apply_patch` when the host swapped the
 * edit-tool family out from under us.
 *
 * OpenCode 1.x removes `edit` and `write` from the catalog for GPT models and
 * advertises `apply_patch` in their place — see the module comment in
 * `./apply-patch.ts` for the upstream reasoning and citations. Cursor keeps
 * using its native write/edit exec channel regardless, so without this the
 * request is refused as an unavailable tool and the model loses the ability to
 * change files at all.
 *
 * Keyed purely off the advertised set: this is inert whenever the host offers
 * `write`/`edit` normally, and equally inert when it offers neither those nor
 * `apply_patch` (the caller's unavailable-tool rejection still applies).
 */
export function remapEditToolsForCatalog(
  parsed: ParsedExecRequest,
  advertisedToolNames: Iterable<string>,
  workspaceRoot?: string,
): void {
  if (parsed.toolName !== "write" && parsed.toolName !== "edit") return
  const advertised = new Set(advertisedToolNames)
  if (advertised.has(parsed.toolName) || !advertised.has(APPLY_PATCH_TOOL)) return

  const requested = parsed.toolName
  const filePath = str(parsed.args.filePath)
  const refuse = (reason: string) => {
    parsed.toolName = APPLY_PATCH_TOOL
    parsed.args = {}
    parsed.localError =
      `Cursor ${requested} request cannot be expressed as an apply_patch call: ${reason}. ` +
      "The host advertises `apply_patch` instead of `edit`/`write` for this model."
  }

  if (!filePath) {
    refuse("no target path was provided")
    return
  }

  let patchText: string
  if (requested === "write") {
    const content = stringValue(parsed.args.content)
    if (content === undefined) {
      refuse("no file content was provided")
      return
    }
    // `*** Add File:` overwrites an existing target, so a whole-file write maps
    // directly without reading the current contents or diffing.
    patchText = buildAddFilePatch(filePath, content)
  } else {
    const oldString = stringValue(parsed.args.oldString)
    const newString = stringValue(parsed.args.newString)
    if (oldString === undefined || newString === undefined) {
      refuse("the replacement is missing its old or new text")
      return
    }
    // apply_patch matches whole lines, so a substring edit has to be widened to
    // the lines it touches — which requires the file the model is editing.
    const absolute = path.resolve(workspaceRoot ?? process.cwd(), filePath)
    let source: string
    try {
      // Bounded because this read is synchronous on the Run pump. Cursor's own
      // executor uses the same 50 MB threshold before reading a file it is
      // about to write.
      const size = fs.statSync(absolute).size
      if (size > MAX_EDIT_SOURCE_BYTES) {
        refuse(`the target file is ${Math.round(size / 1024 / 1024)} MB, too large to patch`)
        return
      }
      source = fs.readFileSync(absolute, "utf8")
    } catch (e) {
      refuse(`the target file could not be read (${(e as Error).message})`)
      return
    }
    const plan = planSubstringEdit(
      source,
      oldString,
      newString,
      parsed.args.replaceAll === true,
    )
    if (!plan.ok) {
      refuse(plan.reason)
      return
    }
    patchText = buildUpdateFilePatch(filePath, plan.chunks)
  }

  parsed.toolName = APPLY_PATCH_TOOL
  parsed.args = { patchText }
  // apply_patch's output does not carry opencode `write`'s <path> tag, so keep
  // the requested path for the typed Cursor result.
  parsed.resultMetadata = { ...parsed.resultMetadata, path: filePath }
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

  // F11: Cursor native background shell → OpenCode bash. Keep the wrapper
  // self-contained so direct provider / hosts without shell.env still detach
  // and return a PID. The classic plugin replaces this with its display-safe
  // env or wrapper-file path before execution.
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
      resultMetadata: {
        background_shell_spawn: true,
        command: command ?? "",
        working_directory: workingDirectory,
      },
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
      resultMetadata: cursorSubagentType
        ? { cursor_subagent_type: cursorSubagentType }
        : undefined,
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
  const rawArgs = (msg[execVariant] as Record<string, unknown>) ?? {}
  const resultMetadata = execVariant === "shell_stream_args"
    ? shellStreamResultMetadata(rawArgs)
    : execVariant === "read_args"
      ? {
          path: str(rawArgs.path) ?? str(rawArgs.file_path) ?? "",
          ...(typeof mapped.args.offset === "number" ? { offset: mapped.args.offset } : {}),
          ...(typeof mapped.args.limit === "number" ? { limit: mapped.args.limit } : {}),
        }
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

  // F11: Cursor native delete_args → OpenCode bash. No delete builtin exists, so
  // we emulate with `rm -f -- <path>` (shell-quoted). Same permission boundary
  // as any other bash tool call.
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
      // Cursor's LocalWriteExecutor prefers `file_bytes` whenever it is
      // non-empty and only falls back to `file_text`; mirror that order so a
      // byte-encoded write is not silently seen as empty content.
      const bytes = bytesValue(cleaned.file_bytes) ?? bytesValue(cleaned.fileBytes)
      const content = bytes !== undefined
        ? decodeWriteBytes(bytes, str(cleaned.encoding_hint) ?? str(cleaned.encodingHint))
        : stringValue(cleaned.content) ?? stringValue(cleaned.file_text) ?? stringValue(cleaned.fileText)
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

/** A non-empty protobuf `bytes` field, or undefined when absent/empty. */
function bytesValue(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v.length > 0 ? v : undefined
  if (Array.isArray(v) && v.every((b) => typeof b === "number")) {
    return v.length > 0 ? Uint8Array.from(v) : undefined
  }
  return undefined
}

/**
 * Decode `WriteArgs.file_bytes`. `encoding_hint` names the file's original
 * encoding; OpenCode's `write` takes a string, so anything Node cannot decode
 * falls back to UTF-8 rather than dropping the write.
 */
function decodeWriteBytes(bytes: Uint8Array, encodingHint?: string): string {
  const encoding = encodingHint?.trim().toLowerCase().replace(/[_ ]/g, "-")
  if (encoding && encoding !== "utf-8" && encoding !== "utf8") {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(bytes)
    } catch {
      trace(`write: unsupported encoding_hint ${JSON.stringify(encodingHint)} — decoding as utf-8`)
    }
  }
  return new TextDecoder("utf-8").decode(bytes)
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
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

// ── Pre-execution read validation (Cursor LocalReadExecutor parity) ──

/** Expand a leading `~` to the home directory, matching Cursor's untildify. */
function untildify(input: string): string {
  return input.replace(/^~(?=$|\/|\\)/, os.homedir())
}

/**
 * Resolve a read target the way Cursor's LocalReadExecutor does before it
 * stats the file: untildify, then resolve a relative path against the workspace
 * root (`env.workspace_paths[0]`), else resolve as-is. Kept in lockstep with
 * agent utils `resolvePath(path, workspaceRoot)`.
 */
export function resolveReadTargetPath(requested: string, workspaceRoot: string): string {
  const expanded = untildify(requested)
  if (workspaceRoot && !path.isAbsolute(expanded)) {
    return path.resolve(workspaceRoot, expanded)
  }
  return path.resolve(expanded)
}

/**
 * A typed ReadResult oneof case for a read target that fails Cursor's
 * pre-execution validation, or undefined when the path is a readable file the
 * tool should actually read. Mirrors LocalReadExecutor exactly:
 *  - missing path (ENOENT/ENOTDIR)     → file_not_found
 *  - directory                         → invalid_file "Path is a directory, not a file"
 *  - socket/fifo/etc (not a file)      → invalid_file "Path is neither a file nor a directory"
 * EACCES/EPERM (exists but unreadable) and any other stat error return undefined
 * so the call proceeds to OpenCode and a genuine permission decision is never
 * masked. Never rejects a non-existent *write/edit* target — this is read-only.
 */
export function classifyMissingReadTarget(
  absolutePath: string,
): Record<string, unknown> | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolutePath)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { file_not_found: { path: absolutePath } }
    }
    return undefined
  }
  if (stat.isDirectory()) {
    return { invalid_file: { path: absolutePath, reason: "Path is a directory, not a file" } }
  }
  if (!stat.isFile()) {
    return {
      invalid_file: { path: absolutePath, reason: "Path is neither a file nor a directory" },
    }
  }
  return undefined
}

/**
 * Encode a pre-execution read rejection as the exact frames Cursor's client
 * emits: the ExecClientMessage carrying the typed ReadResult oneof case, then
 * the ACM #5 stream_close for that id. `readResult` is the case object from
 * classifyMissingReadTarget (e.g. `{ file_not_found: { path } }`).
 */
export function buildReadRejectionMessages(
  execId: number,
  readResult: Record<string, unknown>,
): Uint8Array[] {
  return [
    encodeMessage("AgentClientMessage", {
      exec_client_message: {
        id: execId,
        local_execution_time_ms: 0,
        read_result: readResult,
      },
    }),
    buildExecStreamClose(execId),
  ]
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
  /**
   * Workspace root for result shapes that must name a directory
   * (grep_result workspace_results keys, ls_result directory_tree_root).
   * Must not fall back to process.cwd() — the OpenCode 2.0 daemon's cwd is
   * often $HOME and would re-advertise the wrong folder to the model.
   */
  workspaceRoot?: string
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
      input.shellOutcome,
      input.workspaceRoot,
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
  shellOutcome?: CursorShellOutcome,
  workspaceRoot?: string,
): Record<string, unknown> {
  // Prefer the session workspace; never advertise the host process cwd (daemon
  // often starts in $HOME) as the path Cursor shows the model for glob/ls.
  const resultRoot =
    typeof workspaceRoot === "string" && workspaceRoot.trim()
      ? path.resolve(workspaceRoot)
      : undefined
  switch (resultField) {
    case "read_result": {
      const readPath = str(resultMetadata?.path) ?? extractPathTag(output) ?? ""
      if (error) return { error: { path: readPath, error } }
      // Strip opencode's <path>/<content> envelope so Cursor's model receives
      // raw file content and can't echo the wrapper into subsequent writes.
      // Cursor's native read_args lands here; `mcp_args` reads land in
      // mcp_result. Live captures show gpt-5.4-mini and grok-4.5 both use the
      // native channel, so this is the path that matters in practice.
      const statPath = extractPathTag(output) ?? readPath
      const outputMetadata = parseOpenCodeReadMetadata(output)
      const content = restoreCompleteReadTerminator(
        unwrapReadOutput(output),
        statPath,
        outputMetadata,
        resultMetadata,
        resultRoot,
      )
      const totalLines = outputMetadata.totalLines ?? readFileLineCount(statPath) ?? countLines(content)
      const rangeApplied = readRangeApplied(resultMetadata, totalLines)
      // `truncated` alone is not enough: it is set here, and models still assert
      // the partial content is the whole file. Cursor's own executor puts the
      // limit marker in the output text for the same reason, so append one.
      const notice = readTruncationNotice(output, resultMetadata)
      return {
        success: {
          path: readPath,
          content: notice ? `${content}\n\n${notice}` : content,
          total_lines: totalLines,
          file_size: readFileSize(statPath),
          truncated: readOutputTruncated(resultMetadata, outputMetadata, totalLines),
          range_applied: rangeApplied,
        },
      }
    }
    case "grep_result": {
      if (error) return { error: { error } }
      // Prefer files_with_matches: OpenCode glob/grep often returns path lists.
      // Content-mode GrepSuccess also works but needs GrepFileMatch nesting.
      const files = extractPathLines(output)
      const cwd = resultRoot ?? ""
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
    case "write_result": {
      // `apply_patch` output carries no <path> tag, so prefer the path recorded
      // when the request was remapped away from `write`.
      const remappedPath = str(resultMetadata?.path)
      if (error) return { error: { path: remappedPath ?? "", error } }
      return {
        success: {
          path: remappedPath ?? extractPathTag(output) ?? "",
          lines_created: countLines(output),
          file_size: output.length,
        },
      }
    }
    case "pi_write_result":
      // PiWriteExecSuccess is just { output }; error is { error }.
      if (error) return { error: { error } }
      return { success: { output: output || "Wrote file successfully." } }
    case "pi_read_result": {
      if (error) return { error: { error } }
      // Pi results carry truncation structurally (PiReadExecSuccess field 2),
      // which is how Cursor's own executors report a capped payload.
      const content = unwrapReadOutput(output)
      const truncation = readTruncationMessage(output, content)
      return { success: { output: content, ...(truncation ? { truncation } : {}) } }
    }
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
      // Prefer the structured outcome captured by the plugin after-hook; markers
      // are already stripped from the stored/rendered OpenCode output by then.
      if (shellOutcome?.kind === "backgrounded") {
        return {
          success: {
            shell_id: shellOutcome.shellId,
            command: shellOutcome.command || command,
            working_directory: shellOutcome.workingDirectory || workingDirectory,
            pid: shellOutcome.pid,
          },
        }
      }
      // Fallback when no plugin hook ran: parse the private spawn marker inline.
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
      const rootPath = resultRoot ?? ""
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
    case "mcp_result": {
      if (error) return { error: { error } }
      // opencode built-ins (read/write/grep/…) are advertised as MCP tools, so
      // a read call returns through mcp_result. Scope the unwrap to toolName
      // "read" so a non-read MCP tool whose output merely contains a
      // "<content>"-like block is never rewritten.
      if (toolName !== "read") {
        return { success: { content: [{ text: { text: output } }], is_error: false } }
      }
      // Carry the truncation notice as its own content item: the file content
      // item stays byte-exact, so it can still never be echoed into a write.
      const notice = readTruncationNotice(output)
      return {
        success: {
          content: [
            { text: { text: unwrapReadOutput(output) } },
            ...(notice ? [{ text: { text: notice } }] : []),
          ],
          is_error: false,
        },
      }
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

type OpenCodeReadMetadata = {
  startLine?: number
  endLine?: number
  totalLines?: number
  outputCapped?: boolean
}

/**
 * Isolate opencode's read footer: the last blank-line-separated block before
 * the closing `</content>`. Scanning the whole envelope would let a file that
 * merely *quotes* a footer (this repository's own docs and tests do) pass for a
 * truncated read. The body can never contain a blank line — every source line
 * is rendered as `N: …`, so even an empty line keeps its `N: ` prefix.
 *
 * Falls back to the full string when the envelope is absent, preserving
 * behavior for non-standard read output.
 */
function readEnvelopeFooter(output: string): string {
  const close = output.lastIndexOf("\n</content>")
  if (close === -1) return output
  const start = output.lastIndexOf("\n\n", close)
  if (start === -1) return output
  return output.slice(start + 2, close)
}

/** Recover full-file metadata before unwrapReadOutput removes OpenCode's footer. */
function parseOpenCodeReadMetadata(output: string): OpenCodeReadMetadata {
  const footer = readEnvelopeFooter(output)
  const showing = /Showing lines (\d+)-(\d+)(?: of (\d+))?\./.exec(footer)
  if (showing) {
    return {
      startLine: Number(showing[1]),
      endLine: Number(showing[2]),
      ...(showing[3] ? { totalLines: Number(showing[3]) } : {}),
      outputCapped: footer.includes("(Output capped at "),
    }
  }
  const complete = /\(End of file - total (\d+) lines?\)/.exec(footer)
  if (complete) return { totalLines: Number(complete[1]) }
  return {}
}

/**
 * OpenCode's numbered read envelope cannot represent the terminator after the
 * final line. Cursor's legacy edit executor performs exact replacement against
 * this content, so dropping a real LF/CRLF makes otherwise-valid edits fail and
 * encourages a whole-file rewrite. Restore only that final terminator for an
 * unbounded, confirmed-complete read; paged/capped reads stay untouched.
 */
function restoreCompleteReadTerminator(
  content: string,
  readPath: string,
  metadata: OpenCodeReadMetadata,
  resultMetadata?: Record<string, unknown>,
  workspaceRoot?: string,
): string {
  if (
    !readPath
    || metadata.totalLines === undefined
    || metadata.startLine !== undefined
    || metadata.endLine !== undefined
    || num(resultMetadata?.offset) !== undefined
    || num(resultMetadata?.limit) !== undefined
    || content.endsWith("\n")
  ) return content

  const absolute = path.isAbsolute(readPath)
    ? readPath
    : path.resolve(workspaceRoot ?? process.cwd(), readPath)
  let fd: number | undefined
  try {
    fd = fs.openSync(absolute, "r")
    const size = fs.fstatSync(fd).size
    if (size === 0) return content
    const tail = Buffer.alloc(Math.min(2, size))
    fs.readSync(fd, tail, 0, tail.length, size - tail.length)
    if (tail.length >= 2 && tail[tail.length - 2] === 0x0d && tail[tail.length - 1] === 0x0a) {
      return `${content}\r\n`
    }
    if (tail[tail.length - 1] === 0x0a) return `${content}\n`
  } catch {
    // The host read result remains authoritative when the local path cannot be
    // inspected (deleted/raced/permission changed after the tool completed).
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
  return content
}

/**
 * OpenCode's `read` caps output at 50 KB (`tool/read.ts` MAX_BYTES = 50 * 1024)
 * and cuts on a whole-line boundary, then appends
 * "(Output capped at 50 KB. Showing lines X-Y. Use offset=N to continue.)".
 *
 * `unwrapReadOutput` strips that footer along with the envelope, deliberately:
 * Cursor's model echoes whatever it is handed straight back into the next
 * write, so anything left in the content stream can end up written into the
 * file. But dropping the notice with no replacement is worse — the model then
 * believes a capped read is the complete file, rewrites it from what it has,
 * and everything past the cap is destroyed.
 *
 * Cursor's own CLI never truncates silently. Its local executor annotates every
 * capped payload ("50KB limit reached", "[Showing last …KB of line N (50KB
 * limit). Full output: …]") and returns structured truncation metadata. Mirror
 * that, keeping the signal out of the file content itself so it still cannot be
 * echoed into a write.
 */
function readTruncationSummary(
  output: string,
): { startLine: number; endLine: number; nextOffset: number; capped: boolean; totalLines?: number } | undefined {
  const meta = parseOpenCodeReadMetadata(output)
  if (meta.startLine === undefined || meta.endLine === undefined) return undefined
  // A complete read reports "(End of file …)" and never reaches this shape.
  if (meta.totalLines !== undefined && meta.endLine >= meta.totalLines && !meta.outputCapped) return undefined
  return {
    startLine: meta.startLine,
    endLine: meta.endLine,
    nextOffset: meta.endLine + 1,
    capped: meta.outputCapped === true,
    ...(meta.totalLines !== undefined ? { totalLines: meta.totalLines } : {}),
  }
}

/**
 * Model-visible replacement for the stripped footer.
 *
 * Only for reads the model did not ask to bound. A caller that passed an
 * explicit offset/limit already knows it asked for a slice — warning there
 * would cry wolf on every deliberate paged read.
 */
function readTruncationNotice(
  output: string,
  resultMetadata?: Record<string, unknown>,
): string | undefined {
  const summary = readTruncationSummary(output)
  if (!summary) return undefined
  const rangeRequested =
    num(resultMetadata?.offset) !== undefined || num(resultMetadata?.limit) !== undefined
  if (rangeRequested && !summary.capped) return undefined
  const range = summary.totalLines !== undefined
    ? `lines ${summary.startLine}-${summary.endLine} of ${summary.totalLines}`
    : `lines ${summary.startLine}-${summary.endLine}`
  return (
    `[Partial read: the content above is ${range}` +
    (summary.capped ? ", capped at the host's 50 KB output limit" : "") +
    `. It is NOT the complete file. Continue with offset=${summary.nextOffset} before ` +
    `acting on the whole file; writing the content above back would delete everything ` +
    `after line ${summary.endLine}.]`
  )
}

/** agent.v1.PiTruncation for a capped OpenCode read. */
function readTruncationMessage(
  output: string,
  content: string,
): Record<string, unknown> | undefined {
  const summary = readTruncationSummary(output)
  if (!summary) return undefined
  return {
    truncated: true,
    truncated_by: summary.capped ? "bytes" : "lines",
    ...(summary.totalLines !== undefined ? { total_lines: summary.totalLines } : {}),
    output_lines: Math.max(0, summary.endLine - summary.startLine + 1),
    output_bytes: Buffer.byteLength(content, "utf8"),
    ...(summary.capped ? { max_bytes: OPENCODE_READ_MAX_BYTES } : {}),
  }
}

/** `tool/read.ts` MAX_BYTES — mirrored only to report the cap, never to apply it. */
const OPENCODE_READ_MAX_BYTES = 50 * 1024

function readRangeApplied(
  resultMetadata: Record<string, unknown> | undefined,
  totalLines: number,
): boolean {
  const offset = num(resultMetadata?.offset)
  const limit = num(resultMetadata?.limit)
  if (offset === undefined && limit === undefined) return false
  if (totalLines === 0) return false
  const startLine = offset ?? 1
  return startLine < 0 || startLine <= totalLines
}

function readOutputTruncated(
  resultMetadata: Record<string, unknown> | undefined,
  outputMetadata: OpenCodeReadMetadata,
  totalLines: number,
): boolean {
  if (outputMetadata.outputCapped) return true
  const returnedEnd = outputMetadata.endLine
  if (returnedEnd === undefined || totalLines === 0) return false

  const offset = num(resultMetadata?.offset)
  const limit = num(resultMetadata?.limit)
  const startLine = offset ?? 1
  if (startLine < 0) return false
  const expectedEnd = limit === undefined
    ? totalLines
    : Math.min(totalLines, Math.max(1, startLine) + limit - 1)
  return returnedEnd < expectedEnd
}

function readFileSize(filePath: string): number {
  if (!filePath) return 0
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function readFileLineCount(filePath: string): number | undefined {
  if (!filePath) return undefined
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, "r")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let totalBytes = 0
    let lines = 1
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] === 0x0a) lines++
      }
    }
    return totalBytes === 0 ? 0 : lines
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* best effort */
      }
    }
  }
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
  traceRequestContextPaths(`buildRequestContextResult id=${execId}`, requestContext)
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
