# Feature Parity: cursor-opencode-provider vs Cursor CLI

Historical CLI baseline: **2026.08.25-3e8eec8**, inspected 2026-08-30. The provider column is an implementation inventory, updated from the linked source; this is not a fresh live parity result. Runtime client version is resolved by [`src/protocol/client-version.ts`](../src/protocol/client-version.ts).

Parity target is interactive `cursor-agent` (`Run` client: TUI and `--print`). `cursor-agent worker` / `runBridgeMode` / Cloud Agents are out of scope.

**Legend:** ✅ supported behavior in this inventory · 🔶 partial/adapted · ❌ not implemented · ⚪ outside the interactive target. Symbols are not live-test verdicts.

## Wire protocol (agent service)

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Connect-RPC `Run` bidi stream over HTTP/2 | Yes (`createAgentService`, Run) | Yes (`src/transport/connect.ts`) | ✅ |
| `RunSSE` / `RunPoll` transports | Yes | No (HTTP/2 bidi only) | ❌ |
| Client msgs: run_request, exec, kv, conversation_action, exec_control, interaction_response, client_heartbeat, prewarm | All 8 | All except `prewarm_request` (RunRequest.mcp_tools is prewarm-only, empty on real turns) | 🔶 |
| Server msgs: interaction_update, exec, checkpoint_update, kv, exec_control, interaction_query, ttft_breakdown | All | All except `ttft_breakdown` (not decoded) | 🔶 |
| Run message compression | gzip from 1 KiB (connect-es `sendCompression`, `compressMinBytes`, async `zlib.gzip`) | gzip from 1 KiB with async `zlib.gzip`, in write order; a refused gzip Run is sent once more uncompressed, and later Runs to that host go uncompressed | ✅ |
| ConversationActions | 15 oneof actions + 3 metadata fields (`triggering_auth_id`, `triggering_user_info`, `request_context_parts`): user_message, resume, cancel, summarize, shell_command, start/execute_plan, async_ask_question_completion, cancel_subagent, background_task/shell/subagent, subscription_notification, goal_continuation, inject_context | Schema encodes 5: user_message, resume, cancel, async_ask_question_completion, inject_context (`user_context` payload for host notes and early steers) — summarize emulated via compaction marker | 🔶 |
| Sparse protobuf decode w/ full schema | Native protobuf | Hand-rolled `struct.ts` sparse decoder + full schema table (`messages.ts`) | ✅ |
| Checksums / framing / device id / client-version | Yes | Yes (`checksum.ts`, `framing.ts`, `device-id.ts`, `client-version.ts`) | ✅ |
| Run response compression | Accepts gzip and br (connect-es `acceptCompression`) | Accepts gzip only, the one encoding `decodeFramePayload` inflates; Cursor answers in the request's encoding or the first accepted one | 🔶 |
| Response-required write backpressure + heartbeat | Yes (blocks on heartbeats) | Yes (serialized drain-await without an upload deadline; terminal/cancellation settlement and heartbeat replies) | ✅ |

## Tools (exec requests) — `src/protocol/exec-variants.ts`

| Tool | Interactive CLI | This provider | Match |
|---|---|---|---|
| read / write / edit / delete / grep / ls | Native | Native + OpenCode permission-aware read/write; edit via catalog-aware remap | ✅ |
| Host patch substitution | Native write/edit execs; no patch-format edit exec | Synthesizes `apply_patch` (1.x) / `patch` (2.x) from native text writes/edits when the current turn withholds edit/write; direct dynamic calls also work ([details](../README.md#apply_patch--patch-on-gpt-models)) | 🔶 (host adaptation) |
| shell (streaming, stdin, background, force-background, allowlist precheck) | Native pty | `shell_args` + `shell_stream` + `background_shell_spawn` (managed terminal records; unmanaged POSIX fallback without storage); stdin / force-background / allowlist precheck unsupported | 🔶 |
| mcp, list_mcp_resources, read_mcp_resource, mcp_state | Native | MCP exec + provider-control variants | ✅ |
| subagent, subagent_await | Full SubagentType oneof (computer_use, browser_use, explore, custom, bash, shell, vm_setup_helper, debug, cursor_guide, watch_video, media_review) + permission modes | subagent bridged to advertised OpenCode `task` or 2.x `subagent`; subtype set limited to what OpenCode advertises; await unsupported | 🔶 |
| request_context | Native | provider-control | ✅ |
| diagnostics | Native `read_lints` via codebase-ref / LSP (`DiagnosticsArgs.path`; empty list if `--disable-codebase-ref`) | Soft-deny error. OpenCode already appends LSP errors on write/edit/apply_patch (those remaps already carry them). Dedicated pull `#9` is **not planned**: the public host surface is `GET /lsp` status and the `lsp` **navigation** tool, not a diagnostics fetch. Do not remap `#9` onto `lsp`, spawn language servers, or change OpenCode. | ⚪ |
| canvas_diagnostics | Worker exec-daemon only (`getCanvasDiagnostics`); interactive `createLocalResourceProvider` never registers it | — | ⚪ |
| fetch / web_fetch | Native exec + UI | Native exec unsupported; capability via host `custom_webfetch` / `webfetch` (see Interactions) | 🔶 (parity by design) |
| record_screen, computer_use | Native X11 executor is worker-only (`setupDaemon` `--computer-use` / `enableRecordScreen`). Interactive: `--computer-use-coords` (coords only), Darwin harness stub throws, Mac bundled `computer-use` MCP — not exec #21/#22 | — | ⚪ |
| execute_hook | Native (interactive `hookExecutor`) | ❌ | ❌ |
| redacted_read | Worker-only inbound exec #29; registered only when `isSecretRedactionEnabled` (bridge hardcodes `true`; interactive never sets `registerRedactedReadExecutor`) | Soft-deny | ⚪ |
| smart_mode_classifier | Native `--auto-review` (Smart Auto): client classifier ALLOW/BLOCK | Soft-deny error; OpenCode has no Auto-review mode — not planned | ⚪ |
| git_diff_request | Native (always registered) | Typed refusal (`throw` + `stream_close`) pointing at the advertised shell, where OpenCode authorizes `git diff`; the provider never runs Git itself | 🔶 (permission parity by design) |
| mini_swe_agent_bash (#52→#55) | Native Mini-SWE shell (same `ShellArgs` / `ShellResult` as #2, Pi-style result offset) | Soft-deny `rejected`; Mini-SWE / SWE-agent bash is not planned | ⚪ |
| conversation_search | Native local/cloud conversation index | Soft-deny empty `{hits:[]}` | ❌ |
| agent_store_conflict | Agent-store journal (cloud/worker-shaped) | Soft-deny typed error | ❌ |
| adopt | Cloud agent adoption | Soft-deny typed error | ❌ |
| pi_read/bash/edit/write/grep/find/ls (Cursor Pi-style wire variants) | Typed exec variants | Translated to the canonical advertised OpenCode tools; this does not detect or select a host | ✅ |

## Interactions (server-side queries)

| Interaction | Interactive CLI | This provider | Match |
|---|---|---|---|
| #2 web_search | Native search UI | Rejected by design; `web_search_enabled=false` so Cursor prefers host `custom_websearch` (interaction replies cannot carry OpenCode tool results) | 🔶 (parity by design) |
| #3 ask_question | Blocks until user answers; async variant via `async_ask_question_completion_action` | Bridged to OpenCode `question` tool, CLI-verbatim semantics, async echo of server args | ✅ |
| #4 switch_mode | Blocks until approve/reject | OpenCode 1.x uses advertised `plan_enter`/`plan_exit`; without `plan_enter`, a 1.x host's primary-agent session enters its `plan` agent through a synthetic `session.promptAsync` turn after the Run is terminal (CreatePlan waits for that turn; inside it, CreatePlan writes the host's own plan file and runs the host `plan_exit` review); OpenCode 2.x selects its native `plan`/`build` primary agent after the Run is terminal. Without `plan_exit`, CreatePlan uses the advertised `question` approval; without that channel the user switches agents; provider reminders are the structural fallback. As in the CLI, every user message carries the current mode (`UserMessage.mode`, `agent.v1.AgentMode`); Cursor plan mode follows the host `plan` agent both ways, including a switch in the host's agent picker. Agent/prompt changes preserve the sticky conversation and deliver chronological instruction updates. | ✅ |
| #7 create_plan | Writes Cursor plan file, returns plan_uri | Writes plain markdown where the host keeps plans; executing needs approval through the host's channel: a host plan-stage tool, the `plan_exit` review under the `plan` agent, or else in plan mode the `question` prompt (Yes switches to build); with none, the user switches to the build agent | 🔶 |
| #8 setup_vm | Ack `success:{}` (no VM; TUI `setupVmEnvironmentArgs` is the same no-op) | Ack `success:{}` | ✅ |
| #9 web_fetch | Native fetch UI | Rejected by design; `web_fetch_enabled=false` so Cursor prefers host `custom_webfetch` / `webfetch` | 🔶 (parity by design) |
| #10 pr_management | Errors `PR management is only available in cloud agents` | Rejected | ⚪ |
| #11 mcp_auth | Rejected (`MCP authentication is not supported in CLI mode`) | Rejected | ⚪ |
| #12 generate_image | Approve → server generates → binary write exec | Approve + stage bytes + `cursor_image_save` (byte-exact verified). Classic/OCP raise `external_directory`/`edit`. Stock OpenCode 2.x advertises the same handle-only tool (`permission: "edit"`) and asserts `external_directory`/`edit` on the actual target through public `ctx.permission.assert`, failing closed without it. | 🔶 |
| #13 replace_env | Failed (`Environment replacement is not supported in CLI mode`) | Failed (`Environment replacement is not supported by the OpenCode provider.`) | ✅ |
| #14 connect_scm | Rejected (`Connecting GitHub is not supported in CLI mode`) | Rejected | ⚪ |

## Display / transcript surface

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Tool-call display variants (read/write/edit/shell/mcp/web-search/image/ask/switch/plan/todos/…) | Full UI | Mirrors finalized todo/plan state and opens edit tool rows while arguments stream; unbound rows close without host execution ([bridge](../src/protocol/tool-call-bridge.ts), [early rows](../src/early-tool-rows.ts)) | 🔶 |
| Thinking blocks (`thinking_delta`) | Yes (--show-thinking) | Yes (`thinking.ts`) | ✅ |
| Compaction (`summarize_action` / checkpoint reset) | Native | Emulated via `compaction-marker.ts` + conversation rotation | 🔶 |

## Persistence & state

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Checkpoint handling | Full read/write (agent-kv); soft-reuse incomplete/large | Decode + reachable-blob export graph; warn on >100 MiB / incomplete, never remint | ✅ |
| KV blobs | sqlite blob store + AES-GCM encryption + merkle tree | In-memory blobs plus gzip protobuf restart snapshots; reachability and backpressured writes, without CLI storage encryption | 🔶 |
| Conversation restart/resume | store.db, resume.tsx, fork-chat-session, export | `conversation-persistence.ts` (atomic pb.gz snapshot, configurable retention with a 24 h default, compaction rotation). Uncheckpointed request carryover and steer receipts survive restart. | 🔶 |
| Token details (used/max/category breakdown) | `ConversationStateStructure.tokenDetails` → UI tray | `token-details.ts` → `providerMetadata.cursor.context`; AI SDK usage = authoritative total | ✅ |
| Session lifecycle (superseded, cap) | Managed by CLI | Held-Run KV/control reader, pending-exec heartbeats, activity-renewed leases and `maxOpenSessions` backstop; idle HTTP/2 sessions unref, direct/proxy session memory is 256 MB ([transport](../src/transport/connect.ts), [sessions](../src/session.ts)) | ✅ |

## Context & discovery

| Feature | Cursor CLI | This provider | Match |
|---|---|---|---|
| Rules (AGENTS.md/CLAUDE.md/CONTEXT.md, global config, instructions globs) | Native | OpenCode's system prompt as one `global` (alwaysApply) rule, like the CLI's AGENTS.md | ✅ |
| Skills, agents, plugins discovery | Native | Host prompt supplies instructions; skill paths/descriptions and advertised subagents are materialized separately; plugin metadata supplies `hooks_additional_context` ([context](../src/context/build.ts)) | 🔶 |
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

These have no provider equivalent by design — the provider is a *host language model*, not a terminal app: commands (`agent`, `ls`, `resume`, `login`, `cloud`, `env`, `mcp`, `sandbox`, `worker`, `automations`, `repo search`, `bedrock`, `acp`…), TUI, headless `-p` modes, notifications (OSC 9/777/99), sudo askpass, cursor-blame, background-jobs UI, history rewind, statsig gating, worktrees, sandbox binary, PDF worker, terminal image rendering. ⚪/❌ where Cursor needs them (e.g. goal continuation, autorun, queued-message-enter — the host OpenCode provides the equivalents: autorun, plan mode, resume).

Worker / cloud-bridge only (not a parity target): secret redaction / `redacted_read`, X11 computer-use and record-screen executors, `replace_env` as a working VM swap, PR management, `readOnlyBareMode`, `--pool` / `ClaimWorker`, mounted agent-store claim.

Not planned (OpenCode has no equivalent mode): `smart_mode_classifier` / Cursor `--auto-review`. The host keeps OpenCode allow/ask/deny as the permission gate; inbound `#38` stays a typed soft-deny. Do not implement ALLOW/BLOCK classification.

Not planned (same Mini-SWE / SWE-agent surface): `mini_swe_agent_bash` (`#52`→`#55`). Inbound stays a typed `rejected` soft-deny. Do not remap it onto OpenCode `bash`.

Not planned (no presented pull capability): `diagnostics` / Cursor `read_lints` (`#9`). OpenCode LSP feedback already rides write/edit/apply_patch tool output, which this provider remaps. Public plugin/SDK surface is `GET /lsp` **status** and the `lsp` tool (definition/hover/symbols only). We do not add OpenCode APIs, call host-internal `lsp.diagnostics()`, shell out to `opencode debug lsp`, spawn our own language servers, remap `#9` onto `lsp`, or return an empty success list (that would claim the file is clean). Inbound `#9` stays a typed error deny.

## Validation and remaining scope

The support table is bounded by the implemented request/result inventory in
[`exec-variants.ts`](../src/protocol/exec-variants.ts), interaction dispatch in
[`interactions.ts`](../src/protocol/interactions.ts), and regression coverage.
It does not imply every Cursor CLI feature or every interactive path was tested.

Remaining unsupported surfaces include shell stdin/force-background/allowlist
prechecks, subagent await/force-background, hooks, conversation search,
agent-store conflict/adoption and most ConversationActions. Host notes and
OpenCode 2.x early steers already use user-context injection. Native image saving
is available through the handle-only tool on both OpenCode majors; permission
APIs differ as described above.

Use [host acceptance](host-compat-acceptance.md) for planning, tools and caching,
[execution self-verification](execution-self-verify.md) for native failure and
shell paths, and the [log runbook](cache-log-runbook.md) for evidence. Record
live host/model results separately from deterministic fixtures; no fresh live
check is implied by a documentation update.
