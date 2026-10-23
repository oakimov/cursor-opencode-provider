import { describe, expect, it } from "bun:test"
import protobuf from "protobufjs"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"
import {
  advertisedToolNamesFromDescriptors,
  displayMcpToolError,
  displayNativeDiscoveryError,
  applyTodoMerge,
  extractExecDisplayCallId,
  extractProtobufSubmessage,
  listProtobufFieldNumbers,
  isNativeDisplayToolCall,
  parseDisplayToolCall,
  resolveBridgedOpenCodeToolCall,
  snapshotMirroredTodos,
  snapshotMirroredTodosFromReadOutput,
} from "../src/protocol/tool-call-bridge.js"

function encodeCanonicalToolCall(
  variantField: number,
  writeArgs: (writer: protobuf.Writer) => void,
): Uint8Array {
  const writer = protobuf.Writer.create()
  writer.uint32((variantField << 3) | 2).fork()
  writer.uint32((1 << 3) | 2).fork()
  writeArgs(writer)
  writer.ldelim()
  writer.ldelim()
  writer.uint32((57 << 3) | 2).string("canonical-call")
  return writer.finish()
}

describe("tool-call-bridge", () => {
  it("decodes native discovery errors without replaying discovery as host execution", () => {
    // Independent wire: ToolCall.discovery #44, result #2, error #2, text #1.
    const writer = protobuf.Writer.create()
    writer.uint32((44 << 3) | 2).fork()
    writer.uint32((2 << 3) | 2).fork()
    writer.uint32((2 << 3) | 2).fork()
    writer.uint32((1 << 3) | 2).string("CreatePlan is already available directly")
    writer.ldelim().ldelim().ldelim()
    const decoded = decodeMessage<Record<string, unknown>>("ToolCall", writer.finish())
    expect(displayNativeDiscoveryError(decoded)).toBe("CreatePlan is already available directly")
    expect(displayMcpToolError(decoded)).toBeUndefined()
    expect(resolveBridgedOpenCodeToolCall(parseDisplayToolCall("discovery-error", decoded)!, ["read"]))
      .toBeUndefined()
    expect(displayNativeDiscoveryError({ get_mcp_tools_tool_call: { result: { success: { content: "Error: appears in a tool description" } } } }))
      .toBeUndefined()
    expect(displayNativeDiscoveryError(undefined)).toBeUndefined()
  })
  it("preserves server-side dynamic-call errors that have no started or exec frame", () => {
    // Independent wire fixture: ToolCall.mcp (#15), result (#2), error (#2),
    // title (#1), detail (#2), matching a server-side invocation rejection.
    const detail = "Missing required fields: namespace, toolName"
    const writer = protobuf.Writer.create()
    writer.uint32((15 << 3) | 2).fork()
    writer.uint32((2 << 3) | 2).fork()
    writer.uint32((2 << 3) | 2).fork()
    writer.uint32((1 << 3) | 2).string("Tool execution error")
    writer.uint32((2 << 3) | 2).string(detail)
    writer.ldelim().ldelim().ldelim()
    const decoded = decodeMessage<Record<string, unknown>>("ToolCall", writer.finish())
    expect(displayMcpToolError(decoded)).toBe(`Tool execution error: ${detail}`)
    expect(displayMcpToolError({ mcp_tool_call: { result: { error: { error: "Legacy error" } } } }))
      .toBe("Legacy error")
    expect(displayMcpToolError({ mcp_tool_call: { result: { success: {} } } })).toBeUndefined()
    expect(displayMcpToolError(undefined)).toBeUndefined()
    const display = parseDisplayToolCall("rejected-call", decoded)!
    expect(resolveBridgedOpenCodeToolCall(display, ["grep"])).toBeUndefined()
  })

  it("decodes UpdateTodosToolCall oneof and maps to todowrite", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "tc_todos",
      update_todos_tool_call: {
        args: {
          todos: [{ id: "1", content: "Wire bridge", status: 2 }],
          merge: true,
        },
        result: {
          success: {
            todos: [
              { id: "1", content: "Wire bridge", status: 2 },
              { id: "2", content: "Add tests", status: 1 },
            ],
            was_merge: true,
          },
        },
      },
    })
    const decoded = decodeMessage<Record<string, unknown>>("ToolCall", encoded)
    const display = parseDisplayToolCall("tc_todos", decoded)
    expect(display).toBeDefined()
    expect(display!.variant).toBe("update_todos_tool_call")
    expect(display!.preferredToolName).toBe("todowrite")
    expect(display!.args.todos).toEqual([
      { id: "1", content: "Wire bridge", status: "in_progress", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ])

    const bridged = resolveBridgedOpenCodeToolCall(display!, ["todowrite", "bash"])
    expect(bridged).toEqual({
      toolName: "todowrite",
      callId: "tc_todos",
      variant: "update_todos_tool_call",
      args: {
        todos: [
          { id: "1", content: "Wire bridge", status: "in_progress", priority: "medium" },
          { id: "2", content: "Add tests", status: "pending", priority: "medium" },
        ],
      },
    })
  })

  it("does not let an empty proto-default success list erase final args todos", () => {
    const display = parseDisplayToolCall("tc_todos_final", {
      update_todos_tool_call: {
        args: {
          todos: [
            { id: "a", content: "sv-token-a", status: "completed" },
            { id: "b", content: "sv-token-b", status: "completed" },
          ],
        },
        result: { success: { todos: [] } },
      },
    })

    expect(display?.args.todos).toEqual([
      { id: "a", content: "sv-token-a", status: "completed", priority: "medium" },
      { id: "b", content: "sv-token-b", status: "completed", priority: "medium" },
    ])
  })

  it("maps CreatePlanToolCall into todowrite with a plan summary todo", () => {
    const display = parseDisplayToolCall("tc_plan", {
      create_plan_tool_call: {
        args: {
          name: "Bridge work",
          overview: "Surface Cursor display tools in OpenCode",
          plan: "1. Parse ToolCall\n2. Emit todowrite",
          todos: [{ id: "a", content: "Implement", status: 1 }],
        },
      },
    })
    expect(display?.preferredToolName).toBe("todowrite")
    const todos = display!.args.todos as Array<Record<string, unknown>>
    expect(todos[0]?.id).toBe("plan")
    expect(todos[0]?.status).toBe("completed")
    expect(String(todos[0]?.content)).toContain("Plan: Bridge work")
    expect(todos[1]?.content).toBe("Implement")

    expect(resolveBridgedOpenCodeToolCall(display!, ["bash"])).toBeUndefined()
    expect(resolveBridgedOpenCodeToolCall(display!, ["todowrite"])?.toolName).toBe("todowrite")
  })

  it("decodes AskQuestionToolCall but does not replay a completed interaction", () => {
    const display = parseDisplayToolCall("tc_q", {
      ask_question_tool_call: {
        args: {
          title: "Mode",
          questions: [
            {
              id: "q1",
              prompt: "Continue bridging?",
              allow_multiple: false,
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          ],
        },
      },
    })
    expect(display?.preferredToolName).toBe("question")
    expect(resolveBridgedOpenCodeToolCall(display!, ["question"])).toBeUndefined()
  })

  it("decodes switch_mode without replaying a completed lifecycle operation", () => {
    const display = parseDisplayToolCall("tc_mode", {
      switch_mode_tool_call: {
        args: {
          target_mode_id: "plan",
          explanation: "Need a structured plan",
        },
      },
    })
    expect(display?.preferredToolName).toBe("plan_enter")
    expect(resolveBridgedOpenCodeToolCall(display!, ["todowrite"])).toBeUndefined()
    expect(resolveBridgedOpenCodeToolCall(display!, ["plan_enter"])).toBeUndefined()
  })

  it("declines state-destructive todo fallbacks", () => {
    const mergeWithoutFinalState = parseDisplayToolCall("merge", {
      update_todos_tool_call: {
        args: { merge: true, todos: [{ id: "changed", content: "delta", status: 3 }] },
      },
    })
    expect(resolveBridgedOpenCodeToolCall(mergeWithoutFinalState!, ["todowrite"])).toBeUndefined()

    const leavePlan = parseDisplayToolCall("leave", {
      switch_mode_tool_call: { args: { target_mode_id: "agent" } },
    })
    expect(resolveBridgedOpenCodeToolCall(leavePlan!, ["todowrite"])).toBeUndefined()
  })

  it("mirrors Cursor TodoRead display calls into todoread", () => {
    const display = parseDisplayToolCall("read", {
      read_todos_tool_call: {
        args: { status_filter: [1, 3], id_filter: ["todo-7"] },
        result: {
          success: {
            todos: [{ id: "todo-7", content: "visible", status: 1 }],
            total_count: 1,
          },
        },
      },
    })
    expect(display?.variant).toBe("read_todos_tool_call")
    expect(display?.preferredToolName).toBe("todoread")
    expect(display?.args).toEqual({})
    expect(display?.bridgeable).toBe(true)
    expect(resolveBridgedOpenCodeToolCall(display!, ["todoread"])).toEqual({
      toolName: "todoread",
      callId: "read",
      variant: "read_todos_tool_call",
      args: {},
    })
    expect(resolveBridgedOpenCodeToolCall(display!, ["todowrite"])).toBeUndefined()
  })

  it("applies merge updates against a prior mirrored todo snapshot", () => {
    const prior = [
      { id: "1", content: "Wire bridge", status: "in_progress", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ]
    const display = parseDisplayToolCall(
      "merge-prior",
      {
        update_todos_tool_call: {
          args: {
            merge: true,
            todos: [{ id: "1", content: "Wire bridge", status: 3 }],
          },
        },
      },
      prior,
    )
    expect(display?.bridgeable).toBe(true)
    expect(display?.args.todos).toEqual([
      { id: "1", content: "Wire bridge", status: "completed", priority: "medium" },
      { id: "2", content: "Add tests", status: "pending", priority: "medium" },
    ])
    expect(resolveBridgedOpenCodeToolCall(display!, ["todowrite"])).toEqual({
      toolName: "todowrite",
      callId: "merge-prior",
      variant: "update_todos_tool_call",
      args: {
        todos: [
          { id: "1", content: "Wire bridge", status: "completed", priority: "medium" },
          { id: "2", content: "Add tests", status: "pending", priority: "medium" },
        ],
      },
    })
  })

  it("preserves prior content when a merge patch carries id+status only", () => {
    const prior = [
      { id: "1", content: "Keep this text", status: "in_progress", priority: "high" },
    ]
    const display = parseDisplayToolCall(
      "merge-sparse",
      {
        update_todos_tool_call: {
          args: {
            merge: true,
            todos: [{ id: "1", status: 3 }],
          },
        },
      },
      prior,
    )
    expect(display?.bridgeable).toBe(true)
    expect(display?.args.todos).toEqual([
      { id: "1", content: "Keep this text", status: "completed", priority: "high" },
    ])
  })

  it("matches merge patches by content across id spaces without duplicating", () => {
    const prior = [
      { id: "todo_1", content: "Host-written task", status: "pending", priority: "medium" },
    ]
    // Same task, Cursor-side id: status applies, prior id and order kept.
    expect(
      applyTodoMerge(prior, [{ id: "9", content: "Host-written task", status: 3 }]),
    ).toEqual([
      { id: "todo_1", content: "Host-written task", status: "completed", priority: "medium" },
    ])
    // Status-only patch for an unknown id with no content carries no mappable
    // information: skip it rather than appending a content-less item.
    expect(applyTodoMerge(prior, [{ id: "9", status: 3 }])).toEqual(prior)
    // New content still appends.
    expect(
      applyTodoMerge(prior, [{ id: "9", content: "Brand new", status: 1 }]),
    ).toEqual([
      { id: "todo_1", content: "Host-written task", status: "pending", priority: "medium" },
      { id: "9", content: "Brand new", status: "pending", priority: "medium" },
    ])
  })

  it("snapshots full todo lists and parses host read results", () => {
    expect(
      snapshotMirroredTodos([
        { content: "a", status: "pending" },
        { id: "plan", content: "synthetic", status: "pending" },
      ]),
    ).toEqual([
      { id: "todo_1", content: "a", status: "pending", priority: "medium" },
    ])
    expect(snapshotMirroredTodos(undefined)).toBeUndefined()
    expect(
      snapshotMirroredTodosFromReadOutput(
        JSON.stringify([{ id: "1", content: "x", status: "completed" }]),
      ),
    ).toEqual([
      { id: "1", content: "x", status: "completed", priority: "medium" },
    ])
    expect(
      snapshotMirroredTodosFromReadOutput(
        JSON.stringify({ todos: [{ id: "1", content: "x", status: 1 }] }),
      ),
    ).toEqual([
      { id: "1", content: "x", status: "pending", priority: "medium" },
    ])
    expect(snapshotMirroredTodosFromReadOutput("No todos yet")).toBeUndefined()
    expect(snapshotMirroredTodosFromReadOutput(JSON.stringify({ ok: true }))).toBeUndefined()
  })

  it("prefers ToolCallCompleted todos over a prior snapshot for merges", () => {
    const prior = [
      { id: "1", content: "stale", status: "pending", priority: "medium" },
    ]
    const display = parseDisplayToolCall(
      "merge-completed",
      {
        update_todos_tool_call: {
          args: {
            merge: true,
            todos: [{ id: "1", content: "partial", status: 3 }],
          },
          result: {
            success: {
              todos: [
                { id: "1", content: "final", status: 3 },
                { id: "2", content: "kept", status: 1 },
              ],
              was_merge: true,
            },
          },
        },
      },
      prior,
    )
    expect(display?.args.todos).toEqual([
      { id: "1", content: "final", status: "completed", priority: "medium" },
      { id: "2", content: "kept", status: "pending", priority: "medium" },
    ])
  })

  it("decodes edit and task calls without replaying completed operations", () => {
    const fullEdit = parseDisplayToolCall("edit", {
      edit_tool_call: { args: { path: "/tmp/a.ts", stream_content: "const x = 1\n" } },
    })
    expect(resolveBridgedOpenCodeToolCall(fullEdit!, ["write"])).toBeUndefined()
    expect(resolveBridgedOpenCodeToolCall(fullEdit!, ["edit"])).toBeUndefined()

    const piEdit = parseDisplayToolCall("pi-edit", {
      pi_edit_tool_call: {
        args: { path: "/tmp/a.ts", edits: [{ old_text: "old", new_text: "" }] },
      },
    })
    expect(resolveBridgedOpenCodeToolCall(piEdit!, ["edit"])).toBeUndefined()

    const multiEdit = parseDisplayToolCall("pi-multi", {
      pi_edit_tool_call: {
        args: {
          path: "/tmp/a.ts",
          edits: [
            { old_text: "a", new_text: "b" },
            { old_text: "c", new_text: "d" },
          ],
        },
      },
    })
    expect(resolveBridgedOpenCodeToolCall(multiEdit!, ["edit"])).toBeUndefined()

    const task = parseDisplayToolCall("task", {
      task_tool_call: {
        args: { description: "Inspect", prompt: "Find the bug", subagent_type: { explore: {} } },
      },
    })
    expect(resolveBridgedOpenCodeToolCall(task!, ["task"])).toBeUndefined()
    const missingSubtype = parseDisplayToolCall("task-invalid", {
      task_tool_call: { args: { description: "Inspect", prompt: "Find the bug" } },
    })
    expect(resolveBridgedOpenCodeToolCall(missingSubtype!, ["task"])).toBeUndefined()
  })

  it("keeps TaskToolCall description intact for SubagentArgs correlation", () => {
    // Display TaskToolCall is not mirrored into OpenCode (exec #28 owns execution),
    // but its description is the real short title Cursor generated. SubagentArgs
    // has no description field, so language-model prefers this when tool_call_id matches.
    const display = parseDisplayToolCall("task-call-34", {
      task_tool_call: {
        args: {
          description: "Find auth root cause",
          prompt: "Inspect recent logs and identify the root cause",
          subagent_type: { explore: {} },
        },
      },
    })
    expect(display).toMatchObject({
      variant: "task_tool_call",
      preferredToolName: "task",
      args: {
        description: "Find auth root cause",
        prompt: "Inspect recent logs and identify the root cause",
        subagent_type: "explore",
      },
    })
    expect(extractExecDisplayCallId({
      subagent_args: { tool_call_id: "task-call-34", prompt: "Inspect recent logs and identify the root cause" },
    })).toBe("task-call-34")
  })

  it("does not substitute a search term for a fetch URL", () => {
    const search = parseDisplayToolCall("search", {
      web_search_tool_call: { args: { search_term: "OpenCode" } },
    })
    expect(resolveBridgedOpenCodeToolCall(search!, ["webfetch"])).toBeUndefined()
    expect(resolveBridgedOpenCodeToolCall(search!, ["websearch"])).toBeUndefined()
  })

  it("decodes canonical Pi wire fields and preserves their semantics", () => {
    const piBash = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(62, (writer) => {
        writer.uint32((1 << 3) | 2).string("echo hi")
        writer.uint32((2 << 3) | 1).double(1.5)
      }),
    )
    const bash = parseDisplayToolCall("pi-bash", piBash)
    expect(resolveBridgedOpenCodeToolCall(bash!, ["bash"])).toBeUndefined()

    const piGrep = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(65, (writer) => {
        writer.uint32((1 << 3) | 2).string("needle")
        writer.uint32((2 << 3) | 2).string("/tmp")
        writer.uint32((4 << 3) | 0).bool(true)
      }),
    )
    const grep = parseDisplayToolCall("pi-grep", piGrep)
    expect(resolveBridgedOpenCodeToolCall(grep!, ["grep"])).toBeUndefined()

    const piFind = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(66, (writer) => {
        writer.uint32((1 << 3) | 2).string("*.ts")
        writer.uint32((2 << 3) | 2).string("/tmp")
      }),
    )
    const find = parseDisplayToolCall("pi-find", piFind)
    expect(resolveBridgedOpenCodeToolCall(find!, ["glob"])).toBeUndefined()
  })

  it("decodes canonical Task subagent_type without replaying the completed task", () => {
    const taskCall = decodeMessage<Record<string, unknown>>(
      "ToolCall",
      encodeCanonicalToolCall(19, (writer) => {
        writer.uint32((1 << 3) | 2).string("Inspect")
        writer.uint32((2 << 3) | 2).string("Find the bug")
        writer.uint32((3 << 3) | 2).fork()
        writer.uint32((4 << 3) | 2).fork().ldelim()
        writer.ldelim()
      }),
    )
    const task = parseDisplayToolCall("task", taskCall)
    expect(resolveBridgedOpenCodeToolCall(task!, ["task"])).toBeUndefined()
  })

  it("extracts display call ids from exec args variants", () => {
    expect(extractExecDisplayCallId({
      id: 2,
      shell_args: { command: "ls", tool_call_id: "shell_0" },
    })).toBe("shell_0")
    expect(
      extractExecDisplayCallId({
        id: 3,
        shell_stream_args: { command: "ls", tool_call_id: "shell_1" },
      }),
    ).toBe("shell_1")
    expect(
      extractExecDisplayCallId({
        id: 4,
        read_args: { path: "/x", tool_call_id: "read_1" },
      }),
    ).toBe("read_1")
    expect(
      extractExecDisplayCallId({
        id: 34,
        subagent_args: { prompt: "Investigate", tool_call_id: "task_1" },
      }),
    ).toBe("task_1")
    expect(extractExecDisplayCallId({ id: 5, request_context_args: {} })).toBeUndefined()
  })

  it("lists advertised OpenCode tool names from descriptors", () => {
    expect(
      advertisedToolNamesFromDescriptors([
        { provider_identifier: "opencode", tool_name: "todowrite" },
        { provider_identifier: "github", tool_name: "create_pull_request" },
        { provider_identifier: "opencode", tool_name: "bash" },
      ]),
    ).toEqual(["todowrite", "github_create_pull_request", "bash"])
  })

  it("decodes AwaitToolCall (display-only native tool)", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "tc_await",
      await_tool_call: {
        args: {
          task_id: "shell_1",
          block_until_ms: 30000,
          regex: "exit_code",
        },
      },
    })
    const decoded = decodeMessage<Record<string, unknown>>("ToolCall", encoded)
    const display = parseDisplayToolCall("tc_await", decoded)
    expect(display?.variant).toBe("await_tool_call")
    expect(display?.preferredToolName).toBe("await")
    expect(display?.args).toMatchObject({ task_id: "shell_1", block_until_ms: 30000 })
    // OpenCode turns usually do not advertise an await tool — no bridge.
    expect(resolveBridgedOpenCodeToolCall(display!, ["bash", "todowrite"])).toBeUndefined()
  })

  it("decodes canonical read-todos status and id filters", () => {
    const encoded = encodeCanonicalToolCall(10, (writer) => {
      writer.uint32((1 << 3) | 2).fork().int32(1).int32(3).ldelim()
      writer.uint32((2 << 3) | 2).string("todo-7")
    })
    const decoded = decodeMessage<any>("ToolCall", encoded)
    expect(decoded.read_todos_tool_call.args.status_filter).toEqual([1, 3])
    expect(decoded.read_todos_tool_call.args.id_filter).toEqual(["todo-7"])
  })

  it("lists protobuf field numbers for unknown-variant diagnosis", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "x",
      await_tool_call: { args: { task_id: "t1" } },
    })
    const fields = listProtobufFieldNumbers(encoded)
    expect(fields).toContain(42)
    expect(fields).toContain(57)
    const nested = extractProtobufSubmessage(encoded, [42, 1])
    expect(nested).toBeDefined()
    expect(listProtobufFieldNumbers(nested!)).toContain(1)
  })

  it("maps every known ToolCall variant preferred tool one after another", () => {
    const cases: Array<{
      variant: string
      payload: Record<string, unknown>
      preferred: string
      advertised: string[]
      bridged?: string
    }> = [
      {
        variant: "shell_tool_call",
        payload: { args: { command: "echo hi", working_directory: "/tmp" } },
        preferred: "bash",
        advertised: ["bash"],
        bridged: "bash",
      },
      {
        variant: "delete_tool_call",
        payload: { args: { path: "/tmp/x" } },
        preferred: "bash",
        advertised: ["bash"],
        bridged: "bash",
      },
      {
        variant: "glob_tool_call",
        payload: { args: { glob_pattern: "*.ts", target_directory: "/tmp" } },
        preferred: "glob",
        advertised: ["glob"],
        bridged: "glob",
      },
      {
        variant: "grep_tool_call",
        payload: { args: { pattern: "foo", path: "/tmp", glob: "*.ts" } },
        preferred: "grep",
        advertised: ["grep"],
        bridged: "grep",
      },
      {
        variant: "read_tool_call",
        payload: { args: { path: "/tmp/a.ts" } },
        preferred: "read",
        advertised: ["read"],
        bridged: "read",
      },
      {
        variant: "update_todos_tool_call",
        payload: { args: { todos: [{ id: "1", content: "x", status: 1 }], merge: false } },
        preferred: "todowrite",
        advertised: ["todowrite"],
        bridged: "todowrite",
      },
      {
        variant: "read_todos_tool_call",
        payload: { args: {} },
        preferred: "todoread",
        advertised: ["todoread"],
        bridged: "todoread",
      },
      {
        variant: "edit_tool_call",
        payload: { args: { path: "/tmp/a.ts", stream_content: "new file" } },
        preferred: "write",
        advertised: ["write"],
        bridged: "write",
      },
      {
        variant: "ls_tool_call",
        payload: { args: { path: "/tmp" } },
        preferred: "read",
        advertised: ["read"],
        bridged: "read",
      },
      {
        variant: "mcp_tool_call",
        payload: {
          args: {
            provider_identifier: "github",
            tool_name: "create_pull_request",
            args: { title: "t" },
          },
        },
        preferred: "github_create_pull_request",
        advertised: ["github_create_pull_request"],
        bridged: "github_create_pull_request",
      },
      {
        variant: "create_plan_tool_call",
        payload: { args: { name: "n", overview: "o", plan: "p", todos: [] } },
        preferred: "todowrite",
        advertised: ["todowrite"],
        bridged: "todowrite",
      },
      {
        variant: "web_search_tool_call",
        payload: { args: { search_term: "opencode" } },
        preferred: "websearch",
        advertised: ["websearch", "webfetch"],
        bridged: "websearch",
      },
      {
        variant: "task_tool_call",
        payload: {
          args: { description: "d", prompt: "p", subagent_type: { explore: {} } },
        },
        preferred: "task",
        advertised: ["task"],
        bridged: "task",
      },
      {
        variant: "ask_question_tool_call",
        payload: {
          args: {
            title: "t",
            questions: [{ id: "q", prompt: "Q?", options: [{ id: "a", label: "A" }] }],
          },
        },
        preferred: "question",
        advertised: ["question"],
        bridged: "question",
      },
      {
        variant: "fetch_tool_call",
        payload: { args: { url: "https://example.com" } },
        preferred: "webfetch",
        advertised: ["webfetch"],
        bridged: "webfetch",
      },
      {
        variant: "web_fetch_tool_call",
        payload: { args: { url: "https://example.com" } },
        preferred: "webfetch",
        advertised: ["webfetch"],
        bridged: "webfetch",
      },
      {
        variant: "switch_mode_tool_call",
        payload: { args: { target_mode_id: "plan", explanation: "x" } },
        preferred: "plan_enter",
        advertised: ["plan_enter"],
        bridged: "plan_enter",
      },
      {
        variant: "generate_image_tool_call",
        payload: { args: { description: "a cat" } },
        preferred: "generateimage",
        advertised: ["generateimage"],
        bridged: "generateimage",
      },
      {
        variant: "get_mcp_tools_tool_call",
        payload: { args: { server: "opencode", tool_name: "edit", pattern: "edit" } },
        preferred: "get_mcp_tools",
        advertised: ["bash", "edit", "skill"],
        bridged: undefined,
      },
      {
        variant: "await_tool_call",
        payload: { args: { task_id: "shell_1", block_until_ms: 1000 } },
        preferred: "await",
        advertised: ["bash", "todowrite"],
        bridged: undefined,
      },
      {
        variant: "pi_read_tool_call",
        payload: { args: { path: "/tmp/a.ts" } },
        preferred: "read",
        advertised: ["read"],
        bridged: "read",
      },
      {
        variant: "pi_bash_tool_call",
        payload: { args: { command: "echo hi" } },
        preferred: "bash",
        advertised: ["bash"],
        bridged: "bash",
      },
      {
        variant: "pi_edit_tool_call",
        payload: { args: { path: "/tmp/a.ts", edits: [{ old_text: "a", new_text: "b" }] } },
        preferred: "edit",
        advertised: ["edit"],
        bridged: "edit",
      },
      {
        variant: "pi_write_tool_call",
        payload: { args: { path: "/tmp/a.ts", content: "hi" } },
        preferred: "write",
        advertised: ["write"],
        bridged: "write",
      },
      {
        variant: "pi_grep_tool_call",
        payload: { args: { pattern: "foo", path: "/tmp" } },
        preferred: "grep",
        advertised: ["grep"],
        bridged: "grep",
      },
      {
        variant: "pi_find_tool_call",
        payload: { args: { pattern: "*.ts", path: "/tmp" } },
        preferred: "glob",
        advertised: ["glob"],
        bridged: "glob",
      },
      {
        variant: "pi_ls_tool_call",
        payload: { args: { path: "/tmp" } },
        preferred: "read",
        advertised: ["read"],
        bridged: "read",
      },
    ]

    for (const c of cases) {
      const display = parseDisplayToolCall(`tc_${c.variant}`, { [c.variant]: c.payload })
      expect(display, c.variant).toBeDefined()
      expect(display!.variant, c.variant).toBe(c.variant)
      expect(display!.preferredToolName, c.variant).toBe(c.preferred)
      expect(isNativeDisplayToolCall(c.variant), c.variant).toBe(c.variant === "get_mcp_tools_tool_call")
      const bridged = resolveBridgedOpenCodeToolCall(display!, c.advertised)
      if (
        c.variant === "update_todos_tool_call" ||
        c.variant === "create_plan_tool_call"
      ) {
        expect(bridged?.toolName, c.variant).toBe("todowrite")
      } else if (c.variant === "read_todos_tool_call") {
        expect(bridged?.toolName, c.variant).toBe("todoread")
        expect(bridged?.args, c.variant).toEqual({})
      } else {
        expect(bridged, c.variant).toBeUndefined()
      }
    }
  })

  it("round-trips every schema ToolCall variant through encode/decode", () => {
    const variants: Array<[string, Record<string, unknown>]> = [
      ["shell_tool_call", { args: { command: "echo" } }],
      ["delete_tool_call", { args: { path: "/tmp/x" } }],
      ["glob_tool_call", { args: { glob_pattern: "*.ts" } }],
      ["grep_tool_call", { args: { pattern: "x" } }],
      ["read_tool_call", { args: { path: "/tmp/a" } }],
      ["update_todos_tool_call", { args: { todos: [], merge: false } }],
      ["read_todos_tool_call", { args: {} }],
      ["edit_tool_call", { args: { path: "/tmp/a", stream_content: "new file" } }],
      ["ls_tool_call", { args: { path: "/tmp" } }],
      ["mcp_tool_call", { args: { tool_name: "read", provider_identifier: "opencode" } }],
      ["create_plan_tool_call", { args: { name: "n", overview: "o", plan: "p" } }],
      ["web_search_tool_call", { args: { search_term: "q" } }],
      ["task_tool_call", {
        args: { description: "d", prompt: "p", subagent_type: { explore: {} } },
      }],
      ["ask_question_tool_call", { args: { title: "t", questions: [] } }],
      ["fetch_tool_call", { args: { url: "https://example.com" } }],
      ["switch_mode_tool_call", { args: { target_mode_id: "agent" } }],
      ["generate_image_tool_call", { args: { description: "img" } }],
      ["web_fetch_tool_call", { args: { url: "https://example.com" } }],
      ["await_tool_call", { args: { task_id: "t1" } }],
      ["get_mcp_tools_tool_call", {
        args: { tool_name: "edit" },
        result: { success: { content: "{}", output_file_path: "/tmp/agent-tools/a.txt" } },
      }],
      ["pi_read_tool_call", { args: { path: "/tmp/a" } }],
      ["pi_bash_tool_call", { args: { command: "echo", timeout: 1.5 } }],
      ["pi_edit_tool_call", {
        args: { path: "/tmp/a", edits: [{ old_text: "a", new_text: "b" }] },
      }],
      ["pi_write_tool_call", { args: { path: "/tmp/a", content: "x" } }],
      ["pi_grep_tool_call", { args: { pattern: "x", ignore_case: true } }],
      ["pi_find_tool_call", { args: { pattern: "*.ts", path: "/tmp" } }],
      ["pi_ls_tool_call", { args: { path: "/tmp" } }],
    ]
    for (const [variant, payload] of variants) {
      const encoded = encodeMessage("ToolCall", { tool_call_id: `id_${variant}`, [variant]: payload })
      const decoded = decodeMessage<Record<string, unknown>>("ToolCall", encoded)
      const display = parseDisplayToolCall(`id_${variant}`, decoded)
      expect(display?.variant, variant).toBe(variant)
    }
  })

  it("round-trips GetMcpToolsToolCall result content and output_file_path", () => {
    const encoded = encodeMessage("ToolCall", {
      tool_call_id: "mcp-tools-1",
      get_mcp_tools_tool_call: {
        args: { server: "opencode" },
        result: {
          success: {
            content: '{"mode":"catalog"}',
            output_file_path: "/tmp/agent-tools/spill.txt",
          },
        },
      },
    })
    const decoded = decodeMessage<any>("ToolCall", encoded)
    expect(decoded.get_mcp_tools_tool_call.args.server).toBe("opencode")
    expect(decoded.get_mcp_tools_tool_call.result.success).toEqual({
      content: '{"mode":"catalog"}',
      output_file_path: "/tmp/agent-tools/spill.txt",
    })
    const display = parseDisplayToolCall("mcp-tools-1", decoded)
    expect(display?.preferredToolName).toBe("get_mcp_tools")
    expect(resolveBridgedOpenCodeToolCall(display!, ["write", "bash"])).toBeUndefined()
  })


})
