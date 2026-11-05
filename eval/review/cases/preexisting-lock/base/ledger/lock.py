import fcntl


def update(path, mutate):
    handle = open(path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
        fcntl.flock(handle, fcntl.LOCK_UN)
        mutate(handle)
    finally:
        handle.close()
