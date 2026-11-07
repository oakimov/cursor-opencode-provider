"""Run check commands in a private copy of a source tree."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def run_checks(source: Path, commands: list[list[str]]) -> int:
    with tempfile.TemporaryDirectory(prefix="checks-") as workspace:
        shutil.copytree(source, workspace, dirs_exist_ok=True)
        for command in commands:
            status = subprocess.call(command, cwd=workspace)
            if status:
                return status
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--command", action="append", default=[], help="a check command as a JSON argument list")
    args = parser.parse_args(argv)
    return run_checks(args.source, [json.loads(item) for item in args.command])


if __name__ == "__main__":
    raise SystemExit(main())
