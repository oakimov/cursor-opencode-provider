"""Run check commands in a private copy of a source tree."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

GRACE_SECONDS = 5.0
POLL_SECONDS = 0.05
EXIT_STATUS = {signal.SIGINT: 130, signal.SIGTERM: 143}

_received: list[int] = []


class Cancelled(Exception):
    """SIGINT or SIGTERM reached the runner."""

    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


def _record(signum, _frame) -> None:
    # Only note the signal. The runner acts on it at a checkpoint, so it never
    # interrupts starting, settling, or removing anything.
    _received.append(signum)


def _checkpoint(*_args) -> list[str]:
    if _received:
        raise Cancelled(_received[0])
    return []


def _has_live_member(pgid: int) -> bool:
    """Whether the group holds a process that is not a zombie."""
    try:
        listing = subprocess.run(
            ["ps", "-A", "-o", "pgid=,stat="], capture_output=True, text=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return True  # cannot tell, so do not release the workspace
    return any(
        fields[0] == str(pgid) and not fields[1].startswith("Z")
        for fields in (line.split() for line in listing.splitlines())
        if len(fields) == 2
    )


def _group_alive(pgid: int, killed: bool) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass  # macOS reports a group holding only zombies this way
    # Before SIGKILL any member may still run. After it, only zombies can stay
    # (their parents may have left the group), and a zombie cannot write.
    return True if not killed else _has_live_member(pgid)


def _settle(child: subprocess.Popen) -> None:
    """Return only when no process of the check's process group remains.

    TERM first; whatever outlives the grace period gets KILL. The leader is
    reaped here too, so its zombie does not keep the group alive.
    """
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait()
        return
    except PermissionError:
        pass
    killed = False
    deadline = time.monotonic() + GRACE_SECONDS
    while True:
        child.poll()
        if not _group_alive(child.pid, killed):
            break
        if not killed and time.monotonic() >= deadline:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                break
            except PermissionError:
                pass
            killed = True
        time.sleep(POLL_SECONDS)
    child.wait()


def run(argv: list[str], cwd: Path) -> int:
    """Run one check in its own process group and stop all of it before returning."""
    child = subprocess.Popen(argv, cwd=cwd, start_new_session=True)
    try:
        while (status := child.poll()) is None:
            _checkpoint()
            time.sleep(POLL_SECONDS)
        return status
    finally:
        _settle(child)


def run_checks(source: Path, commands: list[list[str]]) -> int:
    with tempfile.TemporaryDirectory(prefix="checks-") as workspace:
        shutil.copytree(source, workspace, dirs_exist_ok=True, ignore=_checkpoint)
        for command in commands:
            _checkpoint()
            status = run(command, Path(workspace))
            if status:
                return status
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--command", action="append", default=[], help="a check command as a JSON argument list")
    args = parser.parse_args(argv)
    for signum in EXIT_STATUS:
        signal.signal(signum, _record)
    try:
        status = run_checks(args.source, [json.loads(item) for item in args.command])
        _checkpoint()  # a signal during the final cleanup still reports cancellation
        return status
    except Cancelled as cancelled:
        return EXIT_STATUS[cancelled.signum]


if __name__ == "__main__":
    raise SystemExit(main())
