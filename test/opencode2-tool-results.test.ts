import { afterEach, describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { extractTrailingToolResults, extractPromptHistory, hasApprovedUncorrelatedPlanStageResult } from "../src/language-model.js"
import { nativeToolFailure, nativeToolRefusal, preserveNativeToolResults, toolResultFailure, TOOL_RESULT_STATUS_KEY } from "../src/opencode2/tool-results.js"
import { buildExecClientMessages, buildTypedExecResult } from "../src/protocol/tools.js"
import { CURSOR_PLAN_STAGE_TOOL } from "../src/protocol/create-plan.js"
import { decodeMessageSparse, encodeMessage } from "../src/protocol/messages.js"
import { readAllFields } from "../src/protocol/struct.js"
import { captureCursorShellResult, CURSOR_TIMEOUT_BACKGROUND, registerCursorShellCall, resetCursorShellCalls } from "../src/shell-timeout.js"

const id = "cursor_native_1"
const errorValue = { error: { type: "permission.rejected", message: "Permission denied: edit" }, content: [] }
const native = (type: string, value: unknown, callID = id) => [{ role: "tool", content: [{ type: "tool-result", id: callID, name: "write", result: { type, value }, providerMetadata: { cursor: { existing: 7 }, other: { keep: true } } }] }]
// The native host converts error to text and part metadata to provider options:
// https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/aisdk.ts#L652-L685
function lower(messages: any[]): LanguageModelV3CallOptions["prompt"] {
  return messages.map(m => ({ role: m.role, content: m.content.map((p: any) => ({ type: p.type, toolCallId: p.id, toolName: p.name,
    output: { type: p.result.type === "error" ? "text" : p.result.type, value: p.result.type === "error" ? JSON.stringify(p.result.value) : p.result.value },
    providerOptions: p.providerMetadata })) }))
}
const wire = (field: string, error = "failed", refusal?: "permission_denied" | "rejected", interrupted?: boolean) =>
  buildExecClientMessages({ execId: 1, resultField: field, output: "partial", error, refusal, interrupted,
    resultMetadata: { path: "source.txt", command: "echo example", working_directory: "/workspace" }, workspaceRoot: "/workspace" })
    .map(bytes => decodeMessageSparse<any>("AgentClientMessage", bytes))

describe("native OpenCode result status", () => {
  test("preserves error status, namespaces, caller identity and partial text without mutating native history", () => {
    const input = native("error", { ...errorValue, content: [{ type: "text", text: "partial output" }, { type: "file", uri: "file:///ignored" }] })
    const stamped = preserveNativeToolResults(input, new Map([[id, "permission_denied"]]))
    expect(input[0]!.content[0]!.providerMetadata.cursor).toEqual({ existing: 7 })
    expect(stamped[0].content[0].providerMetadata.other).toEqual({ keep: true })
    const result = extractTrailingToolResults(lower(JSON.parse(JSON.stringify(stamped))))[0]!
    expect(result).toMatchObject({ toolCallId: id, error: "Permission denied: edit\n\npartial output", refusal: "permission_denied" })
    expect(result.media).toBeUndefined()
    expect(toolResultFailure(stamped[0].content[0].providerMetadata, "cursor_other_1")).toBeUndefined()
    expect(JSON.stringify(extractPromptHistory(lower(stamped), { toolResults: "all", preserveTrailingUser: true }))).toContain("Permission denied: edit")
  })

  test.each(["text", "json", "content"])("does not interpret successful %s output as an error envelope", type => {
    const value = type === "text" ? JSON.stringify(errorValue) : type === "content" ? [{ type: "text", text: JSON.stringify(errorValue) }] : errorValue
    const messages = preserveNativeToolResults(native(type, value))
    expect(extractTrailingToolResults(lower(messages))[0]?.error).toBeUndefined()
    expect(toolResultFailure(messages[0].content[0].providerMetadata, id)).toBeUndefined()
  })

  // OpenCode 2.1.4 stores a failed shell's exit as its own text block after the
  // output: packages/core/src/tool/plugin/shell.ts resultMessages, shell/result.ts notice.
  test.each([
    ["unterminated output", "partial", "partial\nExited with code 3"],
    ["terminated output", "partial\n", "partial\nExited with code 3"],
    ["empty output", "", "Exited with code 3"],
  ])("keeps a shell's exit notice on its own line after %s, live and in rebuilt history", (_, output, expected) => {
    const messages = preserveNativeToolResults([{ role: "tool", content: [{ type: "tool-result", id, name: "shell",
      result: { type: "content", value: [{ type: "text", text: output }, { type: "text", text: "Exited with code 3" }] } }] }])
    const result = extractTrailingToolResults(lower(messages))[0]!
    expect(result).toMatchObject({ output: expected })
    expect(result.error).toBeUndefined()
    const history = extractPromptHistory(lower(messages), { toolResults: "all", preserveTrailingUser: true })
    expect(history.at(-1)!.content).toEndWith(`"status":"completed"}:\n${expected}`)
  })

  describe("a wrapped shell's exit notice", () => {
    const shellResult = (callID: string, blocks: string[]) => preserveNativeToolResults([{ role: "tool", content: [{ type: "tool-result", id: callID, name: "shell",
      result: { type: "content", value: blocks.map(text => ({ type: "text", text })) } }] }])
    const register = (callID: string, exit: number, raw: string) => {
      registerCursorShellCall(callID, { shell_stream: true, command: "make", working_directory: "/tmp", timeout_ms: 1000, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND, hard_timeout_ms: 300 })
      return captureCursorShellResult(callID, raw, { exit })
    }
    afterEach(() => resetCursorShellCalls())

    test.each([
      ["an exit", 2, "out\n\n__CURSOR_SHELL_EXIT__2\n", "out\n", "Exited with code 2"],
      ["a hard timeout", 124, "out\n__CURSOR_SHELL_TIMEOUT__300\n", "out\nTimed out after 300ms.\n", "Exited with code 124"],
    ])("leaves Cursor's stdout and keeps rebuilt history for %s", (_, exit, raw, clean, notice) => {
      const callID = `cursor_wrapped_${exit}`
      expect(register(callID, exit, raw)).toBe(clean)
      const messages = shellResult(callID, [clean, notice])
      expect(extractTrailingToolResults(lower(messages))[0]!.output).toBe(clean)
      const history = extractPromptHistory(lower(messages), { toolResults: "all", preserveTrailingUser: true })
      expect(history.at(-1)!.content).toEndWith(`${clean}${notice}`)
    })

    test("stays when it does not match the captured exit or no exit was captured", () => {
      register("cursor_wrapped_7", 2, "out\n__CURSOR_SHELL_EXIT__2\n")
      expect(extractTrailingToolResults(lower(shellResult("cursor_wrapped_7", ["out", "Exited with code 3"])))[0]!.output).toBe("out\nExited with code 3")
      expect(extractTrailingToolResults(lower(shellResult("cursor_unregistered_8", ["out", "Exited with code 2"])))[0]!.output).toBe("out\nExited with code 2")
    })
  })

  test("a completed result overwrites stale failure metadata", () => {
    const failed = preserveNativeToolResults(native("error", errorValue))
    failed[0].content[0].result = { type: "text", value: "ok" }
    expect(extractTrailingToolResults(lower(preserveNativeToolResults(failed)))[0]?.error).toBeUndefined()
  })

  test.each([undefined, null, {}, "", { error: { type: "tool.execution", message: "" }, content: [] }])("empty native errors fail with a nonempty reason: %p", value => {
    const result = extractTrailingToolResults(lower(preserveNativeToolResults(native("error", value))))[0]!
    expect(result.error).toBeTruthy()
    expect(buildTypedExecResult("write_result", result.output, result.error).success).toBeUndefined()
  })

  test("permission causes are typed, nested and cycle-safe; ordinary text cannot deny execution", () => {
    expect(nativeToolRefusal({ _tag: "Tool.Error", error: { _tag: "Permission.BlockedError" } })).toBe("permission_denied")
    for (const tag of ["Permission.CorrectedError", "Permission.DeclinedError"]) expect(nativeToolRefusal({ _tag: tag })).toBe("rejected")
    const cycle: any = { message: "Permission denied: edit" }; cycle.error = cycle
    expect(nativeToolRefusal(cycle)).toBeUndefined()
    expect(nativeToolRefusal(new Error("Permission denied: edit"))).toBeUndefined()
    expect(nativeToolFailure(errorValue).refusal).toBe("rejected")
  })

  test("malformed metadata and messages cannot fabricate a result", () => {
    for (const value of [null, [], {}, { cursor: { [TOOL_RESULT_STATUS_KEY]: { callID: id, status: "error", failure: {} } } }]) expect(toolResultFailure(value, id)).toBeUndefined()
    expect(preserveNativeToolResults(undefined)).toEqual([])
    const malformed = [{ role: "user", content: "text" }, { role: "tool", content: [{ type: "tool-result", result: { type: "bogus" } }] }]
    expect(preserveNativeToolResults(malformed)).toEqual(malformed)
  })

  test("independent parallel results retain only their own error", () => {
    const messages = preserveNativeToolResults([...native("error", errorValue), ...native("text", JSON.stringify(errorValue), "cursor_native_2")])
    const results = extractTrailingToolResults(lower(messages))
    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBeTruthy()
    expect(results[1]!.error).toBeUndefined()
  })

  test.each([{ type: "error-text", value: "" }, { type: "execution-denied", reason: "" }, { type: "error-json", value: null }])("SDK error %p cannot become success", output => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "write", output }] }]
    expect(extractTrailingToolResults(prompt)[0]!.error).toBeTruthy()
  })

  test("aborted native errors retain interruption status and cannot acquire detached media", () => {
    const messages = preserveNativeToolResults(native("error", { error: { type: "aborted", message: "Tool execution interrupted" }, content: [] }))
    const prompt: LanguageModelV3CallOptions["prompt"] = [...lower(messages), { role: "user", content: [
      { type: "text", text: "Attached media from tool result:" },
      { type: "file", data: new URL("https://example.test/image.png"), mediaType: "image/png" },
    ] }]
    const result = extractTrailingToolResults(prompt)[0]!
    expect(result.interrupted).toBe(true)
    expect(result.error).toBe("Tool execution interrupted")
    expect(result.refusal).toBeUndefined()
    expect(result.media).toBeUndefined()
  })

  test("failed native plan-stage output cannot authorize implementation", () => {
    const messages = preserveNativeToolResults(native("error", errorValue, "native-plan"))
    messages[0].content[0].name = CURSOR_PLAN_STAGE_TOOL
    expect(hasApprovedUncorrelatedPlanStageResult(lower(messages))).toBe(false)
    const approved = preserveNativeToolResults(native("text", "approved", "native-plan"))
    approved[0].content[0].name = CURSOR_PLAN_STAGE_TOOL
    expect(hasApprovedUncorrelatedPlanStageResult(lower(approved))).toBe(true)
  })
})

describe("Cursor failure and refusal wire arms", () => {
  const fields = ["read_result", "write_result", "delete_result", "ls_result", "grep_result", "shell_result", "background_shell_spawn_result", "mcp_result", "subagent_result",
    "pi_write_result", "pi_read_result", "pi_bash_result", "pi_edit_result", "pi_grep_result", "pi_find_result", "pi_ls_result"]
  test.each(fields)("empty errors never emit success on %s", field => {
    const messages = wire(field, "")
    expect(messages).toHaveLength(2)
    const result = messages[0].exec_client_message[field]
    expect(result.success).toBeUndefined()
    expect(JSON.stringify(result)).toContain("OpenCode tool execution failed")
    expect(messages[1].exec_client_control_message.stream_close.id).toBe(1)
  })

  test.each(["read_result", "write_result", "delete_result", "mcp_result", "shell_result", "background_shell_spawn_result", "ls_result"])("denials and rejections use available native %s arms", field => {
    for (const refusal of ["permission_denied", "rejected"] as const) {
      const result = wire(field, "denied", refusal)[0].exec_client_message[field]
      expect(result.success).toBeUndefined()
      expect(result[field === "ls_result" ? "rejected" : refusal]).toBeDefined()
      if (["write_result", "delete_result", "read_result", "ls_result"].includes(field)) expect(result[field === "ls_result" ? "rejected" : refusal].path).toBe("/workspace/source.txt")
    }
  })

  test("stream refusals close without a fabricated start or exit; interruption is distinct", () => {
    for (const refusal of ["permission_denied", "rejected"] as const) {
      const frames = wire("shell_stream", "denied", refusal)
      expect(frames).toHaveLength(2)
      expect(frames[0].exec_client_message.shell_stream[refusal]).toBeDefined()
    }
    const interrupted = wire("shell_stream", "interrupted", undefined, true)
    expect(interrupted).toHaveLength(5)
    expect(interrupted[1].exec_client_message.shell_stream.stdout.data).toBe("partial")
    expect(interrupted[3].exec_client_message.shell_stream.exit).toMatchObject({ aborted: true, abort_reason: 1, code: 0 })
    expect(wire("shell_result", "interrupted", undefined, true)[0].exec_client_message.shell_result.failure.aborted).toBe(true)
    expect(wire("shell_stream", "")[3].exec_client_message.shell_stream.exit.code).toBe(1)
  })

  // Field numbers checked against the extracted agent.v1 protocol, rather than
  // deriving the expected values from this package's own protobuf declarations.
  test.each([
    ["WriteResult", "rejected", { path: "/w", reason: "declined" }, 6],
    ["ReadResult", "rejected", { path: "/w", reason: "declined" }, 3],
    ["ReadResult", "permission_denied", { path: "/w" }, 5],
    ["DeleteResult", "permission_denied", { path: "/w", client_visible_error: "denied" }, 4],
    ["DeleteResult", "rejected", { path: "/w", reason: "declined" }, 6],
    ["LsResult", "rejected", { path: "/w", reason: "declined" }, 3],
    ["ShellResult", "permission_denied", { error: "denied" }, 7],
    ["McpResult", "rejected", { reason: "declined" }, 3],
    ["McpResult", "permission_denied", { error: "denied" }, 4],
  ] as const)("%s %s uses verified field %p", (type, arm, value, number) => {
    expect(readAllFields(encodeMessage(type, { [arm]: value })).map(f => f.fn)).toEqual([number])
  })
})
