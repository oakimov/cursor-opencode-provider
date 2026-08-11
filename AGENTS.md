# cursor-opencode-provider

OpenCode plugin + AI SDK provider that runs Cursor subscription models by speaking Cursor’s Connect-RPC agent protocol (not a generic chat-completions API).

**Stack:** TypeScript (ESM), Bun for install/test, `tsc` for build. Peer: `@opencode-ai/plugin@^1.17.13` (devDependency pinned to `^1.18.16`). Optional peer: `@opencode-compat/profile` (host cache via OCP `detect()`). Deps: `@ai-sdk/provider@3.0.15`, `protobufjs@^7.6.5`. OpenCode 2.0 conformance types: `@opencode-ai/plugin-next` → `npm:@opencode-ai/plugin@0.0.0-next-17155`.

## Commands

```bash
bun install
bun run build        # tsc → dist/
bun run typecheck
bun test
bun run test:watch
bun run generate:pricing   # refresh src/pricing-data.ts from Cursor docs
bun run check:pricing      # fixture coverage for known model ids
```

Publish surface is `dist/` only (`files` in `package.json`). Always rebuild before testing a local `file://` OpenCode install. Tagged npm publishes (`.github/workflows/publish.yml`) and local `npm publish` (`prepublishOnly`) refresh Cursor pricing from the docs before build so released packages carry current rates.

## Architecture

```
OpenCode
  └── CursorPlugin (auth, model cache, config hook)
        └── createCursor() → LanguageModelV3
              ├── session.ts     held-open Run stream + exec bridge
              ├── context/       RequestContext from OpenCode discovery
              ├── protocol/      protobuf encode/decode, tools, thinking
              └── transport/     Connect-RPC over HTTP/2
```

| Area | Path | Notes |
|------|------|--------|
| Package entry | `src/index.ts` | `createCursor`; default export = classic `CursorPlugin` |
| Classic plugin | `src/plugin.ts` | Auth, OAuth, model cache, provider registration |
| V2 plugin (1.18) | `src/plugin-v2.ts` | Effect/Promise API via `ctx.aisdk.*` — load **only** as `./plugin/v2` |
| OpenCode 2.0 plugin | `src/plugin-opencode2.ts` | 2.0 beta API — load **only** as `./plugin/opencode2` |
| 2.0 support modules | `src/opencode2/` | Catalog mapping, integration/auth, local 2.0 API types |
| Host-neutral core | `src/plugin-core.ts`, `src/model-config.ts` | Shared by every plugin surface; must not import a host plugin API |
| Model pricing | `src/pricing.ts`, `src/pricing-data.ts` | Cursor docs → classic `cost` + OpenCode 2.0 cost tiers; regenerate via `bun run generate:pricing` |
| Language model | `src/language-model.ts` | AI SDK `LanguageModelV3` (`doStream` / `doGenerate`) |
| Session | `src/session.ts` | Held-open agent Run + pending exec correlation |
| Auth / models | `src/auth.ts`, `src/models.ts` | PKCE/API key, JWT refresh, `cursor-models.json` cache |
| Agent host | `src/agent-url.ts` | `GetServerConfig` → region-specific Run host (in-memory memo) |
| Request context | `src/context/` | Rules, skills, agents, plugins, git, layout, env |
| Host paths | `src/context/paths.ts` | Host cache root (`cacheDir` / OCP detect / MiMo·Kilo·OpenCode heuristic); project metadata under `<host-cache>/projects/<slug>/` |
| Wire protocol | `src/protocol/` | Framing, messages, tools, thinking, checksums, device id |
| Patch synthesis | `src/protocol/apply-patch.ts` | `apply_patch` envelopes for hosts that withhold `edit`/`write` |
| Transport | `src/transport/connect.ts` | HTTP/2 bidi + unary RPC |

Package exports:

- `cursor-opencode-provider` → `createCursor` + classic plugin
- `cursor-opencode-provider/plugin` → classic Hooks (auth)
- `cursor-opencode-provider/plugin/v2` → 1.18 v2 plugin only (`CursorPluginV2` is **not** on the root export)
- `cursor-opencode-provider/plugin/opencode2` → OpenCode 2.0 beta plugin only

## OpenCode 2.0 vs the 1.18 "v2" plugin API

These are **source-incompatible APIs, not versions of one API**. Keep them in separate
entrypoints; never try to unify them.

| | 1.18 (`@opencode-ai/plugin@^1.17.13`, `/v2/promise`) | 2.0 beta (`@opencode-ai/plugin@next` / `0.0.0-next-17155`) |
|---|---|---|
| Import | `define` from `.../v2/promise` | `Plugin.define` from the package root |
| Hook shape | `ctx.aisdk.sdk(cb)` | `ctx.aisdk.hook("sdk", cb)` |
| OAuth registration | Effect-valued | Promise-valued |
| Domains | agent, aisdk, catalog, command, integration, plugin, reference, skill | + `app`, `event`, `session`, `tool`, `websearch` |
| Provider schema | `api: { type: "aisdk", package }` | flat `package: "aisdk:…"` |

`src/plugin-opencode2.ts` deliberately does **not** import `@opencode-ai/plugin` at
runtime: the 2.0 types only exist on the `@next` dist-tag and cannot coexist with the
`^1.17.13` dependency under the same specifier. It exports a plain `{ id, setup }`
object (the host's `define` is an identity function) and types it from
`src/opencode2/types.ts`. The aliased `@opencode-ai/plugin-next` devDependency exists
solely so `test/opencode2-conformance.types.ts` can prove, at compile time, that the
real 2.0 API still supports every call the plugin makes. That file is checked by
`tsc -p tsconfig.test.json` (wired into `bun run typecheck`) — the rest of `test/` is
not typechecked.

Two 1.x hooks have no 2.0 equivalent and are emulated:
- **`shell.env`** — gone. The bash command is rewritten to invoke the wrapper file
  (`prepareCursorShellArgs(..., { preferWrapperCommand: true })`) instead of injecting
  `BASH_ENV`/`ZDOTDIR`.
- **`chat.params`** — gone. `ctx.session.hook("context")` is the only place the runtime
  names the owning agent, so compaction turns are recorded there in
  `src/compaction-marker.ts` and read back in `doStream` via the session id the
  provider already derives from request headers.

## Working conventions

- Prefer minimal, targeted changes. Fix root causes; no temporary workarounds.
- Do not commit unless the user (or an explicit implementation task) asks.
- Keep README accurate when behavior users care about changes (auth, env vars, architecture, limitations).
- Tests live in `test/` (Bun test). Mirror protocol/context behavior with unit tests when changing encode/decode or discovery.

## Context this provider sends to Cursor

`src/context/build.ts` builds Cursor `RequestContext` from OpenCode-shaped discovery:

- First of `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` walking up to the git worktree
- Global `~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md`
- `instructions` globs from merged `opencode.json` / `opencode.jsonc` (including `.cursor/` **only** when listed)
- `.opencode` agents/skills/plugins, plus `.claude` / `.agents` skill fallbacks
- Git + project layout + env

When changing rule/skill discovery, keep parity with OpenCode behavior and update `test/context.test.ts`.

## Critical behavioral constraints

- **Agent host:** resolve via `GetServerConfig` (`agentUrlConfig.agentnUrl`). Memoize once per process in memory; never write to disk; never silently fall back to a legacy global host on failure.
- **URL options:** `apiBaseURL` (auth/models/GetServerConfig) vs `agentBaseURL` (Run stream) are separate. Legacy `baseURL` aliases `agentBaseURL` only.
- **Host validation:** explicit agent overrides and GetServerConfig results must be HTTPS `*.cursor.sh`; reject others.
- **Telemetry:** `GetServerConfig` sends `telem_enabled: false` by default; opt in via `telemetryEnabled` or `CURSOR_GET_SERVER_CONFIG_TELEMETRY`.
- **Tool results:** strip OpenCode’s `read` XML envelope before returning content to Cursor so the model cannot echo wrappers into writes. Stripping must not also drop the truncation footer's *meaning*: OpenCode caps reads at 50 KB (`tool/read.ts` `MAX_BYTES`), so re-state the cap or the model treats a capped read as the whole file. Native `read_args` → `read_result` is the path models actually use (verified live for `gpt-5.4-mini` and `grok-4.5`); its structured `truncated` flag is **not** sufficient on its own, so the content also carries a `[Partial read: …]` marker. `mcp_result` gets a separate notice item and Pi reads get structured `truncation`. Never mark a read the caller bounded itself with `offset`/`limit`.
- **Write content:** `WriteArgs` has six fields. `file_bytes` (#5) carries the content whenever Cursor sends bytes instead of `file_text`, decoded per `encoding_hint` (#6); Cursor's own executor prefers bytes when non-empty. Never re-add those two to `CURSOR_INTERNAL_KEYS` — they are content, not transport metadata.
- **Edit-tool substitution:** OpenCode 1.x drops `edit`/`write` from the catalog and advertises `apply_patch` for `gpt-*` model ids. `remapEditToolsForCatalog` translates Cursor's native write/edit exec requests into patch envelopes, keyed only off the advertised set — never off a model id or host version. Rationale and upstream citations live in `src/protocol/apply-patch.ts`; watch items of the same shape are 2.0's missing `task` tool and the pre-announced `bash` rename.
- **Device identity:** stable OS-derived device ids (CLI-shaped); inventing new fingerprints risks “too many devices” errors.
- **Session lifecycle:** `SessionManager` holds a Cursor Run open past `doStream` returning whenever a tool exec is still pending, so a later continuation can resume it. Registering a *new* Run for the same `openCodeSessionId` closes any still-open prior Run for that id (`superseded-by-new-run`) — callers that abandon a Run and retry with a fresh one instead of delivering the continuation must not leak the old Run's stream. `maxOpenSessions` (default 24) is a hard backstop: exceeding it force-closes the oldest open session (`open-session-cap-exceeded`) rather than accumulating streams until Cursor's server closes the whole shared HTTP/2 connection.
- **Personal use:** private Cursor agent protocol; account you own; API can change without notice.

## Env / paths (quick)

| Variable / path | Role |
|-----------------|------|
| `CURSOR_API_BASE_URL` | Auth, models, GetServerConfig (default `https://api2.cursor.sh`) |
| `CURSOR_WEBSITE_URL` | OAuth login base |
| `CURSOR_PROVIDER_DEBUG` | Wire debug log (`CURSOR_PROVIDER_DEBUG_FILE`; default under `$TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Opt in GetServerConfig telemetry |
| `CURSOR_OPENCODE2_DEV_ENTRY` | Local dev only: absolute path to a built entry file (e.g. `dist/index.js`). Points the 2.0 catalog's `aisdk:` package spec at `file://…` so OpenCode 2.0's built-in `DynamicProviderPlugin` fallback imports it directly instead of `npm install`-ing the published package into `<host-cache>/packages/cursor-opencode-provider/`. Unset in production. |
| `createCursor({ cacheDir })` | Explicit host cache root (also Effect v2 `Path.cache` when the plugin passes it) |
| `MIMOCODE_HOME` | When set → `$MIMOCODE_HOME/cache` (before XDG host dirs) |
| `KILO_CONFIG_DIR` | When set → `$XDG_CACHE_HOME/kilo` |
| `XDG_CACHE_HOME` | Base for the explicitly detected or install-path host; otherwise `…/opencode` |
| `<host-cache>/cursor-models.json` | Model cache under resolved host cache (default `~/.cache/opencode/`) |
| `<host-cache>/projects/<slug>/` | Cursor project metadata root (`project_folder` / `workspace_project_dir`; keeps `agent-tools` out of the git workspace) |
| OpenCode auth | `~/.local/share/opencode/auth.json` (`$XDG_DATA_HOME`) |

## Docs map

| File | Purpose |
|------|---------|
| `README.md` | User-facing install, setup, troubleshooting |
| `AGENTS.md` | Canonical agent/project context (this file) |
| `.claude/CLAUDE.md` | Pointer to `AGENTS.md` for Claude Code |
