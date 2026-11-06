#!/usr/bin/env python3
"""Run the complete local checks on Linux, macOS, or a Windows Linux-container engine.

This is a trusted-local-checkout runner. Contributor PRs still use isolated-check.sh.
No Cursor credential or agent is required, and this runner never performs a live Run.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "cursor-provider-tests:local"
IMAGE_LABEL = "org.cursor-provider.test-harness.sha256"
CHECKS = [
    ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    ["bun", "run", "typecheck"],
    ["bun", "run", "build"],
    ["bun", "test"],
    ["bun", "test", "test/architecture.test.ts"],
    ["bun", "run", "test:node-http2"],
    ["bun", "run", "check:pricing"],
]


def probe(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False, **kwargs)


def local_docker() -> tuple[bool, str]:
    if not shutil.which("docker"):
        return False, "Docker is missing; Windows needs a local engine running Linux containers."
    endpoint = os.environ.get("DOCKER_HOST")
    if not endpoint:
        context = probe(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
        endpoint = context.stdout.strip() if context.returncode == 0 else ""
    if not endpoint.startswith(("unix://", "npipe://")):
        return False, "A local Docker socket or named pipe is required; remote engines are refused."
    info = probe(["docker", "info", "--format", "{{.OSType}}"])
    if info.returncode != 0 or info.stdout.strip() != "linux":
        return False, "Start the local Docker engine in Linux-container mode."
    return True, ""


def detect(requested: str = "auto") -> dict:
    system = platform.system()
    native_error = ""
    if system not in ("Linux", "Darwin"):
        native_error = "The POSIX shell tests require the Linux-container backend on this OS."
    elif getattr(os, "geteuid", lambda: -1)() == 0:
        native_error = "Permission tests require an unprivileged user; run as an ordinary user or use Docker."
    else:
        missing = [tool for tool in ("bun", "node", "bash", "git", "python3", "zsh", "openssl") if not shutil.which(tool)]
        if missing:
            native_error = "Missing native test tools: " + ", ".join(missing)
        elif system == "Linux":
            if any(not shutil.which(tool) for tool in ("unshare", "mount", "findmnt", "pivot_root")) or probe(["unshare", "--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "true"]).returncode != 0:
                native_error = "Linux tests need working user, mount, and PID namespaces. Enable them or use Docker."
        elif not shutil.which("sandbox-exec") or probe(["sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]).returncode != 0:
            native_error = "macOS tests need a working sandbox-exec."
    backend = requested if requested != "auto" else ("native" if not native_error else "docker")
    error = native_error if backend == "native" else ""
    if backend == "docker" and not error:
        ready, error = local_docker()
        if not ready and native_error and requested == "auto":
            error = native_error + " " + error
    if not shutil.which("git"):
        error = "Git is required to snapshot the working tree. " + error
    return {
        "os": system,
        "backend": backend,
        "ready": not bool(error),
        "reason": error,
        "cursor_agent_command": bool(shutil.which("cursor-agent") or shutil.which("agent")),
    }


def snapshot(root: Path, destination: Path) -> None:
    """Copy current sources, retaining deliberate deletions and hydrating sparse exclusions.

    Ignore rules exclude credentials, logs, caches and review artifacts. Git metadata
    and host node_modules are never copied, including into the Windows Linux image.
    """
    tracked = subprocess.check_output(["git", "ls-files", "-v", "-z"], cwd=root).split(b"\0")
    entries = [(item[:1], os.fsdecode(item[2:])) for item in tracked if item]
    extra = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root).split(b"\0")
    entries.extend((b"?", os.fsdecode(item)) for item in extra if item)
    modes = {}
    for item in subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=root).split(b"\0"):
        if item:
            metadata, name = item.split(b"\t", 1)
            modes[os.fsdecode(name)] = metadata.split(b" ", 1)[0]
    for flag, name in entries:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] in (".git", "node_modules", "dist"):
            raise ValueError("Invalid source snapshot entry")
        source, target = root / relative, destination / relative
        if source.is_symlink():
            # A checkout link must not cause the runner to copy a private target.
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(os.readlink(source))
        elif source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        elif flag.upper() == b"S":
            data = subprocess.check_output(["git", "show", ":" + name], cwd=root)
            target.parent.mkdir(parents=True, exist_ok=True)
            if modes.get(name) == b"120000":
                target.symlink_to(os.fsdecode(data))
            else:
                target.write_bytes(data)
                if modes.get(name) == b"100755":
                    target.chmod(0o755)


def run(argv: list[str], cwd: Path, *, env: dict | None = None, data: bytes | None = None) -> int:
    """Await child exit before temporary cleanup, including cancellation."""
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if data is not None else None,
                             start_new_session=os.name != "nt")
    try:
        child.communicate(data)
        return child.returncode
    except BaseException:
        if os.name == "nt":
            child.terminate()
        else:
            os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                child.kill()
            else:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        raise


def build_image(image: str) -> int:
    # Send only the Dockerfile to the local engine, never the checkout context.
    data = (ROOT / "scripts/test-harness.Dockerfile").read_bytes()
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as contents:
        member = tarfile.TarInfo("Dockerfile")
        member.size = len(data)
        contents.addfile(member, io.BytesIO(data))
    stamp = hashlib.sha256(data).hexdigest()
    return run(["docker", "build", "--tag", image, "--label", f"{IMAGE_LABEL}={stamp}", "-"], ROOT, data=archive.getvalue())


def image_stamp() -> str:
    return hashlib.sha256((ROOT / "scripts/test-harness.Dockerfile").read_bytes()).hexdigest()


def docker_command(source: Path, image: str, name: str) -> list[str]:
    mount = io.StringIO()
    csv.writer(mount, lineterminator="").writerow(["type=bind", f"source={source}", "target=/input", "readonly"])
    # Nested namespace tests need unrestricted mount/unshare syscalls and an
    # unmasked /proc; the user namespace grants the mount capability, so no
    # capability is added. The engine sees only this disposable snapshot, with
    # no socket, host home, credential environment or other bind mount.
    worker = ("set -euo pipefail\n"
              "unshare --user --map-root-user --mount --pid --fork --mount-proc true || "
              "{ echo 'HARNESS=unavailable nested Linux namespaces cannot mount proc' >&2; exit 2; }\n"
              "cp -R /input/. /src/\nchmod +x scripts/*.sh\n") + "\n".join(" ".join(check) for check in CHECKS)
    return ["docker", "run", "--rm", "--pull=never", "--init", "--name", name,
            "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "seccomp=unconfined",
            "--security-opt", "apparmor=unconfined", "--security-opt", "systempaths=unconfined",
            "--mount", mount.getvalue(),
            "--workdir", "/src", "--env", "CI=1", "--env", "TMPDIR=/tmp",
            "--env", "HOME=/home/test-runner", image, "bash", "-c", worker]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnose", action="store_true", help="report OS, backend and prerequisites without running checks")
    parser.add_argument("--backend", choices=("auto", "native", "docker"), default="auto")
    parser.add_argument("--image", default=IMAGE)
    parser.add_argument("--build-image", action="store_true", help="build the test image on the local Docker engine")
    args = parser.parse_args(argv)
    try:
        report = detect(args.backend)
        print(json.dumps(report), flush=True)
        if not report["ready"]:
            return 2
        if args.diagnose:
            return 0
        if not shutil.which("git"):
            print("Git is required to snapshot the working tree.", file=sys.stderr)
            return 2
        if report["backend"] == "docker":
            if args.build_image:
                status = build_image(args.image)
                if status:
                    return status
            image = probe(["docker", "image", "inspect", "--format", '{{index .Config.Labels "' + IMAGE_LABEL + '"}}', args.image])
            if image.returncode != 0 or image.stdout.strip() != image_stamp():
                print("Test image is missing or differs from the Dockerfile; run again with --build-image.", file=sys.stderr)
                return 2
        with tempfile.TemporaryDirectory(prefix="cursor-harness-") as temporary:
            source = Path(temporary).resolve()
            snapshot(ROOT, source)
            if report["backend"] == "docker":
                source.chmod(0o755)
                name = "cursor-provider-check-" + uuid.uuid4().hex
                try:
                    return run(docker_command(source, args.image, name), ROOT)
                finally:
                    # --rm covers ordinary exit; cancellation must remove a
                    # surviving container before removing its bind source.
                    removed = probe(["docker", "rm", "--force", name])
                    if removed.returncode != 0:
                        remaining = probe(["docker", "ps", "--all", "--quiet", "--filter", f"name=^{name}$"])
                        if remaining.returncode != 0 or remaining.stdout.strip():
                            raise OSError("Could not confirm test-container cleanup")
            # This runner executes trusted local changes. Contributor checks
            # keep their filesystem boundary in isolated-check.sh.
            env = {key: value for key, value in os.environ.items()
                   if key not in ("CURSOR_API_KEY", "GH_TOKEN", "GITHUB_TOKEN") and not key.startswith("REVIEW_APP_")}
            for check in CHECKS:
                print("CHECK=" + " ".join(check), flush=True)
                status = run(check, source, env=env)
                if status:
                    return status
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"HARNESS=unavailable {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
