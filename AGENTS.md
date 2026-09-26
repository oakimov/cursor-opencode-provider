# cursor-opencode-provider

OpenCode plugin + AI SDK provider that runs Cursor subscription models by speaking Cursor’s Connect-RPC agent protocol (not a generic chat-completions API).

**Stack:** TypeScript (ESM), Bun for install/test, `tsc` for build. Optional peer: `@opencode-ai/plugin@^1.17.13` (devDependency pinned to `^1.18.16`). Deps: `@ai-sdk/provider@3.0.15`, `protobufjs@^7.6.5`.

## Non-negotiable provider / compatibility-layer boundary

This provider knows **only OpenCode 1.x and OpenCode 2.0**. The dependency direction is one-way: compatibility layers may know and adapt this provider, but this provider must not know, import, detect, or depend on any compatibility-layer package.

- **No compatibility-layer dependency:** executable code, types, package metadata, tests, and built output must not import or declare `@opencode-compat/*` (or any future compatibility package). Do not dynamically import a detector as an “optional” fallback.
- **No fork identity:** executable code and provider tests must not detect, name, or branch on MiMo, Kilo, Pi, OMP, or another host/fork; their binaries, environment variables, paths, tool names, schemas, and quirks belong in the compatibility layer.
- **Generic contracts only:** the provider may consume structural capabilities installed before load (currently `Symbol.for("opencode.host.path-bridge")` and `Symbol.for("opencode.host.event-bridge")`), explicit OpenCode host API values, advertised canonical tool schemas, and `createCursor({ cacheDir })`. Contract names and shapes must be host-neutral and must not expose who installed them.
- **Canonical OpenCode vocabulary:** provider executable code sees OpenCode names (`task`, `todowrite`, `question`, `plan_enter`, `plan_exit`, etc.). Alternate host vocabulary and payloads are translated before reaching it. Capability gating uses the advertised canonical catalog, never a host or model id.
- **Absolute host ignorance:** `src/`, provider tests, package metadata, and published `dist/` must never name or parse another host's tools, schemas, result envelopes, plan lifecycle, approval wording, session events, environment variables, or package identities. This explicitly includes DSH/DeepSeek Harness, Pi/OMP, MiMo/Kilo, and other consumer providers such as Devin. Receiving an arbitrary advertised tool name as opaque catalog data is allowed; recognizing `exit_plan_mode`, `ask_user_question`, host JSON answer envelopes, or another provider's success strings is not. OCP must normalize those into canonical OpenCode contracts first.
- **No compatibility aliases:** do not export another provider's factory/plugin names or retain aliases that make this package appear to be a different provider. Backward compatibility does not override the provider boundary.
- **Standalone invariant:** without any compatibility layer or injected bridge, the package must remain fully functional and use native OpenCode cache/data/config paths.
- **Testing ownership:** provider tests cover OpenCode behavior and neutral structural contracts only. Fork-specific paths, schemas, call/result translations, and live-host assertions live in OCP.
- **Documentation exception:** README/comments may explain that OCP provides external compatibility and may cite host behavior as rationale, but instructions must never turn those references into provider executable branches.
- **Change gate:** before accepting a provider change, build and scan `src/`, tests, `package.json`, lockfile, and published `dist/` for compatibility-package imports, alternate-host vocabulary/result shapes, and other-provider identities. `test/architecture.test.ts` must fail on every known host family, including DSH, and on Devin identities. A compatibility fix that requires any of these belongs in OCP, not here.

OCP lives at `https://github.com/oakimov/opencode-plugin-compat`; it loads only on the hosts that need it and adapts the unchanged published provider. OpenCode is native: point it at this package's `dist/` (or a published install). Do not wrap live OpenCode with ocp-dev.

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

Publish surface is `dist/` only (`files` in `package.json`). Always rebuild before testing a local `file://` OpenCode install.

## HARD STOP — release / version bump / tag gate (non-optional)

**Do not edit `package.json` `"version"`, create a `v*` tag, push a `v*` tag, or run `npm publish` until the pricing gate below has succeeded in *this* turn and any mapping/`pricing-data.ts` updates are committed.** Skipping it is a process failure, not an acceptable shortcut. CI regenerating pricing later is **not** a substitute: unmapped Cursor display names fail publish after the tag already exists, forcing retags and wasted release cycles (this happened on `v0.6.4`).

**Forbidden until the gate passes:**
- bumping `"version"` in `package.json`
- `git commit` of a version bump
- `git tag v…` / retag / `git push --tags` / `git push origin v…`
- `npm publish` / asking the user to publish

**Required order (no exceptions, no “I’ll fix pricing after the tag”):**
1. `bun run generate:pricing` — must exit 0 against **live** Cursor docs in this session (do not assume a prior run is still valid).
2. On any `Unmapped pricing/context/capability display name`, update `DISPLAY_NAME_TO_MODEL_ID` or `SKIP_DISPLAY_NAMES` in `scripts/generate-cursor-pricing.ts`, add any new wire id to `test/fixtures/cursor-pricing-models.txt`, regenerate, and **commit that fix first**.
3. `bun run check:pricing` — must exit 0.
4. Commit mapping / fixture / `src/pricing-data.ts` changes **before** the version bump commit.
5. Only then bump version, commit, tag, and push.

If the user asks only to “bump / tag / publish”, still run steps 1–4 first and report the pricing result before touching the version.

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
| V2 plugin (1.18) | `src/plugin-v2.ts` | Effect/Promise API via `ctx.aisdk.*` — load as `./plugin/v2` **with** classic `plugin` (no `tool` domain; image-save/websearch need classic) |
| OpenCode 2.0 plugin | `src/plugin-opencode2.ts` | Load **only** as `./plugin/opencode2` (`ctx.provider.transform` inventory; registers `todowrite`/`todoread` only when `CURSOR_OPENCODE2_TODOS=1`/`true` and the host catalog lacks them — off by default; publishes an Exa `websearch` provider for the host's native permission-gated tool. Sets `options.codemode: false` on tools from MCP servers that did not set `codemode: true`, via `ctx.tool.transform`, so Cursor can call them by name. MCP server config is not written. Plugin-owned tools are `codemode: false` with an `output` schema so they sit in the direct catalog, not Code Mode. It does not advertise `cursor_image_save` or a direct web-search fallback because the public 2.0 `ToolContext` cannot request permissions.) |
| 2.0 support modules | `src/opencode2/` | Provider inventory mapping, integration/auth, local 2.0 API types, catalog-gated `todowrite`/`todoread`, direct MCP tool placement |
| Session todo store | `src/todo-store.ts` | In-memory per-session list backing plugin-owned `todowrite`/`todoread` |
| Host-neutral core | `src/plugin-core.ts`, `src/model-config.ts` | Shared by every plugin surface; must not import a host plugin API |
| Model pricing | `src/pricing.ts`, `src/pricing-data.ts` | Cursor docs → classic `cost` + OpenCode 2.0 cost tiers; regenerate via `bun run generate:pricing` |
| Language model | `src/language-model.ts` | AI SDK `LanguageModelV3` (`doStream` / `doGenerate`) |
| Session | `src/session.ts` | Held-open agent Run + pending exec correlation |
| Auth / models | `src/auth.ts`, `src/models.ts` | PKCE/API key, JWT refresh, `cursor-models.json` cache |
| Agent host | `src/agent-url.ts` | `GetServerConfig` → region-specific Run host (in-memory memo) |
| Request context | `src/context/` | Rules, skills, agents, plugins, git, layout, env |
| Host paths | `src/context/paths.ts` | Native OpenCode cache/data defaults with optional structural host path bridge; project metadata under `<host-cache>/projects/<slug>/` |
| Wire protocol | `src/protocol/` | Framing, messages, tools, thinking, checksums, device id |
| Patch synthesis | `src/protocol/apply-patch.ts` | `apply_patch` envelopes for hosts that withhold `edit`/`write` |
| AskQuestion bridge | `src/protocol/ask-question.ts` | Cursor AskQuestion interaction ⇄ OpenCode `question` tool (CLI parity) |
| SwitchMode bridge | `src/protocol/switch-mode.ts` | Cursor SwitchMode (#4) ⇄ OpenCode `plan_enter` / `plan_exit` when advertised |
| CreatePlan bridge | `src/protocol/create-plan.ts`, `hostPlansDir` in `src/context/paths.ts` | Cursor CreatePlan (#7) → plain markdown under the host global data `plans/` dir, never the project worktree; optional advertised host stage remains capability-gated |
| Plan execution kickoff | `src/plan-execution-kickoff.ts` | After CreatePlan Yes, classic OpenCode uses structurally available `session.promptAsync` with `agent: "build"`; without that OpenCode API, no synthetic kickoff is installed |
| Host agent mode sync | `src/host-agent-mode.ts` | Structural callback/terminal queue used by OpenCode 2 to map approved Cursor plan/spec → native `plan`, other modes → `build`; absent on classic 1.x |
| Image generation | `src/protocol/generate-image.ts`, `src/image-staging.ts`, `src/image-save.ts` | Cursor GenerateImage approval + permission-gated byte write |
| Transport | `src/transport/connect.ts` | HTTP/2 bidi + unary RPC |
| HTTPS proxy | `src/transport/https-proxy.ts` | CONNECT tunnel for Run when `HTTPS_PROXY` applies |

Package exports:

- `cursor-opencode-provider` → `createCursor` + classic plugin
- `cursor-opencode-provider/plugin` → classic Hooks (auth)
- `cursor-opencode-provider/plugin/v2` → 1.18 v2 plugin only (`CursorPluginV2` is **not** on the root export)
- `cursor-opencode-provider/plugin/opencode2` → OpenCode 2.0 plugin only
- `cursor-opencode-provider/image-save` → host-neutral `executeCursorImageSave` (pi-bridge / non-plugin hosts; not on the package root)

## OpenCode 2.0 vs the 1.18 "v2" plugin API

These are **source-incompatible APIs, not versions of one API**. Keep them in separate
entrypoints; never try to unify them.

| | 1.18 (`@opencode-ai/plugin@^1.17.13`, `/v2/promise`) | 2.0 (`plugin/opencode2`) |
|---|---|---|
| Import | `define` from `.../v2/promise` | plain `{ id, setup }` (host `define` is identity) |
| Hook shape | `ctx.aisdk.sdk(cb)` | `ctx.aisdk.hook("sdk", cb)` |
| OAuth registration | Effect-valued | Promise-valued |
| Model registration | classic `config` hook | `ctx.provider.transform` + `editor.add` + `reload()` |
| Provider schema | `api: { type: "aisdk", package }` | flat `package: "aisdk:…"` |

`src/plugin-opencode2.ts` does **not** import `@opencode-ai/plugin` or
`@opencode/plugin`. It exports a plain `{ id, setup }` object and duck-types a
subset of the 2.0 context from `src/opencode2/types.ts`, so an OpenCode 2.0
patch release does not require a plugin dependency bump.

Compile-time usage checks against the documented OpenCode 2.0 host contract live
in `test/opencode2-conformance.types.ts` (contract: `test/opencode2-host-contract.ts`).
They are checked by `tsc -p tsconfig.test.json`, which `bun run typecheck` runs.
The rest of `test/` is not typechecked.

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
- Keep README accurate when behavior users care about changes (auth, env vars, architecture, limitations). Host-specific OpenCode install/auth belongs in `docs/opencode-1.md` and `docs/opencode-2.md`, not back in the README.
- Tests live in `test/` (Bun test). Mirror protocol/context behavior with unit tests when changing encode/decode or discovery.
- **Release gate:** any version bump / `v*` tag / publish request must obey the HARD STOP pricing section above. Do not “bump first, check pricing if CI fails.”

## Context this provider sends to Cursor

`src/context/build.ts` builds Cursor `RequestContext` from OpenCode-shaped discovery:

- First of `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` walking up to the git worktree
- Global `~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md`
- `instructions` globs from merged `opencode.json` / `opencode.jsonc` (including `.cursor/` **only** when listed)
- `.opencode` agents/skills/plugins, plus `.claude` / `.agents` skill fallbacks
- Git + project layout + env

When changing rule/skill discovery, keep parity with OpenCode behavior and update `test/context.test.ts`.

## Critical behavioral constraints

- **Release / pricing gate:** before any version bump, `v*` tag, tag push, or publish, run `bun run generate:pricing` and `bun run check:pricing` successfully in this turn and commit mapping/`pricing-data.ts` updates first. See HARD STOP section above. CI re-running pricing is validation, not permission to skip the local gate.
- **Agent host:** resolve via `GetServerConfig` (`agentUrlConfig.agentnUrl`). Memoize once per process in memory; never write to disk; never silently fall back to a legacy global host on failure.
- **URL options:** `apiBaseURL` (auth/models/GetServerConfig) vs `agentBaseURL` (Run stream) are separate. Legacy `baseURL` aliases `agentBaseURL` only.
- **Host validation:** explicit agent overrides and GetServerConfig results must be HTTPS `*.cursor.sh`; reject others.
- **Telemetry:** `GetServerConfig` sends `telem_enabled: false` by default; opt in via `telemetryEnabled` or `CURSOR_GET_SERVER_CONFIG_TELEMETRY`.
- **Tool results:** strip OpenCode’s read envelope before returning content to Cursor so the model cannot echo wrappers into writes. OpenCode 1.x uses `<path>` / `<content>` plus `(Output capped at 50 KB…)`. OpenCode 2 uses `Read file <path>, lines <start>-<end>`, `N: ` prefixes, and `[Output truncated. Continue reading with offset: N]`. Stripping must not also drop the truncation footer's *meaning*: both hosts cap reads at 50 KB, and OpenCode 2 also stops at 2,000 lines and shortens individual lines after 2,000 characters, so re-state every partial result or the model treats it as the whole file. Relative grep, glob, and directory entries are resolved against the workspace root before Cursor sees them. Shell stdout rewrites only relative path tokens (`src/a.ts`, `src/a.ts:12`), not prose. Checkpointed Runs omit the system prompt, so the same workspace-root reminder is appended to that turn's user text. Native `read_args` → `read_result` is the path models actually use (verified live for `gpt-5.4-mini` and `grok-4.5`); its structured `truncated` flag is **not** sufficient on its own, so the content also carries a `[Partial read: …]` marker. `mcp_result` gets a separate notice item and Pi reads get structured `truncation`. Whole-file writes / overwriting Add File patches that echo the marker are rejected; targeted edits are not, because warning text can legitimately occur in source. Never mark ordinary pagination merely because the caller bounded the read with `offset`/`limit`; still mark a byte-capped page or character-truncated line.
- **Write content:** `WriteArgs` has six fields. `file_bytes` (#5) carries the content whenever Cursor sends bytes instead of `file_text`, decoded per `encoding_hint` (#6); Cursor's own executor prefers bytes when non-empty. Never re-add those two to `CURSOR_INTERNAL_KEYS` — they are content, not transport metadata.
- **Edit-tool substitution:** OpenCode 1.x drops `edit`/`write` from the catalog and advertises `apply_patch` for `gpt-*` model ids. `remapEditToolsForCatalog` translates Cursor's native write/edit exec requests into patch envelopes, keyed only off the advertised set — never off a model id or host version. Rationale and upstream citations live in `src/protocol/apply-patch.ts`. The same catalog-gated pattern remaps Cursor Task onto OpenCode 2 `subagent` (`agent` / `sessionID`) when `task` is absent. OpenCode 2 `execute` is Code Mode JavaScript (`code`), not a shell; OS commands stay on `shell`/`bash`.
- **Subagent task title:** Cursor's display `task_tool_call` carries the short description OpenCode shows, but exec `#28` `SubagentArgs` has no description field — only `tool_call_id` + prompt. Prefer the correlated display description via `preferCorrelatedTaskDescription`; the first-five-words prompt slice is fallback only and looks cut off in the TUI.
- **AskQuestion bridge:** Cursor's native AskQuestion is an inbound `InteractionQuery` (#3), not an exec request, and it is the one interaction OpenCode can genuinely satisfy — so it is translated into the host `question` tool rather than refused. Refusing it made models narrate "the AskQuestion tool is unavailable" and answer in prose while `question` sat advertised and never once called. `src/protocol/ask-question.ts` mirrors Cursor CLI (`src/utils/interaction-utils.ts` `Q7`/`iX`/`N$`, `chunk-7076/dist/ui.js`): strip a *trailing* catch-all option because OpenCode's `custom` adds its own, map answer labels back to option ids with anything unmatched becoming `freeform_text` (empty freeform → the literal `"Other"`), and keep the CLI's reason strings verbatim. `run_async` replies `async{}` at once and delivers answers later through `ConversationAction.async_ask_question_completion_action` echoing the server's own `AskQuestionArgs` **bytes**; a synchronous query stays open until the host tool returns, exactly as the CLI blocks on user input. Only unbridgeable turns (no advertised `question`, or `allowTools=false`) reject, and the reason must name the real cause.
- **SwitchMode bridge:** Cursor's native SwitchMode is an inbound `InteractionQuery` (#4) with `SwitchModeArgs{target_mode_id, explanation?, tool_call_id}`; the CLI blocks until `approved{}` or `rejected{reason}` (`"Mode switch rejected by user"` on decline) — there is no async variant. OpenCode 1.x uses advertised `plan_enter` (→ plan) / `plan_exit` (→ build). OpenCode 2 removed those model-callable tools in favor of vendor-maintained primary `plan` / `build` agents, so `plugin-opencode2.ts` installs the structural `host-agent-mode.ts` callback and applies an approved Cursor switch through public `session.switchAgent` only after the owning Run is terminal; `plan`/`spec` select `plan`, every other non-empty target selects `build`. After approval, the provider also records the Cursor unified mode per OpenCode session; CLI-shaped reminders remain the fallback when no native host agent owns the mode. Do not spawn `task`/subagents for SwitchMode itself. A missing plan tool is not a refusal: entering plan can be approved directly, while leaving it uses the advertised `question` fallback so execution remains user-gated. A lifecycle turn (`allowTools=false`) soft-acks with `approved{}` and does not mutate session mode — a hard reject entered the transcript and made the real turn narrate that mode switches were blocked. OCP may translate fork tool vocabulary before the provider sees it. Display `switch_mode_tool_call` (#25) is a separate non-replayed transcript record.
- **CreatePlan bridge:** Cursor's `create_plan_request_query` (#7) writes plain markdown and returns a `file://` `plan_uri`; it never writes into the project worktree, and never into Cursor's own `~/.cursor` — host-native locations only. `hostPlansDir` uses the native OpenCode global data `plans/` location by default, or an optional structural host path bridge's data root. Body is plain markdown (`# title`, overview, plan, optional `## Todos`). Empty / missing args keep the CLI empty-`plan_uri` success ack. Display `create_plan_tool_call` still mirrors into `todowrite` separately and does not write the file.
- **Plan execution approval:** **writing a plan never asks; executing one always does**, and canonical OpenCode reports that through one contract — `success` means the user approved execution, `error` means the plan was written but not accepted, so the model keeps planning. Do not let a refinement request return success: Cursor then implements the plan the user just asked to change. `resolveCreatePlanBridge` picks the channel from the advertised catalog alone: an advertised plan-stage tool writes the artifact and its tool result **is** the outcome (success = approved, error = not approved; the result may name the host's own follow-up approval call, which this provider does not invent), else the OpenCode `question` tool carrying upstream `PlanExitTool`'s own prompt after the provider has already written the file, else a plain ack when nothing can ask. **The user must be able to read the plan before approving it.** Cursor routes the plan body through the interaction query, never the text stream, so nothing has displayed it by the time the prompt appears; on the emulated path the provider emits the plan into the assistant message (`renderPlanReviewMessage`) before the question. It must go there and not into the question text: OpenCode renders the question dock outside its scrollbox in a `flexShrink={0}` box (`tui/src/routes/session/index.tsx:1296-1304`), so a full plan in the prompt would push the conversation off screen. An OpenCode plan-stage tool already receives `content` and shows it in its own review UI. Only an explicit "Yes" approves — an unanswered, dismissed, or failed prompt keeps the model in plan mode. The gate gates the transition *out of* planning, so it is armed only while the provider records an approved Cursor plan/spec mode (`isCursorPlanModeActive`) and never on a lifecycle turn. On approval the session moves to `agent` so the next Run carries the agent reminder. When OpenCode structurally exposes `session.promptAsync`, the classic plugin queues the plan_exit-shaped synthetic user message (`agent: "build"`, PlanExitTool wording) through `src/plan-execution-kickoff.ts` so implementation starts without waiting for the model to ask; without that OpenCode API, no synthetic prompt is registered. Relying on the model to raise SwitchMode back to `agent` after writing is **not** a gate: observed live, the model wrote the plan and ended the turn, so nothing ever asked. A SwitchMode whose target is the mode already in effect auto-approves (as Cursor's own IDE handler does), which also keeps that path from prompting a second time.
- **Image generation:** Cursor approves via `InteractionQuery` #12, generates server-side, then writes the image with an **ordinary write exec** — `WriteArgs{path, file_bytes, return_file_content_after_write:false}` to `<artifactsFolder|projectFolder>/assets/<basename>`, reading the client's `WriteResult` back and branching on `permission_denied` (`agent-cli-local/src/index.ts:84752-84776`). The display `generate_image_tool_call.result.image_data` is **preview only** — Cursor CLI feeds it to its terminal image cache, which falls back to reading the path off disk. Never write from that frame; the bytes would land twice. So the client work is: approve, then honour a binary write. `decodeWriteBytes` returns undefined for bytes that are not text (fatal decode; NUL outside UTF-16/32), those bytes never reach OpenCode's `write` (string content, BOM split, diff, `Format.file()`), and are staged (`src/image-staging.ts`) for the classic `cursor_image_save` plugin tool, which mirrors OpenCode's own `write` gate in the same order: `external_directory` for a target outside the project (the by-design default, so this fires on every ordinary generation), then `edit` with a worktree-relative pattern. Roots are realpath-resolved on both sides or a symlinked project root reads as external. Then the bytes are written verbatim. A refusal returns Cursor's own `WriteResult.permission_denied` (#3), not a generic error. **The commit tool must not return `attachments`:** OpenCode gates media-in-tool-result on an allowlist of `model.api.npm` values no third-party provider can join (`message-v2.ts:299-305`), so media is always extracted into a trailing user message — which stops the next turn from looking like a tool continuation, opens a fresh Run, and strands the pending write result (observed live: session superseded with `pending=1` plus a 1.7 MB rebase). **The tool takes only a single-use opaque id** — never a path or content — so its presence in the catalog gives no model a way to write arbitrary files; keep it that way. `remapCursorImageWritePath` maps Cursor's target onto a real host location: the advertised `project_folder` and the workspace pass through, anything else is rebased to `<projectDir>/assets/<basename>` rather than refused. **Landing in `<projectDir>/assets/` — outside the worktree — is the intended default, not a shortcoming.** Generated images are agent artifacts and stay out of the git tree unless asked for; a user who wants one in the repo asks for a path, Cursor sends that path, and it is honoured verbatim. Do not "fix" the default to write into the workspace, and do not re-raise it as a caveat. Containment is re-checked symlink-aware at commit time against both roots. Approve #12 only when `cursor_image_save` is advertised, otherwise generation spends Cursor quota on an image with nowhere to go. OpenCode 2.0's public plugin `ToolContext` has no permission-request method, so its entrypoint deliberately does **not** advertise `cursor_image_save`; binary writes are rejected before staging rather than bypassing `external_directory` / `edit` or failing after quota is spent. Approach adapted from [`jkalasas/opencode-antigravity-image`](https://github.com/jkalasas/opencode-antigravity-image) (MIT) — prior art for writing image bytes from inside a plugin tool; no code copied. Verified live 2026-08-15 (`sample-balloon.png`, 1203133 B, 1024x1024 PNG written byte-exact). **Cursor's remote path did not raise #12 at all** — zero interaction queries in that session; it emitted the display `generate_image_tool_call` and then the binary write exec directly. The #12 handler therefore stays as correct-if-raised, but the effective gate is the `edit` permission on the write. Reference images (`reference_image_paths`) still do not work — Cursor reads them back through a read exec, and `toolResultOutputToText` drops media on held-Run continuations; `ReadSuccess.data` (#5) is the field that would carry them.
- **Legacy edit reads:** `edit_tool_call` uses a private `read_args` → whole-file `write_args` transaction. For the exact correlated regular file inside the real workspace, answer the private read directly with complete content up to Cursor's 50 MB edit limit; OpenCode's ordinary 50 KB read cap is unsuitable for this transaction. External paths and symlink escapes must first pass through OpenCode's permission-aware read; only after that exact read succeeds may its private result be upgraded to complete content. The final write must still be remapped to a targeted host edit/patch.
- **Prompt-cache context:** freeze and persist the stable `RequestContext` base (rules, env, repository, git, layout) per Cursor `conversation_id`; rediscover tools/MCP, skills, subagents, and plugin metadata every Run then epoch-hold them (equal ids keep frozen bytes; new ids append) and overlay them deterministically. Reuse the prior materialized object when its protobuf bytes are unchanged. Persist the current host primary agent and Context Epoch baseline hash with the checkpoint for diagnostics only — they must never remint a sticky conversation (Cursor CLI keeps the same agentId across mode flips; system-prompt remint is forbidden). V2-style Context Epoch: the first normal seed freezes Baseline System Context (host system + interaction guidance) per `conversation_id`; later host/agent/guidance/mode/kickoff changes are Mid-Conversation System Messages on the user turn (checkpoint Runs never rewrite systemPrompt). Compaction remint ends the epoch; RequestContext workspace base still transfers. Title/generate lifecycle prompts are ephemeral and must not replace that primary identity. **Advertisement and permission are independent, and advertisement must never fluctuate.** Equal name-sets keep frozen descriptors and their order; new names append at the tail (UTF-16 only among the newcomers); the encoder emits advertised order. A varying tool set changes the RequestContext shape and costs the whole prompt cache, so `resolveTurnToolState` re-advertises the last real catalog on *every* zero-tool turn — compaction, title generation, summarization alike. A zero-tool call is never "a smaller catalog"; it is the lifecycle signal for a Run OpenCode opens **alongside** the real one, and Cursor replays the entire agentic turn on it. On cold start, when no catalog is cached yet, a session-keyed zero-tool Run must wait for a sibling `doStream` to publish the first real catalog; cancellation is the only escape. Never time out to an empty advertisement, and never invent or filter the enabled set. Permission is computed separately from what actually arrived (`allowTools`), so those turns advertise fully but refuse execution and cannot duplicate the real turn's side effects — which is why bridged interactions (SwitchMode, CreatePlan) must gate on `allowTools`, not on advertisement: before that gate existed, the title turn flipped plan mode and wrote its own duplicate plan file. When the host shrinks a non-empty catalog (OpenCode plan denies edit), keep the epoch advertisement for RequestContext stability and refuse exec outside the host-permitted set for that turn; grow the epoch catalog when new tool names appear (MCP). Deduplicate concurrent first builds and clear the base with checkpoints/blobs on compaction, prompt, agent, or binding reset.
- **Persisted KV blobs:** a Cursor checkpoint contains content-addressed references and is not independently replayable. At successful `TurnEnded`, persist only blobs reachable from the latest checkpoint using Cursor CLI's export graph (turn/user/step/image, summary/todo/prompt, and recursive subagent refs). If decoding fails or a referenced hash is absent, retain the complete set rather than write an incomplete restart snapshot. Do not mistake these private blobs for OpenCode's own session cache.
- **Checkpoint transport budget:** inspect the checkpoint-reachable KV graph before opening the next Run for diagnostics. A graph above 100 MiB (Cursor CLI export/transfer budget only) or an incomplete reachability proof must **not** remint — warm-reuse the sticky conversation and warn (`action=warm-reuse`), matching CLI soft-reuse. Report checkpoint-envelope bytes, reachable blob bytes, and seed/wire estimates separately; blob bytes are not tokens.
- **Run write backpressure:** response-required protocol writes must be serialized per stream and await HTTP/2 drain. In particular, never queue successive KV `get_blob` replies after `write()` returns false, and never let a heartbeat race or misattribute an already-pending response write.
- **Cursor-authoritative token totals:** Cursor's checkpoint `ConversationStateStructure.token_details` (#5) is the authoritative context snapshot. Decode it without re-encoding the opaque checkpoint; expose `used_tokens`, `max_tokens`, prompt-category breakdown, source, and staleness under `providerMetadata.cursor.context`, and make AI SDK input + output equal `used_tokens`. OpenCode TUI/GUI **replace** each assistant message's tokens (they do not sum occupancy) and the TUI footer only accepts a message with `tokens.output > 0`; session cost **adds** every step-finish. Held-Run tool boundaries therefore emit the last-known occupancy snapshot (`output=1` so the footer updates, remaining occupancy on input/cache) plus `providerMetadata.copilot.totalNanoAiu: 0` — OpenCode's only getUsage cost override — so snapshots are not billed as new prompts. At `TurnEnded`/`stop`, emit the same occupancy snapshot shape once more (`output=1`, remaining occupancy on input/cache, `providerMetadata.copilot.totalNanoAiu: 0`) so host tok/s — which divides generated tokens by this step's wall time — is not inflated by the held-Run aggregate. Preserve exact request counters under `providerMetadata.cursor.*Raw` (input/output/cache/reasoning); a compatibility layer may use the neutral event bridge to reconcile a host's separate aggregate-usage record without changing the assistant-message occupancy. If the current Run supplies no token details, retain the prior checkpoint snapshot as `checkpoint-previous-turn` / `stale: true`; if no snapshot has ever existed, emit zero standard usage and leave context metadata absent. Never reinterpret `TurnEnded` as context occupancy. Keep this last-known snapshot separate from `resumeCheckpoint`, because display state must not make stale transport state retry-eligible. Compaction replaces the snapshot with a lower authoritative total. Do not emit per-step occupancy *deltas*: the TUI would then show only the increment.
- **Device identity:** stable OS-derived device ids (CLI-shaped); inventing new fingerprints risks “too many devices” errors.
- **Session lifecycle:** `SessionManager` holds a Cursor Run open past `doStream` returning whenever a tool exec is still pending, so a later continuation can resume it. Registering a *new* Run for the same `openCodeSessionId` closes any still-open prior Run for that id (`superseded-by-new-run`) — callers that abandon a Run and retry with a fresh one instead of delivering the continuation must not leak the old Run's stream. Before a host *fresh user turn* opens that new Run, finish the prior held Run on the same conversation: settle display-only bridged pendings, cancel any still-open real execs with an error result, and drain for `turn_ended` so the checkpoint/prefix is preserved instead of aborting mid-tool. `maxOpenSessions` (default 24) is a hard backstop: exceeding it force-closes the oldest *idle* session (`open-session-cap-exceeded`) — never a pumping or held-pending Run — rather than accumulating streams until Cursor's server closes the whole shared HTTP/2 connection. Active binding LRU soft-evicts without wiping checkpoint/blobs/frozen; disk hydrate (`hydrateConversationState`) restores after process restart.
- **Cache diagnostics:** Cursor exposes read/write counters only once at `TurnEnded`, aggregated across its held Run; it does not expose per-model-call cache splits. Debug traces must distinguish warm checkpoint continuity and stable RequestContext hashes from the aggregate read ratio, preserve prior/current token categories for comparison, and label unavailable per-call accounting rather than manufacturing it. Start every cache/token investigation with [`docs/cache-log-runbook.md`](docs/cache-log-runbook.md); it defines the reading order, field semantics, comparison math, common patterns, and handoff checklist.
- **Compaction cache stability:** compaction and its following normal rebase must rotate `conversation_id` and discard checkpoints/blobs, but they transfer the frozen workspace context base and prior materialized-byte comparison seed to the new id. Live tools, MCP, skills, agents, and plugin metadata are still rediscovered then epoch-held; reuse the complete RequestContext only when the refreshed encoding is byte-identical.
- **Personal use:** private Cursor agent protocol; account you own; API can change without notice.

## Env / paths (quick)

| Variable / path | Role |
|-----------------|------|
| `CURSOR_API_BASE_URL` | Auth, models, GetServerConfig (default `https://api2.cursor.sh`) |
| `CURSOR_WEBSITE_URL` | OAuth login base |
| `CURSOR_PROVIDER_DEBUG` | Wire debug log (`CURSOR_PROVIDER_DEBUG_FILE`; default under `$TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log`) |
| `CURSOR_GET_SERVER_CONFIG_TELEMETRY` | Opt in GetServerConfig telemetry |
| `CURSOR_OPENCODE2_DEV_ENTRY` | Local dev only: absolute path to a built entry file (e.g. `dist/index.js`). Points the 2.0 `aisdk:` package spec at `file://…` so OpenCode 2.0's built-in fallback imports it directly instead of `npm install`-ing the published package into `<host-cache>/packages/cursor-opencode-provider/`. Unset in production. |
| `CURSOR_OPENCODE2_TODOS` | OpenCode 2.0 only. `1` or `true` force-enables plugin-owned `todowrite`/`todoread`. Off by default. 1.x host builtin is not gated. |
| `createCursor({ cacheDir })` | Explicit host cache root (also Effect v2 `Path.cache` when the plugin passes it) |
| `XDG_CACHE_HOME` | Native OpenCode cache base (`$XDG_CACHE_HOME/opencode`, otherwise `~/.cache/opencode`); an optional structural host path bridge may provide the host cache root |
| `XDG_DATA_HOME` | Native OpenCode data base (`$XDG_DATA_HOME/opencode`, otherwise `~/.local/share/opencode`); an optional structural host path bridge may provide the host data root |
| `<host-cache>/cursor-models.json` | Model cache under the resolved OpenCode/host cache root |
| `<host-cache>/cursor-conversations/*.pb.gz` | One atomic gzip-compressed protobuf restart snapshot per stable host session (checkpoint, reachable blobs, stable context base, lifecycle tool fallback, compaction marker), updated at successful `TurnEnded`; records expire after 24h |
| `<host-cache>/projects/<slug>/` | Cursor project metadata root (`project_folder` / `workspace_project_dir`; keeps `agent-tools` out of the git workspace) |
| `<worktree>/<project-config>/plans/` | CreatePlan files inside a git worktree; `<project-config>` from path bridge (`opencodeProjectConfigDirs`) |
| `<hostGlobalDataDir>/plans/` | CreatePlan files when there is no VCS (OpenCode `Global.Path.data` shape via `hostGlobalDataDir`) |
| OpenCode auth | `~/.local/share/opencode/auth.json` (`$XDG_DATA_HOME`) |

## Docs map

| File | Purpose |
|------|---------|
| `README.md` | User-facing overview, shared model catalog, troubleshooting |
| `docs/opencode-1.md` | OpenCode 1.x install (classic `plugin` + optional 1.18 `plugin/v2`) |
| `docs/opencode-2.md` | OpenCode 2.0 install (`plugin/opencode2`) and migration off `ctx.catalog` / the `opencode.json` catalog dump |
| `AGENTS.md` | Canonical agent/project context (this file) |
| `.claude/CLAUDE.md` | Pointer to `AGENTS.md` for Claude Code |
| `docs/cache-log-runbook.md` | Maintainer runbook for capturing, reading, comparing, and handing off cache/token debug logs |
| `docs/host-compat-acceptance.md` | Pre-release stock-host TTY checklist for CreatePlan, mode switching, generic Pi isolation, and cache stability |
