def release(packages):
    missing = [name for name, tested in packages.items() if not tested]
    if missing:
        return 1
    return 0
