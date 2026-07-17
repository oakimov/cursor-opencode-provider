/**
 * Canonical Cursor agent.v1 exec request/result pairs.
 *
 * Source of truth: Cursor CLI generated `agent/v1/exec_pb.js` plus the
 * registrations in `agent-exec/dist/index.js`. Most request/result variants
 * share a field number; Pi requests deliberately use result field +1.
 *
 * `handling` describes this provider, not the Cursor CLI:
 * - opencode-tool: emitted through an advertised OpenCode tool
 * - provider-control: answered directly on the held-open Run stream
 * - unsupported: known Cursor-native capability with no safe AI SDK bridge
 */
export type CursorExecHandling = "opencode-tool" | "provider-control" | "unsupported"

export type CursorExecVariant = {
  requestField: number
  requestName: string
  resultField: number
  resultName: string
  handling: CursorExecHandling
}

export const CURSOR_EXEC_VARIANTS: readonly CursorExecVariant[] = [
  { requestField: 2, requestName: "shell_args", resultField: 2, resultName: "shell_result", handling: "unsupported" },
  { requestField: 3, requestName: "write_args", resultField: 3, resultName: "write_result", handling: "opencode-tool" },
  { requestField: 4, requestName: "delete_args", resultField: 4, resultName: "delete_result", handling: "opencode-tool" },
  { requestField: 5, requestName: "grep_args", resultField: 5, resultName: "grep_result", handling: "opencode-tool" },
  { requestField: 7, requestName: "read_args", resultField: 7, resultName: "read_result", handling: "opencode-tool" },
  { requestField: 8, requestName: "ls_args", resultField: 8, resultName: "ls_result", handling: "opencode-tool" },
  { requestField: 9, requestName: "diagnostics_args", resultField: 9, resultName: "diagnostics_result", handling: "unsupported" },
  { requestField: 10, requestName: "request_context_args", resultField: 10, resultName: "request_context_result", handling: "provider-control" },
  { requestField: 11, requestName: "mcp_args", resultField: 11, resultName: "mcp_result", handling: "opencode-tool" },
  { requestField: 14, requestName: "shell_stream_args", resultField: 14, resultName: "shell_stream", handling: "opencode-tool" },
  { requestField: 16, requestName: "background_shell_spawn_args", resultField: 16, resultName: "background_shell_spawn_result", handling: "opencode-tool" },
  { requestField: 17, requestName: "list_mcp_resources_exec_args", resultField: 17, resultName: "list_mcp_resources_exec_result", handling: "unsupported" },
  { requestField: 18, requestName: "read_mcp_resource_exec_args", resultField: 18, resultName: "read_mcp_resource_exec_result", handling: "unsupported" },
  { requestField: 20, requestName: "fetch_args", resultField: 20, resultName: "fetch_result", handling: "unsupported" },
  { requestField: 21, requestName: "record_screen_args", resultField: 21, resultName: "record_screen_result", handling: "unsupported" },
  { requestField: 22, requestName: "computer_use_args", resultField: 22, resultName: "computer_use_result", handling: "unsupported" },
  { requestField: 23, requestName: "write_shell_stdin_args", resultField: 23, resultName: "write_shell_stdin_result", handling: "unsupported" },
  { requestField: 27, requestName: "execute_hook_args", resultField: 27, resultName: "execute_hook_result", handling: "unsupported" },
  { requestField: 28, requestName: "subagent_args", resultField: 28, resultName: "subagent_result", handling: "opencode-tool" },
  { requestField: 29, requestName: "redacted_read_args", resultField: 29, resultName: "redacted_read_result", handling: "unsupported" },
  { requestField: 30, requestName: "force_background_shell_args", resultField: 30, resultName: "force_background_shell_result", handling: "unsupported" },
  { requestField: 31, requestName: "force_background_subagent_args", resultField: 31, resultName: "force_background_subagent_result", handling: "unsupported" },
  { requestField: 36, requestName: "mcp_state_exec_args", resultField: 36, resultName: "mcp_state_exec_result", handling: "provider-control" },
  { requestField: 37, requestName: "subagent_await_args", resultField: 37, resultName: "subagent_await_result", handling: "unsupported" },
  { requestField: 38, requestName: "smart_mode_classifier_args", resultField: 38, resultName: "smart_mode_classifier_result", handling: "unsupported" },
  { requestField: 40, requestName: "canvas_diagnostics_args", resultField: 40, resultName: "canvas_diagnostics_result", handling: "unsupported" },
  { requestField: 41, requestName: "shell_allowlist_precheck_args", resultField: 41, resultName: "shell_allowlist_precheck_result", handling: "unsupported" },
  { requestField: 42, requestName: "mcp_allowlist_precheck_args", resultField: 42, resultName: "mcp_allowlist_precheck_result", handling: "unsupported" },
  { requestField: 43, requestName: "web_fetch_allowlist_precheck_args", resultField: 43, resultName: "web_fetch_allowlist_precheck_result", handling: "unsupported" },
  { requestField: 44, requestName: "git_diff_request", resultField: 44, resultName: "git_diff_response", handling: "unsupported" },
  { requestField: 45, requestName: "pi_read_args", resultField: 46, resultName: "pi_read_result", handling: "opencode-tool" },
  { requestField: 46, requestName: "pi_bash_args", resultField: 47, resultName: "pi_bash_result", handling: "opencode-tool" },
  { requestField: 47, requestName: "pi_edit_args", resultField: 48, resultName: "pi_edit_result", handling: "opencode-tool" },
  { requestField: 48, requestName: "pi_write_args", resultField: 49, resultName: "pi_write_result", handling: "opencode-tool" },
  { requestField: 49, requestName: "pi_grep_args", resultField: 50, resultName: "pi_grep_result", handling: "opencode-tool" },
  { requestField: 50, requestName: "pi_find_args", resultField: 51, resultName: "pi_find_result", handling: "opencode-tool" },
  { requestField: 51, requestName: "pi_ls_args", resultField: 52, resultName: "pi_ls_result", handling: "opencode-tool" },
] as const

const BY_REQUEST_FIELD = new Map(CURSOR_EXEC_VARIANTS.map((variant) => [variant.requestField, variant]))
const BY_REQUEST_NAME = new Map(CURSOR_EXEC_VARIANTS.map((variant) => [variant.requestName, variant]))

export function cursorExecVariantByRequestField(field: number): CursorExecVariant | undefined {
  return BY_REQUEST_FIELD.get(field)
}

export function cursorExecVariantByRequestName(name: string): CursorExecVariant | undefined {
  return BY_REQUEST_NAME.get(name)
}

export function describeCursorExecVariant(field: number | undefined): string {
  if (field === undefined) return "unknown request field"
  const variant = cursorExecVariantByRequestField(field)
  if (!variant) return `unknown request field #${field}`
  return `${variant.requestName} (request field #${variant.requestField}, expected result ${variant.resultName} field #${variant.resultField}, handling=${variant.handling})`
}
