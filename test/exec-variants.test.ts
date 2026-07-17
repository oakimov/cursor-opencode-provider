import { describe, expect, it } from "bun:test"
import {
  CURSOR_EXEC_VARIANTS,
  cursorExecVariantByRequestField,
  cursorExecVariantByRequestName,
  describeCursorExecVariant,
} from "../src/protocol/exec-variants.js"
import { detectExecVariantField, mapExecServerToToolName } from "../src/protocol/tools.js"

// Independent transcription of Cursor CLI generated agent/v1/exec_pb.js.
// Tuples are [request field, request name, result field, result name].
const CLI_EXEC_PAIRS = [
  [2, "shell_args", 2, "shell_result"],
  [3, "write_args", 3, "write_result"],
  [4, "delete_args", 4, "delete_result"],
  [5, "grep_args", 5, "grep_result"],
  [7, "read_args", 7, "read_result"],
  [8, "ls_args", 8, "ls_result"],
  [9, "diagnostics_args", 9, "diagnostics_result"],
  [10, "request_context_args", 10, "request_context_result"],
  [11, "mcp_args", 11, "mcp_result"],
  [14, "shell_stream_args", 14, "shell_stream"],
  [16, "background_shell_spawn_args", 16, "background_shell_spawn_result"],
  [17, "list_mcp_resources_exec_args", 17, "list_mcp_resources_exec_result"],
  [18, "read_mcp_resource_exec_args", 18, "read_mcp_resource_exec_result"],
  [20, "fetch_args", 20, "fetch_result"],
  [21, "record_screen_args", 21, "record_screen_result"],
  [22, "computer_use_args", 22, "computer_use_result"],
  [23, "write_shell_stdin_args", 23, "write_shell_stdin_result"],
  [27, "execute_hook_args", 27, "execute_hook_result"],
  [28, "subagent_args", 28, "subagent_result"],
  [29, "redacted_read_args", 29, "redacted_read_result"],
  [30, "force_background_shell_args", 30, "force_background_shell_result"],
  [31, "force_background_subagent_args", 31, "force_background_subagent_result"],
  [36, "mcp_state_exec_args", 36, "mcp_state_exec_result"],
  [37, "subagent_await_args", 37, "subagent_await_result"],
  [38, "smart_mode_classifier_args", 38, "smart_mode_classifier_result"],
  [40, "canvas_diagnostics_args", 40, "canvas_diagnostics_result"],
  [41, "shell_allowlist_precheck_args", 41, "shell_allowlist_precheck_result"],
  [42, "mcp_allowlist_precheck_args", 42, "mcp_allowlist_precheck_result"],
  [43, "web_fetch_allowlist_precheck_args", 43, "web_fetch_allowlist_precheck_result"],
  [44, "git_diff_request", 44, "git_diff_response"],
  [45, "pi_read_args", 46, "pi_read_result"],
  [46, "pi_bash_args", 47, "pi_bash_result"],
  [47, "pi_edit_args", 48, "pi_edit_result"],
  [48, "pi_write_args", 49, "pi_write_result"],
  [49, "pi_grep_args", 50, "pi_grep_result"],
  [50, "pi_find_args", 51, "pi_find_result"],
  [51, "pi_ls_args", 52, "pi_ls_result"],
] as const

function rawAgentServerExec(requestField: number): Uint8Array {
  const writeVarint = (out: number[], value: number) => {
    let remaining = value >>> 0
    while (remaining > 0x7f) {
      out.push((remaining & 0x7f) | 0x80)
      remaining >>>= 7
    }
    out.push(remaining)
  }
  const exec: number[] = []
  writeVarint(exec, (1 << 3) | 0)
  writeVarint(exec, 42)
  writeVarint(exec, (requestField << 3) | 2)
  writeVarint(exec, 0)
  const message: number[] = []
  writeVarint(message, (2 << 3) | 2)
  writeVarint(message, exec.length)
  message.push(...exec)
  return Uint8Array.from(message)
}

describe("canonical Cursor exec variant map", () => {
  it("matches every request/result pair registered by the Cursor CLI", () => {
    expect(CURSOR_EXEC_VARIANTS.map((variant) => [
      variant.requestField,
      variant.requestName,
      variant.resultField,
      variant.resultName,
    ])).toEqual(CLI_EXEC_PAIRS)
  })

  it("has unique request ids/names and classifies every canonical variant", () => {
    expect(new Set(CURSOR_EXEC_VARIANTS.map((variant) => variant.requestField)).size).toBe(37)
    expect(new Set(CURSOR_EXEC_VARIANTS.map((variant) => variant.requestName)).size).toBe(37)
    expect(CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "opencode-tool")).toHaveLength(16)
    expect(CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "provider-control")).toHaveLength(2)
    expect(CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "unsupported")).toHaveLength(19)
  })

  it("keeps OpenCode tool classifications synchronized with executable mappings", () => {
    for (const variant of CURSOR_EXEC_VARIANTS) {
      if (variant.handling !== "opencode-tool") continue
      expect(mapExecServerToToolName(variant.requestName), variant.requestName).toBeDefined()
    }
  })

  it("looks up the non-identical Pi request/result pair by id and name", () => {
    expect(cursorExecVariantByRequestField(48)).toMatchObject({
      requestName: "pi_write_args",
      resultField: 49,
      resultName: "pi_write_result",
    })
    expect(cursorExecVariantByRequestName("pi_write_args")?.requestField).toBe(48)
  })

  it("detects every canonical request id from an independent raw wire frame", () => {
    for (const [requestField] of CLI_EXEC_PAIRS) {
      expect(detectExecVariantField(rawAgentServerExec(requestField))).toBe(requestField)
    }
  })

  it("describes known unsupported and future unknown fields without guessing", () => {
    expect(describeCursorExecVariant(38)).toBe(
      "smart_mode_classifier_args (request field #38, expected result smart_mode_classifier_result field #38, handling=unsupported)",
    )
    expect(describeCursorExecVariant(99)).toBe("unknown request field #99")
    expect(describeCursorExecVariant(undefined)).toBe("unknown request field")
  })
})
