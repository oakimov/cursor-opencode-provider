import fcntl


def update(path, mutate):
    handle = open(path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            mutate(handle)
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        handle.close()
