from pathlib import Path


def publish(workspace, approved, dest):
    root = Path(workspace)
    target_root = Path(dest)
    target_root.mkdir(parents=True, exist_ok=True)
    copied = []
    for line in Path(approved).read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        source = root / line
        target = target_root / Path(line).name
        target.write_bytes(source.read_bytes())
        copied.append(line)
    return copied
