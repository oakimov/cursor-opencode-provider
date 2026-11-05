# Documentation

Start with the [project README](../README.md) for features, models, environment
variables and limitations. Host setup belongs in the matching guide.

| Guide | Purpose |
|-------|---------|
| [OpenCode 1.x](opencode-1.md) | Classic plugin and the separate 1.18 v2 API |
| [OpenCode 2.x](opencode-2.md) | Installation, daemon/local builds, tools and migration |
| [Cache and token logs](cache-log-runbook.md) | Continuity, usage, billing and cache evidence |
| [Checkpoint occupancy](checkpoint-occupancy.md) | Confirmation policy for isolated unexplained context spikes |
| [Host acceptance](host-compat-acceptance.md) | Planning, patch tools, steering and caching checks |
| [Execution self-verification](execution-self-verify.md) | Native shell, permissions, failures and cleanup |
| [CLI parity](cli-parity.md) | Provider support inventory and historical CLI comparison |
| [Cache decisions](cache-aggressive-hold-approval.md) | Approved conversation-retention design and source guards |
| [Review rules](review-rules.md) | PR review criteria |
| [OpenCode live test](pr-review.md) | Live plugin test and isolated pull-request checks |

Maintainers: [AGENTS.md](../AGENTS.md) owns current architecture and release
requirements, with implementation pointers rather than incident histories;
[CONTRIBUTING.md](../CONTRIBUTING.md) owns contribution workflow.
The [lessons index](../tasks/lessons.md) separates general, 1.x and 2.x incident
rationale. Future work is tracked in [tasks/todo.md](../tasks/todo.md).

[SECURITY.md](../SECURITY.md) covers the trust model and private reporting;
[CHANGELOG.md](../CHANGELOG.md) records shipped and unreleased behavior.
Keep current behavior in guides, failure rationale in lessons, and dated test
results in separate run reports. Source/test links support implementation
claims; a checklist is not a claim that a live test has passed.
