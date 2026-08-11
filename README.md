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
- **Image input** — advertises vision only for supported models and forwards OpenCode image attachments to Cursor
- **Streaming** — bidirectional Connect-RPC Runs with stale-session rotation, health checks, semantic/read-idle deadlines, bounded replay-safe recovery, and activity-aware held tool continuations
- **Tool calls** — maps Cursor exec-server messages to AI SDK / OpenCode tool-call parts, including catalog-aware native subagent execution: exact advertised custom agents win, `unspecified` / `generalPurpose` select `general`, read-oriented `bugbot` / `security-review` select `explore`, and `cursor-guide` selects enabled Kilo `scout` before `explore`; MiMo `actor` is used instead of its work-item `task` tool when advertised. The bridge also covers the Pi read/bash/edit/write/grep/find/ls request/result range, enforces the exact current OpenCode tool catalog, mirrors finalized display-only todo/plan state, and strips OpenCode's `read` XML envelope before returning content to Cursor.
- **Thinking / reasoning** — surfaces extended-thinking deltas where the model supports it

## Requirements

- [Bun](https://bun.sh) (for development and tests)
- [OpenCode](https://opencode.ai) with plugin support
- An active Cursor account with API access

## Installation

### From npm

Add the package to OpenCode config. OpenCode installs npm plugins with Bun at startup (cached under `~/.cache/opencode/node_modules/`):

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

Pin a version if you want: `"cursor-opencode-provider@0.4.0"`.

You can also install it yourself first:

```bash
npm install cursor-opencode-provider
# or: bun add cursor-opencode-provider
```

### From a local clone

```bash
git clone https://github.com/oakimov/cursor-opencode-provider.git
cd cursor-opencode-provider
bun install
bun run build
```

Point classic OpenCode config at the built files with absolute `file://` URLs:

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

For **OpenCode 2.0** local development, prefer the plugin path plus `CURSOR_OPENCODE2_DEV_ENTRY` — see [OpenCode 2.0 beta](#opencode-20-beta-opencode2).

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

### OpenCode 2.0 beta (`opencode2`)

OpenCode 2.0 uses a different plugin API from the 1.18 `/v2/promise` one above — they
are source-incompatible, so this package ships a **separate** entrypoint for it.
Everything is registered by that one plugin. You do **not** need a `providers` entry,
and there is no `enabled` flag. Do not also load `./plugin/v2` or the classic `plugin`
entry under `opencode2`; they target the older APIs.

Authenticate with `/connect` inside `opencode2`, choose **Cursor**, then either
browser login or an API key. `CURSOR_API_KEY` is also picked up automatically.

#### From npm

```json
{
  "plugins": ["cursor-opencode-provider/plugin/opencode2"]
}
```

Pin a version if you want: `"cursor-opencode-provider@0.4.0/plugin/opencode2"`.

OpenCode 2.0 installs the published package into its host cache and loads the AI SDK
entry from there (`aisdk:cursor-opencode-provider`). No extra env vars are required.

#### From a local clone (`CURSOR_OPENCODE2_DEV_ENTRY`)

Loading only the local plugin file is not enough for end-to-end local testing: OpenCode
2.0's catalog still resolves the AI SDK package through `npm install` into
`<host-cache>/packages/…` unless you override it. Point
`CURSOR_OPENCODE2_DEV_ENTRY` at the built provider entry (`dist/index.js`, which exports
`createCursor`) so the host imports that file directly.

```bash
cd /absolute/path/to/cursor-opencode-provider
bun install && bun run build

export CURSOR_OPENCODE2_DEV_ENTRY=/absolute/path/to/cursor-opencode-provider/dist/index.js
# optional while debugging:
# export CURSOR_PROVIDER_DEBUG=1
```

Example OpenCode 2.0 config (for example `~/.config/opencode/opencode.json` or a
project `opencode.json`) that loads the built local plugin:

```json
{
  "plugins": [
    "/absolute/path/to/cursor-opencode-provider/dist/plugin-opencode2.js"
  ]
}
```

Equivalent forms for the same plugin entry:

- `"file:///absolute/path/to/cursor-opencode-provider/dist/plugin-opencode2.js"`
- `"../cursor-opencode-provider/dist/plugin-opencode2.js"` (relative to the config file; must start with `./` or `../`)

You can also drop a symlink into `.opencode/plugins/` (or `~/.config/opencode/plugins/`),
which OpenCode scans automatically:

```bash
mkdir -p .opencode/plugins
ln -s /absolute/path/to/cursor-opencode-provider/dist/plugin-opencode2.js \
      .opencode/plugins/cursor.js
```

Important for local 2.0 development:

- **Export the env var before starting the daemon.** `opencode2 serve --service` inherits
  env only at start time. After changing `CURSOR_OPENCODE2_DEV_ENTRY` or rebuilding
  `dist/`, restart the service:

  ```bash
  opencode2 service stop
  export CURSOR_OPENCODE2_DEV_ENTRY=/absolute/path/to/cursor-opencode-provider/dist/index.js
  opencode2 service start
  ```

  `opencode2 service set` does **not** accept arbitrary env var names.
- **Unset `CURSOR_OPENCODE2_DEV_ENTRY` in production** so the catalog uses the published
  `aisdk:cursor-opencode-provider` package again.
- **OpenCode does not install dependencies for local plugin files.** Keep the clone's
  `bun install` intact and load the plugin from inside the clone (a copied-out file will
  not resolve `protobufjs`).
- **Rebuild after every change** (`bun run build`). The daemon reads `dist/`, not `src/`.

Feature parity with the classic plugin, and the two places 2.0 differs:

| Classic plugin | OpenCode 2.0 plugin |
|---|---|
| `config` hook registers provider + models | `ctx.catalog.transform` |
| `auth` hook (OAuth + API key) | `ctx.integration.transform` + `/connect` |
| `tool` hook (`custom_websearch`) | `ctx.tool.transform` |
| `event` hook (session activity) | `ctx.event.subscribe` |
| `tool.execute.before` / `.after` | `ctx.tool.hook(...)` |
| `shell.env` injects the timeout wrapper | **No `shell.env` in 2.0** — the bash command is rewritten to call the wrapper file instead (same behavior, different mechanism) |
| `chat.params` flags compaction turns | **No `chat.params` in 2.0** — the compaction agent is detected in `ctx.session.hook("context")` and correlated by session id |

> **Beta.** OpenCode 2.0 and its plugin API are both beta and still changing. This
> entrypoint is built against `@opencode-ai/plugin@next` (`0.0.0-next-17155`) and is
> guarded by a compile-time conformance check, but expect churn.

### Authenticate

```bash
opencode auth login
```

Choose the **cursor** provider, then one of:

| Method | Description |
|--------|-------------|
| **Cursor account (browser login)** | PKCE OAuth — opens cursor.com to sign in |
| **API key** | Paste a key from [cursor.com/settings](https://cursor.com/settings) (`crsr_...`) |

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

#### Context limit sources

The provider resolves each catalog context limit in this order:

1. Live `AvailableModels` metadata (variant `context` parameters first, then context-limit fields)
2. Cursor’s published model table, generated from [`docs.md`](https://cursor.com/docs.md) alongside pricing data
3. A conservative `200000` fallback when neither source publishes a limit

The docs fallback only fills static catalog metadata. It does not invent Cursor variants or enable a long-context tier that `AvailableModels` did not advertise.

#### Image input

The provider advertises `text` + `image` input only when the selected Cursor model supports images; model output remains text. This works in the classic plugin, the 1.18 v2 plugin, and OpenCode 2.0.

Image support is resolved in this order:

1. Live `AvailableModels.supportsImages` metadata, including authoritative `false` values
2. The `Capabilities` column in Cursor's [`docs.md`](https://cursor.com/docs.md), generated alongside context and pricing metadata
3. Text-only when neither source describes the model

OpenCode image file parts are decoded from bytes, base64/data URLs, local file URLs, or HTTP(S) URLs and sent through Cursor's `UserMessage.selected_context.selected_images` field. On fresh or rebased Runs, the provider also harvests image `file-data` from tool results and `file` parts from assistant history; previously sent history images are deduplicated by content hash per OpenCode session. Held-open continuation results remain text-only because Cursor's exec-result channel has no image field. Attachments are limited to 20 MiB total, matching OpenCode's desktop attachment budget. PDF, audio, and video inputs are not advertised or silently discarded.

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

Pass either `accessToken` (JWT from OAuth or key exchange) or `apiKey` (raw `crsr_...` key). Optional: `apiBaseURL`, `agentBaseURL`, `cacheDir`, `headers`, `telemetryEnabled`, `retry`, and `continuation`. `cacheDir` pins the host cache root for model/version caches and Cursor project metadata; when omitted, the provider uses OCP `@opencode-compat/profile` detect (if installed) or the local MiMo/Kilo/OpenCode heuristic described in [Paths](#paths-host-cache). Transient failures resume from the latest checkpoint produced by that Run, matching Cursor CLI; without an eligible checkpoint, retries remain limited to replay-safe attempts so completed text or tool work is not duplicated. Pending-tool inactivity is renewed by OpenCode activity from the session or its descendants. The older `baseURL` option is still accepted as a legacy alias for `agentBaseURL`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_WEBSITE_URL` | Override OAuth login base URL (default `https://cursor.com`) |
| `CURSOR_API_BASE_URL` | Override API base for auth, model discovery, and `GetServerConfig` agent URL resolution (default `https://api2.cursor.sh`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Set to `1` or `true` to opt the `GetServerConfig` lookup into telemetry in OpenCode/plugin usage |
| `CURSOR_PROVIDER_DEBUG` | Set to `1` or `true` to enable wire-level debug logging |
| `CURSOR_PROVIDER_DEBUG_FILE` | Debug log path (default: `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) |
| `CURSOR_OPENCODE2_DEV_ENTRY` | **Local OpenCode 2.0 only.** Absolute path to a built entry file (usually `dist/index.js`). Rewrites the catalog's AI SDK package to `aisdk:file://…` so the daemon imports your local build instead of `npm install`-ing the published package. Export it **before** `opencode2 service start`, then restart after rebuilds. Unset in production. |
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
| `src/plugin-v2.ts` | OpenCode 1.18 Effect/Promise v2 plugin (`ctx.aisdk.*`); load via `./plugin/v2` only |
| `src/plugin-opencode2.ts` | OpenCode 2.0 beta plugin (catalog, integration, tools, aisdk); load via `./plugin/opencode2` only |
| `src/opencode2/` | 2.0-only catalog mapping, integration/auth, and local API types |
| `src/plugin-core.ts` | Host-neutral SDK factory, package matching, API base/telemetry resolution |
| `src/model-config.ts` | Cursor model → OpenCode model mapping shared by every plugin surface |
| `src/image-input.ts` | AI SDK image attachment validation, decoding, and size limits |
| `src/pricing.ts` / `src/pricing-data.ts` | Cursor docs token rates → classic `cost` and OpenCode 2.0 cost tiers |
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

The provider adds OpenCode-specific system guidance to normal tool-capable conversations, including tool availability, canonical workspace-path grounding, and preferring `edit` / `write` (or `apply_patch`, when the host advertises that instead) over shell-based file mutation when those tools are available. Compaction keeps its dedicated prompt unchanged.

If this guidance causes issues, update `buildOpenCodeInteractionGuidance` in [`src/language-model.ts`](src/language-model.ts) and its focused coverage in [`test/prompt-history.test.ts`](test/prompt-history.test.ts).

### `apply_patch` models (GPT-5 and friends)

OpenCode 1.x does not simply add `apply_patch` for GPT-series models — it **removes** `edit` and `write` from the tool catalog and advertises `apply_patch` in their place (`ToolRegistry.tools`; the model id must contain `gpt-` and neither `oss` nor `gpt-4`). Cursor keeps sending its native write/edit requests regardless, so without translation every file change on a `gpt-5*` model is refused as an unavailable tool.

The provider translates transparently: a native write becomes an `*** Add File:` patch, and a Pi edit becomes a minimal `*** Update File:` chunk widened to whole lines. This is keyed purely off what the host advertises — it is inert whenever `edit`/`write` are offered normally, and inert again when the host offers neither those nor `apply_patch`. An edit that cannot be expressed faithfully (target unreadable, or the text to replace is absent or ambiguous) is refused with a specific message rather than applied to the wrong region.

OpenCode 2.0 does not perform this substitution, so the path is 1.x-only in practice. See [`src/protocol/apply-patch.ts`](src/protocol/apply-patch.ts) for the upstream references.

### Native subagent routing

The provider reads the permission-filtered subagent catalog from the current host `task` or `actor` definition and advertises those recipients to Cursor as custom subagents. Exact configured names are preserved; unknown future Cursor subtype strings fall back to `general`. If a complete catalog omits every compatible recipient, the request fails on Cursor's typed subagent channel instead of selecting an arbitrary specialist.

| Host | Default recipients | Optional recipients |
|------|--------------------|---------------------|
| OpenCode | `general`, `explore` | Add `agent/*.md` or `agents/*.md` with `mode: subagent` or `all` |
| Kilo | `general`, `explore` | Enable `scout` with `KILO_EXPERIMENTAL_SCOUT=true` (or `KILO_EXPERIMENTAL=true`); add `.kilo/agent/*.md` custom agents with `mode: subagent` or `all` |
| MiMo | `general`, `explore` | Add `.mimocode/agent/*.md` with `mode: subagent` |

Kilo `scout` is reserved for external documentation, dependency repositories, and upstream source. Local workspace discovery continues to use `explore`. Primary modes and hidden/internal agents are never selected unless the host explicitly exposes them as spawnable.

## Package exports

| Import path | Export |
|-------------|--------|
| `cursor-opencode-provider` | `createCursor`, `CursorPlugin` (named + default) |
| `cursor-opencode-provider/plugin` | `CursorPlugin` (classic Hooks — auth) |
| `cursor-opencode-provider/plugin/v2` | OpenCode 1.18 Effect/Promise v2 plugin (`ctx.aisdk.*`) |
| `cursor-opencode-provider/plugin/opencode2` | OpenCode 2.0 beta plugin (self-registering: catalog + auth + tools) |
| `cursor-opencode-provider/errors` | Structured provider error classes |

The package root intentionally stays plugin-safe for OpenCode's classic loader. `CursorPluginV2` and non-plugin runtime APIs are **not** re-exported from the package root; load them through their dedicated subpaths.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No Cursor models in the picker | Confirm Cursor auth (`opencode auth login` → **cursor**, or `/connect` in `opencode2`). Restart OpenCode — if auth is present and the cache is empty, models are fetched on startup. Confirm `provider.cursor.npm` is the package name (or a built `file://…/dist/index.js`). |
| Auth / 401 errors mid-session | Re-login. OAuth and exchanged API-key JWTs refresh automatically when near expiry; a revoked refresh token needs a fresh login. |
| Local OpenCode 2.0 still runs the published package | Set `CURSOR_OPENCODE2_DEV_ENTRY` to an absolute `…/dist/index.js` path **before** starting the daemon, rebuild (`bun run build`), then `opencode2 service stop && opencode2 service start`. Loading only `dist/plugin-opencode2.js` is not enough — without the env var, 2.0 still `npm install`s the published package into the host cache. |
| “Too many connections from different devices” | Device IDs are derived from stable OS identifiers (same approach as the Cursor CLI). Avoid running multiple clients that invent different machine fingerprints for the same account. |
| Empty or stale model list | Delete `<host-cache>/cursor-models.json` (default `~/.cache/opencode/`, or MiMo/Kilo host cache) and restart OpenCode. Existing Cursor auth is enough to refill the cache; re-login only if auth itself is broken. Cache TTL is 24h; a failed background refresh keeps serving the previous cache. |
| Stream hangs or HTTP/2 errors | The provider keeps Cursor's Run open across OpenCode tool calls, rotates aged shared connections, resumes transient interruptions from the latest eligible Cursor checkpoint, and falls back to a fresh-history rebase only before stateful output when no checkpoint exists. Repeated interruption is surfaced as an error instead of a false successful stop; retry the turn after checking connectivity. With debug logging enabled, look for `Run interrupted`, `resuming … checkpoint`, or `rebasing fresh Run`. Restart OpenCode after rebuilding a local `file://` install. |
| No response / silent 200 + close | HTTP 200 alone is not a successful agent turn: the provider now requires Cursor's explicit `turn_ended`, captures HTTP/2 trailers/GOAWAY, and recovers once from bare EOF. The Run host still comes from in-memory `GetServerConfig` resolution; set `CURSOR_PROVIDER_DEBUG=1` to confirm the host and termination reason. |
| Visible `<shell_metadata>` timeout text | Rebuild and restart a local install. Cursor's shell timeout is carried on its exec request; the provider now removes OpenCode's internal timeout envelope before it is rendered or stored, then returns Cursor's typed timeout or background-handoff event instead of treating the text as successful stdout. |
| `Unsupported Cursor exec variant …` | The error names the canonical Cursor CLI request field, its expected result field, and this provider's handling classification. `handling=unsupported` is a known Cursor-native capability without a safe OpenCode AI SDK bridge; `unknown request field` indicates new protocol drift; `handling=opencode-tool` or `provider-control` indicates a provider decoder/dispatch regression. Enable the debug log and report the full named error. |
| Need wire-level logs | Set `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`; the default is `debug-<pid>.log` under `$TMPDIR/cursor-provider-logs-<uid>/`) and reproduce the issue. |
| Cache **write** tokens always show as `0` | Not a mapping bug in this provider. Cursor's `TurnEnded` protobuf includes `cache_write` (field 4) and this package forwards it as AI SDK `inputTokens.cacheWrite` / OpenCode `cache.write`. Real agent sessions send field 4 as `0` even when `cache_read` is large on later turns. With debug logging, confirm `turn_ended raw wire fields: … f4:wt0=0` and `v3CacheWrite=0 source=turn_ended`. Cache **read** counts from the same message do populate correctly. |

## Security

Project `instructions` may reference absolute or `~/` paths (OpenCode parity). See [SECURITY.md](./SECURITY.md) for the trust model and `OPENCODE_DISABLE_PROJECT_CONFIG`.

## Known limitations

- **Personal use / ToS** — this provider speaks Cursor’s private agent protocol (CLI-shaped client identity). Use only with an account you own; Cursor may change or restrict the API without notice.
- **`TurnEnded.cache_write` is unused by Cursor's agent** — usage comes from `interaction_update.turn_ended` (`input_tokens`, `output_tokens`, `cache_read`, `cache_write`, `reasoning_tokens`). The provider maps those 1:1 into AI SDK V3 nested usage. Captured live Runs consistently set `cache_write=0` on the wire while still reporting non-zero `cache_read` and `reasoning_tokens`; there is no alternate agent-stream field today that supplies write counts, so OpenCode/Kilo cannot show cache-write tokens for this provider until Cursor populates that counter.
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
- **Large reads are capped at 50 KB by OpenCode, and the cap is reported** — OpenCode's `read` tool stops at `MAX_BYTES = 50 * 1024`, cutting on a whole-line boundary, and appends `(Output capped at 50 KB. Showing lines X-Y. Use offset=N to continue.)`. The provider strips that envelope before returning content to Cursor so the model cannot echo wrappers into a later write, but it re-states the cap: a capped native read appends a `[Partial read: …]` marker after the content, a capped MCP read gets a separate notice content item, and a Pi read carries structured `PiReadExecSuccess.truncation`. The structured `truncated` flag alone is not enough — verified against live `gpt-5.4-mini` and `grok-4.5` sessions, both of which asserted "highly confident" that partial content was the whole file until the textual marker was added. Deliberately paged reads (explicit `offset`/`limit`) are not marked. Without that signal the model treats a capped read as the whole file and rewrites it truncated, discarding everything past the cap. The cap is hardcoded in OpenCode's read tool — it is not the configurable `tool_output.max_bytes`, which governs `Truncate.Service` and not read's line accumulation — so the only lever is paging with `offset`. Prefer `edit` over whole-file `write` on files above 50 KB.
- **No fallback models** — if Cursor’s `AvailableModels` API is unreachable and there is no local cache, the provider exposes no models.

## License

MIT
