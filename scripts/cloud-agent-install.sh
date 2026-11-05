#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap: Bun, zsh, OpenCode CLI, dependencies, build,
# and a local OpenCode 2 config that loads this repo's built plugin.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -x "${HOME}/.bun/bin/bun" ]]; then
  curl -fsSL https://bun.sh/install | bash
fi
sudo ln -sf "${HOME}/.bun/bin/bun" /usr/local/bin/bun

if ! command -v zsh >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y zsh
fi

if [[ ! -x "${HOME}/.opencode/bin/opencode" ]]; then
  curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path
fi
sudo ln -sf "${HOME}/.opencode/bin/opencode" /usr/local/bin/opencode
if [[ -x "${HOME}/.opencode/bin/opencode2" ]]; then
  sudo ln -sf "${HOME}/.opencode/bin/opencode2" /usr/local/bin/opencode2
fi

/usr/local/bin/bun install --frozen-lockfile
/usr/local/bin/bun run build
bash scripts/configure-opencode.sh
