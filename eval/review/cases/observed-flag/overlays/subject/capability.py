def apply(record, key, verdict, forced):
    current = dict(record)
    if verdict is None:
        return current
    if key not in current:
        current[key] = bool(verdict)
        return current
    if forced and verdict is False:
        current[key] = False
    return current
