#!/usr/bin/env bash
# Write an isolated OpenCode 2 config that loads this checkout's built plugin.
# Output is gitignored (.opencode-local/) because the paths are absolute.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$ROOT/.opencode-local}"
ENTRY="$ROOT/dist/index.js"
PLUGIN="$ROOT/dist/plugin-opencode2.js"

if [[ ! -f "$ENTRY" || ! -f "$PLUGIN" ]]; then
  echo "Missing $ENTRY or $PLUGIN. Run bun run build first." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR/plugins/cursor"
cat > "$CONFIG_DIR/plugins/cursor/package.json" <<'EOF'
{
  "name": "cursor-local",
  "type": "module",
  "main": "./index.js"
}
EOF

python3 - "$PLUGIN" "$CONFIG_DIR/plugins/cursor/index.js" <<'PY'
import pathlib, sys
plugin = pathlib.Path(sys.argv[1]).resolve().as_uri()
pathlib.Path(sys.argv[2]).write_text(
    f'export {{ default }} from "{plugin}";\n',
    encoding="utf-8",
)
PY

python3 - "$CONFIG_DIR" <<'PY'
import json, pathlib, sys
config_dir = pathlib.Path(sys.argv[1]).resolve()
(config_dir / "opencode.json").write_text(
    json.dumps({"plugins": [str(config_dir / "plugins" / "cursor")]}, indent=2) + "\n",
    encoding="utf-8",
)
PY

cat > "$CONFIG_DIR/env" <<EOF
export OPENCODE_CONFIG_DIR=$(printf '%q' "$CONFIG_DIR")
export CURSOR_OPENCODE2_DEV_ENTRY=$(printf '%q' "$ENTRY")
EOF

echo "OpenCode config: $CONFIG_DIR/opencode.json"
echo "CURSOR_OPENCODE2_DEV_ENTRY=$ENTRY"
