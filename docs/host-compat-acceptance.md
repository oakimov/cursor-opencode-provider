# Host compatibility acceptance checklist

Run this checklist before releasing changes to CreatePlan, SwitchMode, tool-catalog caching, or the structural host boundary. Unit/type tests support the result; they are not proof of interactive behavior.

## Build/install preflight

- [ ] Provider: `bun run generate:pricing && bun run check:pricing` (commit mapping/`pricing-data.ts` updates before any version bump)
- [ ] Provider: `bun test && bun run typecheck && bun run build`
- [ ] Provider: `bun test test/architecture.test.ts` again **after** build (covers `dist/`)
- [ ] OCP: `bun test ./test && bun run typecheck && bun run build`
- [ ] OCP: `bun test test/architecture.test.ts` again after build
- [ ] `git diff --check` in both repositories
- [ ] Rebuild/reinstall the exact package entries the stock host loads; verify symlink/install tree and loaded `dist` path
- [ ] Do not modify a host/vendor checkout

## Classic OpenCode — CreatePlan approval

1. Start stock OpenCode in a TTY with provider debug logging enabled.
2. Ask for a small plan that requires CreatePlan.
3. Verify the complete plan is visible in transcript before the approval dock.
4. Choose **Yes**.
5. Verify exactly one synthetic build turn starts.
6. Verify the kickoff starts only after the continuation Run has emitted `turn_ended`, persisted state, released pump ownership, closed the provider stream, and has zero pending execs.
7. Verify no second/superseding Run starts before that boundary.
8. Verify implementation begins and completes normally.

Record: host version, provider/OCP paths, plan URI, Cursor/OpenCode session ids, relevant debug timestamps, and kickoff count.

## Classic OpenCode — kickoff failure/retry

1. Use a controlled host-client stub or reproducible host failure that makes `session.promptAsync` reject.
2. Approve the plan.
3. Verify the failure is logged with a structured reason and a user-visible warning appears on the next provider turn.
4. Verify plan mode remains/restores active and the plan remains retryable.
5. Trigger one explicit later provider turn; verify one retry only (no timer loop).
6. Restore the host seam and verify retry succeeds exactly once.

## OpenCode 2.0

1. Load only `cursor-opencode-provider/plugin/opencode2` in stock 2.0.
2. Enter plan mode and raise CreatePlan.
3. Approve execution.
4. Verify the plan is written but CreatePlan returns a clear execution-not-started error because the public SessionDomain cannot select `agent: "build"`.
5. Verify the provider does not flip to agent mode and does not claim success.
6. Verify no private/unsupported host API is invoked.

## OMP interactive plan review

For each choice, start from a fresh plan-mode session:

- **Approve and execute**: one success, plan mode exits, one follow-up execution starts.
- **Refine plan**: tool returns error, message says refinement was requested, plan mode stays enabled, no execution starts.
- **Dismiss/cancel**: tool returns error, message says not approved/cancelled (not “refinement requested”), plan mode stays enabled, no execution starts.
- Host denials/rejections map to Cursor's user-reject reason.

Capture transcript and side effects; confirm no retries/duplicate follow-ups.

## Pi generic-provider isolation

1. Configure a generic/non-Cursor OpenCode provider through pi-bridge.
2. Start stock Pi with no Cursor provider installed.
3. Verify generic provider/model registration and one text + one tool-loop turn.
4. Verify no Cursor host tools are imported/registered and no missing-Cursor error is logged.
5. Configure a provider whose name merely contains “cursor”; verify Cursor tools still do not activate.

## Catalog/cache diagnostics

For one cold session followed by a normal continuation:

- lifecycle call may arrive with `incomingTools=0`, but wire advertisement equals the full sibling catalog;
- lifecycle and real Run use identical RequestContext hashes;
- tool order and definitions are byte-stable;
- `allowTools=false` only affects execution permission, not advertisement;
- subsequent diagnostics show warm continuity/cache reads rather than a catalog-induced rebuild.

Use `docs/cache-log-runbook.md` for exact fields and handoff evidence.

## Filesystem hygiene

- [ ] `git status --porcelain -uall` unchanged in the test project
- [ ] no `.opencode/` or other host config directory created by CreatePlan
- [ ] plan is under the resolved host data `plans/` directory
- [ ] no temporary/debug/agent-worktree files remain in either repository

## Reporting

State each interactive item as **passed**, **failed**, or **not run**. Never infer a TTY result from unit tests. Include exact versions and log paths so another maintainer can reproduce the acceptance run.
