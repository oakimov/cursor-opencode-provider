# cursor-opencode-provider

Use [Cursor](https://cursor.com) subscription models from [OpenCode](https://opencode.ai) by speaking Cursor's Connect-RPC agent protocol.

This project is a custom **AI SDK provider** (`LanguageModelV3`) plus an **OpenCode plugin** that handles authentication and model discovery. Instead of calling a generic chat-completions API, it encodes and decodes Cursor's protobuf agent protocol over HTTP/2 to Cursor's agent backend.

> **Status:** Usable end-to-end in OpenCode (auth, models, streaming, tools). See [Known limitations](#known-limitations).

## Demo

OpenCode driving a Cursor-routed Grok model through this provider:

![OpenCode running a Grok model via cursor-opencode-provider](https://raw.githubusercontent.com/oakimov/cursor-opencode-provider/main/assets/opencode-grok.png)

## Features

- **OpenCode integration** — registers a `cursor` provider with auth hooks and cached model list
- **Authentication** — browser OAuth (PKCE), or API key from [cursor.com/settings](https://cursor.com/settings)
- **Model discovery** — fetches available models from Cursor's API and caches them locally
- **Streaming** — bidirectional Connect-RPC Runs with stale-session rotation, health checks, semantic/read-idle deadlines, bounded replay-safe recovery, and activity-aware held tool continuations
- **Tool calls** — maps Cursor exec-server messages to AI SDK / OpenCode tool-call parts, including native subagent/Task execution (Cursor's `generalPurpose` maps to OpenCode `general`; read-oriented `bugbot` reviews map to `explore`) and the Pi read/bash/edit/write/grep/find/ls request/result field range; enforces the exact current OpenCode agent catalog before emitting any tool call; mirrors finalized display-only todo/plan state into OpenCode; strips OpenCode's `read` XML envelope (`<path>`/`<content>` + `N:` prefixes) before returning content to Cursor so the model cannot echo the wrapper into writes
- **Thinking / reasoning** — surfaces extended-thinking deltas where the model supports it

## Requirements

- [Bun](https://bun.sh) (for development and tests)
- [OpenCode](https://opencode.ai) with plugin support
- An active Cursor account with API access

## Installation

### From npm (after publish)

Add the package name to OpenCode config. OpenCode installs npm plugins with Bun at startup (cached under `~/.cache/opencode/node_modules/`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["cursor-opencode-provider"],
  "provider": {
    "cursor": {
      "npm": "cursor-opencode-provider",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

Pin a version if you want: `"cursor-opencode-provider@0.2.3"`.

### From a local clone

```bash
git clone https://github.com/oakimov/cursor-opencode-provider.git
cd cursor-opencode-provider
bun install
bun run build
```

Point config at the built files with absolute `file://` URLs:

```json
{
  "plugin": ["file:///absolute/path/to/cursor-opencode-provider/dist/plugin.js"],
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/cursor-opencode-provider/dist/index.js",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

## OpenCode setup

If the `cursor` provider block is omitted, the classic plugin auto-registers it on startup (as **Cursor Integration**) using this package's entry. Model entries come from the local cache, which is filled after auth and again on startup when the cache is empty but credentials remain.

For OpenCode builds that use the Effect/Promise **v2** plugin API (`plugins` field), also load:

```json
{
  "plugins": ["cursor-opencode-provider/plugin/v2"]
}
```

Local clone equivalent: `"file:///absolute/path/to/cursor-opencode-provider/dist/plugin-v2.js"`.

That entry registers the provider via `ctx.aisdk.sdk` / `ctx.aisdk.language`. Keep the classic `plugin` entry for auth.

### Authenticate

```bash
opencode auth login
```

Choose the **cursor** provider, then one of:

| Method | Description |
|--------|-------------|
| **Cursor account (browser login)** | PKCE OAuth — opens cursor.com to sign in |
| **API key** | Paste a key from [cursor.com/settings](https://cursor.com/settings) (`sk-...`) |

After login, the plugin fetches your available models and writes them to `~/.cache/opencode/cursor-models.json` (or `$XDG_CACHE_HOME/opencode/` when set). On later startups, a missing, empty, expired, or old-schema cache is refreshed during config load when Cursor auth is available; an existing stale cache remains usable if refresh fails.

### Paths (XDG)

| Kind | Default | Override |
|------|---------|----------|
| Model / version **cache** | `~/.cache/opencode/` | `$XDG_CACHE_HOME/opencode/` |
| OpenCode **auth** (`auth.json`) | `~/.local/share/opencode/` | `$XDG_DATA_HOME/opencode/` |
| OpenCode **config** (AGENTS, skills, …) | `~/.config/opencode/` | (config dir helper; not the model cache) |

### Select a model

Pick a model from the cached list (for example `composer-2.5`, `default`, or a Claude/GPT model exposed by your subscription):

```bash
opencode run --model cursor/composer-2.5 "Hello from Cursor via OpenCode"
```

#### Variants

Cursor models often expose parameterized variants (effort, thinking, fast, context tier, …). The plugin materializes those as OpenCode **model variants**. In the TUI, pick one from the variant dialog or cycle with OpenCode’s `variant_cycle` keybind (default `ctrl+t`).

The selected variant’s Cursor parameter map is forwarded on the Run as `requested_model.parameters` (isolated under `providerOptions.cursor.cursorVariantParameters` so unrelated OpenCode options are not leaked onto the wire). The provider validates that explicit selection against the current cached tuple; malformed, reordered, or stale selections fail clearly instead of silently falling back to another variant.

#### 1M / long context

OpenCode’s context limit is static per model entry, while Cursor’s long-context tier is a variant parameter (`context=1m`). When a model has both a base tier and a `1m` tier, the plugin emits a separate OpenCode entry `<model-id>-1m` (for example `claude-opus-4-8-1m`) with:

- `limit.context` set to the 1M window (so overflow checks and compaction match the tier)
- `limit.output` set to `128000` (max generation tokens — not the context window; base entries use `32000`)
- only the long-context variants in its picker
- the real Cursor model id carried in `options.cursorModelId` (not `config.id`, which would make OpenCode merge base variants into the 1M entry)

The Run still uses Cursor’s original model id; OpenCode’s synthetic `-1m` id is only for picking and limits.

#### Max mode

Cursor IDE has a separate **Max Mode** toggle that sets `requested_model.max_mode` and selects the default max / 1m variant. OpenCode has no equivalent custom toggle, so this provider approximates it:

- Selecting a `*-1m` model (or any resolved params with `context=1m`) sets wire `max_mode` to `true`
- An explicit `providerOptions.cursor.maxMode` hint also turns it on

There is no independent Max Mode chrome in OpenCode beyond choosing the 1M model / long-context variant.

## Programmatic usage

```ts
import { createCursor } from "cursor-opencode-provider"

const cursor = createCursor({
  name: "cursor",
  accessToken: process.env.CURSOR_ACCESS_TOKEN,
  // apiBaseURL: "https://api2.cursor.sh",
  // agentBaseURL: "https://agentn.us.api5.cursor.sh", // explicit Run host override
  // telemetryEnabled: true, // opt in to GetServerConfig telemetry
  // retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 },
  // continuation: { heartbeatMs: 5_000, semanticIdleMs: 120_000, hardCapMs: 600_000 },
})

const model = cursor.languageModel("composer-2.5")
// model implements AI SDK LanguageModelV3 (doStream / doGenerate)
```

Pass either `accessToken` (JWT from OAuth or key exchange) or `apiKey` (raw `sk-...` key). Optional: `apiBaseURL`, `agentBaseURL`, `headers`, `telemetryEnabled`, `retry`, and `continuation`. Retries occur only before visible output or stateful server activity; unsafe replay is surfaced instead of risking duplicate text or tool work. Pending-tool inactivity is renewed by OpenCode activity from the session or its descendants. The older `baseURL` option is still accepted as a legacy alias for `agentBaseURL`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_WEBSITE_URL` | Override OAuth login base URL (default `https://cursor.com`) |
| `CURSOR_API_BASE_URL` | Override API base for auth, model discovery, and `GetServerConfig` agent URL resolution (default `https://api2.cursor.sh`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Set to `1` or `true` to opt the `GetServerConfig` lookup into telemetry in OpenCode/plugin usage |
| `CURSOR_PROVIDER_DEBUG` | Set to `1` or `true` to enable wire-level debug logging |
| `CURSOR_PROVIDER_DEBUG_FILE` | Debug log path (default `/tmp/cursor-provider-debug.log`) |
| `XDG_CACHE_HOME` | When set, model/version caches go under `$XDG_CACHE_HOME/opencode/` instead of `~/.cache/opencode/` |
| `XDG_DATA_HOME` | When set, OpenCode `auth.json` is read from `$XDG_DATA_HOME/opencode/` instead of `~/.local/share/opencode/` |

`createCursor({ agentBaseURL })` overrides the agent Run host. When unset, the provider resolves the host from Cursor's `GetServerConfig` API (`agentUrlConfig.agentnUrl`, region-specific — e.g. `agentn.us.api5.cursor.sh`, `agent-gcpp-uswest.api5.cursor.sh`) once per process and holds it in memory (never written to disk), so a held-open Run stream is never repointed mid-session. Explicit agent overrides and GetServerConfig results are validated as HTTPS `*.cursor.sh` hosts (Cursor's agent hostnames vary and may change); non-`cursor.sh` hosts are rejected. Shared HTTP/2 connections are rotated before they become server-aged, while existing Runs may finish on their original connection. The lookup sends `{ "telem_enabled": false }` by default; set `telemetryEnabled: true` in provider config, or `CURSOR_GET_SERVER_CONFIG_TELEMETRY=1` for OpenCode/plugin usage, to opt in. If the lookup fails or does not return a valid Cursor agent host, the model call fails clearly instead of falling back to `agentn.global.api5.cursor.sh`.

## Development

```bash
bun install          # install dependencies
bun run build        # compile TypeScript → dist/
bun run typecheck    # type-check without emit
bun test             # run unit tests
bun run test:node-http2 # Node-specific HTTP/2 detach regression
bun run test:watch   # watch mode
```

## Architecture

```
OpenCode
  └── CursorPlugin (auth, model cache, config hook)
        └── createCursor() → LanguageModelV3
              ├── session.ts  held-open Run stream + exec bridge
              ├── protocol/   protobuf messages, framing, tools, thinking
              └── transport/  Connect-RPC over HTTP/2 to Cursor's agent backend
```

| Module | Role |
|--------|------|
| `src/plugin.ts` | Classic OpenCode hooks: provider registration, OAuth, API key exchange, token refresh |
| `src/plugin-v2.ts` | OpenCode Effect/Promise v2 plugin (`ctx.aisdk.*`); load via `./plugin/v2` only |
| `src/index.ts` | `createCursor` factory; default export is `CursorPlugin` |
| `src/language-model.ts` | AI SDK `LanguageModelV3` adapter (`doStream`, `doGenerate`) |
| `src/session.ts` | Held-open agent Run session and pending exec correlation |
| `src/debug.ts` | Opt-in wire-level debug logging (`CURSOR_PROVIDER_DEBUG`) |
| `src/auth.ts` | PKCE OAuth, API key exchange, JWT refresh |
| `src/models.ts` | `AvailableModels` fetch and `cursor-models.json` cache |
| `src/agent-url.ts` | `GetServerConfig` fetch + in-process memo (region-specific Run host) |
| `src/transport/connect.ts` | HTTP/2 bidi stream and unary RPC calls |
| `src/protocol/` | Protobuf encode/decode, checksum/device ids, exec + display tool-call mapping (`tool-call-bridge.ts`) |

### Injected system guidance

The provider adds OpenCode-specific system guidance to normal tool-capable conversations, including tool availability and canonical workspace-path grounding. Compaction keeps its dedicated prompt unchanged.

If this guidance causes issues, update `buildOpenCodeInteractionGuidance` in [`src/language-model.ts`](src/language-model.ts) and its focused coverage in [`test/prompt-history.test.ts`](test/prompt-history.test.ts).

## Package exports

| Import path | Export |
|-------------|--------|
| `cursor-opencode-provider` | `createCursor`, `CursorPlugin` (named + default) |
| `cursor-opencode-provider/plugin` | `CursorPlugin` (classic Hooks — auth) |
| `cursor-opencode-provider/plugin/v2` | OpenCode Effect/Promise v2 plugin (`ctx.aisdk.*`) |
| `cursor-opencode-provider/errors` | Structured provider error classes |

The package root intentionally stays plugin-safe for OpenCode's classic loader. `CursorPluginV2` and non-plugin runtime APIs are **not** re-exported from the package root; load them through their dedicated subpaths.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No Cursor models in the picker | Confirm Cursor auth (`opencode auth login` → **cursor**). Restart OpenCode — if auth is present and the cache is empty, models are fetched on startup. Confirm `provider.cursor.npm` is the package name (or a built `file://…/dist/index.js`). |
| Auth / 401 errors mid-session | Re-login. OAuth and exchanged API-key JWTs refresh automatically when near expiry; a revoked refresh token needs a fresh login. |
| “Too many connections from different devices” | Device IDs are derived from stable OS identifiers (same approach as the Cursor CLI). Avoid running multiple clients that invent different machine fingerprints for the same account. |
| Empty or stale model list | Delete `~/.cache/opencode/cursor-models.json` (or under `$XDG_CACHE_HOME/opencode/`) and restart OpenCode. Existing Cursor auth is enough to refill the cache; re-login only if auth itself is broken. Cache TTL is 24h; a failed background refresh keeps serving the previous cache. |
| Stream hangs or HTTP/2 errors | The provider keeps Cursor's Run open across OpenCode tool calls, rotates aged shared connections, and transparently rebases once from full OpenCode history if the Run ends before `turn_ended`. Repeated interruption is surfaced as an error instead of a false successful stop; retry the turn after checking connectivity. With debug logging enabled, look for `Run interrupted` and `rebasing fresh Run`. Restart OpenCode after rebuilding a local `file://` install. |
| No response / silent 200 + close | HTTP 200 alone is not a successful agent turn: the provider now requires Cursor's explicit `turn_ended`, captures HTTP/2 trailers/GOAWAY, and recovers once from bare EOF. The Run host still comes from in-memory `GetServerConfig` resolution; set `CURSOR_PROVIDER_DEBUG=1` to confirm the host and termination reason. |
| Visible `<shell_metadata>` timeout text | Rebuild and restart a local install. Cursor's shell timeout is carried on its exec request; the provider now removes OpenCode's internal timeout envelope before it is rendered or stored, then returns Cursor's typed timeout or background-handoff event instead of treating the text as successful stdout. |
| `Unsupported Cursor exec variant …` | The error names the canonical Cursor CLI request field, its expected result field, and this provider's handling classification. `handling=unsupported` is a known Cursor-native capability without a safe OpenCode AI SDK bridge; `unknown request field` indicates new protocol drift; `handling=opencode-tool` or `provider-control` indicates a provider decoder/dispatch regression. Enable the debug log and report the full named error. |
| Need wire-level logs | Set `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`, default `/tmp/cursor-provider-debug.log`) and reproduce the issue. |

## Known limitations

- **Personal use / ToS** — this provider speaks Cursor’s private agent protocol (CLI-shaped client identity). Use only with an account you own; Cursor may change or restrict the API without notice.
- **`request_context` from OpenCode** — each Run sends Cursor `RequestContext` built from OpenCode project context (workspace env, `AGENTS.md` / `instructions`, `.opencode` agents/skills/plugins, git, layout, plus `.claude`/`.agents` skill fallbacks). Its canonical root is also used by the [injected system guidance](#injected-system-guidance). Same discovery as OpenCode — including `.cursor/` paths only when listed in `instructions`. Cursor-only cloud/sandbox marketplace surfaces are omitted. OpenCode remains the permission authority: its coarse allow/ask/deny configuration is not fabricated into Cursor's unrelated allow/block instruction-list messages.
- **Configured MCP tools keep their upstream server id** — OpenCode builtins and plugin/custom tools are advertised under a synthetic `opencode` MCP server. Tools whose flattened name matches an MCP server in merged `opencode.json` configuration (`github_create_pull_request`, …) are grouped into that server's `mcp_descriptors` / `provider_identifier` (`github`, …). Unknown underscore-containing names stay under `opencode` rather than being guessed incorrectly. Cursor's MCP-state exec probe is answered from the same advertised descriptors before the actual tool request, using the full canonical tool-definition identity required by native `get_mcp_tools`; exec still reconstructs the full OpenCode tool id.
- **Display completions are notifications, not execution requests** — Cursor `tool_call_*` frames use a typed `ToolCall` oneof. The provider decodes them for diagnostics but only mirrors finalized todo/plan state (`update_todos_tool_call` / `create_plan_tool_call`) into advertised OpenCode `todowrite`; the completed payload already contains the authoritative final list. Interactive, data-returning, and side-effecting completions are never replayed as new tools because their result could not be returned to Cursor. Exec-backed native subagent/Task and Pi read/bash/edit/write/grep/find/ls calls use their typed request/result fields instead. Unknown display variants are logged. All 37 Cursor CLI exec request/result pairs are inventoried by field and name; known-but-unsupported and future unknown exec variants fail explicitly rather than receiving a guessed response that could deadlock the Run.
- **Tool availability is per OpenCode agent** — Cursor can request native capabilities such as Task even when a child or restricted OpenCode agent did not advertise the corresponding host tool. The provider prompts Cursor with the exact current catalog and checks every decoded host-tool exec request against it. An unavailable request is answered on Cursor's correlated typed result channel and is never emitted as OpenCode's `invalid` tool.
- **Background shells are non-interactive** — Cursor's native background-shell spawn is bridged through OpenCode's foreground-only `bash` tool by detaching the requested command, redirecting its output to `${TMPDIR:-/tmp}/cursor-opencode-bg.*`, and returning the real PID in Cursor's typed field-16 result. Shell-stream requests also preserve Cursor's foreground timeout, `timeout_behavior`, and `hard_timeout`: cancellation becomes a typed aborted exit, while a soft timeout requested with background behavior becomes a typed background handoff. OpenCode's internal `<shell_metadata>` envelope and the bridge's private markers are stripped before the result reaches the UI. Requests that require `write_shell_stdin` are rejected explicitly because OpenCode does not expose an interactive background-process lifecycle through its AI SDK tool interface.
- **Cursor-native interaction queries remain headless** — Cursor UI/approval *queries* (as distinct from display tool calls) still cannot be surfaced through the AI SDK provider interface. The normal system prompt redirects questions, planning, plan-mode transitions, and known-URL fetching to equivalent OpenCode tools only when they are advertised (`question`, `todowrite`, `plan_enter` / `plan_exit`, `webfetch`); native web/PR/MCP/image/SCM requests are declined so they remain behind OpenCode's tools and permissions. Compaction prompts are unchanged. Unknown future interaction variants fail the turn explicitly instead of hanging the Run stream.
- **Compaction resets Cursor conversation state** — the classic plugin marks OpenCode's `compaction` agent explicitly. On those turns the provider mints an isolated Cursor `conversation_id`, drops the prior checkpoint + KV blobs, preserves real tool-result text in the seed history, and re-advertises the session's last tool catalog while refusing execution during the summary itself. The first normal turn then rebases once more onto a fresh conversation seeded with OpenCode's compacted prompt and normal system instructions, so the summary-agent checkpoint cannot suppress later tool calls. Ordinary no-tool / `toolChoice:none` calls do not reset conversation state.
- **Conversation bindings and compaction catalogs are bounded** — process-global per-session bindings, prior tool catalogs, and pending post-compaction rebases use a 256-session LRU bound. Evicting a conversation binding also drops its checkpoint and KV blobs.
- **Interrupted Runs rebase once** — a remote EOF, Connect end-stream, trailer error, failed continuation write, or closed pending-tool session is never emitted as a successful `stop`. The provider starts one fresh Cursor conversation seeded from the complete OpenCode prompt (including trailing tool results and the live user request), re-advertises the same tools, and preserves compaction's no-execution behavior. A second interruption is returned as an explicit error. Recovery cannot see tokens already streamed to the UI on the interrupted attempt, so mid-generation recovery may briefly duplicate visible text/reasoning even though the rebase prompt asks the model not to repeat completed work.
- **No fallback models** — if Cursor’s `AvailableModels` API is unreachable and there is no local cache, the provider exposes no models.

## License

MIT
