import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from indexlib.store import load


def answer(record, key):
    if key in record["due"]:
        raise RuntimeError(f"{key} is due")
    return record["entries"][key]


def main(argv):
    record = load(argv[0])
    sys.stdout.write(f"{answer(record, argv[1])}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
