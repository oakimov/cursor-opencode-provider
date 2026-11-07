"""Run check commands in a private copy of a source tree."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path


def run(argv: list[str], cwd: Path) -> int:
    """Run one check in its own session, so cancellation can stop all of it."""
    child = subprocess.Popen(argv, cwd=cwd, start_new_session=True)
    try:
        return child.wait()
    except BaseException:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        raise


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
    try:
        return run_checks(args.source, [json.loads(item) for item in args.command])
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
