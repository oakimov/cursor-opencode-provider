#!/usr/bin/env bash
# Write a private OpenCode 2 config that loads one checkout's built plugin.
# OPENCODE_CONFIG_ROOT selects the checkout (default: this repo).
# OPENCODE_REVIEW_HOME, when set, is the private config/cache/data/state/tmp
# root. Otherwise the files live in <root>/.opencode-local. The caller's
# OPENCODE_CONFIG_DIR is not read or replaced.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
if [[ -n "${OPENCODE_CONFIG_ROOT:-}" ]]; then
  ROOT="$(cd "$OPENCODE_CONFIG_ROOT" && pwd)"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
ENTRY="$ROOT/dist/index.js"
PLUGIN="$ROOT/dist/plugin-opencode2.js"

if [[ ! -f "$ENTRY" || ! -f "$PLUGIN" ]]; then
  echo "Missing $ENTRY or $PLUGIN. Run bun run build first." >&2
  exit 1
fi

if [[ -n "${OPENCODE_REVIEW_HOME:-}" ]]; then
  HOME_ROOT="$(mkdir -p "$OPENCODE_REVIEW_HOME" && cd "$OPENCODE_REVIEW_HOME" && pwd)"
  CONFIG_DIR="$HOME_ROOT/config/opencode2"
  XDG_CONFIG_HOME="$HOME_ROOT/config"
  XDG_CACHE_HOME="$HOME_ROOT/cache"
  XDG_DATA_HOME="$HOME_ROOT/share"
  XDG_STATE_HOME="$HOME_ROOT/state"
  REVIEW_TMP="$HOME_ROOT/tmp"
  ENV_FILE="$HOME_ROOT/env"
else
  CONFIG_DIR="$ROOT/.opencode-local"
  XDG_CONFIG_HOME="$CONFIG_DIR/xdg/config"
  XDG_CACHE_HOME="$CONFIG_DIR/xdg/cache"
  XDG_DATA_HOME="$CONFIG_DIR/xdg/share"
  XDG_STATE_HOME="$CONFIG_DIR/xdg/state"
  REVIEW_TMP="$CONFIG_DIR/xdg/tmp"
  ENV_FILE="$CONFIG_DIR/env"
fi

python3 - "$PLUGIN" "$CONFIG_DIR" "$ENTRY" "$ROOT" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$REVIEW_TMP" "$ENV_FILE" <<'PY'
import json, pathlib, shlex, sys
plugin = pathlib.Path(sys.argv[1]).resolve()
config_dir = pathlib.Path(sys.argv[2]).resolve()
entry = pathlib.Path(sys.argv[3]).resolve()
root = pathlib.Path(sys.argv[4]).resolve()
xdg_config, xdg_cache, xdg_data, xdg_state, review_tmp, env_file = map(pathlib.Path, sys.argv[5:])
for path in (config_dir, xdg_config, xdg_cache, xdg_data, xdg_state, review_tmp):
    path.mkdir(parents=True, exist_ok=True)
version = "unknown"
package = root / "package.json"
if package.is_file():
    try:
        parsed = json.loads(package.read_text(encoding="utf-8"))
        if isinstance(parsed, dict) and isinstance(parsed.get("version"), str) and parsed["version"]:
            version = parsed["version"]
    except json.JSONDecodeError:
        version = "unknown"
plug_dir = config_dir / "plugins" / "cursor"
plug_dir.mkdir(parents=True, exist_ok=True)
(plug_dir / "package.json").write_text(
    json.dumps({"name": "cursor-local", "type": "module", "main": "./index.js"}, indent=2) + "\n",
    encoding="utf-8",
)
marker = f"CURSOR_REVIEW_PLUGIN={plugin} version={version}"
(plug_dir / "index.js").write_text(
    "console.error(" + json.dumps(marker) + ")\n"
    + f'export {{ default }} from "{plugin.as_uri()}";\n',
    encoding="utf-8",
)
external = {
    "/tmp/*": "allow",
    f"{root}/*": "allow",
    f"{config_dir}/*": "allow",
    f"{xdg_cache}/*": "allow",
    f"{xdg_data}/*": "allow",
    f"{xdg_state}/*": "allow",
    f"{review_tmp}/*": "allow",
}
config = {
    "$schema": "https://opencode.ai/config.json",
    "lsp": False,
    "permission": {
        "bash": {"*": "allow"},
        "read": {"env": "deny", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow", "*": "allow"},
        "edit": {"env": "deny", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow", "*": "allow"},
        "external_directory": external,
    },
    "agents": {
        "explore": {"mode": "subagent", "model": {"providerID": "cursor", "model": "default"}},
    },
    "plugins": [str(plug_dir)],
    "plugin": [plugin.as_uri()],
}
(config_dir / "opencode.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
(env_file).write_text(
    f"export OPENCODE_CONFIG_DIR={shlex.quote(str(config_dir))}\n"
    f"export CURSOR_OPENCODE2_DEV_ENTRY={shlex.quote(str(entry))}\n"
    f"export XDG_CONFIG_HOME={shlex.quote(str(xdg_config))}\n"
    f"export XDG_CACHE_HOME={shlex.quote(str(xdg_cache))}\n"
    f"export XDG_DATA_HOME={shlex.quote(str(xdg_data))}\n"
    f"export XDG_STATE_HOME={shlex.quote(str(xdg_state))}\n"
    f"export TMPDIR={shlex.quote(str(review_tmp))}\n"
    f"export CURSOR_REVIEW_PLUGIN_PATH={shlex.quote(str(plugin))}\n"
    f"export CURSOR_REVIEW_PLUGIN_VERSION={shlex.quote(version)}\n",
    encoding="utf-8",
)
PY

echo "OpenCode config: $CONFIG_DIR/opencode.json"
echo "CURSOR_OPENCODE2_DEV_ENTRY=$ENTRY"
