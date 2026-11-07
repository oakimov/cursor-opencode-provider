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


class Terminated(Exception):
    """SIGTERM reached the runner."""


def _terminate(_signum, _frame):
    raise Terminated()


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop_group(child: subprocess.Popen) -> None:
    """Stop whatever the finished check left in its session."""
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + GRACE_SECONDS
    while _group_alive(child.pid):
        if time.monotonic() >= deadline:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                return
            deadline = float("inf")
        time.sleep(0.05)


def run(argv: list[str], cwd: Path) -> int:
    """Run one check in its own session, so cancellation can stop all of it."""
    child = subprocess.Popen(argv, cwd=cwd, start_new_session=True)
    try:
        status = child.wait()
    except BaseException:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        raise
    _stop_group(child)
    return status


def run_checks(source: Path, commands: list[list[str]]) -> int:
    with tempfile.TemporaryDirectory(prefix="checks-") as workspace:
        shutil.copytree(source, workspace, dirs_exist_ok=True)
        for command in commands:
            status = run(command, Path(workspace))
            if status:
                return status
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--command", action="append", default=[], help="a check command as a JSON argument list")
    args = parser.parse_args(argv)
    signal.signal(signal.SIGTERM, _terminate)
    try:
        return run_checks(args.source, [json.loads(item) for item in args.command])
    except KeyboardInterrupt:
        return 130
    except Terminated:
        return 143


if __name__ == "__main__":
    raise SystemExit(main())
