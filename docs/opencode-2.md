# OpenCode 2.0

Dedicated entrypoint: `cursor-opencode-provider/plugin/opencode2`. Do **not** also load the classic `plugin` entry or `plugin/v2` under OpenCode 2.0 — they target OpenCode 1.x APIs.

For OpenCode 1.x, see [opencode-1.md](./opencode-1.md). Shared catalog behavior (variants, 1M, Fast, images) lives in the [root README](../README.md#select-a-model).

If you previously ran this plugin against **OpenCode 2.0 next** (`ctx.catalog`) or against a build that **wrote Cursor models into `opencode.json`**, start at [Safe transition](#safe-transition).

## How models register (current)

Discovered Cursor models are published **in memory** through `ctx.provider.transform` → `editor.add({ info, models })` → `ctx.provider.reload()`. The plugin does **not** write a model list into `opencode.json`.

Cache seed (and `/connect` afterwards) refill the inventory. An empty first transform is a no-op, so a failed refresh keeps the last successful list.

You do **not** need a hand-written `providers` entry, and there is no `enabled` flag.

Synced models set `time.released` to `0` (Cursor AvailableModels does not expose release dates). OpenCode 2.0's picker sorts by `released` descending, so filter by provider **Cursor** or search a model id if the global list looks empty.

## From npm

```json
{
  "plugin": ["cursor-opencode-provider/plugin/opencode2"]
}
```

Pin a version if you want: `"cursor-opencode-provider@0.4.1/plugin/opencode2"`.

OpenCode 2.0 installs the published package into its host cache and loads the AI SDK entry from there (`aisdk:cursor-opencode-provider`). No extra env vars are required.

## Config isolation

`opencode2` defaults to the same `~/.config/opencode` as OpenCode 1.x unless you set `OPENCODE_CONFIG_DIR`. Prefer a dedicated directory so 1.x `plugin` / `provider` entries and 2.0 `plugins/` do not share one file:

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
```

If npm subpath resolution is unreliable, install a **plugin directory** under `$OPENCODE_CONFIG_DIR/plugins/` (OpenCode 2.0 rejects a bare `.js` path in config — it must be a directory with `package.json`):

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

## From a local clone (`CURSOR_OPENCODE2_DEV_ENTRY`)

```bash
cd /absolute/path/to/cursor-opencode-provider
bun install && bun run build
```

Loading only the local plugin file is not enough for end-to-end local testing: OpenCode 2.0 still resolves the AI SDK package through `npm install` into `<host-cache>/packages/…` unless you override it. Point `CURSOR_OPENCODE2_DEV_ENTRY` at the built provider entry (`dist/index.js`, which exports `createCursor`) so the host imports that file directly.

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
export CURSOR_OPENCODE2_DEV_ENTRY=/absolute/path/to/cursor-opencode-provider/dist/index.js
```

Example config that loads the local package (directory path — not a bare `.js` file):

```json
{
  "plugin": [
    "/absolute/path/to/cursor-opencode-provider"
  ]
}
```

Prefer the `$OPENCODE_CONFIG_DIR/plugins/<name>/` package directory shown above. For the AI SDK entry, still set `CURSOR_OPENCODE2_DEV_ENTRY` to `dist/index.js`.

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

## Workspace directory

OpenCode 2.0's long-lived daemon often starts from `$HOME` (or another spawn cwd), so `process.cwd()` is not the active project. The provider resolves the session workspace in this order:

1. Request header `x-opencode-directory` (URI-encoded absolute path; per-request)
2. Session mark from `session.hook("context")` → `ctx.session.get()` (`info.directory`, or legacy `info.location.directory`)
3. Static `createSdk({ workspaceRoot })` / process cwd as last resort

The plugin also forces OpenCode 2's `path` / `shell` tool dialect when advertised schemas are opaque, so bridged file tools do not fall back to OpenCode 1.x `filePath` / `bash` under a multi-project daemon.

## Feature parity vs the classic plugin

| Classic plugin (OpenCode 1.x) | OpenCode 2.0 plugin |
|---|---|
| `config` hook registers provider + models | `ctx.provider.transform` + `editor.add` + `reload()` |
| `auth` hook (OAuth + API key) | `ctx.integration.transform` + `/connect` |
| `tool` hook (`custom_websearch`, `cursor_image_save`) | `ctx.tool.transform` registers `todowrite`/`todoread` only when `CURSOR_OPENCODE2_TODOS=1` (or `true`) and the host catalog omits them. Off by default. OpenCode 2's native `websearch` tool owns permission checks and uses the provider registered through `ctx.websearch.transform`. The public 2.0 `ToolContext` has no permission-request method, so this entrypoint does not advertise a direct web-search fallback or `cursor_image_save`. |
| `event` hook (session activity) | `ctx.event.subscribe` |
| `tool.execute.before` / `.after` | `ctx.tool.hook(...)` |
| `shell.env` injects the timeout wrapper | `ctx.shell.hook("create.before")` injects the same env; wrapper-file fallback remains for shells that ignore env |
| `chat.params` flags compaction turns and names the current agent | `session.hook("context")` / `"compaction"` sets `options.opencodeCompaction`, `options.opencodeHostAgent`, and the session marker |
| `plan_enter` / `plan_exit`; plan-exit kickoff uses `session.promptAsync` + `agent: "build"` | OpenCode 2's primary `plan` / `build` agents are selected through `session.switchAgent`. Cursor mode entry is applied after its Run reaches a safe terminal boundary; exit keeps a `question` approval gate. Approved CreatePlan uses `session.synthetic` (or older `session.prompt`) for the execution kickoff. |
| Host `todowrite` builtin | OpenCode 2 dropped host todo tools. Plugin-owned `todowrite`/`todoread` stay **off** unless `CURSOR_OPENCODE2_TODOS=1` (or `true`). When enabled they register as **direct** catalog tools (`codemode: false` + `output` schema, in-memory per session) unless `editor.get`/`list` already owns those names. With the flag unset, no provider todo tools are registered. Cursor TodoWrite/TodoRead mirror into them only when they are advertised. OpenCode 1.x still uses the host builtin and is not gated. |
| Host `task` tool | Native Cursor Task remaps onto advertised `task`, or onto OpenCode 2 `subagent` (`agent` / `sessionID` / `background`) when `task` is absent |
| — | `credential.switched` clears the token cache and reloads models |
| — | `editor.add({ sourceConnection })` binds inventory to the active Cursor connection |
| — | `ctx.websearch.transform` publishes Exa results as `{url,title,content,time}` for OpenCode 2's native permission-gated `websearch` tool |
| Package root / `plugin` | OpenCode 2 `Host.resolve` loads `exports["./server"]` → this entry (`{ id, setup }`). The same module dual-exports `server: CursorPlugin` so OpenCode 1.18 still gets the classic plugin. |

Generated-image saving remains available through the classic plugin/OCP surfaces that provide a permission-aware tool context. On stock OpenCode 2.0, binary image writes are refused before staging because the public plugin tool context cannot raise the required `external_directory` and `edit` approvals. This avoids both permission bypass and a tool that is advertised but always fails.

## Planning and prompt ownership

OpenCode 2 owns its full system prompt and its vendor-maintained Plan agent. The provider forwards the host prompt; it does not copy or replace the 2.0 prompt templates. Provider-added guidance is limited to protocol facts the host cannot know, such as Cursor interaction bridging and the advertised direct tool catalog.

OpenCode 2 normally exposes MCP server tools inside its Code Mode catalog rather than as direct AI SDK tools. Cursor calls the advertised `execute` tool with `{ code }`, then uses the exact `tools` paths and signatures from the host's Code Mode catalog (or its `search` function). The provider's direct-tool list does not exclude those nested tools; OpenCode still applies its own tool availability and permission checks when `execute` runs.

When Cursor raises SwitchMode for `plan` or `spec`, the plugin selects OpenCode 2's `plan` primary agent after the current Cursor Run has safely ended. Approved non-plan targets select `build`; when no native `plan_exit` tool exists, the advertised `question` tool remains the user-visible approval gate. A user switching agents in the OpenCode UI follows the same state path because `session.hook("context")` carries the active agent into the provider.

A Cursor checkpoint embeds the earlier prompt state. Reusing it after an OpenCode agent or stable system-prompt change would bypass the new Plan restrictions, so the provider persists the host agent and prompt hash and rotates/reseeds the Cursor conversation when either changes. Ephemeral title/generation calls do not alter that identity. This reset is intentional: a changed system prompt cannot share the old prompt prefix safely.

## Safe transition

Three plugin shapes have existed for OpenCode 2.0. Only the last one is current.

| Era | How models showed up | Status |
|---|---|---|
| OpenCode 2.0 **next** (`@opencode-ai/plugin@next`, `ctx.catalog`) | In-memory `ctx.catalog.transform` | **Removed.** OpenCode 2.0 has no `ctx.catalog`. |
| Config dump (`55126a8` and follow-ups) | Surgical JSONC upsert into `$OPENCODE_CONFIG_DIR/opencode.json(c)` → `providers.cursor` (often a large `models` map) | **Deprecated.** The plugin no longer writes config. A leftover `providers.cursor` is a second writer and can fight the in-memory inventory. |
| **Current** | In-memory `ctx.provider.transform` + `editor.add` + `reload()` | **Use this.** Nothing is written into `opencode.json`. |

`55126a8` (`fix(opencode2): support stable 2.0.x without ctx.catalog`) is the commit that introduced the `opencode.json` dump: stable OpenCode 2.0 had dropped `ctx.catalog`, so the plugin copied the discovered list into `providers.cursor`. That file could grow to thousands of lines. The current plugin replaces that workaround with the host's in-memory provider editor.

### Before you switch

1. **Stop the daemon** so it cannot rewrite config while you edit it:

   ```bash
   opencode2 service stop
   ```

2. **Use a dedicated config dir** (recommended even if you already do):

   ```bash
   export OPENCODE_CONFIG_DIR=~/.config/opencode2
   ```

   Mixing OpenCode 1.x `plugin` / `provider.cursor` with OpenCode 2.0 `plugins/` in `~/.config/opencode` is the usual source of “models vanished after upgrade” reports.

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

  OpenCode 2.0 still applies that block through its built-in config-provider plugin. Name, package, and integration belong to the in-memory inventory now.

You can leave `<host-cache>/cursor-models.json` alone. That cache is discovery input, not the deprecated config dump.

Old `opencode.json.bak-*` copies from the dump era are safe to delete after the picker works.

### Load only the OpenCode 2.0 entrypoint

Config should load **one** of:

- `"plugin": ["cursor-opencode-provider/plugin/opencode2"]` (npm)
- a `$OPENCODE_CONFIG_DIR/plugins/<name>/` directory that re-exports `dist/plugin-opencode2.js` (local)

Remove, if present:

- `"plugin": ["cursor-opencode-provider"]` (classic 1.x)
- `"plugins": ["cursor-opencode-provider/plugin/v2"]`
- any `file://…/dist/plugin.js` or `plugin-v2.js` path under this config dir
- `@opencode-ai/plugin-next` / “next” plugin pins in this package (the current 2.0 entrypoint duck-types the host; it does not depend on `@opencode/plugin`)

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
| Picker / auth broke after an upgrade | You are likely still on the next-era `ctx.catalog` build or the dump-era plugin. Follow [Safe transition](#safe-transition) and restart. |
| `opencode.json` ballooned to thousands of lines | That was the dump-era `providers.cursor.models` map. Remove `providers.cursor` as above. The current plugin will not recreate it. |
