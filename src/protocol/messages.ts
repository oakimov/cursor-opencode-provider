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

  // Tool call types
  addType(root, "ToolCall", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_name", type: "string" },
    { id: 3, name: "args", type: "string" },
  ])

  addType(root, "ToolCallStarted", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_call", type: "ToolCall" },
    { id: 3, name: "model_call_id", type: "string" },
  ])

  addType(root, "ToolCallCompleted", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_call", type: "ToolCall" },
    { id: 3, name: "model_call_id", type: "string" },
    { id: 4, name: "result", type: "string" },
  ])

  addType(root, "PartialToolCall", [
    { id: 1, name: "call_id", type: "string" },
    { id: 2, name: "tool_call", type: "ToolCall" },
    { id: 3, name: "args_text_delta", type: "string" },
    { id: 4, name: "model_call_id", type: "string" },
  ])

  addType(root, "StepStarted", [
    { id: 1, name: "step_id", type: "string" },
  ])

  addType(root, "StepCompleted", [
    { id: 1, name: "step_id", type: "string" },
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
  addType(root, "ReadSuccess", [
    { id: 1, name: "path", type: "string" },
    { id: 2, name: "content", type: "string" },
    { id: 3, name: "total_lines", type: "int32" },
    { id: 4, name: "file_size", type: "int64" },
    { id: 6, name: "truncated", type: "bool" },
  ])
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
  ])

  addType(root, "ShellStreamStart", []) // optional SandboxPolicy only; empty is valid
  addType(root, "ShellStreamStdout", [{ id: 1, name: "data", type: "string" }])
  addType(root, "ShellStreamStderr", [{ id: 1, name: "data", type: "string" }])
  // agent.v1: code is uint32; protobufjs must emit code=0 (defaults are load-bearing).
  addType(root, "ShellStreamExit", [
    { id: 1, name: "code", type: "uint32" },
    { id: 4, name: "aborted", type: "bool" },
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
    ],
    [{ name: "event", fields: ["stdout", "stderr", "exit", "start", "rejected", "permission_denied"] }],
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
    { id: 10, name: "time_zone", type: "string" },
    { id: 11, name: "project_folder", type: "string" },
    { id: 21, name: "process_working_directory", type: "string" },
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

  addType(root, "RequestContextPayload", [
    { id: 4, name: "env", type: "RequestContextEnv" },
    { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
    { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
    { id: 39, name: "rules_info_complete", type: "bool" },
    { id: 40, name: "env_info_complete", type: "bool" },
    { id: 41, name: "repository_info_complete", type: "bool" },
    { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
    { id: 45, name: "git_status_info_complete", type: "bool" },
  ])

  addType(root, "RequestContextSuccess", [
    { id: 1, name: "request_context", type: "RequestContextPayload" },
  ])

  addType(root, "RequestContextResult", [
    { id: 1, name: "success", type: "RequestContextSuccess" },
  ])

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
    ],
    [{ name: "args", fields: ["write_args", "delete_args", "grep_args", "read_args", "ls_args", "request_context_args", "mcp_args", "shell_stream_args"] }],
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
    ],
    [{ name: "result", fields: ["write_result", "delete_result", "grep_result", "read_result", "ls_result", "request_context_result", "mcp_result", "shell_stream"] }],
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

  // McpToolDefinition — agent.v1 shape used by RequestContext.tools (#7) and
  // AgentRunRequest.mcp_tools (#4). Capture 00074 / CLI: { #1 name (composite
  // <server>-<tool>), #2 description, #3 input_schema (Value bytes),
  // #4 provider_identifier, #5 tool_name }.
  // (Defined later as McpToolDefinition; keep a legacy alias type name for
  // any older encode paths that still look up "McpToolDescriptor".)
  addType(root, "McpToolDescriptor", [
    { id: 1, name: "name", type: "string" },
    { id: 2, name: "description", type: "string" },
    { id: 3, name: "input_schema", type: "bytes" },
    { id: 4, name: "provider_identifier", type: "string" },
    { id: 5, name: "tool_name", type: "string" },
  ])

  // RequestContext — UserMessageAction #2. Live per-turn tools go here
  // (AgentRunRequest.mcp_tools #4 is prewarm-only / empty on real turns).
  addType(root, "RequestContext", [
    { id: 4, name: "env", type: "RequestContextEnv" },
    { id: 7, name: "tools", type: "McpToolDefinition", repeated: true },
    { id: 23, name: "mcp_file_system_options", type: "McpFileSystemOptions" },
    { id: 34, name: "mcp_meta_tool_options", type: "McpMetaToolOptions" },
    { id: 39, name: "rules_info_complete", type: "bool" },
    { id: 40, name: "env_info_complete", type: "bool" },
    { id: 41, name: "repository_info_complete", type: "bool" },
    { id: 44, name: "mcp_file_system_info_complete", type: "bool" },
    { id: 45, name: "git_status_info_complete", type: "bool" },
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
    { id: 14, name: "available_models", type: "RequestedModel", repeated: true },
    { id: 16, name: "conversation_id_dup", type: "string" },
  ])

  // ── Client heartbeat ──

  addType(root, "ClientHeartbeat", [])

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
      { id: 7, name: "client_heartbeat", type: "ClientHeartbeat" },
    ],
    [{ name: "message", fields: ["run_request", "exec_client_message", "kv_client_message", "exec_client_control_message", "client_heartbeat"] }],
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
      { id: 7, name: "interaction_query", type: "bytes" },
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
