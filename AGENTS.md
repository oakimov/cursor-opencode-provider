# cursor-opencode-provider

OpenCode plugin and AI SDK `LanguageModelV3` provider for Cursor's Connect-RPC
agent protocol. TypeScript ESM; Bun installs/tests; `tsc` builds `dist/`.

## Working conventions

- Read the target and its callers before editing. Use independent wire evidence
  for protocol changes; distinguish fixture results from live host validation.
- Keep fixes targeted and preserve prompt-cache continuity. Consider both OpenCode
  majors unless the behavior belongs to one entrypoint. Do not commit unless asked.
- Before changing behavior, read the [lessons index](tasks/lessons.md), the general
  lessons, and the relevant host lessons. Merge incident lessons by cause; keep
  current requirements here and dated validation in private run reports.
- Keep operator behavior in [README.md](README.md) and the matching
  [host guide](docs/README.md). Follow [CONTRIBUTING.md](CONTRIBUTING.md) and the
  [review rules](docs/review-rules.md), including every Greptile finding and
  applicable Codecov issue. User-facing changes need an Unreleased changelog line.
- Never leave TMPDIR remnants, from tests, scripts or your own scratch work
  (files, directories, worktrees, detached processes and their logs). Remove
  what you create before finishing; first await the writes and stop the
  processes that could recreate it (`settleRunSavesForTests`,
  `reapBackgroundSpawn`, `stopProcessesUsing`), and restore the process-wide
  host cache root that `createCursor({ cacheDir })` sets. `test/preload.ts`
  gives every `bun test` run a private TMPDIR and fails the run when anything
  is left in it; Node test scripts import `test/node-tmpdir.mjs` first for the
  same guard.

## Non-negotiable provider / compatibility-layer boundary

This provider knows only OpenCode 1.x and 2.0. Compatibility layers adapt it;
this package never imports, detects, or depends on them.

- `src/`, provider tests, package metadata, lockfile and published `dist/` must not
  import/declare `@opencode-compat/*`, detect other hosts, or parse their tools,
  schemas, results, plan lifecycle, approvals, events, paths or environment.
  This includes MiMo/Kilo, Pi/OMP, DSH/DeepSeek Harness and Devin identities.
  No optional detector imports or other-provider factory/plugin aliases.
- Unknown advertised names may pass through as opaque data. Host-specific
  translation belongs in [OCP](https://github.com/oakimov/opencode-plugin-compat),
  including alternate tool vocabulary such as `exit_plan_mode` or
  `ask_user_question`. Documentation may explain that boundary.
- Consume canonical OpenCode schemas, explicit host APIs, `createCursor({ cacheDir })`
  and neutral structural contracts installed before load:
  `opencode.host.path-bridge`, `opencode.host.event-bridge`, `opencode.host.skills`
  (all through `Symbol.for`). Their shapes must not identify the installer.
- Advertise canonical schemas → normalize Cursor arguments → validate →
  execute/replay. Required fields must be complete before validation. Gate on
  the current advertised/permitted capabilities, never a host or model id.
- Without a bridge, use native OpenCode cache/data/config paths and remain fully
  functional. Load native OpenCode directly; do not wrap it with `ocp-dev`.
- Build and run `test/architecture.test.ts` after boundary changes. Its scans
  cover source, tests, metadata and built output; retain guards for every host
  family and other-provider identities. Before changing a shared contract,
  consult OCP's [tool vocabulary](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/tool-vocabulary.md)
  and verify affected host families and the loaded runtime in OCP.

## Commands

```bash
bun install
bun run typecheck          # source and test projects
bun run build              # tsc → dist/
bun test
bun run test:coverage      # CI's lcov run, with copied-module records stripped
bun run test:node-http2     # build + Node transport regressions
bun run check:pricing      # fixture coverage, not live regeneration
bun run generate:pricing   # live Cursor pricing/context/capability metadata
```

The executable publish surface is `dist/`; rebuild before testing a local
`file://` install. Use `sessionFixture` in tests instead of casting to
`CursorSession`. Protocol tests need independent bytes or vendor definitions.

## Architecture and entrypoints

| Owner | Source |
|-------|--------|
| Public factory + classic plugin | `src/index.ts`, `src/plugin.ts` |
| Separate host plugin APIs | `src/plugin-v2.ts`, `src/plugin-opencode2.ts`, `src/opencode2/` |
| Run lifecycle, continuations, recovery | `src/language-model.ts`, `src/session.ts`, `src/activity.ts` |
| Context, native paths, frozen epochs | `src/context/`, `src/context/epoch.ts` |
| Wire schemas, tools, persistence | `src/protocol/` |
| Auth, renewal, discovery, catalog | `src/auth.ts`, `src/auth-renewal.ts`, `src/agent-url.ts`, `src/models.ts`, `src/model-config.ts` |
| Pricing, billing, shared plain data | `src/pricing.ts`, `src/pricing-data.ts`, `src/billing.ts`, `src/process-shared.ts` |
| HTTP/2, proxy, ordered writes | `src/transport/`, `src/stream-write.ts` |
| Planning, image staging/save | `src/host-agent-mode.ts`, `src/host-plan-file.ts`, `src/image-staging.ts`, `src/image-save.ts` |

Package exports are defined in `package.json`. Root exports `createCursor` and
classic `CursorPlugin`; `CursorPluginV2` stays off the root. Auxiliary APIs stay
on their subpaths. `/server` resolves the 2.0 module and also exports classic
`server: CursorPlugin` for the 1.18 loader.

The **1.18 v2** API and **OpenCode 2.0** are source-incompatible:

- **1.x:** classic `/plugin` owns auth/tools. `/plugin/v2` uses
  `@opencode-ai/plugin/v2/promise`, `ctx.aisdk.sdk` and `ctx.aisdk.language`;
  load it alongside classic because it has no tool domain.
- **2.0:** load only `/plugin/opencode2`. Export plain `{ id, setup }`, use
  local structural types, and import neither host plugin SDK. Inventory is
  in-memory through `ctx.provider.transform`, not written to config. Compile
  usages against `test/opencode2-host-contract.ts` and
  `test/opencode2-conformance.types.ts`.
- 2.0 direct plugin tools need `codemode: false` and an output schema. Todo
  fallbacks are off unless `CURSOR_OPENCODE2_TODOS=1`/`true` and the catalog lacks
  them. MCP placement changes tool options, preserves explicit server opt-ins,
  and never rewrites server config or delays startup. Web search uses the native
  permission-gated backend; the public 2.0 `ToolContext` cannot request approval.
- Keep host hook/permission order intact: 1.x `shell.env` follows permission;
  2.0 `shell.create.before` preserves the command and shell basename through an
  executable adapter. Compaction/agent state comes from explicit host hooks.

## Auth and transport invariants

- Keep browser-session renewal (`POST /oauth/token`) separate from raw API-key
  exchange (`/auth/exchange_user_api_key`). Renew on demand, never by timer or
  after assuming an expired session can be recovered. Inspect `shouldLogout`
  even on HTTP 200; latch final rejection, back off transient errors while the
  credential is valid, and persist only if the stored credential is unchanged.
- Plugins pass `getAccessToken`, not serializable tokens/keys. A raw `crsr_`
  key is never a Bearer token. Preserve stable OS-derived device identity.
- `apiBaseURL` owns auth/models/GetServerConfig; `agentBaseURL` owns Run.
  Legacy `baseURL` aliases only the latter. Resolve `agentUrlConfig.agentnUrl`
  once per process in memory, validate HTTPS `*.cursor.sh`, and fail closed;
  no disk memo or legacy-host fallback. GetServerConfig telemetry defaults off.
- Serialize every response-required write and await drain. A buffered failure
  is ambiguous delivery and cannot be replayed. There is no upload deadline;
  errors, Run termination and the 120 s inbound read-idle watchdog settle waits.
- Initial and replacement uploads own temporary abort/host-Stop listeners;
  continuation delivery and the active pump use their current call's signal.
  Detach temporary listeners after upload so an ordinary tool-step abort keeps
  the held Run alive. Replacement callbacks must not capture the first signal.
  An abort of the pumping step with nothing owed (OpenCode 1.x Stop aborts
  before the stream is cancelled) sends `cancel_action` like any Stop; only a
  write still waiting for drain resets the Run at once.
- Local cancellation resets buffered streams with `NGHTTP2_CANCEL`; `destroy()`
  must work after `end()`. Retiring a cached connection must let siblings drain,
  never destroy them. Direct and proxy connections use `maxSessionMemory: 256`.
  Idle sessions are unref'd; live streams and health-check pings hold a ref.
- Decode Cursor's error title/detail and retry verdict like Cursor CLI: required
  actions, final error codes, `isRetryable: false` and bare `permission_denied`
  end the turn. Final and auth failures reach both hosts as `APICallError` with
  `x-should-retry: false`, a status below 500 and a message without OpenCode 1.x
  retry triggers (`src/errors.ts`); the Connect code stays on `cause`. A
  `hostRetryable` failure is the exception: an `APICallError` with
  `isRetryable: true`, `x-should-retry: true` and no status, so both hosts retry.

## Context, identity and persistence

- Forward the host system prompt plus provider guidance as one `global`
  system-instructions rule. Never read instruction/skill bodies yourself,
  seed `root_prompt_messages_json`, or use `system_prompt_override` as a carrier.
  History for an uncheckpointed Run goes in `seedHistoryUserText`.
- Freeze the workspace base and baseline rule per conversation. Later agent,
  skill, MCP or prompt changes ride chronological user-context updates; they
  must not remint the conversation or rewrite its baseline. Recover the saved
  baseline after restart. Deduplicate concurrent builds and reuse equal bytes.
- Rediscover tools, subagents and plugin metadata, then retain epoch order and
  append new ids. Advertisement is separate from current execution permission:
  a shrinking nonempty catalog keeps frozen advertisement but restricts exec;
  a host-empty lifecycle call advertises `[]` and never waits for a sibling.
  Explicit compaction can retain advertisement while refusing execution.
- RequestContext tools are names-only; full definitions come from the current
  session catalog on exec #36. Omit `RequestContext.tools`, fs MCP descriptors
  and `AgentRunRequest.mcp_tools`. Skill paths/descriptions require advertised
  `skill` and a usable location; never send their content or freeze the list.
- Prefer `x-opencode-session-id` over affinity fallbacks. A daemon's session
  workspace comes from host request context, not its process cwd. Persisted
  host-agent/prompt markers must not remint a conversation. Title/summary helpers
  cannot supersede a held tool Run.
- Compaction/rebase discards old checkpoints/blobs, transfers stable workspace
  context/comparison state and admits a new baseline. Direct Cursor model
  switches keep the conversation. Foreign-provider history rebuilds with every
  tool result; oversized foreign or completed-result seeds fail before opening
  with a host-shaped 413 so the host compacts.
- Persist atomic per-session gzip protobuf snapshots under the native/bridged
  host cache: checkpoint, reachable blobs, baseline, catalogs, provenance, notes,
  lost requests and steer receipts. Keep all blobs if reachability is uncertain.
  A >100 MiB or incomplete transfer graph warns and warm-reuses; it never remints.
- Skip a history image only when the checkpoint being sent is known to hold it
  (`sent-history-images.ts`; hashes per conversation id + checkpoint SHA-256,
  snapshot fields 16/17). A Run's own images count once its turn ends with
  `turn_ended` on a checkpoint that arrived after them; a failed or stopped
  turn, or a snapshot without the set, sends them again. Arrival is when the
  transport received the frame (`frameArrival`), not when a pump read it: the
  checkpoint after a tool step holds none of that tool result's images.
- Retention uses persisted application metadata, not filesystem timestamps.
  Hydrate on demand, expire after 24 h, avoid blocking startup/full-cache decode,
  preserve concurrent replacement files, and keep soft-evicted state reusable.

## Run lifecycle and recovery

- One reader owns frame dispatch. Every inbound frame renews semantic liveness.
  Pending real host execs receive CLI-shaped heartbeats every 3 s until result
  delivery or abort. Open prompts and descendant activity renew held leases;
  running tools extend them up to four hours from their own start, never shorten
  a lease. Shared cross-copy state must be versioned plain data.
- While tools run, `readHeldRun` answers KV/exec control and queues other frames
  in order for the pump. Recheck queued aborts after registering their exec.
  Preserve iterator ownership across timeouts and handoffs.
- Respect `tool_requests_listed` when emitting parallel calls. Early edit rows
  predict the remapped host tool, open none when the edit's private read goes
  to the host, complete with a hand-off note when the call runs as another
  host tool, close as unfinished if no exec arrives, and retain routing after
  Run closure/restart so a late result can rebuild from history.
- Drain a held Run before a fresh user turn. Rebuild late tool results from
  host history; checkpoint resume would request the tool again. Never replay
  side effects after the replay barrier or treat EOF as successful `stop`.
- Retry like Cursor CLI's Run loop: an attempt without its own checkpoint
  resumes the turn's latest eligible one. Delivered tool results and follow-up
  user messages revoke earlier checkpoints; queued frames use receipt order.
  Stateful barriers survive host tool steps. Two resumed attempts that stream
  without a new checkpoint end the turn. With
  no checkpoint in the turn, a transient failure after only text or reasoning
  is `hostRetryable` (the CLI resends the action). A silent drop immediately
  after delivered host results may rebase from history only when every observed
  exec has a completed result and no opaque activity occurred. Include all
  completed tool steps; never resume their earlier checkpoint. Other barriers
  stay final.
  Missing-blob recovery is limited to the initial control-only checkpoint path
  (`isSoleControlFrame`); unknown/mixed frames keep the normal replay barrier.
- Carry an uncheckpointed request only on its unchanged checkpoint; persist it
  on failure. Retry equality uses the previous attempt's own live text. New
  checkpoints, host Stop and history rebuild drop it; unseeded history must not
  duplicate it. Session caps close only idle Runs, never pumping or held-pending
  Runs.
- Host notes and detached media beside tool results continue that Run. Inject
  instructions as `user_context`, keep acknowledgements and ordered fallback,
  and reserve hook context for notices about a result. Never use `system_context`.
  Attribute images only to proven pending owners under one 20 MiB continuation
  budget; remember hashes after delivery and preserve cancellation.
- OpenCode 2 early-steer receipts persist with checkpoints. Deduplicate exact
  promoted copies at their host boundary, preserve later identical requests and
  attachments, rebuild an unanswered promoted/checkpointed steer after failed
  recovery, and deliver all pending user messages in order.

## Tools, planning and images

- Remap from the current permitted catalog, preserving native tools when
  available: 1.x `apply_patch`, 2.0 `patch`, `task`/`subagent`, and `shell`/`bash`.
  2.0 `execute` is JavaScript. Refuse lossy patches before mutation, including
  2.0 CRLF. Keep the correlated Task display title over a prompt fragment.
  Answer a Task's correlated attachment reads with placeholder bytes, never the
  file or a host read; list the attachment paths in the subagent prompt.
- Strip read envelopes while retaining `[Partial read: …]` meaning. Explicit
  pagination alone is not truncation. Reject whole-file writes/overwriting Add
  File patches that echo incomplete content; allow targeted source edits.
  Resolve relative grep/glob/directory paths against the workspace. Shell stdout
  reaches Cursor verbatim, as Cursor CLI sends it; a `cd` changes its paths.
  A failed host shell call's text reaches Cursor once, as stderr, not as stdout.
- `WriteArgs.file_bytes` and `encoding_hint` are content. Private legacy-edit
  reads need complete correlated content after the exact host-authorized read,
  including workspace files and external/symlink-escaped files. Final mutation remains a host edit/patch.
- AskQuestion is an interaction query, not an exec. Preserve CLI option/freeform,
  rejection and synchronous/async behavior; async completion echoes the original
  argument bytes. Bridge only through an advertised permitted `question`.
- Write plans as plain markdown in host-native locations, never Cursor's plan
  store. Display records do not execute tools. Writing a plan does not ask;
  leaving approved plan mode to execute does. Show the plan in the transcript
  before asking; Yes starts build, No/dismissal ends the owning turn and keeps
  the plan agent until a new user message, and typed freeform feedback continues
  the same turn in plan mode with that text as the CreatePlan reply. Treat
  failure as unapproved. Use the advertised host review channel; without one
  the user switches agents.
- SwitchMode never spawns a subagent. Apply native primary-agent switches only
  after the owning Run is terminal; lifecycle turns soft-ack without mutating
  mode. Same-mode switches auto-approve. Entering plan needs no execution gate.
- Generated images arrive through binary write execs; display image data is
  preview only. Gate GenerateImage approval on advertised `cursor_image_save`.
  Stage bytes behind a single-use opaque `cursor_image_save` id,
  never a model-supplied path/content writer. Recheck symlink-aware containment.
  Classic asks `external_directory` then `edit`; 2.0 asserts those actions and
  actual resources through public `ctx.permission.assert`, failing closed when
  no permission API exists. Catalog membership is not execution authorization. Refusal is `permission_denied`.
  Do not return save-tool attachments or change the default project-assets
  location outside the worktree. Explicit workspace targets remain supported.

## Usage and billing

Use checkpoint `token_details` for occupancy, with source/staleness metadata;
never reinterpret aggregate TurnEnded counters as context. Emit occupancy per
step (not deltas), reserving one output token for host display. Preserve raw
counters separately. Keep displayed occupancy separate from retry checkpoints.

`src/billing.ts` estimates tool steps and reconciles aggregate catalog-priced
cost at turn end. Book only delivered finishes; bound cache counters and retain
unsettled balances. 1.x supports `copilot.totalNanoAiu`; 2.0 prices tokens, so
both projections must agree without host detection. Do not invent per-call tier
attribution or bill unpriced Auto. Use the [log runbook](docs/cache-log-runbook.md)
for cache, token and billing claims.

## HARD STOP — release / version bump / tag gate (non-optional)

**Do not edit the package version, create/push a `v*` tag, or publish until all
steps 1–4 below succeed in this turn.** CI or a previous run cannot replace them.

1. Run `bun run generate:pricing` against live Cursor docs.
2. Resolve every unmapped display name in `DISPLAY_NAME_TO_MODEL_ID` or
   `SKIP_DISPLAY_NAMES` (`scripts/generate-cursor-pricing.ts`); add wire ids to
   `test/fixtures/cursor-pricing-models.txt` and regenerate until exit 0.
3. Run `bun run check:pricing` successfully. Commit mapping/fixture/generated
   `src/pricing-data.ts` changes **before** the version bump commit.
4. Finalize `CHANGELOG.md`: cover every user-facing change since the release,
   rename Unreleased to `[X.Y.Z] - YYYY-MM-DD` using the UTC release date, and
   insert a fresh empty Unreleased section.
5. Only then bump the version, commit with the finalized changelog, tag and push.

A request only to bump/tag/publish still requires steps 1–4 first; report their
results before touching the version. The failed-release rationale belongs in
[general lessons](tasks/lessons/opencode.md#auth-models-and-delivery-process).

## Changelog

Use `CHANGELOG.md` → `## [Unreleased]`, with applicable `### Breaking Changes`
(first), `Added`, `Changed`, `Fixed`, `Removed` sections. Entries are brief,
user-facing, and link issues/PRs with public contributor attribution. Leave
released sections immutable. Pure docs/test/CI changes need no entry unless
operator or integrator behavior changes. Normalize formatting at release time.

Documentation ownership and environment/setup references:
[docs index](docs/README.md), [README](README.md), [1.x guide](docs/opencode-1.md),
[2.0 guide](docs/opencode-2.md), [lessons index](tasks/lessons.md).
