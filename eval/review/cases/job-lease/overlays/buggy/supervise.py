import argparse
import subprocess
import sys
from pathlib import Path


def serve(worker, done, receipt, cancel_fifo):
    process = subprocess.Popen(
        [sys.executable, worker, done],
        stdin=subprocess.PIPE,
        start_new_session=True,
    )
    with open(cancel_fifo, encoding="utf-8") as handle:
        command = handle.readline().strip()
    cancelled = command == "cancel"
    if process.stdin is None:
        raise RuntimeError("worker stdin is closed")
    if cancelled:
        Path(receipt).with_name("cancel-requested").write_text("1\n", encoding="utf-8")
    process.stdin.write(b"x")
    process.stdin.close()
    code = process.wait()
    if code == 0:
        Path(receipt).write_text("ok\n", encoding="utf-8")
    return 0


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    parser.add_argument("--done", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--cancel", required=True)
    args = parser.parse_args(argv)
    return serve(args.worker, args.done, args.receipt, args.cancel)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
