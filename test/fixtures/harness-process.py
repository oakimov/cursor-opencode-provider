"""Acknowledged process lifecycles for the local harness regression tests."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
role, state_name, mode, *arguments = sys.argv[1:]
state = Path(state_name)


def wait_for(path: Path) -> None:
    deadline = time.monotonic() + 10
    while not path.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("No lifecycle acknowledgement")
        time.sleep(0.01)


if role == "adapter":
    spec = importlib.util.spec_from_file_location("harness", arguments[0])
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    harness.ROOT = state / "repo"
    harness.detect = lambda requested: {"backend": "native", "ready": True}
    harness.CHECKS = [[sys.executable, __file__, "leader", str(state), mode]]
    harness.CLEANUP_GRACE_SECONDS = 0.15
    raise SystemExit(harness.main([]))

if role == "descendant":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (state / "descendant.pid").write_text(str(os.getpid()))
    (state / "workspace").write_text(os.getcwd())
    (state / "descendant.ready").write_text("ready")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with open("heartbeat", "a", encoding="utf-8") as handle:
                handle.write("x")
        except OSError:
            pass
        time.sleep(0.01)
    raise SystemExit(0)

if role != "leader":
    raise ValueError("Unknown fixture role")
(state / "leader.pid").write_text(str(os.getpid()))
subprocess.Popen([sys.executable, __file__, "descendant", str(state), mode],
                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
wait_for(state / "descendant.ready")
if mode == "repeated":
    signal.signal(signal.SIGTERM, lambda *_: (state / "term-seen").write_text("ready"))
(state / "leader.ready").write_text("ready")
if mode in ("success", "failure"):
    raise SystemExit(7 if mode == "failure" else 0)
time.sleep(15)
