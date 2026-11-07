"""Export rows as JSON lines through a staging directory."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path


def export_rows(rows, dest: Path) -> None:
    staging = Path(tempfile.mkdtemp(prefix="export-"))
    try:
        target = staging / "rows.jsonl"
        with open(target, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, allow_nan=False) + "\n")
        os.replace(target, dest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
