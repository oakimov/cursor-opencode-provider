#!/usr/bin/env bash
# Write an isolated OpenCode 2 config that loads this checkout's built plugin.
# Output is gitignored (.opencode-local/). OPENCODE_CONFIG_DIR is not read or replaced.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$ROOT/.opencode-local"
ENTRY="$ROOT/dist/index.js"
PLUGIN="$ROOT/dist/plugin-opencode2.js"

if [[ ! -f "$ENTRY" || ! -f "$PLUGIN" ]]; then
  echo "Missing $ENTRY or $PLUGIN. Run bun run build first." >&2
  exit 1
fi

python3 - "$PLUGIN" "$CONFIG_DIR" "$ENTRY" <<'PY'
import json, pathlib, shlex, sys
plugin = pathlib.Path(sys.argv[1]).resolve()
config_dir = pathlib.Path(sys.argv[2]).resolve()
entry = pathlib.Path(sys.argv[3]).resolve()
plug_dir = config_dir / "plugins" / "cursor"
plug_dir.mkdir(parents=True, exist_ok=True)
(plug_dir / "package.json").write_text(
    json.dumps({"name": "cursor-local", "type": "module", "main": "./index.js"}, indent=2) + "\n",
    encoding="utf-8",
)
(plug_dir / "index.js").write_text(
    f'export {{ default }} from "{plugin.as_uri()}";\n',
    encoding="utf-8",
)
(config_dir / "opencode.json").write_text(
    json.dumps({"plugins": [str(plug_dir)]}, indent=2) + "\n",
    encoding="utf-8",
)
(config_dir / "env").write_text(
    f"export OPENCODE_CONFIG_DIR={shlex.quote(str(config_dir))}\n"
    f"export CURSOR_OPENCODE2_DEV_ENTRY={shlex.quote(str(entry))}\n",
    encoding="utf-8",
)
PY

echo "OpenCode config: $CONFIG_DIR/opencode.json"
echo "CURSOR_OPENCODE2_DEV_ENTRY=$ENTRY"
