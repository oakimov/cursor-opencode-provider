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

Pin a version if you want: `"cursor-opencode-provider@0.2.8"`.

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

After login, the plugin fetches your available models and writes them to `<host-cache>/cursor-models.json` (default `~/.cache/opencode/`). On later startups, a missing, empty, expired, or old-schema cache is refreshed during config load when Cursor auth is available; an existing stale cache remains usable if refresh fails.

### Paths (host cache)

Model/version caches and Cursor project metadata live under a **host cache root**, resolved in this order:

1. Explicit `createCursor({ cacheDir })` / Effect v2 `Path.cache`
2. Optional `@opencode-compat/profile` `detect()` when it reports strong environment, binary, or package identity
3. Explicit `$MIMOCODE_HOME` / `KILO_CONFIG_DIR`, then the provider's host-named install path under `$XDG_CACHE_HOME`
4. Default `~/.cache/opencode/`

Config-directory presence is deliberately ignored: having MiMo or Kilo installed
must not redirect a native OpenCode process into that host's cache.

| Kind | Default (OpenCode) | Notes |
|------|--------------------|-------|
| Model / version **cache** | `~/.cache/opencode/` | MiMo: `$MIMOCODE_HOME/cache` or `~/.cache/mimocode/`; Kilo: `~/.cache/kilo/` |
| Cursor **project metadata** (`agent-tools`, terminals, …) | `~/.cache/opencode/projects/<slug>/` | under `<host-cache>/projects/` |
| OpenCode **auth** (`auth.json`) | `~/.local/share/opencode/` | `$XDG_DATA_HOME/opencode/` when set |
| OpenCode **config** (AGENTS, skills, …) | `~/.config/opencode/` | still OpenCode-named for rule discovery |

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
  // cacheDir: "/path/to/host/cache", // optional; else host heuristic / ~/.cache/opencode
  // retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 },
  // continuation: { heartbeatMs: 5_000, semanticIdleMs: 120_000, hardCapMs: 600_000 },
})

const model = cursor.languageModel("composer-2.5")
// model implements AI SDK LanguageModelV3 (doStream / doGenerate)
```

Pass either `accessToken` (JWT from OAuth or key exchange) or `apiKey` (raw `sk-...` key). Optional: `apiBaseURL`, `agentBaseURL`, `cacheDir`, `headers`, `telemetryEnabled`, `retry`, and `continuation`. `cacheDir` pins the host cache root for model/version caches and Cursor project metadata; when omitted, the provider uses OCP `@opencode-compat/profile` detect (if installed) or the local MiMo/Kilo/OpenCode heuristic described in [Paths](#paths-host-cache). Transient failures resume from the latest checkpoint produced by that Run, matching Cursor CLI; without an eligible checkpoint, retries remain limited to replay-safe attempts so completed text or tool work is not duplicated. Pending-tool inactivity is renewed by OpenCode activity from the session or its descendants. The older `baseURL` option is still accepted as a legacy alias for `agentBaseURL`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_WEBSITE_URL` | Override OAuth login base URL (default `https://cursor.com`) |
| `CURSOR_API_BASE_URL` | Override API base for auth, model discovery, and `GetServerConfig` agent URL resolution (default `https://api2.cursor.sh`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Set to `1` or `true` to opt the `GetServerConfig` lookup into telemetry in OpenCode/plugin usage |
| `CURSOR_PROVIDER_DEBUG` | Set to `1` or `true` to enable wire-level debug logging |
| `CURSOR_PROVIDER_DEBUG_FILE` | Debug log path (default: `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) |
| `XDG_CACHE_HOME` | Base for host cache dirs (`$XDG_CACHE_HOME/opencode/`, `…/mimocode/`, or `…/kilo/`) when no explicit `cacheDir` / OCP detect override |
| `MIMOCODE_HOME` | When set, host cache is `$MIMOCODE_HOME/cache` (MiMo) |
| `KILO_CONFIG_DIR` | When set, host cache is `$XDG_CACHE_HOME/kilo` |
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
| `src/context/paths.ts` | Host cache root + Cursor project metadata under `<host-cache>/projects/<slug>/` |
| `src/agent-url.ts` | `GetServerConfig` fetch + in-process memo (region-specific Run host) |
| `src/transport/connect.ts` | HTTP/2 bidi stream and unary RPC calls |
| `src/protocol/` | Protobuf encode/decode, checksum/device ids, exec + display tool-call mapping (`tool-call-bridge.ts`) |

### Injected system guidance

The provider adds OpenCode-specific system guidance to normal tool-capable conversations, including tool availability, canonical workspace-path grounding, and preferring `edit` / `write` over shell-based file mutation when those tools are available. Compaction keeps its dedicated prompt unchanged.

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
| Empty or stale model list | Delete `<host-cache>/cursor-models.json` (default `~/.cache/opencode/`, or MiMo/Kilo host cache) and restart OpenCode. Existing Cursor auth is enough to refill the cache; re-login only if auth itself is broken. Cache TTL is 24h; a failed background refresh keeps serving the previous cache. |
| Stream hangs or HTTP/2 errors | The provider keeps Cursor's Run open across OpenCode tool calls, rotates aged shared connections, resumes transient interruptions from the latest eligible Cursor checkpoint, and falls back to a fresh-history rebase only before stateful output when no checkpoint exists. Repeated interruption is surfaced as an error instead of a false successful stop; retry the turn after checking connectivity. With debug logging enabled, look for `Run interrupted`, `resuming … checkpoint`, or `rebasing fresh Run`. Restart OpenCode after rebuilding a local `file://` install. |
| No response / silent 200 + close | HTTP 200 alone is not a successful agent turn: the provider now requires Cursor's explicit `turn_ended`, captures HTTP/2 trailers/GOAWAY, and recovers once from bare EOF. The Run host still comes from in-memory `GetServerConfig` resolution; set `CURSOR_PROVIDER_DEBUG=1` to confirm the host and termination reason. |
| Visible `<shell_metadata>` timeout text | Rebuild and restart a local install. Cursor's shell timeout is carried on its exec request; the provider now removes OpenCode's internal timeout envelope before it is rendered or stored, then returns Cursor's typed timeout or background-handoff event instead of treating the text as successful stdout. |
| `Unsupported Cursor exec variant …` | The error names the canonical Cursor CLI request field, its expected result field, and this provider's handling classification. `handling=unsupported` is a known Cursor-native capability without a safe OpenCode AI SDK bridge; `unknown request field` indicates new protocol drift; `handling=opencode-tool` or `provider-control` indicates a provider decoder/dispatch regression. Enable the debug log and report the full named error. |
| Need wire-level logs | Set `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`; the default is `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) and reproduce the issue. |

## Security

Project `instructions` may reference absolute or `~/` paths (OpenCode parity). See [SECURITY.md](./SECURITY.md) for the trust model and `OPENCODE_DISABLE_PROJECT_CONFIG`.

## Known limitations

- **Personal use / ToS** — this provider speaks Cursor’s private agent protocol (CLI-shaped client identity). Use only with an account you own; Cursor may change or restrict the API without notice.
- **`request_context` from OpenCode** — each Run sends Cursor `RequestContext` built from OpenCode project context (workspace env, `AGENTS.md` / `instructions`, `.opencode` agents/skills/plugins, git, layout, plus `.claude`/`.agents` skill fallbacks). Its canonical root is also used by the [injected system guidance](#injected-system-guidance). Same discovery as OpenCode — including `.cursor/` paths only when listed in `instructions`. Cursor-only cloud/sandbox marketplace surfaces are omitted. `env.workspace_paths` / `process_working_directory` stay on the real git workspace; Cursor's metadata root (`project_folder`, MCP `workspace_project_dir`, terminals/transcripts) is advertised under `<host-cache>/projects/<slug>/` (default `~/.cache/opencode/projects/…`) so dumps like `agent-tools/` do not land in the repo. OpenCode remains the permission authority: its coarse allow/ask/deny configuration is not fabricated into Cursor's unrelated allow/block instruction-list messages.
- **Configured MCP tools keep their upstream server id** — OpenCode builtins and plugin/custom tools are advertised under a synthetic `opencode` MCP server. Tools whose flattened name matches an MCP server in merged `opencode.json` configuration (`github_create_pull_request`, …) are grouped into that server's `mcp_descriptors` / `provider_identifier` (`github`, …). Unknown underscore-containing names stay under `opencode` rather than being guessed incorrectly. Cursor's MCP-state exec probe is answered from the same advertised descriptors before the actual tool request, using the full canonical tool-definition identity required by native `get_mcp_tools`; exec still reconstructs the full OpenCode tool id.
- **Display completions are notifications, not execution requests** — Cursor `tool_call_*` frames use a typed `ToolCall` oneof. The provider decodes them for diagnostics but only mirrors finalized todo/plan state (`update_todos_tool_call` / `create_plan_tool_call`) into advertised OpenCode `todowrite`; the completed payload already contains the authoritative final list. Interactive, data-returning, and side-effecting completions are never replayed as new tools because their result could not be returned to Cursor. Exec-backed native subagent/Task and Pi read/bash/edit/write/grep/find/ls calls use their typed request/result fields instead. Unknown display variants are logged. All 37 Cursor CLI exec request/result pairs are inventoried by field and name; known-but-unsupported and future unknown exec variants fail explicitly rather than receiving a guessed response that could deadlock the Run.
- **Tool availability is per OpenCode agent** — Cursor can request native capabilities such as Task even when a child or restricted OpenCode agent did not advertise the corresponding host tool. The provider prompts Cursor with the exact current catalog and checks every decoded host-tool exec request against it. An unavailable request is answered on Cursor's correlated typed result channel and is never emitted as OpenCode's `invalid` tool.
- **Host web tools use collision-safe aliases** — Cursor sees `custom_websearch` / `custom_webfetch`, and the held Run maps each alias back to an executable OpenCode tool with its schema, permission check, and correlated result intact. The plugin registers its search fallback directly as `custom_websearch`, avoiding OpenCode's reserved `websearch` id filter for third-party providers and taking precedence over MCP search providers such as Brave without host environment configuration. Exact host `webfetch` is translated the same way. Cursor's UI-bound native web interactions stay disabled because their approval replies cannot carry OpenCode tool results.
- **Background shells are non-interactive** — Cursor's native background-shell spawn and soft-background shell-stream timeouts are bridged through OpenCode's foreground-only `bash` tool. With bash/zsh, the classic plugin keeps the original permission/UI command and executes the wrapper through `shell.env` (`BASH_ENV` / `ZDOTDIR`); OpenCode's non-interactive sh/dash argv ignores those startup variables, so the plugin uses a short `exec /bin/sh '<wrapper-file>'` command backed by the same private wrapper. Native background-spawn requests also carry a self-contained marker-producing fallback when the classic hooks are absent. Spawn/soft-bg wrappers detach with `nohup`, redirect output under `${TMPDIR:-/tmp}/cursor-opencode-{bg,shell}.*`, and return the real PID (or typed timeout/exit) to Cursor. Private markers and OpenCode's `<shell_metadata>` envelope are stripped before storage/render, with a short still-running / started / timed-out status line left for the bash bubble. Requests that require `write_shell_stdin` are rejected explicitly because OpenCode does not expose an interactive background-process lifecycle through its AI SDK tool interface. The POSIX wrap path is not implemented for native Windows PowerShell/`cmd`.
- **Cursor-native interaction queries remain headless** — Cursor UI/approval *queries* (as distinct from display tool calls) still cannot be surfaced through the AI SDK provider interface. The normal system prompt redirects questions, planning, plan-mode transitions, and available web capabilities to executable host tools (`question`, `todowrite`, `plan_enter` / `plan_exit`, `custom_websearch`, `custom_webfetch`); native web/PR/MCP/image/SCM requests are declined so they remain behind host tool permissions. Separately from display `create_plan_tool_call` → `todowrite` mirroring, interaction `create_plan_request_query` is auto-acked (CLI headless parity) with success and an empty `plan_uri`, so Cursor may treat the plan as accepted without an OpenCode UI confirm. Compaction prompts are unchanged. Unknown future interaction variants fail the turn explicitly instead of hanging the Run stream.
- **Compaction resets Cursor conversation state** — the classic plugin marks OpenCode's `compaction` agent explicitly. On those turns the provider mints an isolated Cursor `conversation_id`, drops the prior checkpoint + KV blobs, preserves real tool outputs as OpenCode-host observations in the seed history, and re-advertises the session's last tool catalog while refusing execution during the summary itself. The first normal turn then rebases once more onto a fresh conversation seeded with OpenCode's compacted prompt and normal system instructions, so the summary-agent checkpoint cannot suppress later tool calls. Ordinary no-tool / `toolChoice:none` calls do not reset conversation state.
- **Conversation bindings and compaction catalogs are bounded** — process-global per-session bindings, prior tool catalogs, and pending post-compaction rebases use a 256-session LRU bound. Evicting a conversation binding also drops its checkpoint and KV blobs.
- **Interrupted Runs resume from checkpoints** — a remote EOF, Connect end-stream, or trailer error is never emitted as a successful `stop`. When the failed Run produced an eligible checkpoint, the provider opens a new RPC for the same conversation and sends that state with `ResumeAction`, so completed text and tool work are not replayed. Before any stateful output, an interruption without a checkpoint can still rebase from OpenCode history. Stateful interruptions without a checkpoint are surfaced because replay would be ambiguous; retry exhaustion remains explicit. A transport closure after `turn_ended` is treated as successful completion.
- **No fallback models** — if Cursor’s `AvailableModels` API is unreachable and there is no local cache, the provider exposes no models.

## License

MIT
