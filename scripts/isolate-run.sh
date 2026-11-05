#!/usr/bin/env bash
# Run a command where it cannot see reviewer files or credentials.
#
# Linux: user, mount, and pid namespaces, then pivot_root. The command sees
# read-only /usr and /etc, the tool binaries named with --tool, read-only
# --ro-bind mounts, and a read-write copy at /src. Host /tmp, /home,
# /workspace, agent sockets, and git metadata are not mounted. The environment
# starts empty. macOS uses sandbox-exec with the same allow list. If neither
# mechanism works, the script exits 2. It does not fall back to env -i.
#
#   scripts/isolate-run.sh --src DIR [--tool NAME] [--ro-bind HOST:DEST] \
#     [--env NAME] [--set NAME=VALUE] -- COMMAND...
#
# --env copies one existing variable in. --set passes a literal. Review
# credentials stay out unless a caller passes that variable after a separate
# trust decision.
set -euo pipefail

isolate_mechanism() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Linux" ]]; then
    if unshare --user --map-root-user --mount --pid --fork --mount-proc true >/dev/null 2>&1; then
      printf 'linux-unshare'
      return 0
    fi
  elif [[ "$os" == "Darwin" ]]; then
    if command -v sandbox-exec >/dev/null 2>&1; then
      printf 'darwin-sandbox'
      return 0
    fi
  fi
  printf 'unavailable'
  return 1
}

isolate_unavailable() {
  echo "ISOLATION=unavailable" >&2
  echo "$1" >&2
  echo "Refusing to run without a filesystem and process boundary. env -i is not a substitute." >&2
  return 2
}

# Print owner/repo for a github remote URL. Never print userinfo.
isolate_github_slug() {
  local url="$1" rest
  url="${url%.git}"
  url="${url%/}"
  if [[ "$url" == *"://"* ]]; then
    rest="${url#*://}"
    rest="${rest#*@}"
  else
    rest="${url#*@}"
    rest="${rest/:/\/}"
  fi
  if [[ "$rest" =~ ^github\.com/([^/]+)/([^/]+)$ ]]; then
    printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

isolate_main() {
  local src="" mechanism=""
  local -a tools=() ro_binds=() env_names=() set_pairs=() command=()
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --src)
        [[ "$#" -ge 2 ]] || isolate_unavailable "Missing --src directory." || return 2
        src="$2"
        shift 2
        ;;
      --tool)
        [[ "$#" -ge 2 ]] || isolate_unavailable "Missing --tool name." || return 2
        tools+=("$2")
        shift 2
        ;;
      --ro-bind)
        [[ "$#" -ge 2 && "$2" == *:* ]] || isolate_unavailable "Use --ro-bind HOST:DEST." || return 2
        ro_binds+=("$2")
        shift 2
        ;;
      --env)
        [[ "$#" -ge 2 ]] || isolate_unavailable "Missing --env name." || return 2
        env_names+=("$2")
        shift 2
        ;;
      --set)
        [[ "$#" -ge 2 && "$2" == *=* ]] || isolate_unavailable "Use --set NAME=VALUE." || return 2
        set_pairs+=("$2")
        shift 2
        ;;
      --)
        shift
        command+=("$@")
        break
        ;;
      *)
        echo "Unknown argument: $1" >&2
        return 2
        ;;
    esac
  done
  [[ -n "$src" && -d "$src" ]] || isolate_unavailable "A readable --src directory is required." || return 2
  [[ "${#command[@]}" -gt 0 ]] || isolate_unavailable "A command after -- is required." || return 2
  isolate_check_names || return 2
  src="$(cd "$src" && pwd)"

  mechanism="$(isolate_mechanism)" || true
  case "$mechanism" in
    linux-unshare) isolate_linux "$src" ;;
    darwin-sandbox) isolate_darwin "$src" ;;
    *)
      isolate_unavailable "Linux needs working user, mount, and pid namespaces (unshare). macOS needs sandbox-exec." || return 2
      ;;
  esac
}

isolate_linux() {
  local src="$1" stage root enter status=0
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cursor-isolate.XXXXXX")"
  root="$stage/root"
  mkdir -p "$root"
  # shellcheck disable=SC2064
  trap "rm -rf $(printf '%q' "$stage")" EXIT
  isolate_write_env "$root"
  isolate_write_argv "$root"
  enter="$stage/enter.sh"
  cat >"$enter" <<'EOF'
#!/bin/bash
set -euo pipefail
root="$1"
src="$2"
shift 2
mount --make-rprivate /
mount --bind "$root" "$root"
mkdir -p "$root/usr" "$root/etc" "$root/src" "$root/tmp" "$root/proc" "$root/dev" "$root/oldroot" "$root/opt/tools" "$root/home/reviewer"
mount --bind /usr "$root/usr"
mount -o remount,bind,ro "$root/usr"
mount --bind /etc "$root/etc"
mount -o remount,bind,ro "$root/etc"
ln -sfn usr/bin "$root/bin"
ln -sfn usr/lib "$root/lib"
if [[ -d /usr/lib64 ]]; then
  ln -sfn usr/lib64 "$root/lib64"
fi
mount -t tmpfs -o mode=0755 tmpfs "$root/dev"
for node in null zero full random urandom tty; do
  if [[ -e "/dev/$node" ]]; then
    : >"$root/dev/$node"
    mount --bind "/dev/$node" "$root/dev/$node"
  fi
done
mkdir -p "$root/dev/shm"
mount -t tmpfs -o mode=1777 tmpfs "$root/dev/shm"
mount --bind "$src" "$root/src"
mount -t tmpfs -o mode=1777 tmpfs "$root/tmp"
mount -t tmpfs -o mode=0755 tmpfs "$root/home"
mkdir -p "$root/home/reviewer"
chmod 0755 "$root/home/reviewer"
if [[ -f "$root/isolate-env" ]]; then
  # Keep the copied variables on the tmpfs home, off the directory that
  # contained the staging files.
  mv "$root/isolate-env" "$root/home/reviewer/env"
  chmod 0400 "$root/home/reviewer/env"
fi
while [[ "$#" -gt 0 ]]; do
  spec="$1"
  shift
  host="${spec%%$'\t'*}"
  dest="${spec#*$'\t'}"
  if [[ "$dest" == "$spec" || -z "$host" || -z "$dest" ]]; then
    echo "Bad read-only mount." >&2
    exit 2
  fi
  mkdir -p "$root$dest"
  mount --bind "$host" "$root$dest"
  mount -o remount,bind,ro "$root$dest"
done
# Tool binaries are bound by the outer script's list, one host path per line.
if [[ -f "$root/tool-binds" ]]; then
  while IFS=$'\t' read -r host base; do
    [[ -n "$host" && -n "$base" ]] || continue
    mkdir -p "$root/opt/tools"
    : >"$root/opt/tools/$base"
    mount --bind "$host" "$root/opt/tools/$base"
    mount -o remount,bind,ro "$root/opt/tools/$base"
  done <"$root/tool-binds"
  rm -f "$root/tool-binds"
fi
cd "$root"
pivot_root . oldroot
mount -t proc proc /proc
umount -l /oldroot
rmdir /oldroot 2>/dev/null || true
exec /init
EOF
  chmod 0755 "$enter"
  isolate_write_init "$root"
  isolate_write_tools "$root"
  local -a bind_args=()
  local spec host dest
  for spec in "${ro_binds[@]}"; do
    host="${spec%%:*}"
    dest="${spec#*:}"
    [[ -d "$host" ]] || isolate_unavailable "Read-only source is missing: $host" || return 2
    dest="/${dest#/}"
    bind_args+=("${host}"$'\t'"${dest}")
  done
  # The enter script and stage live on the host and disappear at pivot.
  set +e
  unshare --user --map-root-user --mount --pid --fork --mount-proc \
    bash "$enter" "$root" "$src" "${bind_args[@]}"
  status=$?
  set -e
  rm -rf "$stage"
  trap - EXIT
  return "$status"
}

isolate_write_tools() {
  local root="$1" name host base seen=" "
  : >"$root/tool-binds"
  for name in "${tools[@]}"; do
    host="$(command -v "$name" 2>/dev/null || true)"
    [[ -n "$host" && -x "$host" ]] || continue
    case "$host" in
      /usr/*|/bin/*) continue ;;
    esac
    base="$(basename "$host")"
    case "$seen" in
      *" $base "*) continue ;;
    esac
    seen+="$base "
    printf '%s\t%s\n' "$host" "$base" >>"$root/tool-binds"
  done
}

isolate_check_names() {
  local name value
  for name in "${env_names[@]}"; do
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || isolate_unavailable "Refusing environment name $name." || return 2
  done
  for name in "${set_pairs[@]}"; do
    value="${name%%=*}"
    [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || isolate_unavailable "Refusing --set name." || return 2
  done
}

isolate_write_env() {
  local root="$1" name value
  : >"$root/isolate-env"
  chmod 0600 "$root/isolate-env"
  {
    printf 'PATH=/opt/tools:/usr/bin:/bin\n'
    printf 'HOME=/home/reviewer\n'
    printf 'TMPDIR=/tmp\n'
    printf 'USER=reviewer\n'
    printf 'LOGNAME=reviewer\n'
    printf 'LANG=%s\n' "${LANG:-C.UTF-8}"
    printf 'CI=1\n'
    for name in "${env_names[@]}"; do
      value="${!name-}"
      printf 'export %s=%q\n' "$name" "$value"
    done
    for name in "${set_pairs[@]}"; do
      value="${name#*=}"
      name="${name%%=*}"
      printf 'export %s=%q\n' "$name" "$value"
    done
  } >>"$root/isolate-env"
}

isolate_write_argv() {
  local root="$1"
  python3 - "${command[@]}" >"$root/argv.json" <<'PY'
import json, sys
json.dump(sys.argv[1:], sys.stdout)
PY
}

isolate_write_init() {
  local root="$1"
  cat >"$root/init" <<'EOF'
#!/bin/bash
set -euo pipefail
# Drop the host environment. The sourced file is the whole environment.
exec /usr/bin/env -i /bin/bash --noprofile --norc /enter-command
EOF
  cat >"$root/enter-command" <<'EOF'
#!/bin/bash
set -euo pipefail
set -a
if [[ -f /home/reviewer/env ]]; then
  # shellcheck disable=SC1091
  source /home/reviewer/env
fi
set +a
cd /src
exec python3 -c 'import json, os; args = json.load(open("/argv.json")); os.execvp(args[0], args)'
EOF
  chmod 0755 "$root/init" "$root/enter-command"
}

# macOS: default-deny profile. This path is not executed on Linux.
isolate_darwin_profile() {
  local src="$1" home="$2" tmp="$3" profile="$4" spec host dest
  {
    echo '(version 1)'
    echo '(deny default)'
    echo '(allow process-exec)'
    echo '(allow process-fork)'
    echo '(allow signal (target same-sandbox))'
    echo '(allow file-ioctl)'
    echo '(allow file-read-metadata)'
    echo '(allow sysctl-read)'
    echo '(allow mach-lookup)'
    echo '(allow network*)'
    echo '(allow file-read*'
    echo '  (subpath "/usr")'
    echo '  (subpath "/bin")'
    echo '  (subpath "/System")'
    echo '  (subpath "/Library")'
    echo '  (subpath "/dev")'
    echo '  (subpath "/opt/tools")'
    printf '  (subpath "%s")\n' "$src"
    printf '  (subpath "%s")\n' "$home"
    printf '  (subpath "%s")\n' "$tmp"
    for spec in "${ro_binds[@]}"; do
      host="${spec%%:*}"
      printf '  (subpath "%s")\n' "$host"
    done
    echo ')'
    echo '(allow file-write*'
    printf '  (subpath "%s")\n' "$src"
    printf '  (subpath "%s")\n' "$home"
    printf '  (subpath "%s")\n' "$tmp"
    echo ')'
  } >"$profile"
}

isolate_darwin() {
  local src="$1" home tmp profile
  home="$(mktemp -d "${TMPDIR:-/tmp}/cursor-isolate-home.XXXXXX")"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/cursor-isolate-tmp.XXXXXX")"
  profile="$(mktemp "${TMPDIR:-/tmp}/cursor-isolate-profile.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf $(printf '%q' "$home") $(printf '%q' "$tmp") $(printf '%q' "$profile")" EXIT
  isolate_darwin_profile "$src" "$home" "$tmp" "$profile"
  local -a env_args=(
    "PATH=/usr/bin:/bin:/opt/tools"
    "HOME=$home"
    "TMPDIR=$tmp"
    "USER=reviewer"
    "LOGNAME=reviewer"
    "LANG=${LANG:-C.UTF-8}"
    "CI=1"
  )
  local name value
  for name in "${env_names[@]}"; do
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || isolate_unavailable "Refusing environment name $name." || return 2
    value="${!name-}"
    env_args+=("$name=$value")
  done
  for name in "${set_pairs[@]}"; do
    env_args+=("$name")
  done
  set +e
  sandbox-exec -f "$profile" env -i "${env_args[@]}" "${command[@]}"
  local status=$?
  set -e
  rm -rf "$home" "$tmp" "$profile"
  trap - EXIT
  return "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  isolate_main "$@"
fi
