#!/usr/bin/env bash
# Run a command where it cannot see reviewer files or credentials.
#
# Linux: user, mount, and pid namespaces, then pivot_root. The command sees
# read-only /usr and /etc, the tool binaries named with --tool, read-only
# --ro-bind mounts, and a read-write copy at /src. A tool outside /usr/bin
# and /bin, including /usr/local and a symlink into the reviewer home, is
# mounted as its real file under the requested name. The directory that
# contains that file is not mounted. Host /tmp, /home,
# /workspace, agent sockets, and git metadata are not mounted. The environment
# starts empty. --map-root-user grants mount capabilities inside the
# namespace; those are dropped after the mounts exist and before the command
# runs, so a read-only bind cannot be remounted writable. PID 1 then stays a
# reaper: the command runs in its own session, orphaned zombies are collected,
# and termination signals are forwarded to that session. The command is not
# PID 1. macOS uses sandbox-exec. Virtual paths (/src, /tmp, /home/reviewer, /opt/tools, and
# --ro-bind destinations) are translated to private directories. The profile
# allows the dynamic linker, a read of the root directory itself, and the
# selected tool files. It does not allow a tool's parent directory or every
# file read. If neither mechanism works, the script exits 2. It does not fall
# back to env -i.
#
#   scripts/isolate-run.sh --src DIR [--tool NAME] [--ro-bind HOST:DEST] \
#     [--env NAME] [--set NAME=VALUE] -- COMMAND...
#
# --env copies one existing variable in. --set passes a literal. Review
# credentials, including REVIEW_APP_PRIVATE_KEY, stay out unless a caller
# passes that variable after a separate trust decision.
set -euo pipefail

isolate_unshare_detail=""
isolate_mechanism_name=""

# Sets isolate_mechanism_name. Also prints that name. A command substitution
# would drop isolate_unshare_detail, so callers in this script invoke it
# directly.
isolate_mechanism() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Linux" ]]; then
    local err
    # stderr is the command substitution; stdout from `true` is discarded.
    if err="$(unshare --user --map-root-user --mount --pid --fork --mount-proc true 2>&1 >/dev/null)"; then
      isolate_mechanism_name="linux-unshare"
      printf '%s' "$isolate_mechanism_name"
      return 0
    fi
    isolate_unshare_detail="$err"
  elif [[ "$os" == "Darwin" ]]; then
    if command -v sandbox-exec >/dev/null 2>&1; then
      isolate_mechanism_name="darwin-sandbox"
      printf '%s' "$isolate_mechanism_name"
      return 0
    fi
  fi
  isolate_mechanism_name="unavailable"
  printf '%s' "$isolate_mechanism_name"
  return 1
}

isolate_unavailable() {
  echo "ISOLATION=unavailable" >&2
  echo "$1" >&2
  echo "Refusing to run without a filesystem and process boundary. env -i is not a substitute." >&2
  return 2
}

# Print the regular file that should be placed on the boundary PATH under the
# requested tool name. /usr/bin and /bin are already on that PATH. /usr/local
# is not, and a symlink there often points at the reviewer home, which is not
# mounted. Return 1 when the tool is missing or already visible.
isolate_tool_file() {
  local name="$1" host real
  host="$(command -v "$name" 2>/dev/null || true)"
  [[ -n "$host" && -e "$host" ]] || return 1
  real="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$host" 2>/dev/null || true)"
  [[ -n "$real" && -f "$real" && -x "$real" ]] || return 1
  case "$real" in
    /usr/bin/*|/bin/*) return 1 ;;
  esac
  printf '%s\n' "$real"
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

# Length of a named array. ${#name[@]} is safe for an empty array under
# set -u on bash 3.2; expanding "${name[@]}" is not.
isolate_count() {
  eval "printf '%s' \${#$1[@]}"
}

isolate_at() {
  eval "printf '%s' \"\${$1[$2]}\""
}

isolate_main() {
  local src=""
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
  [[ "$(isolate_count command)" -gt 0 ]] || isolate_unavailable "A command after -- is required." || return 2
  isolate_check_names || return 2
  src="$(cd "$src" && pwd)"

  isolate_mechanism >/dev/null || true
  case "$isolate_mechanism_name" in
    linux-unshare) isolate_linux "$src" ;;
    darwin-sandbox) isolate_darwin "$src" ;;
    *)
      local reason="Linux needs working user, mount, and pid namespaces (unshare). macOS needs sandbox-exec."
      if [[ -n "$isolate_unshare_detail" ]]; then
        reason="${reason}"$'\n'"${isolate_unshare_detail}"
      fi
      isolate_unavailable "$reason" || return 2
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
# A container can have locked submounts under /usr (its init) and /etc
# (resolver/hosts files). A nonrecursive bind cannot strip those in a child
# user namespace. Retain the tree, then make every member read-only while
# preserving its locked VFS flags; protecting only the parent is insufficient.
readonly_bind() {
  local source="$1" target="$2" point options
  mount --rbind "$source" "$target"
  findmnt --json --submounts --target "$target" --output TARGET,VFS-OPTIONS >"$root/../mount-tree.json"
  python3 - "$root/../mount-tree.json" "$target" >"$root/../readonly-mounts" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    trees = json.load(handle)["filesystems"]
if len(trees) != 1 or os.path.realpath(trees[0]["target"]) != os.path.realpath(sys.argv[2]):
    raise SystemExit("Could not identify the read-only bind tree")
def emit(node):
    for child in node.get("children", []):
        emit(child)
    options = [flag for flag in node["vfs-options"].split(",") if flag not in ("rw", "ro")]
    sys.stdout.buffer.write(os.fsencode(node["target"]) + b"\0")
    sys.stdout.buffer.write(("remount,bind,ro," + ",".join(options)).encode() + b"\0")
emit(trees[0])
PY
  while IFS= read -r -d '' point && IFS= read -r -d '' options; do
    mount -o "$options" "$point"
  done <"$root/../readonly-mounts"
  rm -f "$root/../mount-tree.json" "$root/../readonly-mounts"
}
mkdir -p "$root/usr" "$root/etc" "$root/src" "$root/tmp" "$root/proc" "$root/dev" "$root/oldroot" "$root/opt/tools" "$root/home/reviewer"
readonly_bind /usr "$root/usr"
readonly_bind /etc "$root/etc"
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
  readonly_bind "$host" "$root$dest"
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
# --map-root-user can remount a read-only bind of a user-owned file.
# Drop that capability in this process, then replace it with the command.
if [[ ! -x /usr/bin/python3 || ! -f /drop-caps.py ]]; then
  echo "python3 is required to drop capabilities before the command." >&2
  exit 2
fi
exec /usr/bin/python3 /drop-caps.py
EOF
  chmod 0755 "$enter"
  isolate_write_init "$root"
  isolate_write_tools "$root"
  local -a bind_args=()
  local spec host dest i n
  n="$(isolate_count ro_binds)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    spec="$(isolate_at ro_binds "$i")"
    host="${spec%%:*}"
    dest="${spec#*:}"
    [[ -d "$host" ]] || isolate_unavailable "Read-only source is missing: $host" || return 2
    dest="/${dest#/}"
    bind_args+=("${host}"$'\t'"${dest}")
    i=$((i + 1))
  done
  # The enter script and stage live on the host and disappear at pivot.
  # An empty bind list must not be expanded: bash 3.2 treats that as unset.
  set +e
  if [[ "$(isolate_count bind_args)" -gt 0 ]]; then
    unshare --user --map-root-user --mount --pid --fork --mount-proc \
      bash "$enter" "$root" "$src" "${bind_args[@]}"
  else
    unshare --user --map-root-user --mount --pid --fork --mount-proc \
      bash "$enter" "$root" "$src"
  fi
  status=$?
  set -e
  rm -rf "$stage"
  trap - EXIT
  return "$status"
}

isolate_write_tools() {
  local root="$1" name real seen=" " i n
  : >"$root/tool-binds"
  n="$(isolate_count tools)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at tools "$i")"
    i=$((i + 1))
    real="$(isolate_tool_file "$name" || true)"
    [[ -n "$real" ]] || continue
    case "$seen" in
      *" $name "*) continue ;;
    esac
    seen+="$name "
    printf '%s\t%s\n' "$real" "$name" >>"$root/tool-binds"
  done
}

isolate_check_names() {
  local name value i n
  n="$(isolate_count env_names)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at env_names "$i")"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || isolate_unavailable "Refusing environment name $name." || return 2
    i=$((i + 1))
  done
  n="$(isolate_count set_pairs)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at set_pairs "$i")"
    value="${name%%=*}"
    [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || isolate_unavailable "Refusing --set name." || return 2
    i=$((i + 1))
  done
}

isolate_write_env() {
  local root="$1" name value i n
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
  } >>"$root/isolate-env"
  n="$(isolate_count env_names)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at env_names "$i")"
    value="${!name-}"
    printf 'export %s=%q\n' "$name" "$value" >>"$root/isolate-env"
    i=$((i + 1))
  done
  n="$(isolate_count set_pairs)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at set_pairs "$i")"
    value="${name#*=}"
    name="${name%%=*}"
    printf 'export %s=%q\n' "$name" "$value" >>"$root/isolate-env"
    i=$((i + 1))
  done
}

isolate_write_argv() {
  local root="$1"
  if [[ "$(isolate_count command)" -eq 0 ]]; then
    echo "A command after -- is required." >&2
    return 2
  fi
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
  cat >"$root/drop-caps.py" <<'EOF'
import ctypes, os, sys

libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
libc.prctl.restype = ctypes.c_int


def fail(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(2)


# PR_CAPBSET_DROP is 24. Caps the kernel does not define return EINVAL (22).
# Any other failure, including EPERM, refuses to run the command.
for cap in range(41):
    ctypes.set_errno(0)
    if libc.prctl(24, cap, 0, 0, 0) != 0 and ctypes.get_errno() != 22:
        fail("capability bound drop failed for %s: %s" % (cap, ctypes.get_errno()))
# PR_SET_NO_NEW_PRIVS is 38.
if libc.prctl(38, 1, 0, 0, 0) != 0:
    fail("no_new_privs failed: %s" % ctypes.get_errno())


class Header(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class Data(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


header = Header(0x20080522, 0)
data = (Data * 2)()
libc.capset.argtypes = [ctypes.POINTER(Header), ctypes.POINTER(Data)]
libc.capset.restype = ctypes.c_int
if libc.capset(ctypes.byref(header), ctypes.cast(data, ctypes.POINTER(Data))) != 0:
    fail("capset failed: %s" % ctypes.get_errno())

# Stay PID 1 and run the command as a child. A test runner left as PID 1 does
# not reap grandchildren whose parents have exited, and kill(pid, 0) still
# succeeds for those zombies.
import signal

try:
    command = os.fork()
except OSError as error:
    fail("fork failed: %s" % error.errno)
if command == 0:
    try:
        os.setsid()
        os.execv("/init", ["/init"])
    finally:
        os._exit(127)


def forward(signum, _frame):
    try:
        os.kill(-command, signum)
    except OSError:
        pass


for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT):
    signal.signal(signum, forward)

exit_code = 1
while True:
    try:
        pid, status = os.waitpid(-1, 0)
    except InterruptedError:
        continue
    except ChildProcessError:
        break
    if pid != command:
        continue
    if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        exit_code = 128 + os.WTERMSIG(status)
    break
while True:
    try:
        pid, _status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        break
    if pid == 0:
        break
os._exit(exit_code)
EOF
}

# Longest virtual prefix first, so /opt/harness wins over a shorter prefix.
isolate_map_add() {
  virt_from+=("$1")
  virt_to+=("$2")
}

isolate_map_sort() {
  local n i j left right from to
  n="$(isolate_count virt_from)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    j=0
    while [[ "$((j + 1))" -lt "$n" ]]; do
      left="$(isolate_at virt_from "$j")"
      right="$(isolate_at virt_from "$((j + 1))")"
      if [[ "${#left}" -lt "${#right}" ]]; then
        virt_from[j]="$right"
        virt_from[j + 1]="$left"
        from="$(isolate_at virt_to "$j")"
        to="$(isolate_at virt_to "$((j + 1))")"
        virt_to[j]="$to"
        virt_to[j + 1]="$from"
      fi
      j=$((j + 1))
    done
    i=$((i + 1))
  done
}

isolate_translate() {
  local value="$1" i n virt real
  n="$(isolate_count virt_from)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    virt="$(isolate_at virt_from "$i")"
    real="$(isolate_at virt_to "$i")"
    if [[ "$value" == "$virt" ]]; then
      printf '%s' "$real"
      return 0
    fi
    if [[ "$value" == "$virt"/* ]]; then
      printf '%s' "${real}${value#"$virt"}"
      return 0
    fi
    i=$((i + 1))
  done
  printf '%s' "$value"
}

isolate_profile_quote() {
  local path="$1"
  case "$path" in
    *\"*|*\\*|*\)*|*'('*|*$'\n'*)
      echo "Refusing a sandbox path that cannot be quoted." >&2
      return 2
      ;;
  esac
  printf '%s' "$path"
}

isolate_darwin_allow() {
  local path
  path="$(isolate_profile_quote "$1")" || return 2
  darwin_reads+=("$path")
}

# Allow one executable or one library file. A directory allow would include
# neighboring credentials, so a selected tool never grants its prefix.
isolate_darwin_allow_file() {
  local path
  [[ -f "$1" ]] || return 0
  path="$(isolate_profile_quote "$1")" || return 2
  darwin_files+=("$path")
}

# Record absolute shared libraries the binary names. Do not infer a prefix.
isolate_darwin_note_dependencies() {
  local bin="$1" listing line dep
  [[ -f "$bin" ]] || return 0
  listing=""
  if command -v otool >/dev/null 2>&1; then
    listing="$(otool -L "$bin" 2>/dev/null || true)"
  elif command -v ldd >/dev/null 2>&1; then
    listing="$(ldd "$bin" 2>/dev/null || true)"
  fi
  [[ -n "$listing" ]] || return 0
  while IFS= read -r line; do
    if [[ "$line" == *"=>"* ]]; then
      dep="${line#*=>}"
    else
      dep="$line"
    fi
    dep="${dep%% (*}"
    dep="${dep#"${dep%%[![:space:]]*}"}"
    dep="${dep%"${dep##*[![:space:]]}"}"
    case "$dep" in
      /*) isolate_darwin_allow_file "$dep" || return 2 ;;
    esac
  done <<< "$listing"
}

# Materialize selected tools and the profile. Does not call sandbox-exec.
# Reads tools, ro_binds, and command from the caller. Sets darwin_home,
# darwin_tmp, darwin_tools, darwin_profile, and darwin_command.
isolate_darwin_prepare() {
  local src="$1" i n spec host dest name real path
  [[ -n "$src" && -d "$src" ]] || return 2
  # Seatbelt matches the resolved path. macOS's default TMPDIR (/var/folders)
  # and /tmp are symlinks into /private, so a rule naming the logical path
  # would deny every access to src, the home and the temp directory.
  src="$(cd "$src" && pwd -P)" || return 2
  darwin_files=()
  darwin_home="$(mktemp -d "${TMPDIR:-/tmp}/cursor-isolate-home.XXXXXX")"
  darwin_tmp="$(mktemp -d "${TMPDIR:-/tmp}/cursor-isolate-tmp.XXXXXX")"
  darwin_tools="$(mktemp -d "${TMPDIR:-/tmp}/cursor-isolate-tools.XXXXXX")"
  darwin_profile="$(mktemp "${TMPDIR:-/tmp}/cursor-isolate-profile.XXXXXX")"
  darwin_home="$(cd "$darwin_home" && pwd -P)" || return 2
  darwin_tmp="$(cd "$darwin_tmp" && pwd -P)" || return 2
  darwin_tools="$(cd "$darwin_tools" && pwd -P)" || return 2
  virt_from=()
  virt_to=()
  darwin_command=()
  darwin_reads=()
  isolate_map_add "/src" "$src"
  isolate_map_add "/tmp" "$darwin_tmp"
  isolate_map_add "/home/reviewer" "$darwin_home"
  isolate_map_add "/opt/tools" "$darwin_tools"
  n="$(isolate_count ro_binds)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    spec="$(isolate_at ro_binds "$i")"
    host="${spec%%:*}"
    dest="${spec#*:}"
    dest="/${dest#/}"
    [[ -d "$host" ]] || {
      echo "Read-only source is missing: $host" >&2
      return 2
    }
    host="$(cd "$host" && pwd -P)" || return 2
    isolate_map_add "$dest" "$host"
    isolate_darwin_allow "$host" || return 2
    i=$((i + 1))
  done
  isolate_map_sort
  n="$(isolate_count tools)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at tools "$i")"
    i=$((i + 1))
    real="$(isolate_tool_file "$name" || true)"
    [[ -n "$real" ]] || continue
    ln -sfn "$real" "$darwin_tools/$name"
    isolate_darwin_allow_file "$real" || return 2
    isolate_darwin_note_dependencies "$real" || return 2
  done
  for path in \
    /usr /bin /System /Library \
    /System/Volumes/Preboot/Cryptexes/OS \
    /System/Volumes/Preboot/Cryptexes/App \
    /private/etc /private/var/db/dyld /dev \
    "$src" "$darwin_home" "$darwin_tmp" "$darwin_tools"
  do
    isolate_darwin_allow "$path" || return 2
  done
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
    # The root directory inode. A subpath of "/" would allow every file.
    echo '  (literal "/")'
    n="$(isolate_count darwin_reads)"
    i=0
    while [[ "$i" -lt "$n" ]]; do
      printf '  (subpath "%s")\n' "$(isolate_at darwin_reads "$i")"
      i=$((i + 1))
    done
    n="$(isolate_count darwin_files)"
    i=0
    while [[ "$i" -lt "$n" ]]; do
      printf '  (literal "%s")\n' "$(isolate_at darwin_files "$i")"
      i=$((i + 1))
    done
    echo ')'
    echo '(allow file-map-executable'
    n="$(isolate_count darwin_reads)"
    i=0
    while [[ "$i" -lt "$n" ]]; do
      printf '  (subpath "%s")\n' "$(isolate_at darwin_reads "$i")"
      i=$((i + 1))
    done
    n="$(isolate_count darwin_files)"
    i=0
    while [[ "$i" -lt "$n" ]]; do
      printf '  (literal "%s")\n' "$(isolate_at darwin_files "$i")"
      i=$((i + 1))
    done
    echo ')'
    echo '(allow file-write*'
    # Discarding output is ordinary shell use; the rest of /dev stays read-only.
    echo '  (literal "/dev/null")'
    printf '  (subpath "%s")\n' "$(isolate_profile_quote "$src")"
    printf '  (subpath "%s")\n' "$(isolate_profile_quote "$darwin_home")"
    printf '  (subpath "%s")\n' "$(isolate_profile_quote "$darwin_tmp")"
    echo ')'
  } >"$darwin_profile"
  n="$(isolate_count command)"
  [[ "$n" -gt 0 ]] || return 2
  i=0
  while [[ "$i" -lt "$n" ]]; do
    darwin_command+=("$(isolate_translate "$(isolate_at command "$i")")")
    i=$((i + 1))
  done
}

isolate_darwin_cleanup() {
  [[ -z "${darwin_home:-}" ]] || rm -rf "$darwin_home"
  [[ -z "${darwin_tmp:-}" ]] || rm -rf "$darwin_tmp"
  [[ -z "${darwin_tools:-}" ]] || rm -rf "$darwin_tools"
  [[ -z "${darwin_profile:-}" ]] || rm -f "$darwin_profile"
  darwin_home=""
  darwin_tmp=""
  darwin_tools=""
  darwin_profile=""
}

isolate_darwin() {
  local src="$1" status=0 i n name value translated
  local -a env_args=()
  darwin_home=""
  darwin_tmp=""
  darwin_tools=""
  darwin_profile=""
  trap isolate_darwin_cleanup EXIT
  isolate_darwin_prepare "$src" || return 2
  env_args=(
    "PATH=${darwin_tools}:/usr/bin:/bin"
    "HOME=${darwin_home}"
    "TMPDIR=${darwin_tmp}"
    "USER=reviewer"
    "LOGNAME=reviewer"
    "LANG=${LANG:-C.UTF-8}"
    "CI=1"
  )
  n="$(isolate_count env_names)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at env_names "$i")"
    value="${!name-}"
    env_args+=("$name=$value")
    i=$((i + 1))
  done
  n="$(isolate_count set_pairs)"
  i=0
  while [[ "$i" -lt "$n" ]]; do
    name="$(isolate_at set_pairs "$i")"
    value="${name#*=}"
    name="${name%%=*}"
    translated="$(isolate_translate "$value")"
    env_args+=("$name=$translated")
    i=$((i + 1))
  done
  set +e
  (cd "$src" && sandbox-exec -f "$darwin_profile" env -i "${env_args[@]}" "${darwin_command[@]}")
  status=$?
  set -e
  isolate_darwin_cleanup
  trap - EXIT
  return "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  isolate_main "$@"
fi
