#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap. .cursor/environment.json install is this
# file, so a build of main does not need this path to exist.
# Neither OpenCode major is pinned. Each run installs the current release
# when the copy on disk is missing or older.
# 2.x (@opencode/cli, https://opencode.ai/v2/install) lands in ~/.opencode
# and is linked as opencode. 1.x (opencode-ai, https://opencode.ai/install)
# uses its own prefix, because that installer always writes
# $HOME/.opencode/bin/opencode and would replace the 2.x binary. It is
# linked as opencode1.

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

# metadata is JSON with a "version" field. The 2.x feed is
# https://opencode.ai/update/api/latest/cli/npm and the 1.x feed is
# https://registry.npmjs.org/opencode-ai/latest.
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

# Accept only an OpenCode 1 release. opencode-ai's latest dist-tag is that
# line; a 2.x or pre-release value is refused instead of installed.
opencode1_release_version() {
  local version
  version="$(opencode_version_from_metadata "$1")"
  if [[ ! "$version" =~ ^1\.[0-9]+\.[0-9]+$ ]]; then
    echo "Could not read the latest OpenCode 1.x release." >&2
    return 1
  fi
  printf '%s' "$version"
}

latest_opencode1_version() {
  local metadata
  metadata="$(curl -fsSL https://registry.npmjs.org/opencode-ai/latest)"
  opencode1_release_version "$metadata"
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
  if ! command -v openssl >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y openssl
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

  # The 1.x installer writes $HOME/.opencode/bin/opencode and treats an
  # `opencode` already on PATH as the install to keep. Give it a private HOME
  # and a PATH with no opencode, so it cannot replace or skip past 2.x.
  opencode1_home="$HOME/.opencode1"
  opencode1_bin="$opencode1_home/.opencode/bin/opencode"
  installed1="$(opencode_version_of "$opencode1_bin")"
  latest1="$(latest_opencode1_version)"
  if [[ "$installed1" != "$latest1" ]]; then
    echo "Installing OpenCode ${latest1}"
    mkdir -p "$opencode1_home"
    HOME="$opencode1_home" PATH="/usr/bin:/bin:/usr/sbin" bash -c 'curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path'
  else
    echo "OpenCode ${installed1} is current"
  fi
  if [[ ! -x "$opencode1_bin" ]]; then
    echo "OpenCode 1.x installer did not write ${opencode1_bin}." >&2
    exit 1
  fi
  sudo ln -sf "$opencode1_bin" /usr/local/bin/opencode1

  /usr/local/bin/bun install --frozen-lockfile
  /usr/local/bin/bun run build
  if [[ ! -f "$ROOT/dist/index.js" || ! -f "$ROOT/dist/plugin.js" || ! -f "$ROOT/dist/plugin-opencode2.js" ]]; then
    echo "Missing dist/index.js, dist/plugin.js, or dist/plugin-opencode2.js after build." >&2
    exit 1
  fi

  # OpenCode config is not written here. The review harness writes it after
  # this install, including on main, where that harness is absent.
  echo "OpenCode $(opencode_version_of /usr/local/bin/opencode)"
  echo "OpenCode 1.x $(opencode_version_of /usr/local/bin/opencode1)"
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_main "$@"
fi
