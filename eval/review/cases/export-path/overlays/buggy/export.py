import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate import rejection


def export(workspace, relative, body, approved):
    reason = rejection(relative)
    destination = Path(workspace) / relative
    if reason:
        sys.stderr.write(f"{reason}\n")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(body, encoding="utf-8")
    with open(approved, "a", encoding="utf-8") as handle:
        handle.write(f"{relative}\n")
    return 0


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace")
    parser.add_argument("relative")
    parser.add_argument("body")
    parser.add_argument("approved")
    args = parser.parse_args(argv)
    return export(args.workspace, args.relative, args.body, args.approved)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
