import { describe, expect, it } from "bun:test"
import {
  CURSOR_EXEC_VARIANTS,
  FORCE_BACKGROUND_STATUS_ERROR,
  cursorExecVariantByRequestField,
  cursorExecVariantByRequestName,
  describeCursorExecVariant,
  isExecRequestWithoutNewCall,
} from "../src/protocol/exec-variants.js"
import {
  buildUnsupportedExecDeny,
  detectExecVariantField,
  mapExecServerToToolName,
} from "../src/protocol/tools.js"
import { readAllFields, type RawField } from "../src/protocol/struct.js"

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
  [52, "mini_swe_agent_bash_args", 55, "mini_swe_agent_bash_result"],
  [53, "conversation_search_args", 53, "conversation_search_result"],
  [54, "agent_store_conflict_args", 54, "agent_store_conflict_result"],
  [56, "adopt_args", 56, "adopt_result"],
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
    ])).toEqual(CLI_EXEC_PAIRS.map((pair) => [...pair]))
  })

  it("has unique request ids/names and classifies every canonical variant", () => {
    expect(new Set(CURSOR_EXEC_VARIANTS.map((variant) => variant.requestField)).size).toBe(41)
    expect(new Set(CURSOR_EXEC_VARIANTS.map((variant) => variant.requestName)).size).toBe(41)
    expect(CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "opencode-tool")).toHaveLength(17)
    expect(CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "provider-control")).toHaveLength(5)
    expect(CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "unsupported")).toHaveLength(19)
  })

  it("keeps OpenCode tool classifications synchronized with executable mappings", () => {
    const unmapped = CURSOR_EXEC_VARIANTS
      .filter((variant) => variant.handling === "opencode-tool")
      .filter((variant) => mapExecServerToToolName(variant.requestName) === undefined)
      .map((variant) => variant.requestName)
    expect(unmapped).toEqual([])
  })

  it("looks up the non-identical Pi request/result pair by id and name", () => {
    expect(cursorExecVariantByRequestField(48)).toMatchObject({
      requestName: "pi_write_args",
      resultField: 49,
      resultName: "pi_write_result",
    })
    expect(cursorExecVariantByRequestName("pi_write_args")?.requestField).toBe(48)
  })

  it("looks up the Mini-SWE request/result offset and reclassified variants", () => {
    expect(cursorExecVariantByRequestField(52)).toMatchObject({
      requestName: "mini_swe_agent_bash_args",
      resultField: 55,
      resultName: "mini_swe_agent_bash_result",
      handling: "unsupported",
    })
    expect(cursorExecVariantByRequestName("git_diff_request")?.handling).toBe("provider-control")
    expect(cursorExecVariantByRequestName("shell_args")?.handling).toBe("opencode-tool")
  })

  it("detects every canonical request id from an independent raw wire frame", () => {
    expect(CLI_EXEC_PAIRS.map(([requestField]) => detectExecVariantField(rawAgentServerExec(requestField))))
      .toEqual(CLI_EXEC_PAIRS.map(([requestField]) => requestField))
  })

  it("describes known unsupported and future unknown fields without guessing", () => {
    expect(describeCursorExecVariant(38)).toBe(
      "smart_mode_classifier_args (request field #38, expected result smart_mode_classifier_result field #38, handling=unsupported)",
    )
    expect(describeCursorExecVariant(99)).toBe("unknown request field #99")
    expect(describeCursorExecVariant(undefined)).toBe("unknown request field")
  })
})

type DenyWireExpect =
  | {
      requestName: string
      kind: "result"
      resultField: number
      innerOneofField: number
      innerVarint?: { field: number; value: number }
    }
  | { requestName: string; kind: "throw" }

/**
 * Independent of protobufjs decode against this package's own schema: walk
 * raw field numbers on the encoded deny so a wrong oneof (e.g. RecordScreen
 * failure at #1 instead of #4) fails the test.
 */
const UNSUPPORTED_DENY_WIRE: readonly DenyWireExpect[] = [
  { requestName: "diagnostics_args", kind: "result", resultField: 9, innerOneofField: 2 },
  { requestName: "fetch_args", kind: "result", resultField: 20, innerOneofField: 2 },
  { requestName: "record_screen_args", kind: "result", resultField: 21, innerOneofField: 4 },
  { requestName: "computer_use_args", kind: "result", resultField: 22, innerOneofField: 2 },
  { requestName: "write_shell_stdin_args", kind: "result", resultField: 23, innerOneofField: 2 },
  { requestName: "execute_hook_args", kind: "throw" },
  { requestName: "redacted_read_args", kind: "result", resultField: 29, innerOneofField: 2 },
  {
    requestName: "force_background_shell_args",
    kind: "result",
    resultField: 30,
    innerOneofField: 1,
    innerVarint: { field: 1, value: FORCE_BACKGROUND_STATUS_ERROR },
  },
  {
    requestName: "force_background_subagent_args",
    kind: "result",
    resultField: 31,
    innerOneofField: 1,
    innerVarint: { field: 1, value: FORCE_BACKGROUND_STATUS_ERROR },
  },
  { requestName: "subagent_await_args", kind: "result", resultField: 37, innerOneofField: 4 },
  { requestName: "smart_mode_classifier_args", kind: "result", resultField: 38, innerOneofField: 2 },
  { requestName: "canvas_diagnostics_args", kind: "result", resultField: 40, innerOneofField: 2 },
  { requestName: "shell_allowlist_precheck_args", kind: "result", resultField: 41, innerOneofField: 1, innerVarint: { field: 1, value: 0 } },
  { requestName: "mcp_allowlist_precheck_args", kind: "result", resultField: 42, innerOneofField: 1, innerVarint: { field: 1, value: 0 } },
  { requestName: "web_fetch_allowlist_precheck_args", kind: "result", resultField: 43, innerOneofField: 1, innerVarint: { field: 1, value: 0 } },
  { requestName: "mini_swe_agent_bash_args", kind: "result", resultField: 55, innerOneofField: 4 },
  { requestName: "conversation_search_args", kind: "result", resultField: 53, innerOneofField: 1 },
  { requestName: "agent_store_conflict_args", kind: "result", resultField: 54, innerOneofField: 2 },
  { requestName: "adopt_args", kind: "result", resultField: 56, innerOneofField: 5 },
]

function requireField(bytes: Uint8Array, fn: number, label: string): RawField {
  const hit = readAllFields(bytes).find((field) => field.fn === fn)
  if (!hit) throw new Error(`${label} missing field #${fn}`)
  return hit
}

function requireLengthDelimited(bytes: Uint8Array, fn: number, label: string): Uint8Array {
  const hit = requireField(bytes, fn, label)
  if (hit.wt !== 2) throw new Error(`${label} field #${fn} wire type ${hit.wt}`)
  if (!hit.bytes) throw new Error(`${label} field #${fn} bytes missing`)
  return hit.bytes
}

function isStreamClose(frame: Uint8Array, execId: number): boolean {
  const control = requireLengthDelimited(frame, 5, "ACM")
  const close = requireLengthDelimited(control, 1, "ExecClientControlMessage")
  return requireField(close, 1, "stream_close").varint === execId
}

describe("unsupported exec deny wire shapes", () => {
  it("covers every known unsupported variant with a dedicated raw-field fixture", () => {
    const unsupported = CURSOR_EXEC_VARIANTS.filter((variant) => variant.handling === "unsupported")
    expect(unsupported.map((variant) => variant.requestName)).toEqual(
      UNSUPPORTED_DENY_WIRE.map((entry) => entry.requestName),
    )
  })

  it("emits the canonical result oneof field, not a guessed sibling", () => {
    const observed = UNSUPPORTED_DENY_WIRE.map((entry) => {
      const variant = cursorExecVariantByRequestName(entry.requestName)
      if (!variant) return { requestName: entry.requestName, error: "missing variant" }
      const frames = buildUnsupportedExecDeny({
        execId: 42,
        variant,
        reason: "not available; use listed tools",
      })
      if (frames.length !== 2 || !isStreamClose(frames[1]!, 42)) {
        return { requestName: entry.requestName, error: `frames ${frames.length}` }
      }
      if (entry.kind === "throw") {
        const control = requireLengthDelimited(frames[0]!, 5, `${entry.requestName} ACM`)
        const thrown = requireLengthDelimited(control, 2, `${entry.requestName} throw`)
        const id = requireField(thrown, 1, `${entry.requestName} throw.id`).varint
        const errorBytes = requireLengthDelimited(thrown, 2, `${entry.requestName} throw.error`)
        return {
          requestName: entry.requestName,
          id,
          error: new TextDecoder().decode(errorBytes).includes("not available") ? undefined : "missing reason",
        }
      }
      const exec = requireLengthDelimited(frames[0]!, 2, `${entry.requestName} ACM`)
      const id = requireField(exec, 1, `${entry.requestName} id`).varint
      const resultBytes = requireLengthDelimited(exec, entry.resultField, `${entry.requestName} result`)
      const inner = readAllFields(resultBytes).find((field) => field.fn === entry.innerOneofField)
      return {
        requestName: entry.requestName,
        id,
        innerWire: inner?.wt,
        innerVarint: entry.innerVarint ? inner?.varint : undefined,
      }
    })
    expect(observed).toEqual(UNSUPPORTED_DENY_WIRE.map((entry) => (
      entry.kind === "throw"
        ? { requestName: entry.requestName, id: 42, error: undefined }
        : {
          requestName: entry.requestName,
          id: 42,
          innerWire: entry.innerVarint ? 0 : 2,
          innerVarint: entry.innerVarint?.value,
        }
    )))
  })

  it("cites ForceBackgroundStatus error = 2", () => {
    expect(FORCE_BACKGROUND_STATUS_ERROR).toBe(2)
  })

  it("marks setup probes and force-background requests as carrying no new call", () => {
    const withoutNewCall = CURSOR_EXEC_VARIANTS
      .filter((variant) => isExecRequestWithoutNewCall(variant.requestField))
      .map((variant) => variant.requestName)
    expect(withoutNewCall).toEqual([
      "request_context_args",
      "force_background_shell_args",
      "force_background_subagent_args",
      "mcp_state_exec_args",
    ])
    expect(isExecRequestWithoutNewCall(undefined)).toBe(false)
  })
})
