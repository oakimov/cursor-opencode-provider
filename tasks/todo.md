# TODO

- [x] Fix [#165](https://github.com/oakimov/cursor-opencode-provider/issues/165),
  staged images lost during bursts.
  - [x] Reproduce the 35-image failure on current main and inspect the proposed fix.
  - [x] Trace the decompiled CLI's direct binary write and permission ownership.
  - [x] Preserve accepted bytes like the CLI; refuse new images at capacity
    instead of evicting issued handles. Count pending and claimed saves together.
  - [x] Cover burst saves, saturation, approval waits, release and module copies.
  - [x] Update staging limits, changelog and the existing incident lesson.
  - [x] Run final regressions, typecheck, build and the full test suite; review diff.
  - Review: issued handles survive capacity pressure, claimed saves retain their
    budget until settlement, and the 35-image burst saves byte-for-byte.
    Validation uses local fixtures and host contracts, without a live Cursor Run.

- [x] Enforce review evidence before rendering and publication.
  - [x] Reproduce clean rendering without a ledger and inspect later consumers.
  - [x] Validate a revision-bound ledger and mandatory command result at render.
  - [x] Retain digest-bound evidence and recheck it through approval/publication.
  - [x] Preserve existing frozen pending previews and reject new bypasses.
  - [x] Regress missing, stale, incomplete, changed and recovered evidence.
  - [x] Update review instructions and incident lessons; validate and review.
  - Review: rendering, preview, approval and publication enforce the retained
    evidence binding; existing pending bytes remain recoverable. These checks
    validate the evidence gate, not a reviewer's defect-detection rate.

- [x] Fix [#160](https://github.com/oakimov/cursor-opencode-provider/issues/160),
  debug-log retention following OpenCode's append and in-place trim policy.
  - [x] Verify OpenCode 1.18.31 and 2.2.5 writers and recycling behavior.
  - [x] Design: preserve paths/modes, trim above 50 MiB to a line-aligned
    25 MiB tail, check on first write and hourly, coordinate through a lock.
  - [x] Implement bounded-memory compaction and shared maintenance cadence.
  - [x] Test retention, startup/reload, append handles, locks and failures.
  - [x] Update operator guides and changelog; typecheck, build and regressions.
  - [x] Design opt-in numbered rotation with configurable size and archive count.
  - [x] Implement rotation while retaining the default in-place trim policy.
  - [x] Cover archive ordering, startup/reload, concurrent writers and failures.
  - [x] Document rotation settings and validate the updated build.
  - [x] Cover enabled logging in the instrumented test process and validate
    patch LCOV without changing coverage thresholds.
  - [x] Reproduce and fix archive loss on repeated active-file rename failures.
  - [x] Reproduce and fix stale cleanup removing a newly acquired lock.
  - [x] Validate failure recovery, documentation and full coverage.

- [x] Fix [#91](https://github.com/oakimov/cursor-opencode-provider/issues/91),
  OpenCode 2.x cold model readiness.
  - [x] Trace OpenCode 2.1.4 activation and model resolution.
  - [x] Bound cold discovery/publication, retain warm-cache startup and retries.
  - [x] Reject superseded or expired attempts and publication after cleanup.
  - [x] Cover delayed discovery/publication, warm cache, missing/rejected
    credentials, discovery/publication failure, deadlines and credential changes.
  - [x] Update operator docs; run typecheck, build, regressions and native
    OpenCode 2.1.4 cold/warm checks and same-session continuity.
  - [x] Preserve cached/discovered inventory when optional connection metadata
    fails, with independent required authentication and regression coverage.

- [ ] Redesign shell handling around native OpenCode execution and eradicate
  unnecessary provider duplication. Preserve the current fixes while designing
  the replacement; passing supervisor tests alone does not justify keeping it.
  - [ ] Trace supported OpenCode 1.x and 2.x execution, permission, background,
    timeout, cancellation, output, and completion contracts from their actual
    sources. Start with the [classic shell tool](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell.ts),
    [2.x shell tool](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/tool/plugin/shell.ts),
    [public shell endpoints](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/protocol/src/groups/shell.ts),
    and [plugin context](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/plugin/src/promise/plugin.ts).
    Verify supported access from the plugin rather than inferring missing
    capabilities from the shell hook alone.
  - [ ] Let native tools own foreground execution, shell selection, permissions,
    process groups, deadlines, cancellation, and OpenCode 2.x background jobs and
    completion notices. Keep launch authorization on the native tool path;
    direct shell creation must not bypass its permission checks.
  - [ ] Keep only the Cursor protocol adapter: map Cursor numeric shell IDs to
    native handles, translate output/status/exit results and soft-background
    handoffs, and serve the required terminal view from native output. Verify
    hard deadlines, bounded reads, handle retention, and restart behavior.
  - [ ] Retain a classic fallback only for a demonstrated native capability
    gap. Document the gap and the smallest required emulation; do not impose it
    on OpenCode 2.x or add compatibility-layer or alternate-host dependencies.
  - [ ] Remove redundant supervisor, collector, lifeline, polling, wrapper,
    startup-injection, and job-file code and their implementation-specific
    tests once native behavior replaces them. Keep independent catalog-spill
    storage and necessary protocol translation; update README and changelog.
  - [ ] Validate rebuilt, loaded providers in both native hosts with scripted
    Cursor traffic: foreground results, fast and long background commands,
    soft/hard timeouts, denial, interruption, daemon survival, output polling,
    host completion notices, and concurrent sessions. Run regression, strict
    compiler, architecture, and package checks before declaring the redesign
    complete.

- [ ] Evaluate recent-inbound-traffic HTTP/2 ping suppression separately from
  parallel tool-call batching. Compare Cursor CLI connection management with
  [the fork's transport optimization](https://github.com/nkoynov/cursor-opencode-provider/commit/c1643f7009a575350dc95f1a1ba299938efdda9e)
  and [cancellation follow-up](https://github.com/nkoynov/cursor-opencode-provider/commit/e498c9e45b002ca469a0ca793b20555ca6bfea60).
  Measure the benefit and test retired-session cancellation on Bun and Node;
  any resend must preserve replay safety and must not treat missing response
  headers as proof that a stateful Run was never processed.

- [ ] Investigate the system prompt resent after a restart, and decide only
  from A/B results. The frozen system-instructions rule already goes out with
  every Run and keeps the prompt cache. Separately, the first turn after a
  process restart (`context epoch: recovered`) also puts the whole live host
  system prompt into the user text as "Current host system instructions after
  session recovery" (`admitContextEpoch`, `src/context/epoch.ts`). Seen live
  2026-10-17 on OpenCode 1.19.3 with grok-4.7: about 43 KB of user text against
  27 characters on the session's first turn. A process per turn (`opencode
  run`) pays it on every turn. The reminder exists because a checkpoint may
  hold instruction changes made after the frozen rule. It is documented
  behavior, not a known bug, so do not remove or narrow it from reading code.
  - [ ] Measure first: uncached input and cache reads on the first turn after a
    restart, with and without the reminder, on both hosts and on several models
    (Claude, GPT, Grok, composer).
  - [ ] A/B the behavior: after a restart, does the model still follow the host
    instructions without the reminder? Cover unchanged instructions, an
    AGENTS.md or MCP instruction change before the restart, an agent switch
    (build/plan) before the restart, and a restart right after compaction.
  - [ ] Only then choose: keep it, skip it when provably redundant (persist the
    epoch snapshot the checkpoint actually reflects, including in-progress
    saves of a held Run), or send only what changed. Record the results and
    the reason for the choice in `tasks/lessons/` and AGENTS.md.

- [x] Design how Cursor metadata spills (`write_args` to
  `<project_folder>/agent-tools/<uuid>.txt`) are written, to match Cursor CLI
  behavior instead of routing them through the host `write` tool. Implemented
  in `src/runtime-files.ts`, sharing the managed terminal layout.
