# cursor-opencode-provider

OpenCode plugin + AI SDK provider that runs Cursor subscription models by speaking Cursor’s Connect-RPC agent protocol (not a generic chat-completions API).

**Stack:** TypeScript (ESM), Bun for install/test, `tsc` for build. Peer: `@opencode-ai/plugin`. Deps: `@ai-sdk/provider`, `protobufjs`.

## Commands

```bash
bun install
bun run build        # tsc → dist/
bun run typecheck
bun test
bun run test:watch
```

Publish surface is `dist/` only (`files` in `package.json`). Always rebuild before testing a local `file://` OpenCode install.

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
| V2 plugin | `src/plugin-v2.ts` | Effect/Promise API via `ctx.aisdk.*` — load **only** as `./plugin/v2` |
| Language model | `src/language-model.ts` | AI SDK `LanguageModelV3` (`doStream` / `doGenerate`) |
| Session | `src/session.ts` | Held-open agent Run + pending exec correlation |
| Auth / models | `src/auth.ts`, `src/models.ts` | PKCE/API key, JWT refresh, `cursor-models.json` cache |
| Agent host | `src/agent-url.ts` | `GetServerConfig` → region-specific Run host (in-memory memo) |
| Request context | `src/context/` | Rules, skills, agents, plugins, git, layout, env |
| Wire protocol | `src/protocol/` | Framing, messages, tools, thinking, checksums, device id |
| Transport | `src/transport/connect.ts` | HTTP/2 bidi + unary RPC |

Package exports:

- `cursor-opencode-provider` → `createCursor` + classic plugin
- `cursor-opencode-provider/plugin` → classic Hooks (auth)
- `cursor-opencode-provider/plugin/v2` → v2 plugin only (`CursorPluginV2` is **not** on the root export)

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
- **Tool results:** strip OpenCode’s `read` XML envelope before returning content to Cursor so the model cannot echo wrappers into writes.
- **Device identity:** stable OS-derived device ids (CLI-shaped); inventing new fingerprints risks “too many devices” errors.
- **Personal use:** private Cursor agent protocol; account you own; API can change without notice.

## Env / paths (quick)

| Variable / path | Role |
|-----------------|------|
| `CURSOR_API_BASE_URL` | Auth, models, GetServerConfig (default `https://api2.cursor.sh`) |
| `CURSOR_WEBSITE_URL` | OAuth login base |
| `CURSOR_PROVIDER_DEBUG` | Wire debug log (`CURSOR_PROVIDER_DEBUG_FILE`; default under `$TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Opt in GetServerConfig telemetry |
| `~/.cache/opencode/cursor-models.json` | Model cache (`$XDG_CACHE_HOME/opencode/` when set) |
| `~/.cache/opencode/projects/<slug>/` | Cursor project metadata root (`project_folder` / `workspace_project_dir`; keeps `agent-tools` out of the git workspace) |
| OpenCode auth | `~/.local/share/opencode/auth.json` (`$XDG_DATA_HOME`) |

## Docs map

| File | Purpose |
|------|---------|
| `README.md` | User-facing install, setup, troubleshooting |
| `AGENTS.md` | Canonical agent/project context (this file) |
| `.claude/CLAUDE.md` | Pointer to `AGENTS.md` for Claude Code |
