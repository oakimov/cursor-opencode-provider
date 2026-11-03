# OpenCode 1.x

Classic OpenCode and the 1.18 Effect/Promise **v2** plugin API. For OpenCode 2.x, see [opencode-2.md](./opencode-2.md). Shared catalog behavior (variants, 1M, Fast, images) lives in the [root README](../README.md#select-a-model).

This guide follows the development checkout. Check [Unreleased](../CHANGELOG.md#unreleased)
for fixes that require a rebuilt local install until the next release.

## From npm

OpenCode installs npm plugins with Bun at startup (cached under `~/.cache/opencode/node_modules/`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["cursor-opencode-provider"],
  "provider": {
    "cursor": {
      "npm": "cursor-opencode-provider",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

Pin a version if you want: `"cursor-opencode-provider@0.8.2"`.

You can also install it yourself first:

```bash
npm install cursor-opencode-provider
# or: bun add cursor-opencode-provider
```

If the `cursor` provider block is omitted, the classic plugin auto-registers it on startup (as **Cursor Integration**) using this package's entry. Model entries come from the local cache, which is filled after auth and again on startup when the cache is empty but credentials remain.

## From a local clone

```bash
git clone https://github.com/oakimov/cursor-opencode-provider.git
cd cursor-opencode-provider
bun install
bun run build
```

Point classic OpenCode config at the built files with absolute `file://` URLs:

```json
{
  "plugin": ["file:///absolute/path/to/cursor-opencode-provider/dist/plugin.js"],
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/cursor-opencode-provider/dist/index.js",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

OpenCode does not install dependencies for a copied-out plugin file. Load the plugin from inside the clone so `protobufjs` resolves. Rebuild (`bun run build`) after every change; the host reads `dist/`, not `src/`.

## 1.18 v2 plugin API

For OpenCode builds that use the Effect/Promise **v2** plugin API (`plugins` field), also load:

```json
{
  "plugins": ["cursor-opencode-provider/plugin/v2"]
}
```

Local clone equivalent: `"file:///absolute/path/to/cursor-opencode-provider/dist/plugin-v2.js"`.

That entry registers the provider via `ctx.aisdk.sdk` / `ctx.aisdk.language`. Keep the classic `plugin` entry for auth **and** plugin tools (notably `cursor_image_save` / `custom_websearch`): the 1.18 `/v2/promise` API has no `tool` domain, so a v2-only load silently disables Cursor image generation.

Do **not** load `cursor-opencode-provider/plugin/opencode2` under OpenCode 1.x. That entrypoint is OpenCode 2.x only.

OpenCode 1.18 prefers `package.json` `exports["./server"]` when resolving a package-dir plugin. That subpath is the OpenCode 2.x module, but it dual-exports `server: CursorPlugin`, so classic 1.x hooks still run. Keep using `"plugin": ["cursor-opencode-provider"]` or `/plugin` — do not point 1.x config at `/plugin/opencode2` for its `setup()` API.

## Authenticate

```bash
opencode auth login
```

Choose the **cursor** provider, then browser login (PKCE) or an API key (`crsr_...` from [cursor.com/settings](https://cursor.com/settings)). After login, the plugin fetches available models into `<host-cache>/cursor-models.json`.

## Select a model

```bash
opencode run --model cursor/composer-2.5 "Hello from Cursor via OpenCode"
```

Variant, long-context, Fast, image, and Max Mode behavior is the same on every host — see [Select a model](../README.md#select-a-model) in the root README.

Choose `cursor/grok-4.7-500k` (or `-500k-fast`) for its advertised 500k tier;
the base `cursor/grok-4.7` entry keeps its 256k limit. Selecting a model entry
without a variant retains Cursor's declared default effort for that tier.
Saved 500k variants on the base/Fast entries remain valid after upgrading;
reselect the dedicated 500k entry to use its full host context budget.

## Planning and session edit rules

Cursor tools use the route advertised for the current turn. Call a supplied
top-level SwitchMode/CreatePlan function directly; when listed in a dynamic
namespace, discover its schema and invoke it through CallDynamicTool with the
discovered namespace, tool name and arguments. Discovery is not a mode switch.

When the provider owns the native agent handoff, approval ends the plan Run
before starting the build turn. Declining or dismissing the review ends the
current turn and keeps the session in plan; a new user message is required
before any further work, including self-test images or scoring. Typing freeform
feedback into the provider's emulated `question` review keeps the turn open in
plan mode and sends that text back as the CreatePlan reply so the model can revise.
Host-owned `plan_exit` and plan-stage reviews retain their native outcomes.

CreatePlan persists the plan through an advertised host `write` or patch tool,
shows it, then asks whether to implement. When a plan-file exception permits
saving, a session-wide edit deny keeps the saved plan without an implementation approval
or a build-agent handoff; allowing only the plan file does not lift that deny.
Host file permission may still prompt for the save.
Change the session rule in the client before approving implementation. The
classic plugin reads native `permission` rules, retries a failed session lookup
once, and blocks CreatePlan and implementing mode switches if the rules remain
unreadable. Ordinary requests and native tool permission checks still work;
lookup failure is not treated as an empty ruleset. A saved plan held by an edit
deny ends its turn before any queued tool can execute. Compaction reads no rules.
Rule changes reach held tool continuations too; lifting a deny replaces its
earlier reminder without bypassing the normal plan review, including when a
deferred note restores an older deny. Ordinary tool steps without a deny to
supersede send no rule reminder.

## Task attachments

Cursor Task attachments reach the native `task` prompt as exact, quoted file
paths, retaining Cursor's description. The child opens each file through its
own permission-checked tools; attachment bytes are not read into the parent.
Choose an image-capable child model for image inspection. See
[shared subagent routing](../README.md#native-subagent-routing).

## File editing

Eligible GPT models receive `apply_patch` instead of `edit` / `write`. The
provider advertises that host tool and converts Cursor-native file execs using
the current permitted catalog, including after a model switch. Targeted edits
preserve existing LF/CRLF conventions; intentional whole-file writes retain
their requested contents. See [shared patch behavior](../README.md#apply_patch--patch-on-gpt-models)
and [1.x incident lessons](../tasks/lessons/opencode-1.md).

Edit rows use Cursor's own result when an edit finishes without a host write,
including errors after the authorized read. A row still waiting for its exec
may close as deferred when another tool ends the step; a terminal Run closes it
as unfinished, and a refused exec as failed with the refusal reason, including
when other calls are pending or Cursor later reports a different completion.
A binary write staged for the image save tool hands its row to that tool.
Failure labels use the permitted catalog without reading target files.
See [shared early-row behavior](../README.md#known-limitations).

## Shell failures and interruption

Wrapped commands expose their real exit status to the host. A hard timeout
exits 124; a background handoff exits 0. The request projection adds failed
command status from `metadata.exit` for history rebuilds and removes that
notice from live stdout while preserving command bytes.

Terminal-record headers and footers stay out of command stdout, including
when completion races a timeout or background handoff.

Shell output keeps path-like text, whitespace and successful timeout-shaped
text unchanged. Internal wrapper markers are removed without trimming command
output, and failed shell streams retain partial output alongside their error.
A host shell failure reaches Cursor once as stderr in streamed and unary
results; distinct command output remains on stdout.

The classic plugin releases unstarted shell reservations from persisted tool
error events as well as the after hook, because rejection can stop the host
before a continuation. OpenCode 1's shell [returns a null exit after abort or
timeout](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell.ts#L542-L589);
the provider preserves that outcome before parsing wrapper output.

For model requests, interrupted partial output stays an error with its progress
text. The host otherwise [converts interrupted error state to successful
output](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/message-v2.ts#L325-L346).
The plugin adjusts only the request's projection of Cursor-owned results;
stored messages are preserved.

## Interrupted model requests

OpenCode retries a transient failure after only text or reasoning when the
turn has no new checkpoint. An unfinished tool display row also permits retry
if no exec or started tool lifecycle arrived; it closes without execution.
Stateful activity stays a replay barrier. Like Cursor CLI, an active Run with no
pending host work fails after 30 s without an inbound frame; heartbeats and
partial inputs renew that deadline, while client heartbeats do not. The 120 s
transport read-idle watchdog remains a backstop. A drop immediately after
completed tool results can rebuild from complete host history
before new output; missing results or unrepresented activity remain final.
A rebuild too large for the model's context is reported as a context overflow
(413) so the host can compact. Recovery retains the latest eligible checkpoint across token renewal, including
a rejected credential on an untouched resumed attempt. Checkpoints received
while a completed tool result drains remain eligible only after Cursor acknowledges
the matching tool completion. A late pre-result checkpoint cannot authorize replay.
Question, mode-switch and plan replies use the same acknowledgement guard;
display-only todo mirrors do not wait for a second completion. Saves of
Cursor's input-image copies, which name no call and are never completed, do
not wait either; Cursor gets their reply at once, and a Run it finishes while a
save waits for approval is kept until the save is answered. A generated image's
save waits for its GenerateImage completion. A resumed Run counts the images
the interrupted Run sent. Terminal drains
recognize matching completions too. Follow-ups retain
checkpoints received while opening the new Run. Two resumed attempts that stream without saving a
checkpoint end the turn.
History recovery keeps completed results from earlier resumed Runs too.
Completed inline catalog lookups do not block it; unfinished, spilled, malformed,
and unknown server-side work still do. For recovery metadata without prompts or
tool payloads, set `CURSOR_PROVIDER_RECOVERY_DEBUG=1` before starting the host.

The provider shares Cursor CLI's limits of 10 transport retries and 3 server
retries across this turn, including OpenCode's retries. OpenCode can stop earlier.
Set `CURSOR_ENDLESS_RETRIES=1` or `true` before starting the host
to bypass count limits while retaining replay guards, Stop, final errors, the
two-resume cutoff and the 180 s consecutive semantic-stall retry window.
See [retry limits](../README.md#retry-limits) for classification and SDK options.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No Cursor models in the picker | Confirm Cursor auth (`opencode auth login` → **cursor**). Restart OpenCode — if auth is present and the cache is empty, models are fetched on startup. Confirm `provider.cursor.npm` is the package name (or a built `file://…/dist/index.js`). |
| Empty or stale model list | Delete `<host-cache>/cursor-models.json` (default `~/.cache/opencode/`) and restart. Existing Cursor auth is enough to refill the cache. |
| Image save / web search missing | You loaded v2 without the classic `plugin` entry. Keep both. |
| `401` / "sign in to Cursor again" | A browser login renews itself through Cursor's `/oauth/token` and is saved back to `auth.json`; an API-key login re-exchanges its stored key. Run `opencode auth login` → **cursor** again when the error says the session was ended, the key was rejected, or the login was saved without its key (API-key logins made before the key was kept in `metadata.apiKey`). |
