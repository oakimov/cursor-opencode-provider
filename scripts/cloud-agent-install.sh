#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap. .cursor/environment.json install is this
# file, so a build of main does not need this path to exist.
# OpenCode is not pinned. Each run installs the current release when the
# copy in ~/.opencode is missing or older.

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

# metadata is the JSON from https://opencode.ai/update/api/latest/cli/npm
opencode_version_from_metadata() {
  local metadata="$1"
  local version
  version="$(printf '%s' "$metadata" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  version="${version#v}"
  printf '%s' "$version"
}

latest_opencode_version() {
  local metadata version
  metadata="$(curl -fsSL https://opencode.ai/update/api/latest/cli/npm)"
  version="$(opencode_version_from_metadata "$metadata")"
  if [[ -z "$version" ]]; then
    echo "Could not read the latest OpenCode release." >&2
    return 1
  fi
  printf '%s' "$version"
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

  installed="$(opencode_version_of "$HOME/.opencode/bin/opencode")"
  latest="$(latest_opencode_version)"
  if [[ "$installed" != "$latest" ]]; then
    echo "Installing OpenCode ${latest}"
    # No version argument: the official installer selects the current release.
    curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path
  else
    echo "OpenCode ${installed} is current"
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

  # OpenCode config is not written here. The review harness writes it after
  # this install, including on main, where that harness is absent.
  echo "OpenCode $(opencode_version_of /usr/local/bin/opencode)"
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_main "$@"
fi
