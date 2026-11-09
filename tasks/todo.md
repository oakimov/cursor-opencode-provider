# TODO

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
  from A/B results. Compare the frozen system-instructions rule with the
  recovered context-epoch reminder (`admitContextEpoch`, `src/context/epoch.ts`).
  Do not remove or narrow the reminder solely from code inspection.
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
