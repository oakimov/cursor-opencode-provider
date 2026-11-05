#!/usr/bin/env bash
# GitHub-hosted Ubuntu denies unprivileged user namespaces. The isolation
# tests require them. When the probe fails and the AppArmor sysctl is set,
# clear it and probe again. Exit 0 when a user, mount, and pid namespace
# can be created. Exit 1 when it still cannot.
set -euo pipefail

probe() {
  unshare --user --map-root-user --mount --pid --fork --mount-proc true
}

if probe >/dev/null 2>&1; then
  echo "user namespaces already available"
  exit 0
fi

sysctl_path=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ -r "$sysctl_path" && "$(cat "$sysctl_path")" != "0" ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
clone_path=/proc/sys/kernel/unprivileged_userns_clone
if [[ -r "$clone_path" && "$(cat "$clone_path")" != "1" ]]; then
  sudo sysctl -w kernel.unprivileged_userns_clone=1
fi

if probe >/dev/null 2>&1; then
  echo "user namespaces enabled"
  exit 0
fi

echo "unshare still cannot create a user, mount, and pid namespace." >&2
probe || true
exit 1
