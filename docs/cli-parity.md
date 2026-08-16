# Feature Parity: cursor-opencode-provider vs Cursor CLI

Comparison against the decompiled Cursor agent CLI **2026.08.11-e8db854** (client version reported in `src/statsig.ts`). Last verified 2026-08-16.

**Legend:** ✅ full parity · 🔶 partial/adapted · ❌ not implemented · ⚪ N/A (not a CLI concern)

## Wire protocol (agent service)

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Connect-RPC `Run` bidi stream over HTTP/2 | Yes (`createAgentService`, Run) | Yes (`src/transport/connect.ts`) | ✅ |
| `RunSSE` / `RunPoll` transports | Yes | No (HTTP/2 bidi only) | ❌ |
| Client msgs: run_request, exec, kv, conversation_action, exec_control, interaction_response, client_heartbeat, prewarm | All 8 | All except `prewarm_request` (RunRequest.mcp_tools is prewarm-only, empty on real turns) | 🔶 |
| Server msgs: interaction_update, exec, checkpoint_update, kv, exec_control, interaction_query, ttft_breakdown | All | All except `ttft_breakdown` (not decoded) | 🔶 |
| ConversationActions | 16 (user_message, resume, cancel, summarize, shell_command, start/execute_plan, async_ask_question_completion, cancel_subagent, background_task/shell/subagent, subscription_notification, goal_continuation, inject_context + triggering_auth_id/user_info/request_context_parts) | 3: user_message, resume, cancel (via agent protocol) — summarize emulated via compaction marker; async_ask_question_completion used | 🔶 |
| Sparse protobuf decode w/ full schema | Native protobuf | Hand-rolled `struct.ts` sparse decoder + full schema table (`messages.ts`) | ✅ |
| Checksums / framing / device id / client-version | Yes | Yes (`checksum.ts`, `framing.ts`, `device-id.ts`, `client-version.ts`) | ✅ |
| Response-required write backpressure + heartbeat | Yes (blocks on heartbeats) | Yes (drain-await per stream, heartbeat replies) | ✅ |

## Tools (exec requests) — `src/protocol/exec-variants.ts`

| Tool | Cursor CLI | This provider | Match |
|---|---|---|---|
| read / write / edit / delete / grep / ls | Native | Native + OpenCode permission-aware read/write; edit via catalog-aware remap | ✅ |
| apply_patch (edit/write substitution) | Native `apply_patch` exists | Synthesizes `apply_patch` envelopes when OpenCode 1.x drops edit/write | 🔶 (parity by design) |
| shell (streaming, stdin, background, force-background, allowlist precheck) | Native pty | shell_stream only; stdin/force/allowlist rejected | 🔶 |
| mcp, list_mcp_resources, read_mcp_resource, mcp_state | Native | MCP exec + provider-control variants | ✅ |
| subagent, subagent_await | Full SubagentType oneof (computer_use, browser_use, explore, custom, bash, shell, vm_setup_helper, debug, cursor_guide, watch_video, media_review) + permission modes | subagent bridged to OpenCode `task`; subtype set limited to what OpenCode advertises; await unsupported | 🔶 |
| request_context | Native | provider-control | ✅ |
| diagnostics, canvas_diagnostics | Native | ❌ | ❌ |
| fetch / web_fetch | Native | ❌ (websearch/webfetch via OpenCode tools instead) | 🔶 |
| record_screen, computer_use | Native (X11/xdotool, worker) | ❌ | ❌ |
| execute_hook, redacted_read, smart_mode_classifier, git_diff_request | Native | ❌ | ❌ |
| pi_read/bash/edit/write/grep/find/ls (Pi/OMP protocol) | — | ✅ (pi-bridge hosts) | ✅ (provider extra) |

## Interactions (server-side queries)

| Interaction | Cursor CLI | This provider | Match |
|---|---|---|---|
| #2 web_search | Native search UI | Rejected (headless); OpenCode `websearch`/`custom_websearch` tool registered instead | 🔶 |
| #3 ask_question | Blocks until user answers; async variant via `async_ask_question_completion_action` | Bridged to OpenCode `question` tool, CLI-verbatim semantics, async echo of server args | ✅ |
| #4 switch_mode | Blocks until approve/reject | Three tiers: native `plan_enter`/`plan_exit` when advertised → else enter-plan approved outright → else leave-plan via host `question`; CLI-shaped system reminder injected on next Run | ✅ |
| #7 create_plan | Writes Cursor plan file, returns plan_uri | Writes plain markdown to host `plans/` dir | 🔶 |
| #8 setup_vm | Full VM env setup | Ack `success:{}` | 🔶 |
| #9 web_fetch | Native fetch UI | Rejected headless | 🔶 |
| #10 pr_management | Native PR workflow (gh) | Rejected | ❌ |
| #11 mcp_auth | OAuth flow (pkce, Slack client-id) | Rejected | ❌ |
| #12 generate_image | Approve → server generates → binary write exec | Approve + stage bytes + `cursor_image_save` plugin tool (permission-gated), byte-exact verified | ✅ |
| #13 replace_env | Native | Acknowledged (no-UI case) | 🔶 |
| #14 connect_scm | Native SCM connect | Rejected | ❌ |

## Display / transcript surface

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Tool-call display variants (~40 UIs: read/write/edit/shell/mcp/web-search/image/ask/switch/plan/todos/sem-search/…) | Full | Subset bridged to OpenCode tools (todowrite, websearch, question, webfetch, plan_enter, generateimage); non-bridgeable variants dropped with replay-safety | 🔶 |
| Thinking blocks (`thinking_delta`) | Yes (--show-thinking) | Yes (`thinking.ts`) | ✅ |
| Compaction (`summarize_action` / checkpoint reset) | Native | Emulated via `compaction-marker.ts` + conversation rotation | 🔶 |

## Persistence & state

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Checkpoint handling | Full read/write (agent-kv) | Decode + reachable-blob export graph; rebase on >100 MiB budget | ✅ |
| KV blobs | sqlite blob store + AES-GCM encryption + merkle tree | Blob store + reachability; writes serialized w/ backpressure | ✅ |
| Conversation restart/resume | store.db, resume.tsx, fork-chat-session, export | `conversation-persistence.ts` (atomic pb.gz snapshot, 24h expiry, compaction rotation) | 🔶 |
| Token details (used/max/category breakdown) | `ConversationStateStructure.tokenDetails` → UI tray | `token-details.ts` → `providerMetadata.cursor.context`; AI SDK usage = authoritative total | ✅ |
| Session lifecycle (superseded, cap) | Managed by CLI | `maxOpenSessions` backstop, superseded-by-new-run | ✅ |

## Context & discovery

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Rules (AGENTS.md/CLAUDE.md/CONTEXT.md, global config, instructions globs) | Native | Full, git-worktree walk + global + config globs | ✅ |
| Skills, agents, plugins discovery | Native | `.opencode` + `.claude`/`.agents` fallbacks | ✅ |
| Git + layout + env + terminal epochs | Native (direnv, terminal env) | Git/layout/env; no terminal-state epochs | 🔶 |
| Slash commands / custom modes | Native | Not sent as context | ❌ |
| @-file selections, selected skills, cursor commands | Native (selectedContext) | Images from user messages; no @-file/skills picking UI | ❌ |
| Stable prompt-cache base (frozen + byte-identical reuse) | CLI relies on server cache | Explicit freeze/compare/overlay per conversation_id | ✅ (provider extra) |

## Auth, models, host

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| PKCE OAuth + API key + refresh | Yes + keychain (macOS) | Yes (auth.json); no keychain | 🔶 |
| GetServerConfig / agent host resolution | Yes, memoized | Yes, memoized in-memory, HTTPS `*.cursor.sh` validation | ✅ |
| Model registry | GetUsableModels + fixed catalog + picker | cursor-models.json cache + pricing | ✅ |
| Telemetry | statsig (~599 flags) + quality metrics | Opt-in GetServerConfig telemetry only | 🔶 |

## Beyond the wire (CLI-only surface)

These have no provider equivalent by design — the provider is a *host language model*, not a terminal app: commands (`agent`, `ls`, `resume`, `login`, `cloud`, `env`, `mcp`, `sandbox`, `worker`, `automations`, `repo search`, `bedrock`, `acp`…), TUI, headless `-p` modes, notifications (OSC 9/777/99), sudo askpass, PR opening, cursor-blame, background-jobs UI, history rewind, statsig gating, worktrees, sandbox binary, PDF worker, terminal image rendering. ⚪/❌ where Cursor needs them (e.g. goal continuation, autorun, queued-message-enter — the host OpenCode provides the equivalents: autorun, plan mode, resume).

## Bottom line

- **Core agent protocol:** near-total parity — every message class, checkpoint/KV semantics, token accounting, backpressure, and the interaction machinery are mirrored, many CLI-verbatim.
- **Tools:** the full read/write/edit/grep/ls/mcp/subagent family plus Pi variants; deliberately unsupported: shell args/allowlist, computer use, record_screen, hooks, diagnostics, redacted_read, git_diff, smart_mode_classifier.
- **Interactions:** 4 of 11 bridged with CLI-verbatim semantics (ask_question, switch_mode, create_plan, generate_image); 5 rejected headless (web, PR, MCP auth, SCM); 2 acked.
- **Biggest gaps:** PR management, MCP OAuth approval, computer use/screen recording, full ConversationAction surface (background jobs, goal continuation, inject_context, shell_command), and everything UI-shaped (TUI, notifications, sudo, worktrees, sandbox).