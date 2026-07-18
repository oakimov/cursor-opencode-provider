import protobuf from "protobufjs"

// ── Helper: create a root and add a Type with fields ──

type FieldDef = { id: number; name: string; type: string; repeated?: boolean }
type OneofDef = { name: string; fields: string[] }

function addType(
  root: protobuf.Root,
  name: string,
  fields: FieldDef[],
  oneofs?: OneofDef[],
): protobuf.Type {
  const t = new protobuf.Type(name)
  for (const f of fields) {
    t.add(new protobuf.Field(f.name, f.id, f.type, f.repeated ? "repeated" : undefined))
  }
  for (const o of oneofs ?? []) {
    t.add(new protobuf.OneOf(o.name, o.fields))
  }
  root.add(t)
  return t
}

// ── Utility messages ──

export function createMessageTypes(): protobuf.Root {
  const root = new protobuf.Root()

  addType(root, "TextDeltaUpdate", [
    { id: 1, name: "text", type: "string" },
  ])

  addType(root, "ThinkingDeltaUpdate", [
    { id: 1, name: "text", type: "string" },
  ])

  addType(root, "TurnEnded", [
    { id: 1, name: "input_tokens", type: "uint32" },
    { id: 2, name: "output_tokens", type: "uint32" },
    { id: 3, name: "cache_read", type: "uint32" },
    { id: 4, name: "cache_write", type: "uint32" },
    { id: 5, name: "reasoning_tokens", type: "uint32" },
  ])

  addType(root, "Heartbeat", [])

  // Display ToolCall (interaction_update.tool_call_*) — agent.v1 oneof, not
  // {tool_name,args} strings. Args-only wrappers are enough to bridge into
  // OpenCode; result payloads are ignored on decode.
  root.add(new protobuf.Enum("TodoStatus", {
    TODO_STATUS_UNSPECIFIED: 0,
    TODO_STATUS_PENDING: 1,
    TODO_STATUS_IN_PROGRESS: 2,
    TODO_STATUS_COMPLETED: 3,
    TODO_STATUS_CANCELLED: 4,
  }))
  addType(root, "TodoItem", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "content", type: "string" },
    { id: 3, name: "status", type: "TodoStatus" },
    { id: 4, name: "created_at", type: "int64" },
    { id: 5, name: "updated_at", type: "int64" },
    { id: 6, name: "dependencies", type: "string", repeated: true },
  ])
  addType(root, "UpdateTodosArgs", [
    { id: 1, name: "todos", type: "TodoItem", repeated: true },
    { id: 2, name: "merge", type: "bool" },
  ])
  addType(root, "UpdateTodosSuccess", [
    { id: 1, name: "todos", type: "TodoItem", repeated: true },
    { id: 2, name: "total_count", type: "int32" },
    { id: 3, name: "was_merge", type: "bool" },
  ])
  addType(root, "UpdateTodosError", [{ id: 1, name: "error", type: "string" }])
  addType(
    root,
    "UpdateTodosResult",
    [
      { id: 1, name: "success", type: "UpdateTodosSuccess" },
      { id: 2, name: "error", type: "UpdateTodosError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )
  addType(root, "UpdateTodosToolCall", [
    { id: 1, name: "args", type: "UpdateTodosArgs" },
    { id: 2, name: "result", type: "UpdateTodosResult" },
  ])
  addType(root, "ReadToolArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "offset", type: "int32" },
    { id: 3, name: "limit", type: "int32" },
  ])
  addType(root, "ReadToolCall", [{ id: 1, name: "args", type: "ReadToolArgs" }])
  addType(root, "ShellToolCall", [{ id: 1, name: "args", type: "ShellArgs" }])
  addType(root, "DeleteToolCall", [{ id: 1, name: "args", type: "DeleteArgs" }])
  addType(root, "GlobToolCall", [{ id: 1, name: "args", type: "GlobArgs" }])
  addType(root, "GrepToolCall", [{ id: 1, name: "args", type: "GrepArgs" }])
  addType(root, "EditToolArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 6, name: "stream_content", type: "string" },
  ])
  addType(root, "EditToolCall", [{ id: 1, name: "args", type: "EditToolArgs" }])
  addType(root, "LsToolCall", [{ id: 1, name: "args", type: "LsArgs" }])
  addType(root, "McpToolCall", [{ id: 1, name: "args", type: "McpArgs" }])
  addType(root, "CreatePlanArgs", [
    { id: 1, name: "plan", type: "string" },
    { id: 2, name: "todos", type: "TodoItem", repeated: true },
    { id: 3, name: "overview", type: "string" },
    { id: 4, name: "name", type: "string" },
    { id: 5, name: "is_project", type: "bool" },
  ])
  addType(root, "CreatePlanToolCall", [{ id: 1, name: "args", type: "CreatePlanArgs" }])
  addType(root, "WebSearchToolArgs", [
    { id: 1, name: "search_term", type: "string" },
    { id: 2, name: "tool_call_id", type: "string" },
  ])
  addType(root, "WebSearchToolCall", [{ id: 1, name: "args", type: "WebSearchToolArgs" }])
  addType(root, "SubagentTypeUnspecified", [])
  addType(root, "SubagentTypeComputerUse", [])
  addType(root, "SubagentTypeCustom", [{ id: 1, name: "name", type: "string" }])
  addType(root, "SubagentTypeExplore", [])
  addType(root, "SubagentTypeMediaReview", [])
  addType(root, "SubagentTypeBash", [])
  addType(root, "SubagentTypeBrowserUse", [])
  addType(root, "SubagentTypeShell", [])
  addType(root, "SubagentTypeVmSetupHelper", [])
  addType(root, "SubagentTypeDebug", [])
  addType(root, "SubagentTypeCursorGuide", [])
  addType(root, "SubagentTypeWatchVideo", [])
  addType(
    root,
    "SubagentType",
    [
      { id: 1, name: "unspecified", type: "SubagentTypeUnspecified" },
      { id: 2, name: "computer_use", type: "SubagentTypeComputerUse" },
      { id: 3, name: "custom", type: "SubagentTypeCustom" },
      { id: 4, name: "explore", type: "SubagentTypeExplore" },
      { id: 5, name: "media_review", type: "SubagentTypeMediaReview" },
      { id: 6, name: "bash", type: "SubagentTypeBash" },
      { id: 7, name: "browser_use", type: "SubagentTypeBrowserUse" },
      { id: 8, name: "shell", type: "SubagentTypeShell" },
      { id: 9, name: "vm_setup_helper", type: "SubagentTypeVmSetupHelper" },
      { id: 10, name: "debug", type: "SubagentTypeDebug" },
      { id: 11, name: "cursor_guide", type: "SubagentTypeCursorGuide" },
      { id: 12, name: "watch_video", type: "SubagentTypeWatchVideo" },
    ],
    [{
      name: "type",
      fields: [
        "unspecified", "computer_use", "custom", "explore", "media_review", "bash",
        "browser_use", "shell", "vm_setup_helper", "debug", "cursor_guide", "watch_video",
      ],
    }],
  )
  addType(root, "TaskToolArgs", [
    { id: 1, name: "description", type: "string" },
    { id: 2, name: "prompt", type: "string" },
    { id: 3, name: "subagent_type", type: "SubagentType" },
    { id: 4, name: "model", type: "string" },
    { id: 5, name: "resume", type: "string" },
    { id: 6, name: "agent_id", type: "string" },
  ])
  addType(root, "TaskToolCall", [{ id: 1, name: "args", type: "TaskToolArgs" }])

  // Native subagent execution is separate from the display-only TaskToolCall.
  // Cursor asks the local client to run the task through ExecServerMessage #28
  // and waits for the correlated SubagentResult at ExecClientMessage #28.
  addType(root, "SubagentArgs", [
    { id: 1, name: "tool_call_id", type: "string" },
    { id: 2, name: "subagent_type", type: "string" },
    { id: 3, name: "model_id", type: "string" },
    { id: 4, name: "prompt", type: "string" },
    { id: 5, name: "readonly", type: "bool" },
    { id: 6, name: "resume_agent_id", type: "string" },
    { id: 7, name: "run_in_background", type: "bool" },
  ])
  addType(root, "SubagentSuccess", [
    { id: 1, name: "agent_id", type: "string" },
    { id: 2, name: "final_message", type: "string" },
    { id: 3, name: "tool_call_count", type: "int32" },
    { id: 4, name: "background_reason", type: "int32" },
    { id: 5, name: "transcript_path", type: "string" },
  ])
  addType(root, "SubagentError", [
    { id: 1, name: "agent_id", type: "string" },
    { id: 2, name: "error", type: "string" },
  ])
  addType(
    root,
    "SubagentResult",
    [
      { id: 1, name: "success", type: "SubagentSuccess" },
      { id: 2, name: "error", type: "SubagentError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )
  addType(root, "AskQuestionOption", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "label", type: "string" },
  ])
  addType(root, "AskQuestionItem", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "prompt", type: "string" },
    { id: 3, name: "options", type: "AskQuestionOption", repeated: true },
    { id: 4, name: "allow_multiple", type: "bool" },
  ])
  addType(root, "AskQuestionArgs", [
    { id: 1, name: "title", type: "string" },
    { id: 2, name: "questions", type: "AskQuestionItem", repeated: true },
  ])
  addType(root, "AskQuestionToolCall", [{ id: 1, name: "args", type: "AskQuestionArgs" }])
  addType(root, "FetchToolArgs", [
    { id: 1, name: "url", type: "string" },
    { id: 2, name: "tool_call_id", type: "string" },
  ])
  addType(root, "FetchToolCall", [{ id: 1, name: "args", type: "FetchToolArgs" }])
  addType(root, "WebFetchToolCall", [{ id: 1, name: "args", type: "FetchToolArgs" }])
  addType(root, "SwitchModeToolArgs", [
    { id: 1, name: "target_mode_id", type: "string" },
    { id: 2, name: "explanation", type: "string" },
    { id: 3, name: "tool_call_id", type: "string" },
  ])
  addType(root, "SwitchModeToolCall", [{ id: 1, name: "args", type: "SwitchModeToolArgs" }])
  addType(root, "PiReadToolArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "offset", type: "int32" },
    { id: 3, name: "limit", type: "int32" },
  ])
  addType(root, "PiBashToolArgs", [
    { id: 1, name: "command", type: "string" },
    { id: 2, name: "timeout", type: "double" },
  ])
  addType(root, "PiEditReplacement", [
    { id: 1, name: "old_text", type: "string" },
    { id: 2, name: "new_text", type: "string" },
  ])
  addType(root, "PiEditToolArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "edits", type: "PiEditReplacement", repeated: true },
  ])
  addType(root, "PiWriteToolArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "content", type: "string" },
  ])
  addType(root, "PiGrepToolArgs", [
    { id: 1, name: "pattern", type: "string" },
    { id: 2, name: "path", type: "string" },
    { id: 3, name: "glob", type: "string" },
    { id: 4, name: "ignore_case", type: "bool" },
    { id: 5, name: "literal", type: "bool" },
    { id: 6, name: "context", type: "int32" },
    { id: 7, name: "limit", type: "int32" },
  ])
  addType(root, "PiFindToolArgs", [
    { id: 1, name: "pattern", type: "string" },
    { id: 2, name: "path", type: "string" },
    { id: 3, name: "limit", type: "int32" },
  ])
  addType(root, "PiLsToolArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "limit", type: "int32" },
  ])
  addType(root, "PiWriteToolCall", [{ id: 1, name: "args", type: "PiWriteToolArgs" }])
  addType(root, "PiReadToolCall", [{ id: 1, name: "args", type: "PiReadToolArgs" }])
  addType(root, "PiBashToolCall", [{ id: 1, name: "args", type: "PiBashToolArgs" }])
  addType(root, "PiEditToolCall", [{ id: 1, name: "args", type: "PiEditToolArgs" }])
  addType(root, "PiGrepToolCall", [{ id: 1, name: "args", type: "PiGrepToolArgs" }])
  addType(root, "PiFindToolCall", [{ id: 1, name: "args", type: "PiFindToolArgs" }])
  addType(root, "PiLsToolCall", [{ id: 1, name: "args", type: "PiLsToolArgs" }])
  // Display-only native tools Cursor may complete without an ExecServerMessage.
  addType(root, "ReadTodosArgs", [
    { id: 1, name: "status_filter", type: "TodoStatus", repeated: true },
    { id: 2, name: "id_filter", type: "string", repeated: true },
  ])
  addType(root, "ReadTodosToolCall", [{ id: 1, name: "args", type: "ReadTodosArgs" }])
  addType(root, "AwaitArgs", [
    { id: 1, name: "task_id", type: "string" },
    { id: 2, name: "block_until_ms", type: "uint32" },
    { id: 3, name: "regex", type: "string" },
  ])
  addType(root, "AwaitToolCall", [{ id: 1, name: "args", type: "AwaitArgs" }])
  addType(root, "GetMcpToolsArgs", [
    { id: 1, name: "server", type: "string" },
    { id: 2, name: "tool_name", type: "string" },
    { id: 3, name: "pattern", type: "string" },
    { id: 4, name: "tool_call_id", type: "string" },
  ])
  addType(root, "GetMcpToolsToolCall", [{ id: 1, name: "args", type: "GetMcpToolsArgs" }])

  addType(root, "GenerateImageToolArgs", [
    { id: 1, name: "description", type: "string" },
    { id: 2, name: "file_path", type: "string" },
    { id: 5, name: "reference_image_paths", type: "string", repeated: true },
  ])
  addType(root, "GenerateImageToolCall", [{ id: 1, name: "args", type: "GenerateImageToolArgs" }])

  addType(
    root,
    "ToolCall",
    [
      { id: 57, name: "tool_call_id", type: "string" },
      { id: 1, name: "shell_tool_call", type: "ShellToolCall" },
      { id: 3, name: "delete_tool_call", type: "DeleteToolCall" },
      { id: 4, name: "glob_tool_call", type: "GlobToolCall" },
      { id: 5, name: "grep_tool_call", type: "GrepToolCall" },
      { id: 8, name: "read_tool_call", type: "ReadToolCall" },
      { id: 9, name: "update_todos_tool_call", type: "UpdateTodosToolCall" },
      { id: 10, name: "read_todos_tool_call", type: "ReadTodosToolCall" },
      { id: 12, name: "edit_tool_call", type: "EditToolCall" },
      { id: 13, name: "ls_tool_call", type: "LsToolCall" },
      { id: 15, name: "mcp_tool_call", type: "McpToolCall" },
      { id: 17, name: "create_plan_tool_call", type: "CreatePlanToolCall" },
      { id: 18, name: "web_search_tool_call", type: "WebSearchToolCall" },
      { id: 19, name: "task_tool_call", type: "TaskToolCall" },
      { id: 23, name: "ask_question_tool_call", type: "AskQuestionToolCall" },
      { id: 24, name: "fetch_tool_call", type: "FetchToolCall" },
      { id: 25, name: "switch_mode_tool_call", type: "SwitchModeToolCall" },
      { id: 28, name: "generate_image_tool_call", type: "GenerateImageToolCall" },
      { id: 37, name: "web_fetch_tool_call", type: "WebFetchToolCall" },
      { id: 42, name: "await_tool_call", type: "AwaitToolCall" },
      { id: 44, name: "get_mcp_tools_tool_call", type: "GetMcpToolsToolCall" },
      { id: 61, name: "pi_read_tool_call", type: "PiReadToolCall" },
      { id: 62, name: "pi_bash_tool_call", type: "PiBashToolCall" },
      { id: 63, name: "pi_edit_tool_call", type: "PiEditToolCall" },
      { id: 64, name: "pi_write_tool_call", type: "PiWriteToolCall" },
      { id: 65, name: "pi_grep_tool_call", type: "PiGrepToolCall" },
      { id: 66, name: "pi_find_tool_call", type: "PiFindToolCall" },
      { id: 67, name: "pi_ls_tool_call", type: "PiLsToolCall" },
    ],
    [{
      name: "tool",
      fields: [
        "shell_tool_call", "delete_tool_call", "glob_tool_call", "grep_tool_call",
        "read_tool_call", "update_todos_tool_call", "read_todos_tool_call",
        "edit_tool_call", "ls_tool_call",
        "mcp_tool_call", "create_plan_tool_call", "web_search_tool_call", "task_tool_call",
        "ask_question_tool_call", "fetch_tool_call", "switch_mode_tool_call",
        "generate_image_tool_call", "web_fetch_tool_call", "await_tool_call", "get_mcp_tools_tool_call",
        "pi_read_tool_call", "pi_bash_tool_call", "pi_edit_tool_call",
        "pi_write_tool_call", "pi_grep_tool_call", "pi_find_tool_call", "pi_ls_tool_call",
      ],
    }],
  )

  addType(root, "ToolCallStarted", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_call", type: "ToolCall" },
    { id: 3, name: "model_call_id", type: "string" },
  ])

  // agent.v1 ToolCallCompletedUpdate has no string result field — result lives
  // inside the typed ToolCall variant.
  addType(root, "ToolCallCompleted", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_call", type: "ToolCall" },
    { id: 3, name: "model_call_id", type: "string" },
  ])

  addType(root, "PartialToolCall", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_call", type: "ToolCall" },
    { id: 3, name: "args_text_delta", type: "string" },
    { id: 4, name: "model_call_id", type: "string" },
  ])

  // agent.v1 StepStartedUpdate / StepCompletedUpdate: step_id is uint64 (T:4),
  // not string — wrong type made every step_completed frame throw
  // "index out of range" in decodeMessage.
  addType(root, "StepStarted", [
    { id: 1, name: "step_id", type: "uint64" },
  ])

  addType(root, "StepCompleted", [
    { id: 1, name: "step_id", type: "uint64" },
    { id: 2, name: "step_duration_ms", type: "int64" },
  ])

  // InteractionUpdate — the core streaming update message
  addType(
    root,
    "InteractionUpdate",
    [
      { id: 1, name: "text_delta", type: "TextDeltaUpdate" },
      { id: 2, name: "tool_call_started", type: "ToolCallStarted" },
      { id: 3, name: "tool_call_completed", type: "ToolCallCompleted" },
      { id: 4, name: "thinking_delta", type: "ThinkingDeltaUpdate" },
      { id: 7, name: "partial_tool_call", type: "PartialToolCall" },
      { id: 13, name: "heartbeat", type: "Heartbeat" },
      { id: 14, name: "turn_ended", type: "TurnEnded" },
      { id: 16, name: "step_started", type: "StepStarted" },
      { id: 17, name: "step_completed", type: "StepCompleted" },
    ],
    [{ name: "update", fields: ["text_delta", "tool_call_started", "tool_call_completed", "thinking_delta", "partial_tool_call", "heartbeat", "turn_ended", "step_started", "step_completed"] }],
  )

  // ── Exec channel ──

  // Field numbers match agent.v1. Extra fields we don't use are still declared
  // so protobufjs doesn't drop them on decode.
  addType(root, "ReadArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "tool_call_id", type: "string" },
    { id: 4, name: "offset", type: "int32" },
    { id: 5, name: "limit", type: "uint32" },
  ])

  // agent.v1 ReadResult is a oneof — flat {content,error} was rejected by the
  // server (endless heartbeats after read_result).
  addType(
    root,
    "ReadSuccess",
    [
      { id: 1, name: "path", type: "string" },
      { id: 2, name: "content", type: "string" },
      { id: 3, name: "total_lines", type: "int32" },
      { id: 4, name: "file_size", type: "int64" },
      { id: 5, name: "data", type: "bytes" },
      { id: 6, name: "truncated", type: "bool" },
      { id: 7, name: "output_blob_id", type: "bytes" },
      { id: 8, name: "range_applied", type: "bool" },
    ],
    [{ name: "output", fields: ["content", "data"] }],
  )
  addType(root, "ReadError", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "error", type: "string" },
  ])
  addType(
    root,
    "ReadResult",
    [
      { id: 1, name: "success", type: "ReadSuccess" },
      { id: 2, name: "error", type: "ReadError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )

  addType(root, "GrepArgs", [
    { id: 1, name: "pattern", type: "string" },
    { id: 2, name: "path", type: "string" },
    { id: 3, name: "glob", type: "string" },
    { id: 4, name: "output_mode", type: "string" },
    { id: 8, name: "case_insensitive", type: "bool" },
    { id: 10, name: "head_limit", type: "int32" },
    { id: 14, name: "tool_call_id", type: "string" },
    { id: 16, name: "offset", type: "int32" },
  ])

  addType(root, "GrepError", [{ id: 1, name: "error", type: "string" }])
  addType(root, "GrepFilesResult", [
    { id: 1, name: "files", type: "string", repeated: true },
    { id: 2, name: "total_files", type: "int32" },
    { id: 3, name: "client_truncated", type: "bool" },
  ])
  addType(root, "GrepContentMatch", [
    { id: 1, name: "line_number", type: "int32" },
    { id: 2, name: "content", type: "string" },
  ])
  addType(root, "GrepFileMatch", [
    { id: 1, name: "file", type: "string" },
    { id: 2, name: "matches", type: "GrepContentMatch", repeated: true },
  ])
  addType(root, "GrepContentResult", [
    { id: 1, name: "matches", type: "GrepFileMatch", repeated: true },
    { id: 2, name: "total_lines", type: "int32" },
    { id: 3, name: "total_matched_lines", type: "int32" },
  ])
  addType(
    root,
    "GrepUnionResult",
    [
      { id: 2, name: "files", type: "GrepFilesResult" },
      { id: 3, name: "content", type: "GrepContentResult" },
    ],
    [{ name: "result", fields: ["files", "content"] }],
  )
  {
    const t = new protobuf.Type("GrepSuccess")
    t.add(new protobuf.Field("pattern", 1, "string"))
    t.add(new protobuf.Field("path", 2, "string"))
    t.add(new protobuf.Field("output_mode", 3, "string"))
    t.add(new protobuf.MapField("workspace_results", 4, "string", "GrepUnionResult"))
    root.add(t)
  }
  addType(
    root,
    "GrepResult",
    [
      { id: 1, name: "success", type: "GrepSuccess" },
      { id: 2, name: "error", type: "GrepError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )

  addType(root, "WriteArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "file_text", type: "string" },
    { id: 3, name: "tool_call_id", type: "string" },
  ])

  addType(root, "WriteSuccess", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "lines_created", type: "int32" },
    { id: 3, name: "file_size", type: "int32" },
  ])
  addType(root, "WriteError", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "error", type: "string" },
  ])
  addType(
    root,
    "WriteResult",
    [
      { id: 1, name: "success", type: "WriteSuccess" },
      { id: 5, name: "error", type: "WriteError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )

  // agent.v1 Pi exec results. Cursor places Pi requests at ExecServerMessage
  // fields #45..#51 and their corresponding ExecClientMessage results at
  // #46..#52 (the result fields are deliberately offset by one).
  //
  // The success payloads contain additional optional truncation/diff metadata;
  // OpenCode returns text, so the minimal output/error shapes are sufficient.
  addType(root, "PiWriteArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "content", type: "string" },
  ])
  addType(root, "PiWriteSuccess", [
    { id: 1, name: "output", type: "string" },
  ])
  addType(root, "PiWriteError", [
    { id: 1, name: "error", type: "string" },
  ])
  addType(root, "PiWriteRejected", [
    { id: 1, name: "reason", type: "string" },
  ])
  addType(
    root,
    "PiWriteResult",
    [
      { id: 1, name: "success", type: "PiWriteSuccess" },
      { id: 2, name: "error", type: "PiWriteError" },
      { id: 3, name: "rejected", type: "PiWriteRejected" },
    ],
    [{ name: "result", fields: ["success", "error", "rejected"] }],
  )
  addType(root, "PiOutputSuccess", [{ id: 1, name: "output", type: "string" }])
  addType(root, "PiExecError", [{ id: 1, name: "error", type: "string" }])
  addType(root, "PiExecRejected", [{ id: 1, name: "reason", type: "string" }])
  for (const resultType of [
    "PiReadExecResult",
    "PiBashExecResult",
    "PiGrepExecResult",
    "PiFindExecResult",
    "PiLsExecResult",
  ]) {
    addType(
      root,
      resultType,
      [
        { id: 1, name: "success", type: "PiOutputSuccess" },
        { id: 2, name: "error", type: "PiExecError" },
      ],
      [{ name: "result", fields: ["success", "error"] }],
    )
  }
  addType(
    root,
    "PiEditExecResult",
    [
      { id: 1, name: "success", type: "PiOutputSuccess" },
      { id: 2, name: "error", type: "PiExecError" },
      { id: 3, name: "rejected", type: "PiExecRejected" },
    ],
    [{ name: "result", fields: ["success", "error", "rejected"] }],
  )

  addType(root, "DeleteArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "tool_call_id", type: "string" },
  ])

  addType(root, "DeleteSuccess", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "deleted_file", type: "string" },
  ])
  addType(root, "DeleteError", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "error", type: "string" },
  ])
  addType(
    root,
    "DeleteResult",
    [
      { id: 1, name: "success", type: "DeleteSuccess" },
      { id: 7, name: "error", type: "DeleteError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )

  addType(root, "LsArgs", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "ignore", type: "string", repeated: true },
    { id: 3, name: "tool_call_id", type: "string" },
  ])

  addType(root, "LsDirectoryTreeFile", [{ id: 1, name: "name", type: "string" }])
  addType(root, "LsDirectoryTreeNode", [
    { id: 1, name: "abs_path", type: "string" },
    { id: 2, name: "children_dirs", type: "LsDirectoryTreeNode", repeated: true },
    { id: 3, name: "children_files", type: "LsDirectoryTreeFile", repeated: true },
    { id: 6, name: "num_files", type: "int32" },
  ])
  addType(root, "LsSuccess", [
    { id: 1, name: "directory_tree_root", type: "LsDirectoryTreeNode" },
  ])
  addType(root, "LsError", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "error", type: "string" },
  ])
  addType(
    root,
    "LsResult",
    [
      { id: 1, name: "success", type: "LsSuccess" },
      { id: 2, name: "error", type: "LsError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )

  addType(root, "ShellArgs", [
    { id: 1, name: "command", type: "string" },
    { id: 2, name: "working_directory", type: "string" },
    { id: 3, name: "timeout", type: "uint32" },
    { id: 4, name: "tool_call_id", type: "string" },
    // Canonical agent.v1 fields used by the native CLI to distinguish a
    // foreground cancellation deadline from a soft background handoff.
    { id: 13, name: "timeout_behavior", type: "uint32" },
    { id: 14, name: "hard_timeout", type: "uint32" },
  ])

  addType(root, "ShellStreamStart", []) // optional SandboxPolicy only; empty is valid
  addType(root, "ShellStreamStdout", [{ id: 1, name: "data", type: "string" }])
  addType(root, "ShellStreamStderr", [{ id: 1, name: "data", type: "string" }])
  // agent.v1: code is uint32; protobufjs must emit code=0 (defaults are load-bearing).
  addType(root, "ShellStreamExit", [
    { id: 1, name: "code", type: "uint32" },
    { id: 2, name: "cwd", type: "string" },
    { id: 4, name: "aborted", type: "bool" },
    { id: 5, name: "abort_reason", type: "uint32" },
    { id: 6, name: "local_execution_time_ms", type: "uint32" },
  ])
  addType(root, "ShellStreamBackgrounded", [
    { id: 1, name: "shell_id", type: "uint32" },
    { id: 2, name: "command", type: "string" },
    { id: 3, name: "working_directory", type: "string" },
    { id: 4, name: "pid", type: "uint32" },
    { id: 5, name: "ms_to_wait", type: "uint32" },
    { id: 6, name: "reason", type: "uint32" },
  ])
  // ShellRejected / ShellPermissionDenied (shared with ShellResult) — reason/error at #3.
  addType(root, "ShellRejected", [
    { id: 1, name: "command", type: "string" },
    { id: 2, name: "working_directory", type: "string" },
    { id: 3, name: "reason", type: "string" },
  ])
  addType(root, "ShellPermissionDenied", [
    { id: 1, name: "command", type: "string" },
    { id: 2, name: "working_directory", type: "string" },
    { id: 3, name: "error", type: "string" },
  ])

  // Cursor's non-blocking shell path is a separate exec variant from the
  // foreground ShellStream above. The host only needs the fields used at the
  // OpenCode boundary; protobufjs safely skips the richer classifier/approval
  // messages that are private to Cursor's native client.
  addType(root, "BackgroundShellSpawnArgs", [
    { id: 1, name: "command", type: "string" },
    { id: 2, name: "working_directory", type: "string" },
    { id: 3, name: "tool_call_id", type: "string" },
    { id: 6, name: "enable_write_shell_stdin_tool", type: "bool" },
    { id: 7, name: "description", type: "string" },
    { id: 12, name: "skip_approval", type: "bool" },
    { id: 13, name: "conversation_id", type: "string" },
  ])
  addType(root, "BackgroundShellSpawnSuccess", [
    { id: 1, name: "shell_id", type: "uint32" },
    { id: 2, name: "command", type: "string" },
    { id: 3, name: "working_directory", type: "string" },
    { id: 4, name: "pid", type: "uint32" },
  ])
  addType(root, "BackgroundShellSpawnError", [
    { id: 1, name: "command", type: "string" },
    { id: 2, name: "working_directory", type: "string" },
    { id: 3, name: "error", type: "string" },
  ])
  addType(
    root,
    "BackgroundShellSpawnResult",
    [
      { id: 1, name: "success", type: "BackgroundShellSpawnSuccess" },
      { id: 2, name: "error", type: "BackgroundShellSpawnError" },
      { id: 3, name: "rejected", type: "ShellRejected" },
      { id: 4, name: "permission_denied", type: "ShellPermissionDenied" },
    ],
    [{ name: "result", fields: ["success", "error", "rejected", "permission_denied"] }],
  )

  addType(
    root,
    "ShellStream",
    [
      { id: 1, name: "stdout", type: "ShellStreamStdout" },
      { id: 2, name: "stderr", type: "ShellStreamStderr" },
      { id: 3, name: "exit", type: "ShellStreamExit" },
      { id: 4, name: "start", type: "ShellStreamStart" },
      { id: 5, name: "rejected", type: "ShellRejected" },
      { id: 6, name: "permission_denied", type: "ShellPermissionDenied" },
      { id: 7, name: "backgrounded", type: "ShellStreamBackgrounded" },
    ],
    [{ name: "event", fields: ["stdout", "stderr", "exit", "start", "rejected", "permission_denied", "backgrounded"] }],
  )

  addType(root, "GlobArgs", [
    { id: 1, name: "target_directory", type: "string" },
    { id: 2, name: "glob_pattern", type: "string" },
  ])

  addType(root, "GlobResult", [
    { id: 1, name: "files", type: "string", repeated: true },
    { id: 2, name: "error", type: "string" },
  ])

  // `args` is a map<string, google.protobuf.Value> on the wire (repeated map
  // entries at field #2). We capture each entry as raw bytes and decode them in
  // tools.ts via struct.decodeStructEntriesToJson.
  addType(root, "McpArgs", [
    { id: 1, name: "name", type: "string" },
    { id: 2, name: "args", type: "bytes", repeated: true },
    { id: 3, name: "tool_call_id", type: "string" },
    { id: 4, name: "provider_identifier", type: "string" },
    { id: 5, name: "tool_name", type: "string" },
  ])

  addType(root, "McpTextContent", [{ id: 1, name: "text", type: "string" }])
  addType(
    root,
    "McpToolResultContentItem",
    [{ id: 1, name: "text", type: "McpTextContent" }],
    [{ name: "content", fields: ["text"] }],
  )
  addType(root, "McpSuccess", [
    { id: 1, name: "content", type: "McpToolResultContentItem", repeated: true },
    { id: 2, name: "is_error", type: "bool" },
  ])
  addType(root, "McpError", [{ id: 1, name: "error", type: "string" }])
  addType(
    root,
    "McpResult",
    [
      { id: 1, name: "success", type: "McpSuccess" },
      { id: 2, name: "error", type: "McpError" },
    ],
    [{ name: "result", fields: ["success", "error"] }],
  )

  // McpToolDefinition — agent.v1 shape for RequestContext.tools (#7) and
  // AgentRunRequest.mcp_tools (#4). Defined early so RequestContext* can
  // reference it.
  addType(root, "McpToolDefinition", [
    { id: 1, name: "name", type: "string" },
    { id: 2, name: "description", type: "string" },
    { id: 3, name: "input_schema", type: "bytes" },
    { id: 4, name: "provider_identifier", type: "string" },
    { id: 5, name: "tool_name", type: "string" },
  ])

  // ── request_context (#10): server-initiated setup probe ──
  // At the start of an agent turn the server sends ExecServerMessage
  // {request_context_args} to ask the client for workspace/env/tool context.
  // The reply is ExecClientMessage {request_context_result{success{request_context}}}.
  // If we don't reply, the server blocks on heartbeats forever (the "times out,
  // no response" symptom). We populate a minimal-but-real RequestContext — env
  // (workspace/shell/os) plus the tool list echoed into #7 tools (same
  // McpToolDefinition shape as AgentRunRequest #4 mcp_tools) so the model keeps
  // the tools opencode advertised.
  addType(root, "RequestContextArgs", [
    { id: 2, name: "notes_session_id", type: "string" },
    { id: 3, name: "workspace_id", type: "string" },
    { id: 7, name: "use_cached", type: "bool" },
  ])

  addType(root, "RequestContextEnv", [
    { id: 1, name: "os_version", type: "string" },
    { id: 2, name: "workspace_paths", type: "string", repeated: true },
    { id: 3, name: "shell", type: "string" },
    { id: 5, name: "sandbox_enabled", type: "bool" },
    { id: 10, name: "time_zone", type: "string" },
    { id: 11, name: "project_folder", type: "string" },
    { id: 14, name: "sandbox_supported", type: "bool" },
    { id: 20, name: "is_working_dir_home_dir", type: "bool" },
    { id: 21, name: "process_working_directory", type: "string" },
  ])

  addType(root, "CursorRule", [
    { id: 1, name: "full_path", type: "string" },
    { id: 2, name: "content", type: "string" },
  ])

  addType(root, "RepositoryIndexingInfo", [
    { id: 1, name: "relative_workspace_path", type: "string" },
    { id: 2, name: "remote_urls", type: "string", repeated: true },
    { id: 3, name: "remote_names", type: "string", repeated: true },
    { id: 4, name: "repo_name", type: "string" },
    { id: 5, name: "repo_owner", type: "string" },
    { id: 6, name: "is_tracked", type: "bool" },
    { id: 7, name: "is_local", type: "bool" },
    { id: 9, name: "workspace_uri", type: "string" },
  ])

  addType(root, "GitRepoInfo", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "status", type: "string" },
    { id: 3, name: "branch_name", type: "string" },
    { id: 4, name: "remote_url", type: "string" },
  ])

  addType(root, "AgentSkill", [
    { id: 1, name: "full_path", type: "string" },
    { id: 2, name: "content", type: "string" },
    { id: 3, name: "description", type: "string" },
  ])

  addType(root, "CustomSubagent", [
    { id: 1, name: "full_path", type: "string" },
    { id: 2, name: "name", type: "string" },
    { id: 3, name: "description", type: "string" },
    { id: 6, name: "prompt", type: "string" },
  ])

  // Nested MCP filesystem / meta-tool shapes (agent.v1). Must be defined
  // before RequestContextPayload / RequestContext reference them.
  addType(root, "McpFsToolDescriptor", [
    { id: 1, name: "tool_name", type: "string" },
    { id: 3, name: "description", type: "string" },
    { id: 4, name: "input_schema", type: "bytes" },
  ])

  addType(root, "McpDescriptor", [
    { id: 1, name: "server_name", type: "string" },
    { id: 2, name: "server_identifier", type: "string" },
    { id: 5, name: "tools", type: "McpFsToolDescriptor", repeated: true },
  ])

  addType(root, "McpFileSystemOptions", [
    { id: 1, name: "enabled", type: "bool" },
    { id: 2, name: "workspace_project_dir", type: "string" },
    { id: 3, name: "mcp_descriptors", type: "McpDescriptor", repeated: true },
  ])

  addType(root, "McpMetaToolOptions", [
    { id: 1, name: "enabled", type: "bool" },
    { id: 2, name: "mcp_descriptors", type: "McpDescriptor", repeated: true },
  ])

  addType(root, "PermissionsAutoRunInstructions", [
    { id: 1, name: "allow_instructions", type: "string", repeated: true },
    { id: 2, name: "block_instructions", type: "string", repeated: true },
  ])

  addType(root, "RequestContextPayload", [
    { id: 2, name: "rules", type: "CursorRule", repeated: true },
    { id: 4, name: "env", type: "RequestContextEnv" },
    { id: 6, name: "repository_info", type: "RepositoryIndexingInfo", repeated: true },
    { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
    { id: 11, name: "git_repos", type: "GitRepoInfo", repeated: true },
    { id: 13, name: "project_layouts", type: "LsDirectoryTreeNode", repeated: true },
    { id: 22, name: "custom_subagents", type: "CustomSubagent", repeated: true },
    { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
    { id: 25, name: "hooks_additional_context", type: "string" },
    { id: 29, name: "agent_skills", type: "AgentSkill", repeated: true },
    { id: 33, name: "git_repo_info_complete", type: "bool" },
    { id: 34, name: "mcp_meta_tool_options", type: "McpMetaToolOptions" },
    { id: 36, name: "mcp_info_complete", type: "bool" },
    { id: 39, name: "rules_info_complete", type: "bool" },
    { id: 40, name: "env_info_complete", type: "bool" },
    { id: 41, name: "repository_info_complete", type: "bool" },
    { id: 42, name: "custom_subagents_info_complete", type: "bool" },
    { id: 43, name: "agent_skills_info_complete", type: "bool" },
    { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
    { id: 45, name: "git_status_info_complete", type: "bool" },
    { id: 46, name: "user_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
    { id: 47, name: "project_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
  ])

  addType(root, "RequestContextSuccess", [
    { id: 1, name: "request_context", type: "RequestContextPayload" },
  ])

  addType(root, "RequestContextResult", [
    { id: 1, name: "success", type: "RequestContextSuccess" },
  ])

  // Cursor probes MCP server availability before emitting an MCP-backed tool
  // call. OpenCode owns those servers, so answer from the descriptors already
  // advertised in RequestContext rather than surfacing this as a user tool.
  addType(root, "McpStateExecArgs", [
    { id: 1, name: "server_identifiers", type: "string", repeated: true },
    { id: 2, name: "kick_only", type: "bool" },
  ])
  addType(root, "McpInstructions", [
    { id: 1, name: "server_name", type: "string" },
    { id: 2, name: "instructions", type: "string" },
    { id: 3, name: "server_identifier", type: "string" },
  ])
  addType(root, "McpStateServer", [
    { id: 1, name: "server_name", type: "string" },
    { id: 2, name: "server_identifier", type: "string" },
    { id: 3, name: "plugin", type: "string" },
    { id: 4, name: "marketplace", type: "string" },
    // Unlike McpDescriptor (#23/#34), exec #36 returns the full canonical
    // McpToolDefinition shape, including composite name and provider identity.
    { id: 5, name: "tools", type: "McpToolDefinition", repeated: true },
    { id: 6, name: "instructions", type: "McpInstructions", repeated: true },
    { id: 7, name: "status", type: "string" },
  ])
  addType(root, "McpStateSuccess", [
    { id: 1, name: "servers", type: "McpStateServer", repeated: true },
  ])
  addType(root, "McpStateError", [{ id: 1, name: "error", type: "string" }])
  addType(root, "McpStateRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(
    root,
    "McpStateExecResult",
    [
      { id: 1, name: "success", type: "McpStateSuccess" },
      { id: 2, name: "error", type: "McpStateError" },
      { id: 3, name: "rejected", type: "McpStateRejected" },
    ],
    [{ name: "result", fields: ["success", "error", "rejected"] }],
  )

  // ExecServerMessage — server asks us to execute a tool
  addType(
    root,
    "ExecServerMessage",
    [
      { id: 1, name: "id", type: "uint32" },
      { id: 15, name: "exec_id", type: "string" },
      { id: 19, name: "span", type: "string" },
      { id: 3, name: "write_args", type: "WriteArgs" },
      { id: 4, name: "delete_args", type: "DeleteArgs" },
      { id: 5, name: "grep_args", type: "GrepArgs" },
      { id: 7, name: "read_args", type: "ReadArgs" },
      { id: 8, name: "ls_args", type: "LsArgs" },
      { id: 10, name: "request_context_args", type: "RequestContextArgs" },
      { id: 11, name: "mcp_args", type: "McpArgs" },
      { id: 14, name: "shell_stream_args", type: "ShellArgs" },
      { id: 16, name: "background_shell_spawn_args", type: "BackgroundShellSpawnArgs" },
      { id: 28, name: "subagent_args", type: "SubagentArgs" },
      { id: 36, name: "mcp_state_exec_args", type: "McpStateExecArgs" },
      { id: 45, name: "pi_read_args", type: "PiReadToolArgs" },
      { id: 46, name: "pi_bash_args", type: "PiBashToolArgs" },
      { id: 47, name: "pi_edit_args", type: "PiEditToolArgs" },
      { id: 48, name: "pi_write_args", type: "PiWriteArgs" },
      { id: 49, name: "pi_grep_args", type: "PiGrepToolArgs" },
      { id: 50, name: "pi_find_args", type: "PiFindToolArgs" },
      { id: 51, name: "pi_ls_args", type: "PiLsToolArgs" },
    ],
    [{ name: "args", fields: [
      "write_args", "delete_args", "grep_args", "read_args", "ls_args",
      "request_context_args", "mcp_args", "shell_stream_args", "background_shell_spawn_args", "mcp_state_exec_args",
      "subagent_args",
      "pi_read_args", "pi_bash_args", "pi_edit_args", "pi_write_args",
      "pi_grep_args", "pi_find_args", "pi_ls_args",
    ] }],
  )

  // ExecClientMessage — client sends tool result back
  addType(
    root,
    "ExecClientMessage",
    [
      { id: 1, name: "id", type: "uint32" },
      { id: 15, name: "exec_id", type: "string" },
      { id: 39, name: "local_execution_time_ms", type: "uint64" },
      { id: 3, name: "write_result", type: "WriteResult" },
      { id: 4, name: "delete_result", type: "DeleteResult" },
      { id: 5, name: "grep_result", type: "GrepResult" },
      { id: 7, name: "read_result", type: "ReadResult" },
      { id: 8, name: "ls_result", type: "LsResult" },
      { id: 10, name: "request_context_result", type: "RequestContextResult" },
      { id: 11, name: "mcp_result", type: "McpResult" },
      { id: 14, name: "shell_stream", type: "ShellStream" },
      { id: 16, name: "background_shell_spawn_result", type: "BackgroundShellSpawnResult" },
      { id: 28, name: "subagent_result", type: "SubagentResult" },
      { id: 36, name: "mcp_state_exec_result", type: "McpStateExecResult" },
      { id: 46, name: "pi_read_result", type: "PiReadExecResult" },
      { id: 47, name: "pi_bash_result", type: "PiBashExecResult" },
      { id: 48, name: "pi_edit_result", type: "PiEditExecResult" },
      { id: 49, name: "pi_write_result", type: "PiWriteResult" },
      { id: 50, name: "pi_grep_result", type: "PiGrepExecResult" },
      { id: 51, name: "pi_find_result", type: "PiFindExecResult" },
      { id: 52, name: "pi_ls_result", type: "PiLsExecResult" },
    ],
    [{ name: "result", fields: [
      "write_result", "delete_result", "grep_result", "read_result", "ls_result",
      "request_context_result", "mcp_result", "shell_stream", "background_shell_spawn_result", "mcp_state_exec_result",
      "subagent_result",
      "pi_read_result", "pi_bash_result", "pi_edit_result", "pi_write_result",
      "pi_grep_result", "pi_find_result", "pi_ls_result",
    ] }],
  )

  addType(root, "ExecServerControlMessage", [
    { id: 1, name: "abort", type: "ExecServerAbort" },
  ])

  addType(root, "ExecServerAbort", [
    { id: 1, name: "id", type: "uint32" },
  ])

  // Client→server control (ACM #5). Distinct from ExecServerControlMessage (ASM #5).
  // After every exec result (especially multi-frame shell_stream), the real CLI
  // sends stream_close{id} — without it the cloud waits forever on shell execs.
  addType(root, "ExecClientStreamClose", [{ id: 1, name: "id", type: "uint32" }])
  addType(root, "ExecClientThrow", [
    { id: 1, name: "id", type: "uint32" },
    { id: 2, name: "error", type: "string" },
  ])
  addType(root, "ExecClientHeartbeat", [{ id: 1, name: "id", type: "uint32" }])
  addType(
    root,
    "ExecClientControlMessage",
    [
      { id: 1, name: "stream_close", type: "ExecClientStreamClose" },
      { id: 2, name: "throw", type: "ExecClientThrow" },
      { id: 3, name: "heartbeat", type: "ExecClientHeartbeat" },
    ],
    [{ name: "message", fields: ["stream_close", "throw", "heartbeat"] }],
  )

  // ── Run request types ──

  addType(root, "ParameterValue", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "value", type: "string" },
  ])

  addType(root, "RequestedModel", [
    { id: 1, name: "model_id", type: "string" },
    { id: 2, name: "max_mode", type: "bool" },
    { id: 3, name: "parameters", type: "ParameterValue", repeated: true },
  ])

  addType(root, "UserMessage", [
    { id: 1, name: "text", type: "string" },
    { id: 2, name: "message_id", type: "string" },
  ])

  // RequestContext — UserMessageAction #2. Live per-turn tools go here
  // (AgentRunRequest.mcp_tools #4 is prewarm-only / empty on real turns).
  addType(root, "RequestContext", [
    { id: 2, name: "rules", type: "CursorRule", repeated: true },
    { id: 4, name: "env", type: "RequestContextEnv" },
    { id: 6, name: "repository_info", type: "RepositoryIndexingInfo", repeated: true },
    { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
    { id: 11, name: "git_repos", type: "GitRepoInfo", repeated: true },
    { id: 13, name: "project_layouts", type: "LsDirectoryTreeNode", repeated: true },
    { id: 22, name: "custom_subagents", type: "CustomSubagent", repeated: true },
    { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
    { id: 25, name: "hooks_additional_context", type: "string" },
    { id: 29, name: "agent_skills", type: "AgentSkill", repeated: true },
    { id: 33, name: "git_repo_info_complete", type: "bool" },
    { id: 34, name: "mcp_meta_tool_options", type: "McpMetaToolOptions" },
    { id: 36, name: "mcp_info_complete", type: "bool" },
    { id: 39, name: "rules_info_complete", type: "bool" },
    { id: 40, name: "env_info_complete", type: "bool" },
    { id: 41, name: "repository_info_complete", type: "bool" },
    { id: 42, name: "custom_subagents_info_complete", type: "bool" },
    { id: 43, name: "agent_skills_info_complete", type: "bool" },
    { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
    { id: 45, name: "git_status_info_complete", type: "bool" },
    { id: 46, name: "user_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
    { id: 47, name: "project_permissions_auto_run", type: "PermissionsAutoRunInstructions" },
  ])

  addType(root, "UserMessageAction", [
    { id: 1, name: "user_message", type: "UserMessage" },
    { id: 2, name: "request_context", type: "RequestContext" },
  ])

  addType(root, "ResumeAction", [
    { id: 1, name: "conversation_id", type: "string" },
  ])

  addType(root, "CancelAction", [
    { id: 1, name: "conversation_id", type: "string" },
  ])

  addType(
    root,
    "ConversationAction",
    [
      { id: 1, name: "user_message_action", type: "UserMessageAction" },
      { id: 2, name: "resume_action", type: "ResumeAction" },
      { id: 3, name: "cancel_action", type: "CancelAction" },
    ],
    [{ name: "action", fields: ["user_message_action", "resume_action", "cancel_action"] }],
  )

  // Seed ConversationStateStructure for turn 1 (system prompt as JSON strings
  // in #1). After the first conversation_checkpoint_update we echo opaque
  // server bytes instead — CLI's live structure uses blob-id bytes in #1/#8.
  addType(root, "AssistantMessage", [
    { id: 1, name: "text", type: "string" },
  ])

  addType(
    root,
    "ConversationStep",
    [
      { id: 1, name: "assistant_message", type: "AssistantMessage" },
    ],
    [{ name: "message", fields: ["assistant_message"] }],
  )

  addType(root, "AgentConversationTurn", [
    { id: 1, name: "user_message", type: "UserMessage" },
    { id: 2, name: "steps", type: "ConversationStep", repeated: true },
  ])

  addType(
    root,
    "ConversationTurn",
    [
      { id: 1, name: "agent_conversation_turn", type: "AgentConversationTurn" },
    ],
    [{ name: "turn", fields: ["agent_conversation_turn"] }],
  )

  // Seed-only schema (JSON strings). Checkpoint bytes are never decoded here —
  // AgentRunRequest.conversation_state is typed as bytes and carries them opaque.
  addType(root, "ConversationStateStructure", [
    { id: 1, name: "root_prompt_messages_json", type: "string", repeated: true },
    { id: 8, name: "turns", type: "ConversationTurn", repeated: true },
  ])

  addType(root, "ModelDetails", [
    { id: 1, name: "model_id", type: "string" },
  ])

  addType(root, "McpTools", [
    { id: 1, name: "mcp_tools", type: "McpToolDefinition", repeated: true },
  ])

  addType(root, "AgentRunRequest", [
    { id: 1, name: "conversation_state", type: "bytes" },
    { id: 2, name: "action", type: "ConversationAction" },
    { id: 4, name: "mcp_tools", type: "McpTools" },
    { id: 5, name: "conversation_id", type: "string" },
    { id: 8, name: "custom_system_prompt", type: "string" },
    { id: 9, name: "requested_model", type: "RequestedModel" },
    { id: 10, name: "unknown_flag", type: "uint32" },
    { id: 12, name: "field_12", type: "uint32" },
    { id: 14, name: "selected_subagent_models", type: "RequestedModel", repeated: true },
    { id: 16, name: "conversation_group_id", type: "string" },
  ])

  // ── Client heartbeat ──

  addType(root, "ClientHeartbeat", [])

  // ── Interaction query/response channel ──
  // Cursor sends UI/integration requests outside the exec tool channel. Query
  // bodies stay opaque: this headless provider only needs their id + variant
  // to return a conservative typed response on the same Run stream.
  addType(
    root,
    "InteractionQuery",
    [
      { id: 1, name: "id", type: "uint32" },
      { id: 2, name: "web_search_request_query", type: "bytes" },
      { id: 3, name: "ask_question_interaction_query", type: "bytes" },
      { id: 4, name: "switch_mode_request_query", type: "bytes" },
      { id: 7, name: "create_plan_request_query", type: "bytes" },
      { id: 8, name: "setup_vm_environment_args", type: "bytes" },
      { id: 9, name: "web_fetch_request_query", type: "bytes" },
      { id: 10, name: "pr_management_request_query", type: "bytes" },
      { id: 11, name: "mcp_auth_request_query", type: "bytes" },
      { id: 12, name: "generate_image_request_query", type: "bytes" },
      { id: 13, name: "replace_env_args", type: "bytes" },
      { id: 14, name: "connect_scm_request_query", type: "bytes" },
    ],
    [{
      name: "query",
      fields: [
        "web_search_request_query", "ask_question_interaction_query",
        "switch_mode_request_query", "create_plan_request_query",
        "setup_vm_environment_args", "web_fetch_request_query",
        "pr_management_request_query", "mcp_auth_request_query",
        "generate_image_request_query", "replace_env_args",
        "connect_scm_request_query",
      ],
    }],
  )

  addType(root, "WebSearchRequestApproved", [])
  addType(root, "WebSearchRequestRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "WebSearchRequestResponse", [
    { id: 1, name: "approved", type: "WebSearchRequestApproved" },
    { id: 2, name: "rejected", type: "WebSearchRequestRejected" },
  ], [{ name: "result", fields: ["approved", "rejected"] }])

  addType(root, "AskQuestionRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "AskQuestionResult", [
    { id: 3, name: "rejected", type: "AskQuestionRejected" },
  ], [{ name: "result", fields: ["rejected"] }])
  addType(root, "AskQuestionInteractionResponse", [
    { id: 1, name: "result", type: "AskQuestionResult" },
  ])

  addType(root, "SwitchModeRequestApproved", [])
  addType(root, "SwitchModeRequestRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "SwitchModeRequestResponse", [
    { id: 1, name: "approved", type: "SwitchModeRequestApproved" },
    { id: 2, name: "rejected", type: "SwitchModeRequestRejected" },
  ], [{ name: "result", fields: ["approved", "rejected"] }])

  addType(root, "CreatePlanSuccess", [])
  addType(root, "CreatePlanError", [{ id: 1, name: "error", type: "string" }])
  addType(root, "CreatePlanResult", [
    { id: 1, name: "success", type: "CreatePlanSuccess" },
    { id: 2, name: "error", type: "CreatePlanError" },
    { id: 3, name: "plan_uri", type: "string" },
  ], [{ name: "result", fields: ["success", "error"] }])
  addType(root, "CreatePlanRequestResponse", [
    { id: 1, name: "result", type: "CreatePlanResult" },
  ])

  addType(root, "SetupVmEnvironmentSuccess", [])
  addType(root, "SetupVmEnvironmentResult", [
    { id: 1, name: "success", type: "SetupVmEnvironmentSuccess" },
  ], [{ name: "result", fields: ["success"] }])

  addType(root, "WebFetchRequestApproved", [])
  addType(root, "WebFetchRequestRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "WebFetchRequestResponse", [
    { id: 1, name: "approved", type: "WebFetchRequestApproved" },
    { id: 2, name: "rejected", type: "WebFetchRequestRejected" },
  ], [{ name: "result", fields: ["approved", "rejected"] }])

  addType(root, "PrManagementRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "PrManagementResult", [
    { id: 3, name: "rejected", type: "PrManagementRejected" },
  ], [{ name: "result", fields: ["rejected"] }])

  addType(root, "McpAuthRequestApproved", [])
  addType(root, "McpAuthRequestRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "McpAuthRequestResponse", [
    { id: 1, name: "approved", type: "McpAuthRequestApproved" },
    { id: 2, name: "rejected", type: "McpAuthRequestRejected" },
  ], [{ name: "result", fields: ["approved", "rejected"] }])

  addType(root, "GenerateImageRequestApproved", [{ id: 1, name: "description", type: "string" }])
  addType(root, "GenerateImageRequestRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "GenerateImageRequestResponse", [
    { id: 1, name: "approved", type: "GenerateImageRequestApproved" },
    { id: 2, name: "rejected", type: "GenerateImageRequestRejected" },
  ], [{ name: "result", fields: ["approved", "rejected"] }])

  addType(root, "ReplaceEnvSuccess", [])
  addType(root, "ReplaceEnvFailure", [
    { id: 1, name: "error_message", type: "string" },
    { id: 2, name: "setup_logs", type: "string" },
  ])
  addType(root, "ReplaceEnvResult", [
    { id: 1, name: "success", type: "ReplaceEnvSuccess" },
    { id: 2, name: "failure", type: "ReplaceEnvFailure" },
  ], [{ name: "result", fields: ["success", "failure"] }])

  addType(root, "ConnectScmRequestApproved", [])
  addType(root, "ConnectScmRequestRejected", [{ id: 1, name: "reason", type: "string" }])
  addType(root, "ConnectScmRequestFailed", [{ id: 1, name: "error", type: "string" }])
  addType(root, "ConnectScmRequestResponse", [
    { id: 1, name: "approved", type: "ConnectScmRequestApproved" },
    { id: 2, name: "rejected", type: "ConnectScmRequestRejected" },
    { id: 3, name: "failed", type: "ConnectScmRequestFailed" },
  ], [{ name: "result", fields: ["approved", "rejected", "failed"] }])

  addType(
    root,
    "InteractionResponse",
    [
      { id: 1, name: "id", type: "uint32" },
      { id: 2, name: "web_search_request_response", type: "WebSearchRequestResponse" },
      { id: 3, name: "ask_question_interaction_response", type: "AskQuestionInteractionResponse" },
      { id: 4, name: "switch_mode_request_response", type: "SwitchModeRequestResponse" },
      { id: 7, name: "create_plan_request_response", type: "CreatePlanRequestResponse" },
      { id: 8, name: "setup_vm_environment_result", type: "SetupVmEnvironmentResult" },
      { id: 9, name: "web_fetch_request_response", type: "WebFetchRequestResponse" },
      { id: 10, name: "pr_management_result", type: "PrManagementResult" },
      { id: 11, name: "mcp_auth_request_response", type: "McpAuthRequestResponse" },
      { id: 12, name: "generate_image_request_response", type: "GenerateImageRequestResponse" },
      { id: 13, name: "replace_env_result", type: "ReplaceEnvResult" },
      { id: 14, name: "connect_scm_request_response", type: "ConnectScmRequestResponse" },
    ],
    [{
      name: "result",
      fields: [
        "web_search_request_response", "ask_question_interaction_response",
        "switch_mode_request_response", "create_plan_request_response",
        "setup_vm_environment_result", "web_fetch_request_response",
        "pr_management_result", "mcp_auth_request_response",
        "generate_image_request_response", "replace_env_result",
        "connect_scm_request_response",
      ],
    }],
  )

  // ── KV blob store (cursor moves large payloads out-of-band via this channel) ──
  // Server sends KvServerMessage (AgentServerMessage #4); client MUST reply with
  // KvClientMessage (AgentClientMessage #3) on the same Run stream, echoing `id`.
  // If we don't ack set_blob / answer get_blob, the server hangs (endless
  // heartbeats, no response) — this was the "no response" root cause.

  addType(root, "GetBlobArgs", [
    { id: 1, name: "blob_id", type: "bytes" },
  ])
  addType(root, "GetBlobResult", [
    { id: 1, name: "blob_data", type: "bytes" },
  ])
  addType(root, "SetBlobArgs", [
    { id: 1, name: "blob_id", type: "bytes" },
    { id: 2, name: "blob_data", type: "bytes" },
  ])
  addType(root, "SetBlobResult", [
    { id: 1, name: "error", type: "string" },
  ])
  addType(
    root,
    "KvServerMessage",
    [
      { id: 1, name: "id", type: "uint32" },
      { id: 2, name: "get_blob_args", type: "GetBlobArgs" },
      { id: 3, name: "set_blob_args", type: "SetBlobArgs" },
    ],
    [{ name: "message", fields: ["get_blob_args", "set_blob_args"] }],
  )
  addType(
    root,
    "KvClientMessage",
    [
      { id: 1, name: "id", type: "uint32" },
      { id: 2, name: "get_blob_result", type: "GetBlobResult" },
      { id: 3, name: "set_blob_result", type: "SetBlobResult" },
    ],
    [{ name: "message", fields: ["get_blob_result", "set_blob_result"] }],
  )

  // ── AgentClientMessage ──

  addType(
    root,
    "AgentClientMessage",
    [
      { id: 1, name: "run_request", type: "AgentRunRequest" },
      { id: 2, name: "exec_client_message", type: "ExecClientMessage" },
      { id: 3, name: "kv_client_message", type: "KvClientMessage" },
      { id: 5, name: "exec_client_control_message", type: "ExecClientControlMessage" },
      { id: 6, name: "interaction_response", type: "InteractionResponse" },
      { id: 7, name: "client_heartbeat", type: "ClientHeartbeat" },
    ],
    [{ name: "message", fields: ["run_request", "exec_client_message", "kv_client_message", "exec_client_control_message", "interaction_response", "client_heartbeat"] }],
  )

  // ── AgentServerMessage ──

  addType(
    root,
    "AgentServerMessage",
    [
      { id: 1, name: "interaction_update", type: "InteractionUpdate" },
      { id: 2, name: "exec_server_message", type: "ExecServerMessage" },
      { id: 3, name: "conversation_checkpoint_update", type: "bytes" },
      { id: 4, name: "kv_server_message", type: "KvServerMessage" },
      { id: 5, name: "exec_server_control_message", type: "ExecServerControlMessage" },
      { id: 7, name: "interaction_query", type: "InteractionQuery" },
    ],
    [{ name: "message", fields: ["interaction_update", "exec_server_message", "conversation_checkpoint_update", "kv_server_message", "exec_server_control_message", "interaction_query"] }],
  )

  // ── AvailableModels types ──

  addType(root, "AvailableModelsRequest", [])

  addType(root, "AvailableModelParameterDefinition", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "values", type: "string", repeated: true },
  ])

  addType(root, "AvailableModelParameterValue", [
    { id: 1, name: "id", type: "string" },
    { id: 2, name: "value", type: "string" },
  ])

  addType(root, "AvailableModelVariant", [
    { id: 1, name: "display_name", type: "string" },
    { id: 2, name: "is_max_mode", type: "bool" },
    { id: 3, name: "is_default_max_config", type: "bool" },
    { id: 4, name: "is_default_non_max_config", type: "bool" },
    { id: 5, name: "parameter_values", type: "AvailableModelParameterValue", repeated: true },
  ])

  addType(root, "AvailableModelEntry", [
    { id: 1, name: "name", type: "string" },
    { id: 2, name: "default_on", type: "bool" },
    { id: 5, name: "supports_agent", type: "bool" },
    { id: 9, name: "supports_thinking", type: "bool" },
    { id: 10, name: "supports_images", type: "bool" },
    { id: 14, name: "supports_max_mode", type: "bool" },
    { id: 15, name: "context_token_limit", type: "uint32" },
    { id: 17, name: "client_display_name", type: "string" },
    { id: 18, name: "server_model_name", type: "string" },
    { id: 29, name: "parameter_definitions", type: "AvailableModelParameterDefinition", repeated: true },
    { id: 30, name: "variants", type: "AvailableModelVariant", repeated: true },
  ])

  addType(root, "AvailableModelsResponse", [
    { id: 1, name: "models", type: "AvailableModelEntry", repeated: true },
  ])

  return root
}

// ── Singleton root ──

let _root: protobuf.Root | null = null

export function getMessageTypes(): protobuf.Root {
  if (!_root) {
    _root = createMessageTypes()
  }
  return _root
}

export function encodeMessage(typeName: string, message: Record<string, unknown>): Uint8Array {
  const root = getMessageTypes()
  const type = root.lookupType(typeName)
  const err = type.verify(message)
  if (err) throw new Error(`Invalid message for ${typeName}: ${err}`)
  return type.encode(type.fromObject(message)).finish()
}

export function decodeMessage<T = Record<string, unknown>>(
  typeName: string,
  data: Uint8Array,
): T {
  const root = getMessageTypes()
  const type = root.lookupType(typeName)
  const decoded = type.decode(data)
  return type.toObject(decoded, { defaults: true, json: true, longs: Number }) as T
}

/**
 * Decode a protobuf sub-message from a frame payload that wraps it in
 * a top-level field key + length varint.  Skips the outer wrapper and
 * decodes the inner body as `typeName`.
 */
export function decodeWrappedMessage<T = Record<string, unknown>>(
  typeName: string,
  data: Uint8Array,
): T {
  let offset = 1 // skip field key
  // skip varint length
  while (offset < data.length) {
    const b = data[offset]
    offset++
    if (!(b & 0x80)) break
  }
  return decodeMessage<T>(typeName, data.subarray(offset))
}
