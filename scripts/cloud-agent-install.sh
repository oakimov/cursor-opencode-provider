#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap. .cursor/environment.json install is this
# file, so a build of main does not need this path to exist.
OPENCODE_PIN="2.2.5"

opencode_version_of() {
  local bin="$1"
  local installed=""
  if [[ -x "$bin" ]]; then
    installed="$("$bin" --version 2>/dev/null || true)"
    installed="${installed##* }"
    installed="${installed#v}"
  fi
  printf '%s' "$installed"
}

install_main() {
  set -euo pipefail
  export PYTHONDONTWRITEBYTECODE=1
  export DEBIAN_FRONTEND=noninteractive

  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" && "$(basename "$(dirname "${BASH_SOURCE[0]}")")" == "scripts" ]]; then
    ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  else
    ROOT="$(pwd)"
  fi
  cd "$ROOT"

  if [[ ! -x "$HOME/.bun/bin/bun" ]]; then
    curl -fsSL https://bun.sh/install | bash
  fi
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun

  if ! command -v zsh >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y zsh
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y python3
  fi

  if [[ "$(opencode_version_of "$HOME/.opencode/bin/opencode")" != "$OPENCODE_PIN" ]]; then
    echo "Installing OpenCode ${OPENCODE_PIN}"
    curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "$OPENCODE_PIN" --no-modify-path
  else
    echo "OpenCode ${OPENCODE_PIN} already installed"
  fi
  sudo ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode
  if [[ -x "$HOME/.opencode/bin/opencode2" ]]; then
    sudo ln -sf "$HOME/.opencode/bin/opencode2" /usr/local/bin/opencode2
  fi

  /usr/local/bin/bun install --frozen-lockfile
  /usr/local/bin/bun run build
  if [[ ! -f "$ROOT/dist/index.js" || ! -f "$ROOT/dist/plugin-opencode2.js" ]]; then
    echo "Missing dist/index.js or dist/plugin-opencode2.js after build." >&2
    exit 1
  fi

  python3 - "$ROOT/dist/plugin-opencode2.js" "$ROOT/.opencode-local" "$ROOT/dist/index.js" <<'PY'
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

  echo "OpenCode config: $ROOT/.opencode-local/opencode.json"
  /usr/local/bin/opencode --version
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_main "$@"
fi
