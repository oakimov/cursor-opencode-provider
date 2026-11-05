import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from indexlib.store import load, save


def endpoint_value(endpoint, key):
    item = json.loads(Path(endpoint).read_text(encoding="utf-8"))[key]
    if item.get("error"):
        raise RuntimeError(str(item["error"]))
    return item["value"]


def run(record_path, endpoint, refresh):
    record = load(record_path)
    due = list(record["due"])
    if refresh:
        try:
            record["entries"][refresh] = endpoint_value(endpoint, refresh)
            if refresh in due:
                due.remove(refresh)
            record["due"] = due
            save(record_path, record)
            return 0
        except RuntimeError:
            if refresh in due:
                due.remove(refresh)
            record["due"] = due
            save(record_path, record)
            return 1
    for key in list(due):
        try:
            record["entries"][key] = endpoint_value(endpoint, key)
        except RuntimeError:
            record["due"] = due
            save(record_path, record)
            return 1
        due.remove(key)
    record["due"] = due
    save(record_path, record)
    return 0 if not due else 1


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("record")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--refresh")
    args = parser.parse_args(argv)
    return run(args.record, args.endpoint, args.refresh)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
