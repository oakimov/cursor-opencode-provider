from pathlib import Path


def rejection(relative):
    if not relative or relative.startswith("/") or ".." in Path(relative).parts:
        return "path leaves the workspace"
    return None
