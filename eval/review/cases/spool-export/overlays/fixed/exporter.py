"""Export rows as JSON lines through a staging directory."""
from __future__ import annotations

import json
import os
import queue
import shutil
import tempfile
import threading
from pathlib import Path


def _write(lines: "queue.Queue[str | None]", target: Path, failures: list[OSError]) -> None:
    """Write every line; after an I/O error keep draining so the producer never blocks."""
    handle = None
    try:
        handle = open(target, "w", encoding="utf-8")
    except OSError as error:
        failures.append(error)
    while (line := lines.get()) is not None:
        if handle is None:
            continue
        try:
            handle.write(line + "\n")
        except OSError as error:
            failures.append(error)
            try:
                handle.close()
            except OSError:
                pass
            handle = None
    if handle is not None:
        try:
            handle.close()
        except OSError as error:
            failures.append(error)


def export_rows(rows, dest: Path) -> None:
    """Serialize on the caller's thread and write on a background writer."""
    staging = Path(tempfile.mkdtemp(prefix="export-"))
    target = staging / "rows.jsonl"
    lines: "queue.Queue[str | None]" = queue.Queue(maxsize=256)
    failures: list[OSError] = []
    writer = threading.Thread(target=_write, args=(lines, target, failures), daemon=True)
    try:
        try:
            writer.start()
            for row in rows:
                lines.put(json.dumps(row, allow_nan=False))
        finally:
            # The writer stops on every path before its directory goes away.
            if writer.is_alive():
                lines.put(None)
                writer.join()
        if failures:
            raise failures[0]
        os.replace(target, dest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
