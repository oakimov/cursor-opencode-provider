import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "ledger"))
from lock import update


def reserve(path):
    def mutate(handle):
        handle.seek(0)
        raw = handle.read().strip()
        value = int(raw or "0") + 1
        handle.seek(0)
        handle.truncate()
        handle.write(str(value))
        handle.flush()

    update(path, mutate)


if __name__ == "__main__":
    reserve(sys.argv[1])
