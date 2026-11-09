#!/usr/bin/env bash
# Write private OpenCode configs that load one checkout's built plugin.
# OpenCode 2.x loads dist/plugin-opencode2.js through plugins/cursor.
# OpenCode 1.x loads dist/plugin.js, the classic plugin, through a one-export
# wrapper. OPENCODE_CONFIG_ROOT selects the checkout (default: this repo).
# OPENCODE_REVIEW_HOME, when set, is the private config/cache/data/state/tmp
# root. Otherwise the files live in <root>/.opencode-local and
# <root>/.opencode-local-1. The caller's OPENCODE_CONFIG_DIR is not read or
# replaced.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
if [[ -n "${OPENCODE_CONFIG_ROOT:-}" ]]; then
  ROOT="$(cd "$OPENCODE_CONFIG_ROOT" && pwd)"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
ENTRY="$ROOT/dist/index.js"
PLUGIN="$ROOT/dist/plugin-opencode2.js"
CLASSIC="$ROOT/dist/plugin.js"

if [[ ! -f "$ENTRY" || ! -f "$PLUGIN" || ! -f "$CLASSIC" ]]; then
  echo "Missing $ENTRY, $PLUGIN, or $CLASSIC. Run bun run build first." >&2
  exit 1
fi

if [[ -n "${OPENCODE_REVIEW_HOME:-}" ]]; then
  HOME_ROOT="$(mkdir -p "$OPENCODE_REVIEW_HOME" && cd "$OPENCODE_REVIEW_HOME" && pwd)"
  CONFIG_DIR="$HOME_ROOT/config/opencode2"
  CONFIG1="$HOME_ROOT/config/opencode1"
  XDG_CONFIG_HOME="$HOME_ROOT/config"
  XDG_CACHE_HOME="$HOME_ROOT/cache"
  XDG_DATA_HOME="$HOME_ROOT/share"
  XDG_STATE_HOME="$HOME_ROOT/state"
  XDG1_CONFIG_HOME="$HOME_ROOT/opencode1/config"
  XDG1_CACHE_HOME="$HOME_ROOT/opencode1/cache"
  XDG1_DATA_HOME="$HOME_ROOT/opencode1/share"
  XDG1_STATE_HOME="$HOME_ROOT/opencode1/state"
  REVIEW_TMP="$HOME_ROOT/tmp"
  ENV_FILE="$HOME_ROOT/env"
  ENV1="$HOME_ROOT/env-opencode1"
else
  CONFIG_DIR="$ROOT/.opencode-local"
  CONFIG1="$ROOT/.opencode-local-1"
  XDG_CONFIG_HOME="$CONFIG_DIR/xdg/config"
  XDG_CACHE_HOME="$CONFIG_DIR/xdg/cache"
  XDG_DATA_HOME="$CONFIG_DIR/xdg/share"
  XDG_STATE_HOME="$CONFIG_DIR/xdg/state"
  XDG1_CONFIG_HOME="$CONFIG1/xdg/config"
  XDG1_CACHE_HOME="$CONFIG1/xdg/cache"
  XDG1_DATA_HOME="$CONFIG1/xdg/share"
  XDG1_STATE_HOME="$CONFIG1/xdg/state"
  REVIEW_TMP="$CONFIG_DIR/xdg/tmp"
  ENV_FILE="$CONFIG_DIR/env"
  ENV1="$CONFIG1/env"
fi

python3 - "$PLUGIN" "$CONFIG_DIR" "$ENTRY" "$ROOT" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$REVIEW_TMP" "$ENV_FILE" "$CLASSIC" "$CONFIG1" "$ENV1" "$XDG1_CONFIG_HOME" "$XDG1_CACHE_HOME" "$XDG1_DATA_HOME" "$XDG1_STATE_HOME" <<'PY'
import json, os, pathlib, shlex, sys
plugin = pathlib.Path(sys.argv[1]).resolve()
config_dir = pathlib.Path(sys.argv[2]).resolve()
entry = pathlib.Path(sys.argv[3]).resolve()
root = pathlib.Path(sys.argv[4]).resolve()
xdg_config, xdg_cache, xdg_data, xdg_state, review_tmp, env_file = map(pathlib.Path, sys.argv[5:11])
classic = pathlib.Path(sys.argv[11]).resolve()
config1 = pathlib.Path(sys.argv[12]).resolve()
env1 = pathlib.Path(sys.argv[13])
xdg1_config, xdg1_cache, xdg1_data, xdg1_state = map(pathlib.Path, sys.argv[14:18])
for path in (config_dir, config1, xdg_config, xdg_cache, xdg_data, xdg_state, xdg1_config, xdg1_cache, xdg1_data, xdg1_state, review_tmp):
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
classic_marker = f"CURSOR_REVIEW_PLUGIN={classic} version={version}"
init_prefix = "CURSOR_REVIEW_PLUGIN_INIT count="
# One registration. OpenCode ignores a file URL in `plugin` and would also
# import dist/plugin-opencode2.js itself, so the provider would start twice.
(plug_dir / "index.js").write_text(
    "import plugin from " + json.dumps(plugin.as_uri()) + "\n"
    "console.error(" + json.dumps(marker) + ")\n"
    "const setup = plugin.setup.bind(plugin)\n"
    "let inits = 0\n"
    "plugin.setup = async (ctx) => {\n"
    "  inits += 1\n"
    "  console.error(" + json.dumps(init_prefix) + " + inits + " + json.dumps(f" path={plugin}") + ")\n"
    "  return setup(ctx)\n"
    "}\n"
    "export default plugin\n",
    encoding="utf-8",
)
# OpenCode 1.x calls every export. This wrapper exports only CursorPlugin and
# delegates to dist/plugin.js, the classic entrypoint.
wrapper = config1 / "cursor-review.mjs"
wrapper.write_text(
    "import { CursorPlugin as load } from " + json.dumps(classic.as_uri()) + "\n"
    "console.error(" + json.dumps(classic_marker) + ")\n"
    "let inits = 0\n"
    "export async function CursorPlugin(input, options) {\n"
    "  inits += 1\n"
    "  console.error(" + json.dumps(init_prefix) + " + inits + " + json.dumps(f" path={classic}") + ")\n"
    "  return load(input, options)\n"
    "}\n",
    encoding="utf-8",
)
# The pong prompt runs no shell. Deny every command. Add an allow entry only
# after a live run shows OpenCode refused a command this test needs.
# OpenCode keeps the last matching permission rule (evaluate uses findLast).
# A trailing "*" allow would override the env denies, so the broad allow is
# first and the ".env.example" exception is last. "*.env.*" also matches
# ".env.example", which is why that exception follows it.
# `opencode run --auto` would approve an unlisted external directory. Allow
# only this checkout and the private config roots. A "/tmp/*" allow would
# cover other jobs' temporary directories, so it is not granted. Each root
# is the lexical path and, when it differs, the canonical path.
path_rules = {
    "*": "allow",
    "env": "deny",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
}
external = {"*": "deny"}
seen = []
for path in (root, config_dir, config1, xdg_cache, xdg_data, xdg_state, xdg1_cache, xdg1_data, xdg1_state, review_tmp):
    for candidate in (pathlib.Path(os.path.abspath(path)), pathlib.Path(os.path.realpath(path))):
        text = candidate.as_posix().rstrip("/")
        if text in seen:
            continue
        seen.append(text)
        external[f"{text}/*"] = "allow"
permission = {
    "bash": {"*": "deny"},
    "read": path_rules,
    "edit": path_rules,
    "external_directory": external,
}
config = {
    "$schema": "https://opencode.ai/config.json",
    "lsp": False,
    "permission": permission,
    "agents": {
        "explore": {"mode": "subagent", "model": {"providerID": "cursor", "model": "default"}},
    },
    "plugins": [str(plug_dir)],
}
(config_dir / "opencode.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
classic_config = {
    "$schema": "https://opencode.ai/config.json",
    "lsp": False,
    "permission": permission,
    "plugin": [wrapper.as_uri()],
    "provider": {
        "cursor": {
            "npm": entry.as_uri(),
            "name": "Cursor",
            "models": {},
        },
    },
}
(config1 / "opencode.json").write_text(json.dumps(classic_config, indent=2) + "\n", encoding="utf-8")
def write_env(path, config_directory, plugin_path, extra):
    lines = [
        f"export OPENCODE_CONFIG_DIR={shlex.quote(str(config_directory))}",
        *extra,
        f"export XDG_CONFIG_HOME={shlex.quote(str(xdg_config if path == env_file else xdg1_config))}",
        f"export XDG_CACHE_HOME={shlex.quote(str(xdg_cache if path == env_file else xdg1_cache))}",
        f"export XDG_DATA_HOME={shlex.quote(str(xdg_data if path == env_file else xdg1_data))}",
        f"export XDG_STATE_HOME={shlex.quote(str(xdg_state if path == env_file else xdg1_state))}",
        f"export TMPDIR={shlex.quote(str(review_tmp))}",
        f"export CURSOR_REVIEW_PLUGIN_PATH={shlex.quote(str(plugin_path))}",
        f"export CURSOR_REVIEW_PLUGIN_VERSION={shlex.quote(version)}",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
write_env(env_file, config_dir, plugin, [f"export CURSOR_OPENCODE2_DEV_ENTRY={shlex.quote(str(entry))}"])
write_env(
    env1,
    config1,
    classic,
    [
        "export OPENCODE_DISABLE_PROJECT_CONFIG=1",
        "export OPENCODE_DISABLE_LSP_DOWNLOAD=1",
    ],
)
PY

echo "OpenCode config: $CONFIG_DIR/opencode.json"
echo "OpenCode 1.x config: $CONFIG1/opencode.json"
echo "CURSOR_OPENCODE2_DEV_ENTRY=$ENTRY"
