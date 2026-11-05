import sys
from pathlib import Path

payload = sys.stdin.buffer.read(1)
if payload:
    Path(sys.argv[1]).write_text("done\n", encoding="utf-8")
