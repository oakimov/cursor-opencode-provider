# Security notes

This provider mirrors OpenCode’s trust model for project configuration. That has implications for what ends up in Cursor context.

## Project `instructions` can include arbitrary local paths

OpenCode’s `opencode.json` / `opencode.jsonc` `instructions` array may list:

- relative paths / globs (e.g. `.cursor/rules/*.md`)
- absolute paths
- home-relative paths (`~/…`)
- remote URLs (`https://…`; this provider fetches HTTPS only)

OpenCode itself expands `~/`, accepts absolute paths, and injects those file contents into the model prompt for **every** provider. This package does the same discovery when building Cursor `RequestContext.rules`.

So a project config like:

```json
{
  "instructions": ["~/.ssh/id_rsa", "/etc/passwd"]
}
```

can cause those files to be read and sent to the model provider (OpenCode prompt path and/or this provider’s Cursor `RequestContext`). That is intentional OpenCode parity, not a Cursor-only hole. There is no path allowlist that rejects absolute/`~/` instruction paths (matching OpenCode; OpenCode has not treated this as a defect).

Treat project `opencode.json` as **trusted**. Do not open untrusted repositories with project config enabled if that is unacceptable.

## Mitigation: disable project config

To ignore project-level OpenCode config (including project `instructions` and project `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` discovery), set:

```bash
export OPENCODE_DISABLE_PROJECT_CONFIG=1
```

OpenCode honors this flag when loading config and assembling prompts. This provider honors the same flag when collecting rules for Cursor `RequestContext`, so project `instructions` are not merged and project instruction files are not auto-discovered. Global config under `~/.config/opencode` (and `~/.claude/CLAUDE.md` when applicable) still applies.

Truthy values: `1` or `true` (case-insensitive), same as OpenCode.

## Related hardening in this provider

- Remote `instructions` URLs are **HTTPS-only** (`http://` is skipped). Redirects (including to a local proxy) are intentional and not blocked.
