import json
from pathlib import Path


def load(path):
    file = Path(path)
    if not file.exists():
        return {"entries": {}, "due": []}
    data = json.loads(file.read_text(encoding="utf-8"))
    data.setdefault("entries", {})
    data.setdefault("due", [])
    return data


def save(path, record):
    Path(path).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
