# Contributing to cursor-opencode-provider

External contributions are welcome. Start with an idea or bug report when the change is non-trivial (see below).

## Before you write code

Post an [idea](https://github.com/oakimov/cursor-opencode-provider/discussions/categories/ideas) first (and wait for maintainer direction) for new features, public API or config changes, auth/transport/protocol behavior, broad refactors, or dependency bumps. Bugs go to [issues](https://github.com/oakimov/cursor-opencode-provider/issues) — see below.

Security vulnerabilities: use GitHub's private [vulnerability reporting form](https://github.com/oakimov/cursor-opencode-provider/security/advisories/new) — do not open a public issue, discussion, or PR. See [SECURITY.md](./SECURITY.md).

Host-specific work for other coding agents belongs in [OCP](https://github.com/oakimov/opencode-plugin-compat), not here. This package stays OpenCode-only and host-neutral; see [AGENTS.md](./AGENTS.md).

## Bug reports

Every bug issue must include:

- Clear **reproduction steps** (host, plugin entrypoint, what you did, what you expected, what happened)
- Which **model** was used (Cursor model id as shown in the host)
- Provider debug logs from a reproduction with `CURSOR_PROVIDER_DEBUG=1` (optional `CURSOR_PROVIDER_DEBUG_FILE`; default path is under `$TMPDIR/cursor-provider-logs-<uid>/` — see [README](./README.md))
- Relevant **host logs** from the same reproduction

Prefer, but do not require, relevant excerpts from the session transcript that show the failure.

Issues without reproduction steps, model, or debug/host logs will be closed.

## Development

```bash
bun install
bun run build
bun run typecheck
bun test
```

Full commands, architecture, and release rules: [AGENTS.md](./AGENTS.md). Install
and operator docs: [README.md](./README.md) and the [documentation index](docs/README.md).
Before changing behavior, read the [general and host-specific lessons](tasks/lessons.md).
Merge new incident lessons with existing causes rather than appending duplicates.

## Pull requests

We strive for exceptional quality and consistency — mass-produced slop is not welcome. Keep at most **3 open PRs** per contributor at a time.

When opening one:

- Keep it small and focused on one problem.
- Explain the problem and fix in your own words; say how you verified it.
- If the PR changes behavior or how models treat something, include **A/B testing results** (before vs after, models tried, what improved or regressed).
- **New features must follow OpenCode's security, sandbox, and permission model.** If OpenCode does not provide acceptable footing for a Cursor capability, mimic Cursor CLI's own client-side restrictions instead — and explain that choice and the permission/sandbox path in the PR.
- Link `Fixes #123` / `Closes #123` when applicable.
- Update [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` for user-facing changes.
- Update affected guides and acceptance criteria together; pure documentation corrections do not need a changelog entry. Keep released changelog sections immutable.
- Prefer conventional-commit titles (`fix:`, `docs:`, `test:`, …).
- PR descriptions must be human-readable: concise, concrete, and written for people — not verbose and not in LLM speak.
- **Bug fixes must not regress prompt caching** — confirm RequestContext / checkpoint continuity stays warm where it should (see `cache diagnosis:` lines in `CURSOR_PROVIDER_DEBUG` logs and [docs/cache-log-runbook.md](./docs/cache-log-runbook.md)).
- **Consider both OpenCode 1.x and OpenCode 2.x** for every fix — apply or verify the change on both majors unless the bug is specific to one entrypoint.

### Review and coverage requirements

- **Resolve every Greptile finding before merge, regardless of severity**, including minor issues and nits. Address each finding and resolve its review thread; leave no open Greptile issues.
- **Provide sufficient test coverage for new and changed behavior**, including relevant error paths. Address uncovered changes and coverage regressions reported by Codecov; all applicable Codecov checks must pass under the repository's [coverage configuration](codecov.yml).
- **PRs with unresolved Greptile findings or Codecov coverage issues will be closed if they go 3 days without an update addressing those issues.** Keep the PR updated while working through review and coverage feedback.

## License

Contributions are licensed under the [MIT License](./LICENSE). See also [DISCLAIMER.md](./DISCLAIMER.md).
