# Host compatibility acceptance checklist

Run this checklist for changes to CreatePlan, SwitchMode, file-tool substitution, early steers, tool-catalog caching, or the structural host boundary. Unit/type tests support the result; they are not proof of interactive behavior. This is a reusable procedure, not a record of passed tests.

## Build/install preflight

- [ ] For a release/version/tag only: follow the [pricing and changelog gate](../AGENTS.md#hard-stop--release--version-bump--tag-gate-non-optional); do not tag first and rely on publish CI
- [ ] Provider: `bun test && bun run typecheck && bun run build`
- [ ] Provider: `bun test test/architecture.test.ts` again **after** build (covers `dist/`)
- [ ] For structural/OCP boundary changes, also build/test OCP and run its architecture checks after build
- [ ] `git diff --check` in each affected repository
- [ ] Rebuild/reinstall the exact package entries the stock host loads; verify symlink/install tree, loaded `dist` path, and copied package manifests/exports as well as file contents
- [ ] OCP plugin discovery accepts valid JSONC without joining tokens across comments, and rejects malformed JSONC and unterminated block comments
- [ ] Do not modify a host/vendor checkout

## OpenCode 2.x model startup

Use stock OpenCode 2.1.4 with the rebuilt local plugin and AI SDK entry. Isolate
config, data and cache; use a working Cursor credential without changing the
operator's store. Enable provider debug logs for each run.

1. With no `cursor-models.json`, immediately run a standalone request for an
   available Cursor model. Verify `opencode2 models: ready` precedes the first
   Run and the response completes without `provider.no-route`.
2. Repeat with the populated cache and compare startup with the cold run.
   Continue a conversation to verify checkpoint and frozen context continuity.
3. Delay AvailableModels and publication independently. Activation must remain
   pending until both finish, bounded by the readiness deadline. A pending
   GetServerConfig warmup must not postpone catalog readiness.
4. Check no credentials, rejected credentials, network/discovery failure, empty
   inventory and publication failure. Keep `/connect` usable, report the real
   startup failure and recover after a credential event or later activity.
   Host routing can still say `Model unavailable` after actual discovery failure.
5. Switch credentials during discovery and publication. Only the current
   attempt may publish; dispose a setup while discovery is pending and verify
   no later reload comes from it. Use deterministic fixtures for these races.
6. Seed a catalog just before its 24-hour expiry. After expiry, create a
   session without sending a prompt. Verify a newly discovered model appears
   in `model.list` without remounting the Location. Repeat with a failed
   discovery and verify the last good catalog stays visible.

## OpenCode 2.x foreign compaction

Use stock OpenCode 2.1.4 with the rebuilt plugin and provider, isolated host
state, and debug logs. Configure a compaction model from another provider.

1. Build a Cursor conversation, compact it, and retain recent Cursor messages
   after the summary. Confirm the next Run uses a new conversation id, the same
   conversation group, no old checkpoint, and the summary plus retained history.
   Continue once more: the new conversation and checkpoint stay warm.
2. Fail a summary request. Confirm the next Cursor Run keeps its conversation
   and checkpoint. Repeat while a successful background summary is held but
   unused: preparing it alone must not invalidate the saved state. Apply that
   precomputed summary later and verify the rebase occurs then.
3. Compact between host tool steps. Confirm completed results seed the new
   Run once and are never uploaded onto the pre-compaction held Run.
4. Shut down after the successful compaction, before the next Cursor request,
   including with a held tool Run. Restart and verify compacted history replaces
   the old checkpoint. Exercise duplicate event observers across Locations and
   a late save from the retired conversation with deterministic fixtures.
5. Make snapshot saving fail. The receipt remains pending, the next request
   reports the failure, and a later request can retry after storage recovers.

These checks belong to the dedicated OpenCode 2.x entrypoint. Keep classic
compaction and warm-continuation regressions passing in the full suite.

## Classic OpenCode — approval without `plan_exit`

1. Start stock OpenCode in a TTY with provider debug logging enabled, in the default build agent.
2. Enter plan mode and ask for a small plan that makes Cursor raise CreatePlan, with `question` advertised and `plan_exit` absent.
3. Verify CreatePlan first emits a host `write` (or patch) of the plan file, then shows the plan in the assistant transcript before the `question` approval prompt. The provider must not write the file itself (`src/protocol/interactions.ts`, `src/protocol/create-plan.ts`, `src/language-model.ts`).
4. Answer No: the turn ends and the plan agent stays selected. Type freeform feedback instead of Yes/No: the CreatePlan reply carries that text, the turn continues in plan mode, and no build-agent switch starts. Answer Yes: after successful reply delivery, verify a native build-agent turn starts and the requested implementation happens once (`src/language-model.ts`, `src/host-agent-mode.ts`).

## OpenCode 1.x without `plan_enter`

1. Start OpenCode 1.x in a TTY with `OPENCODE_EXPERIMENTAL_PLAN_MODE=1` (so `plan_exit` is advertised) and provider debug logging, in the default build agent.
2. Ask the model to switch to plan mode and plan a tiny change.
3. Verify `host-agent-mode: pending … target=plan`, any CreatePlan in that Run replies `outcome=failed` (deferred, nothing written), and `host-agent-mode: switched … target=plan` follows the Run's end.
4. Verify the next turn runs under the `plan` agent with `cursorMode=plan`; CreatePlan logs a bridged host `write`/`patch` first, then `BRIDGED create_plan … bridge=exit hostTool=plan_exit`, the plan is shown at the session plan file (`.opencode/plans/<created>-<slug>.md` in a git project), and the `plan_exit` question appears. The model makes no `get_mcp_tools` lookup for `plan_exit`.
5. Answer No: the turn ends, the session stays in `plan`, and no further tool runs until a new human message.
6. Approve: verify `host-agent-mode: host left plan agent`, the session returns to the build agent, and the change is applied exactly once.
7. Verify no turn is injected into subagent or hidden sessions.
8. New session: pick `plan` in the agent picker (Tab) before asking for a plan. Verify `host-agent-mode: host entered plan agent`, the Run logs `cursorMode=plan`, and steps 4–6 hold without any SwitchMode: CreatePlan persists through the host file tool then bridges to `plan_exit`, with no MCP `plan_exit` call by the model and no `get_mcp_tools` lookup.

## OpenCode 2.x

Install and leftover-dump cleanup: [OpenCode 2.x setup](./opencode-2.md) ([safe transition](./opencode-2.md#safe-transition)).

1. Load only `cursor-opencode-provider/plugin/opencode2` in stock 2.x (prefer a dedicated `OPENCODE_CONFIG_DIR`; use a `$OPENCODE_CONFIG_DIR/plugins/<name>/` package directory, not a bare `.js` path).
2. Confirm Cursor auth + models: `/connect` → Cursor, then Cursor models in the picker (in-memory `ctx.provider` inventory). There must be no leftover `providers.cursor` in `opencode.json`. Filter picker by provider Cursor if needed (`time.released` is `0`).
3. Enter plan mode (Tab to Plan, or ask the model to switch). If the model uses SwitchMode from the build agent, that Run should end and a Plan-agent turn should start (`host-agent-mode: switched`); CreatePlan belongs in that Plan turn.
4. Verify the plan is written to the Plan directory, the plan appears in the transcript before the advertised `question` approval prompt, and the session is the Plan agent.
5. Answer No: end the turn and remain in plan mode. Answer Yes: verify the native build-agent continuation and one implementation. Also check a manual switch to build: `host-agent-mode: host left plan agent`, `cursorMode=agent`, and implementation follows the plan.
6. Verify no private/unsupported host API is invoked.
7. Ask for SwitchMode to the already active native agent, including plan/spec aliases. It should approve without cancelling the Run, switching agents, or injecting a continuation turn.

## Session edit deny

Run on stock OpenCode 1.x and stock OpenCode 2.x after the plan-approval checks above.

1. With no session edit rule, a plan-agent catalog that omits edit still asks whether to implement, and Yes switches to the build agent and uses the normal edit or patch tool.
2. Set a session rule whose last `edit` match on `*` is deny, then allow edit only for the plan file. Ask for a plan.
3. Verify the plan file is written and shown, no approval question is asked, no agent switch runs, and the owning Run cancels and drains before any queued tool can run. Include a queued shell command that would write a proof file; that file must not exist afterward.
4. Replace that rule with `edit` `*` allow. A later plan approval ends the old plan Run, starts the native build turn, and uses the normal edit or patch tool there. No second approval prompt or host execution may come from the old plan Run. Decline must end the turn, leave the session in plan, and emit no further tools until a new human message.
5. Ask the model to enter plan mode. When SwitchMode is dynamically listed, verify discovery is followed by CallDynamicTool using the advertised identity, then a real `switch_mode_request_query` and native plan-agent handoff. A lookup or narration is not execution or an unavailable refusal. Verify CreatePlan writes and displays the plan in the following plan turn; a supplied top-level function remains a valid route. Check the advertised route for GenerateImage too when image save is available.
6. Change the session edit rule while a tool is held. Verify its result is delivered first, followed by current rule guidance, without replacing the Run. Lift a deny after a checkpoint: the next plan turn must supersede the deny reminder while retaining the conversation and frozen RequestContext. Repeat with a deferred deny after a no-deny turn, and after failed or duplicate delivery. Ordinary tool steps without a deny carry no rule reminder.
7. Restart after a handoff's zero-token terminal checkpoint. Verify the next Run sends that checkpoint unchanged and retains its last measured occupancy as the cached prefix.
8. Fail both session lookups. Text-only answers and read-only work must remain usable; CreatePlan and an implementing SwitchMode must fail closed and end the owning Run. A read-only mode or plan entry remains available. Repeat while a review is pending: a returned Yes must not approve execution using unknown rules. Restore the lookup and verify a later user turn reads the current rules again.
9. Include quotes and an echoed copy of the review question in typed feedback. Preserve the whole answer without approving its prefix. Malformed or conflicting single-choice JSON answers must fail closed. If a result batch contains No followed by another review approval, No must keep the owning Run's execution gate closed.

## Refusal and native permission matrix

Run on both native majors; do not infer permission from catalog membership.

1. Decline an execution review while later text, shell, file, metadata and image requests are queued. The owning Run sends cancellation, drains its terminal acknowledgment, emits no later host call, and keeps the plan agent. A fresh human message is required before any more work. A synthetic handoff or a tool answer does not supply that authorization.
2. In any self-test, No/dismissal ends the turn before images, scoring, or scratch cleanup. Score P1, P2 and T7 **failed** if any tool executes after refusal and before a new human message, even if it performs only read-only checks or the requested implementation remains unapplied. An honored refusal is an expected passing case. Typed freeform refine feedback may continue the same turn in plan mode; score that separately from refusal. Score unknown chronology **blocked**.
3. On a later user turn still in plan mode, test path-specific edit allow/deny/ask, read denial, external-directory denial, and plain rejection with the host's native rules. On 2.x the plan-path exception can leave `cursor_image_save` advertised; a save outside that exception must still be denied, before creating a file or parent directory. Optional todos assert their own permissions too. Policy failure or missing native permission APIs must never become implicit approval.
4. An exact, successful native read permits the correlated edit prerequisite to supply complete contents above the host preview cap. A denied, failed, unrelated or still-pending read must not do so. The eventual mutation remains a native edit/patch operation.
5. Keep intentional runtime operations: an authorized shell launch captures output and updates its terminal record without extra edit approval; polling that exact record and catalog spills still work under workspace edit denial. Denied launches start no payload, and released unstarted reservations cannot later launch. Already running authorized jobs survive a plan-review refusal. Reject arbitrary writes, symlinks and hardlinks under the runtime root; generated assets there still require ordinary user-artifact permissions.
6. Private Git diff requests return a typed refusal directing the model to the native shell; no provider child process starts for that exec. Explicit native shell requests retain the host's command scanner, selected shell and permission path.

## OMP interactive plan review

This is a separate OCP-owned compatibility run, not native OpenCode acceptance.

For each choice, start from a fresh plan-mode session:

- **Approve and execute**: one success, plan mode exits, one follow-up execution starts.
- **Refine plan**: tool returns error, message says refinement was requested, plan mode stays enabled, no execution starts.
- **Dismiss/cancel**: tool returns error, message says not approved/cancelled (not “refinement requested”), plan mode stays enabled, no execution starts.
- Host denials/rejections map to Cursor's user-reject reason.

Capture transcript and side effects; confirm no retries/duplicate follow-ups.

## Mode-switch delivery and concurrency

Use controlled transport/host-callback failures for these supporting checks;
then exercise the successful handoff in the stock host's interactive session.

1. Fail delivery of an approved CreatePlan reply. Verify recorded Cursor mode stays in plan mode and no implementation or native build-agent switch is queued.
2. Deliver the approval successfully. Verify the native switch waits for the owning Run to end and starts exactly one implementation turn.
3. Trigger overlapping native-agent switch flushes for one session. Verify at most one host callback runs at a time.
4. Queue a replacement while the callback is pending. Verify completion or failure of the older callback preserves the replacement and its Run ownership, and releases the callback lock so the replacement can run.

## OCP host capabilities and continuations

Run on stock MiMo, Kilo, Pi, OMP, and DSH through OCP, using the shared
[Cursor + OCP self-verify checklist](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/cursor-ocp-self-verify.md).

1. Exercise each available question, todo, helper, plan-review, and image-save capability. Skip only unavailable capabilities; an unanswered question or unexercised image save is not a pass.
2. Verify todo snapshots preserve completed entries and leave no exercised item open at the end. Check both stored task status and the live task display: completing a task must show a checked row, including after row reordering; cancelling a task must not appear as completion. Verify helper output reaches the parent once.
3. On DSH, verify a child notice after a tool result still delivers that result and resumes the pending assistant tool call. Notices after a completed text-only assistant reply must not start another turn.
4. Verify plan approval precedes implementation, No/dismissal ends the owning turn while keeping the plan agent, typed freeform refine continues in plan mode when that host path applies, and execution happens once. If plan staging fails, verify no execution starts and a later explicit retry can complete the review.
5. Verify an image save succeeds, its file exists with the reported byte count, and its default artifact location stays outside the worktree unless an in-repository path was requested.
6. With a plugin that changes `chat.params`, verify provider options, temperature, topP, topK, and maxOutputTokens reach the model with the plugin's values. Report a failed field independently of successful registration or tool execution.

## Pi generic-provider isolation

1. Configure a generic/non-Cursor OpenCode provider through pi-bridge.
2. Start stock Pi with no Cursor provider installed.
3. Verify generic provider/model registration and one text + one tool-loop turn.
4. Verify no Cursor host tools are imported/registered and no missing-Cursor error is logged.
5. Configure a provider whose name merely contains “cursor”; verify Cursor tools still do not activate.

## Catalog/cache diagnostics

For one cold session followed by a normal continuation:

- host-empty lifecycle calls advertise `[]` on an ephemeral conversation and do not wait for a sibling catalog;
- score lifecycle RequestContext separately from the real Run; identical hashes are not required;
- nonempty epoch catalogs keep existing descriptors/order and append new names; a permission shrink does not rewrite them;
- execution uses the current permitted set, independently of epoch advertisement; OpenCode 2.x compaction can retain a nonempty advertisement while refusing all execution;
- subsequent diagnostics show warm continuity/cache reads rather than a catalog-induced rebuild;
- a smaller incoming catalog that carries a result matching a pending parent call reconciles that result on the parent conversation before helper isolation;
- a real helper uses its own conversation and leaves the held parent intact;
- plan approval and the following implementation request retain the parent conversation with a nonempty checkpoint, `reset=false`, and `requestContextReused=true` at each transition;
- every emitted usage-validation record reports `status=ok`; a later warm Run does not excuse an earlier unexpected parent reset.

Use `docs/cache-log-runbook.md` for exact fields and handoff evidence.

## File edits on both majors

1. Build and verify the loaded provider in native 1.x and 2.x separately, with
   both `CURSOR_PROVIDER_DEBUG=1` and a fresh `CURSOR_PROVIDER_DEBUG_FILE`.
2. Use an eligible GPT model. Verify the host advertises `apply_patch` on 1.x or
   `patch` on 2.x. Create a file, make a native targeted edit, and exercise a direct
   dynamic patch call. Verify file bytes and exactly one mutation per request.
3. Cover blank lines, substring changes, existing-file replacement, LF and CRLF.
   1.x targeted edits retain the existing newline convention; 2.x patch requests
   that would lose CRLF must return a typed refusal and leave the file unchanged.
4. Switch to a model/turn that permits native edit/write, then back. Verify
   translation follows the current permitted catalog, including edit-only and
   restricted turns; a frozen advertisement must not authorize a forbidden tool.
5. Compare the next ordinary turn's conversation/checkpoint/RequestContext and
   raw cache counters. Report refusals separately from unexpected protocol or
   dynamic-wrapper failures ([patch details](../README.md#apply_patch--patch-on-gpt-models)).

## OpenCode 2.x early steers and Stop

1. While Cursor waits on a known background job, send a plain-text steer without
   files or skills. Verify its answer arrives before the job ends and only once.
2. Send a queued message, change it to steer, and verify the same behavior. A
   message that cannot be admitted early must remain available at the host boundary.
3. Exercise Stop followed by multiple messages, mixed tool continuations, and
   restart/retry before the host promotes its copy. Preserve every unmatched
   message and attachment; repeat the same words later and require a fresh answer.
4. Inspect complete host/provider logs for duplicate Runs, lost receipts, invalid
   calls, usage mismatches or unexpected resets. Compare a separate warm follow-up.
   Use [deterministic regressions](../test/early-steer.test.ts) for exact promotion
   and attachment cases; label those separately from live-model observations.

## Filesystem hygiene

- [ ] `git status --porcelain -uall` unchanged in the test project
- [ ] no package install or unrelated host configuration created by CreatePlan
- [ ] plan uses the host's own location: the known session plan file for OpenCode 1.x (which may be worktree `.opencode/plans/`), the Plan directory for OpenCode 2.x, or the structural bridge's location (`src/context/paths.ts`, `src/host-plan-file.ts`)
- [ ] no temporary/debug/agent-worktree files remain in either repository

## Reporting

State each item as **passed**, **failed**, **skipped** (capability unavailable),
or **not run**. Record the host/provider/OCP versions, loaded package entries,
and evidence location with transcript records or debug-log line numbers for
each result. Redact credentials, identities, and private local paths. Keep
interactive outcomes separate from controlled regressions and build/package
checks; never infer a TTY result from unit tests or a supplied run made before
the current rebuild. Store dated run reports separately from this reusable
checklist.
