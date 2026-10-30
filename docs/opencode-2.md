# OpenCode 2.x

Dedicated entrypoint: `cursor-opencode-provider/plugin/opencode2`. Do **not** also load the classic `plugin` entry or `plugin/v2` under OpenCode 2.x — they target OpenCode 1.x APIs.

For OpenCode 1.x, see [opencode-1.md](./opencode-1.md). Shared catalog behavior (variants, 1M, Fast, images) lives in the [root README](../README.md#select-a-model).

If you previously ran this plugin against **OpenCode next** (`ctx.catalog`) or against a build that **wrote Cursor models into `opencode.json`**, start at [Safe transition](#safe-transition).

This guide follows the development checkout. Check [Unreleased](../CHANGELOG.md#unreleased)
for fixes that require a rebuilt local install until the next release.

## How models register (current)

Discovered Cursor models are published **in memory** through `ctx.provider.transform` → `editor.add({ info, models })` → `ctx.provider.reload()`. The plugin does **not** write a model list into `opencode.json`.

Cache seed (and `/connect` afterwards) refill the inventory. An empty first transform is a no-op, so a failed refresh keeps the last successful list.

On OpenCode 2.1.4, session requests wait for plugin activation before resolving
their model. With no usable cache, setup waits for authenticated discovery and
inventory publication, sharing a 10-second readiness budget. A populated cache
publishes immediately without waiting for credential renewal or fresh discovery.
Endpoint warmup runs separately from catalog readiness.

A temporary connection-metadata lookup failure does not hide saved or discovered
models: the inventory publishes without that optional metadata. Each Run still
requires a usable current credential; model visibility does not authorize access.

Missing credentials leave `/connect` available. Authentication, network, empty
catalog, publication and readiness-timeout failures are reported in startup
warnings and provider debug logs; setup stays active so later credential events,
host activity and the startup retry window can recover. The host may still
report `Model unavailable` when discovery actually fails: its public plugin API
has no hook to replace that routing error before a model exists. Results from
superseded credentials, expired attempts or disposed setups cannot publish a
new inventory. See [startup acceptance checks](host-compat-acceptance.md#opencode-2-model-startup).

You do **not** need a hand-written `providers` entry, and there is no `enabled` flag.

Synced models set `time.released` to `0` (Cursor AvailableModels does not expose release dates). OpenCode 2.x's picker sorts by `released` descending, so filter by provider **Cursor** or search a model id if the global list looks empty.

## Compaction with another provider

You can use another provider's model for the host's compaction summary. After
OpenCode commits that summary, the next normal Cursor request starts from the
compacted host history, keeping the recent messages and completed tool results.
The conversation group stays stable; subsequent turns reuse the new checkpoint.
Preparing a background summary or failing a summary does not reset Cursor.

The rebase requirement is saved with the conversation snapshot and survives a
server restart, including a shutdown save from a held tool Run. If saving that
requirement fails, the next Cursor request reports the error and retries saving
on a later request. No extra configuration is needed. See the
[compaction acceptance checks](host-compat-acceptance.md#opencode-2-foreign-compaction).

## From npm

```json
{
  "plugins": ["cursor-opencode-provider/plugin/opencode2"]
}
```

Pin a version if you want: `"cursor-opencode-provider@0.8.2/plugin/opencode2"`.

OpenCode 2.x installs the published package into its host cache and loads the AI SDK entry from there (`aisdk:cursor-opencode-provider`). No extra env vars are required.

## Config isolation

`opencode2` defaults to the same `~/.config/opencode` as OpenCode 1.x unless you set `OPENCODE_CONFIG_DIR`. Prefer a dedicated directory so 1.x `plugin` / `provider` entries and 2.x `plugins/` do not share one file:

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
```

If npm subpath resolution is unreliable, install a **plugin directory** under `$OPENCODE_CONFIG_DIR/plugins/` (OpenCode 2.x rejects a bare `.js` path in config — it must be a directory with `package.json`):

```bash
mkdir -p "$OPENCODE_CONFIG_DIR/plugins/cursor"
cat > "$OPENCODE_CONFIG_DIR/plugins/cursor/package.json" <<'EOF'
{ "name": "cursor-local", "type": "module", "main": "./index.js" }
EOF
cat > "$OPENCODE_CONFIG_DIR/plugins/cursor/index.js" <<EOF
export { default } from "/absolute/path/to/cursor-opencode-provider/dist/plugin-opencode2.js"
EOF
```

## Authenticate

Inside `opencode2`, run `/connect`, choose **Cursor**, then browser login or an API key. `CURSOR_API_KEY` is also picked up automatically.

After auth, Cursor models appear in the picker from the in-memory inventory. The `<host-cache>/cursor-models.json` cache is still used as the discovery source; it is not copied into config.

The 500k max tier appears as `grok-4.7-500k` (and `grok-4.7-500k-fast`),
with its own context limit and variant list. These entries still send
`grok-4.7` to Cursor and retain the tier's declared default effort;
see [shared model selection](../README.md#select-a-model).
Saved 500k variants on the original base/Fast entries remain available after
upgrading. Select the dedicated 500k entry for its full host context budget.

The plugin supplies its own Cursor SDK even when the host's generic package loader already created one. Each new Run resolves the active integration credential and applies on-demand renewal; a token captured by the generic loader or its options cannot bypass that resolver.

## From a local clone (`CURSOR_OPENCODE2_DEV_ENTRY`)

```bash
cd /absolute/path/to/cursor-opencode-provider
bun install && bun run build
```

Loading only the local plugin file is not enough for end-to-end local testing: OpenCode 2.x still resolves the AI SDK package through `npm install` into `<host-cache>/packages/…` unless you override it. Point `CURSOR_OPENCODE2_DEV_ENTRY` at the built provider entry (`dist/index.js`, which exports `createCursor`) so the host imports that file directly.

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
export CURSOR_OPENCODE2_DEV_ENTRY=/absolute/path/to/cursor-opencode-provider/dist/index.js
```

Example config for the plugin directory created above (with its own
`package.json` and `index.js`):

```json
{
  "plugins": [
    "/absolute/path/to/cursor-plugin"
  ]
}
```

Use the wrapper directory, rather than the provider source root, as the local plugin entry. For the AI SDK entry, still set `CURSOR_OPENCODE2_DEV_ENTRY` to `dist/index.js`.

- **Export the env var before starting the daemon.** `opencode2 serve` / `service start` inherit env at start time. After changing `CURSOR_OPENCODE2_DEV_ENTRY`, `OPENCODE_CONFIG_DIR`, or rebuilding `dist/`, restart the service:

  ```bash
  opencode2 service stop
  export OPENCODE_CONFIG_DIR=~/.config/opencode2
  export CURSOR_OPENCODE2_DEV_ENTRY=/absolute/path/to/cursor-opencode-provider/dist/index.js
  opencode2 service set env OPENCODE_CONFIG_DIR "$OPENCODE_CONFIG_DIR"
  opencode2 service set env CURSOR_OPENCODE2_DEV_ENTRY "$CURSOR_OPENCODE2_DEV_ENTRY"
  opencode2 service start
  ```

- **Unset `CURSOR_OPENCODE2_DEV_ENTRY` in production** so the daemon uses the published `aisdk:cursor-opencode-provider` package again.
- **OpenCode does not install dependencies for local plugin files.** Keep the clone's `bun install` intact and load the plugin from inside the clone (a copied-out file will not resolve `protobufjs`).
- **Rebuild after every change** (`bun run build`). The daemon reads `dist/`, not `src/`.
- **Plugin reload does not refresh the running AI SDK.** The daemon caches SDKs and language models separately from plugin hooks. A new plugin `copy=#…` header can therefore appear while turns still use earlier code. Fully restart the daemon after rebuilding; for cost-reporting changes, confirm fresh `billing: step=` records on tool and final finishes.

## Workspace directory

OpenCode 2.x's long-lived daemon often starts from `$HOME` (or another spawn cwd), so `process.cwd()` is not the active project. The provider resolves the session workspace in this order:

1. Request header `x-opencode-directory` (URI-encoded absolute path; per-request). The plugin adds it on `session.hook("model.request")` for the `cursor` provider from `ctx.session.get()` → `info.location.directory`, falling back to the last known session directory, then `ctx.location.directory`. It rides the AI SDK call options only and is never sent to Cursor, so it does not depend on in-memory state shared with the module copy that runs the model.
2. Session mark from session hooks → `ctx.session.get()` (`info.location.directory`) — fallback within the same module copy only
3. Static `createSdk({ workspaceRoot })` / process cwd as last resort

The plugin also forces OpenCode 2.x's `path` / `shell` tool dialect when advertised schemas are opaque, so bridged file tools do not fall back to OpenCode 1.x `filePath` / `bash` under a multi-project daemon.

## MCP tools

OpenCode 2.x routes MCP servers through Code Mode unless their config sets `codemode: false` (the host default is `true`). Code Mode tools do not reach the model individually: the provider only sees a single `execute` tool, so Cursor cannot call an MCP tool such as `github_create_pull_request` by name.

The plugin leaves that server config alone. `codemode` on the server also decides whether OpenCode asks a remote MCP server for its raw tools. Catalog placement is separate: `ctx.tool.transform` sets `options.codemode: false` on tools whose namespace belongs to an MCP server that did not set `"codemode": true`. Those tools join the direct catalog. Explicit `"codemode": true` stays inside `execute`, as do OpenCode's own Code Mode tools.

The tool registry is shared by every provider in the process. A server that should stay in Code Mode for other models needs `"codemode": true` in its MCP config.

**Cursor layer (OpenCode 1.x and 2.x):** joining the AI SDK / direct catalog is what lets this provider advertise the tool in RequestContext. Cursor still keeps those tools off its native top-level function list — models reach them through GetDynamicTools / CallDynamicTool (and the provider's `mcp_args` exec path). When the host advertises `skill` and/or tools of MCP servers configured in `opencode.json`, shared interaction guidance names those routes and mirrors OpenCode's load-when-matches / do-not-reinvoke rules. Mid-Conversation skill reminders fire only when the available-skills catalog changes after baseline admission (same contract as OpenCode `SkillGuidance` / `SkillInstructions`) — not on every user turn that happens to mention a skill id ([issue #29](https://github.com/oakimov/cursor-opencode-provider/issues/29)). Classic OpenCode 1.x already puts MCP tools in the AI SDK catalog; only OpenCode 2.x needs the direct-catalog transform above.

No extra configuration is needed. Declare MCP servers in `opencode.json` as usual:

```json
{
  "mcp": {
    "servers": {
      "github": { "type": "local", "command": ["github-mcp-server", "stdio"] },
      "docs": { "type": "remote", "url": "https://example.com/mcp" },
      "executor": { "type": "local", "command": ["my-executor"], "codemode": true }
    }
  }
}
```

`github` and `docs` leave `codemode` unset, so their tools join the direct catalog and this provider can advertise them to Cursor (for example `github_create_pull_request` via GetDynamicTools / CallDynamicTool). `executor` sets `"codemode": true` and stays inside `execute`. The plugin does not rewrite these entries.

Server names are normalized into tool namespaces (`my.docs` becomes `my_docs`). If names collide, an explicit `"codemode": true` prevents this plugin from moving that namespace. The `opencode` namespace is always left alone to preserve OpenCode's own tools; choose another MCP server name to use automatic direct placement.

OpenCode's `<mcp_instructions>` still say to use `execute` for a server that left `codemode` unset, because that sentence reads the server config and not the tool option. The provider guidance tells Cursor to ignore that sentence for tools that are on the direct list. Discovery reloads replay the tool transform, so tools that connect after startup join the same catalog.

A prompt sent before those servers finish connecting will not see their tools. OpenCode connects MCP servers asynchronously and does not block startup on a slow server. The next turn in the same session includes the tools that have connected. That first-turn gap is expected host behavior, not a missing catalog placement.

## Feature parity vs the classic plugin

| Classic plugin (OpenCode 1.x) | OpenCode 2.x plugin |
|---|---|
| `config` hook registers provider + models | `ctx.provider.transform` + `editor.add` + `reload()` |
| `auth` hook (OAuth + API key) | `ctx.integration.transform` + `/connect` |
| `tool` hook (`custom_websearch`, `cursor_image_save`) | `ctx.tool.transform` registers handle-only `cursor_image_save` (`codemode: false`, `permission: "edit"`, output schema) so generated images can be committed. `todowrite`/`todoread` only when `CURSOR_OPENCODE2_TODOS=1` (or `true`) and the host catalog omits them. Off by default. OpenCode 2.x's native `websearch` tool owns permission checks and uses the provider registered through `ctx.websearch.transform`. Plugin tools call the public `ctx.permission.assert` with the executing session, agent, tool source and actual resource before accessing data or saving an image. Image saves assert `external_directory` and `edit`; optional todos assert their own actions. Missing permission APIs fail closed. Web search keeps its native executor. |
| `event` hook (session activity) | `ctx.event.subscribe` |
| `tool.execute.before` / `.after` | `ctx.tool.hook(...)` |
| Post-approval `shell.env` injects the timeout wrapper for bash/zsh | `ctx.shell.hook("create.before")` installs a same-basename executable adapter. The command stays unchanged for the host's later permission scan; the payload uses the actual selected shell. |
| `chat.params` flags compaction turns and names the current agent | `session.hook("context")` / `"compaction"` sets `options.opencodeCompaction`, `options.opencodeHostAgent`, and the session marker |
| `plan_enter` / `plan_exit` | OpenCode 2.x's primary `plan` / `build` agents are selected through `session.switchAgent`. Cursor mode entry is applied after its Run reaches a safe terminal boundary. CreatePlan persists the plan through an advertised host `write` or `patch` into the Plan directory, shows it, and asks through `question` whether to switch to `build` and start implementing; Yes ends the plan Run before selecting `build` and continuing. No or dismissal ends the current turn, keeps `plan`, and requires a new user message before further work. Typed freeform feedback continues the same turn in plan mode with that text as the CreatePlan reply. |
| Host `todowrite` builtin | OpenCode 2.x dropped host todo tools. Plugin-owned `todowrite`/`todoread` stay **off** unless `CURSOR_OPENCODE2_TODOS=1` (or `true`). When enabled they register as **direct** catalog tools (`codemode: false` + `output` schema, in-memory per session) unless `editor.get`/`list` already owns those names. With the flag unset, no provider todo tools are registered. Cursor TodoWrite/TodoRead mirror into them only when they are advertised. OpenCode 1.x still uses the host builtin and is not gated. |
| Host `task` tool | Native Cursor Task remaps onto advertised `task`, or onto OpenCode 2.x `subagent` (`agent` / `sessionID` / `background`) when `task` is absent |
| — | `credential.switched` clears the token cache and reloads models |
| — | `editor.add({ sourceConnection })` binds inventory to the active Cursor connection |
| — | `ctx.websearch.transform` publishes Exa results as `{url,title,content,time}` for OpenCode 2.x's native permission-gated `websearch` tool |
| Package root / `plugin` | OpenCode 2.x `Host.resolve` loads `exports["./server"]` → this entry (`{ id, setup }`). The same module dual-exports `server: CursorPlugin` so OpenCode 1.18 still gets the classic plugin. |

Edit rows use Cursor's own result when an edit finishes without a host write,
including errors after the authorized read. A row still waiting for its exec
may close as deferred when another tool ends the step; a terminal Run closes it
as unfinished, and a refused exec as failed with the refusal reason, including
when other calls are pending or Cursor later reports a different completion.
A binary write staged for the image save tool hands its row to that tool.
Failure labels use the permitted catalog without reading target files.
See [shared early-row behavior](../README.md#known-limitations).

Wrapped commands expose their real exit status to the host. A hard timeout
exits 124; a background handoff exits 0. The native final `Exited with code N`
block remains in history on its own line and is removed from live stdout when
it matches the captured outcome, including when a command printed nothing and
the notice is the whole result. Native signal and timeout notices also start on
their own line. Other text blocks retain their exact bytes.

Terminal-record headers and footers stay out of command stdout, including
when completion races a timeout or background handoff.

Shell output keeps path-like text, whitespace and successful timeout-shaped
text unchanged. Internal wrapper markers are removed without trimming command
output, and failed shell streams retain partial output alongside their error.
A host shell failure reaches Cursor once as stderr in streamed and unary
results; distinct command output remains on stdout.

The shell integration follows each host's execution order. OpenCode 1.18.31
[checks permissions before `shell.env`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell.ts#L599-L637).
OpenCode 2.0.27 [runs `create.before` before its permission callback and then spawns the selected executable](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/shell.ts#L263-L307),
so the adapter keeps the original command and shell basename intact for
[the native scanner](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/tool/plugin/shell.ts#L125-L145).
OpenCode 2.x's [AI SDK conversion lowers tool errors to ordinary text](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/aisdk.ts#L652-L685).
The session hooks preserve the native result status in each tool part's provider
metadata before conversion, so reads, writes, deletes and other tools remain
failures in continuations and replayed history. The tool after hook retains typed
permission causes to distinguish configured denials from user rejection;
successful output that resembles an error is left successful.
A [decline without feedback bypasses the tool after hook](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/permission.ts#L244-L255).
The permission and terminal-failure events release unstarted shell reservations
immediately; running jobs retain their records. Disposing another project's setup
keeps pending shell approvals while an event observer remains. A replacement
setup retains rejections received during its reload gap, including across module
copies. Only the final live observer releases the remaining pending wrappers;
an event subscription that fails during startup does not retain that ownership.

Generated-image saving uses the same handle-only `cursor_image_save` tool on classic and OpenCode 2.x. Classic/OCP surfaces raise `external_directory` then `edit` before the write. Stock OpenCode 2.x has no public `ask` on its tool context, so the 2.x entrypoint advertises the tool with `permission: "edit"` (agents that deny edits do not get it) and, before writing, asserts `external_directory` and `edit` on the actual target through the plugin's `ctx.permission.assert`; without that API the save is refused. The id is opaque, so the model cannot write arbitrary files.

## Task attachments

Cursor Task attachments reach the native `subagent` prompt as exact, quoted
file paths, retaining Cursor's description input. The child opens each file
through its own permission-checked tools; attachment bytes are not read into
the parent. Choose an image-capable child model for image inspection. See
[shared subagent routing](../README.md#native-subagent-routing).

## File editing

OpenCode 2.x selects `patch` (input `{ patchText }`) for eligible GPT models and
removes `edit` / `write`. The provider accepts direct dynamic patch calls and
converts Cursor-native file execs from the current permitted catalog. It refuses
patch operations that would lose CRLF bytes before changing a file. Native
`edit` / `write` remain unchanged when permitted; see [shared patch behavior](../README.md#apply_patch--patch-on-gpt-models).

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
(413), so OpenCode compacts instead of retrying. Recovery retains the latest eligible checkpoint across token renewal, including
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
and unknown server-side work still do. For sleep/wake diagnostics, set
`CURSOR_PROVIDER_RECOVERY_DEBUG=1` before starting the daemon. This records recovery
metadata without prompts or tool payloads, using the existing 10 MiB log cap.

The provider shares Cursor CLI's limits of 10 transport retries and 3 server
retries across this turn, including OpenCode's retries. OpenCode can stop earlier.
The host's plain-text interruption notice does not reset the provider's budget,
including appended `<system-reminder>` or `<system-update>` text parts.
Only retry identity ignores these notes; Cursor still receives their content.
Set `CURSOR_ENDLESS_RETRIES=1` or `true` before starting the host (or its daemon)
to bypass count limits while retaining replay guards, Stop, final errors, the
two-resume cutoff and the 180 s consecutive semantic-stall retry window.
See [retry limits](../README.md#retry-limits) for classification and SDK options.

## Mid-turn steers and Stop

A plain-text steer without files or skills can reach an actively pumping Cursor
Run before OpenCode reaches its next step boundary, including during AwaitShell.
Messages that cannot be admitted early retain the normal host delivery path.
Answered copies are deduplicated across restart/retry, while later identical
requests, unmatched messages and attachments remain intact. If a Run fails after
an unanswered steer was promoted or checkpointed and recovery cannot preserve
it, the next attempt rebuilds from host history to retain the message. Stop
notifies the Cursor Run and saves recoverable state; the next turn preserves the checkpoint
when safe and otherwise rebuilds from host history. See [2.x incident lessons](../tasks/lessons/opencode-2.md#early-steers-stop-and-restart)
and [acceptance checks](host-compat-acceptance.md#opencode-2-early-steers-and-stop).

## Planning and prompt ownership

Cursor tools use their advertised invocation route. A supplied top-level
function is called directly; a SwitchMode, CreatePlan or GenerateImage listed
in a dynamic namespace is discovered and invoked through GetDynamicTools /
CallDynamicTool with its namespace, tool name and arguments. Discovery alone
does not invoke the tool or install a new top-level function. Each tool's
route is chosen per turn: SwitchMode can be dynamic while the following plan
turn supplies CreatePlan directly, so the model looks up a tool only in the
turn that invokes it and never looks up a supplied function.

An approved CreatePlan review ends the old plan Run before the host switches
to its build agent and continues implementation. Declining leaves it in plan.
Selecting the already active native agent keeps the current Run and adds no
continuation turn.

OpenCode 2.x owns its full system prompt and its vendor-maintained Plan agent. The provider forwards the host prompt verbatim as Cursor's always-apply system-instructions rule (Cursor does not follow a client-seeded `system` message); it does not copy or replace the 2.x prompt templates. Provider-added guidance is limited to protocol facts the host cannot know, such as Cursor interaction bridging and the advertised direct tool catalog.

MCP tools whose server did not set `"codemode": true` are on the direct catalog and are called by name. `execute` remains Code Mode for tools that are still absent from that list, including an explicit `"codemode": true` server and OpenCode's own Code Mode tools. Cursor calls `execute` with `{ code }` and uses the exact paths and signatures from the host Code Mode catalog (or its `search` function). OpenCode still applies its own tool availability and permission checks when `execute` runs.

When Cursor raises SwitchMode for `plan` or `spec`, the plugin selects OpenCode 2.x's `plan` primary agent after the current Cursor Run has safely ended. Approved implementing targets select `build`. Cursor's read-only Ask targets (`chat`, `ask`, `search`) keep the current agent, so they are approved even under the `plan` agent or a session edit deny. While the session runs the `plan` agent and no native `plan_exit` tool exists, a Cursor SwitchMode out of plan mode is declined with a pointer to CreatePlan, whose `question` prompt is the approval to start implementing (without `question`, the user switches agents). A user switching agents in the OpenCode UI follows the same state path because `session.hook("context")` carries the active agent into the provider. After its own switch the plugin waits briefly for OpenCode's plan-mode note before continuing the turn, so that note is written once.

A session-wide edit deny keeps a saved plan from approving implementation or
switching to build, even if edits to the plan file are allowed. Change that
session rule in the client first. The plugin reads current `permissions` on
each context request and retries a failed lookup once. If the rules remain
unreadable, CreatePlan and implementing mode switches are blocked; ordinary
requests and native tool permission checks remain usable. Unknown rules are
never treated as an empty ruleset. Saving a plan under an edit deny ends that
turn before queued tools can run. Compaction reads no rules.
Current rule reminders also reach held tool continuations. Lifting a deny
supersedes its earlier reminder while preserving normal plan approval, including
when a deferred note restores an older deny. Ordinary tool steps without a deny
to supersede send no rule reminder.

An OpenCode agent or system-prompt change keeps the sticky Cursor conversation, as Cursor CLI keeps its conversation across mode flips. The conversation's first system context stays frozen as the system-instructions rule, so the prompt cache survives; the new agent and the changed host instructions arrive as a Mid-Conversation System Message on the next user turn, which the model follows. The host agent and prompt hash are persisted with the checkpoint for diagnostics only. Ephemeral title/generation calls do not alter that identity.

## Safe transition

Three plugin shapes have existed for OpenCode 2.x. Only the last one is current.

| Era | How models showed up | Status |
|---|---|---|
| OpenCode 2.x **next** (`@opencode-ai/plugin@next`, `ctx.catalog`) | In-memory `ctx.catalog.transform` | **Removed.** OpenCode 2.x has no `ctx.catalog`. |
| Config dump (`55126a8` and follow-ups) | Surgical JSONC upsert into `$OPENCODE_CONFIG_DIR/opencode.json(c)` → `providers.cursor` (often a large `models` map) | **Deprecated.** The plugin no longer writes config. A leftover `providers.cursor` is a second writer and can fight the in-memory inventory. |
| **Current** | In-memory `ctx.provider.transform` + `editor.add` + `reload()` | **Use this.** Nothing is written into `opencode.json`. |

`55126a8` (`fix(opencode2): support stable 2.x without ctx.catalog`) is the commit that introduced the `opencode.json` dump: stable OpenCode 2.x had dropped `ctx.catalog`, so the plugin copied the discovered list into `providers.cursor`. That file could grow to thousands of lines. The current plugin replaces that workaround with the host's in-memory provider editor.

### Before you switch

1. **Stop the daemon** so it cannot rewrite config while you edit it:

   ```bash
   opencode2 service stop
   ```

2. **Use a dedicated config dir** (recommended even if you already do):

   ```bash
   export OPENCODE_CONFIG_DIR=~/.config/opencode2
   ```

   Mixing OpenCode 1.x `plugin` / `provider.cursor` with OpenCode 2.x `plugins/` in `~/.config/opencode` is the usual source of “models vanished after upgrade” reports.

3. **Back up config** before deleting the dump:

   ```bash
   cp "$OPENCODE_CONFIG_DIR/opencode.json" "$OPENCODE_CONFIG_DIR/opencode.json.bak"
   ```

4. **Install the current plugin** (published `plugin/opencode2`, or a rebuilt local clone — see above). Do not keep a next-era or dump-era `dist/` loaded via `$OPENCODE_CONFIG_DIR/plugins/cursor`.

### Remove the deprecated catalog dump

Open `$OPENCODE_CONFIG_DIR/opencode.json` (or `opencode.jsonc`).

- Delete the entire `"cursor"` object under `"providers"`.
- If `"providers"` is then empty, delete `"providers"` too.
- **Keep** MCP, permissions, `plugin` / `plugins/` entries, and anything else you added.
- Do **not** leave a stub such as:

  ```json
  "providers": {
    "cursor": {
      "name": "Cursor",
      "package": "aisdk:file:///…/dist/index.js",
      "integrationID": "cursor"
    }
  }
  ```

  OpenCode 2.x still applies that block through its built-in config-provider plugin. Name, package, and integration belong to the in-memory inventory now.

You can leave `<host-cache>/cursor-models.json` alone. That cache is discovery input, not the deprecated config dump.

Old `opencode.json.bak-*` copies from the dump era are safe to delete after the picker works.

### Load only the OpenCode 2.x entrypoint

Config should load **one** of:

- `"plugins": ["cursor-opencode-provider/plugin/opencode2"]` (npm)
- a `$OPENCODE_CONFIG_DIR/plugins/<name>/` directory that re-exports `dist/plugin-opencode2.js` (local)

Remove, if present:

- `"plugins": ["cursor-opencode-provider"]` (classic 1.x)
- `"plugins": ["cursor-opencode-provider/plugin/v2"]`
- any `file://…/dist/plugin.js` or `plugin-v2.js` path under this config dir
- `@opencode-ai/plugin-next` / “next” plugin pins in this package (the current 2.x entrypoint duck-types the host; it does not depend on `@opencode/plugin`)

### Restart and confirm

```bash
opencode2 service set env OPENCODE_CONFIG_DIR "$OPENCODE_CONFIG_DIR"
# local clone only:
# opencode2 service set env CURSOR_OPENCODE2_DEV_ENTRY /absolute/path/to/cursor-opencode-provider/dist/index.js
opencode2 service start
```

Then `/connect` → **Cursor** if credentials are missing. Filter the picker by provider **Cursor**. Models should appear without a `providers.cursor` block.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No Cursor models in the picker | `/connect` → **Cursor** (or shared `auth.json`). Dedicated `OPENCODE_CONFIG_DIR`. Plugin is a **directory** re-exporting `plugin/opencode2`, not a bare `.js`. Filter by provider **Cursor** (`time.released` is `0`). Remove leftover `providers.cursor` (see [Safe transition](#safe-transition)). |
| Local daemon still runs the published package | Set `CURSOR_OPENCODE2_DEV_ENTRY` to an absolute `…/dist/index.js` path **before** start, persist it with `opencode2 service set env`, rebuild, restart. Loading only `dist/plugin-opencode2.js` is not enough. |
| The model cannot find an MCP tool and searches files for it instead | The server set `"codemode": true`, so its tools stay inside `execute`. Remove that field to put them on the direct catalog; see [MCP tools](#mcp-tools). |
| A prompt immediately after startup does not see MCP tools | Expected. OpenCode connects MCP servers asynchronously and does not block startup on a slow server. The next turn in the same session includes tools that have connected. Do not treat this as a catalog bug or delay startup to wait for MCP. |
| Picker / auth broke after an upgrade | You are likely still on the next-era `ctx.catalog` build or the dump-era plugin. Follow [Safe transition](#safe-transition) and restart. |
| `opencode.json` ballooned to thousands of lines | That was the dump-era `providers.cursor.models` map. Remove `providers.cursor` as above. The current plugin will not recreate it. |
| `401` / "sign in to Cursor again" | A browser login is renewed through Cursor's `/oauth/token` when a request needs a token and less than 1272 h of the 60-day session remain. The credential stores the JWT expiry as `expires`; the 2.x host refreshes it within five minutes of that and persists the renewal the plugin already holds in memory. A daemon that serves no request for the whole 60 days lets the session expire; reconnect (`/connect` → **Cursor**) then. API keys (`/connect` key or `CURSOR_API_KEY`) are re-exchanged within five minutes of the exchanged JWT's expiry. |
