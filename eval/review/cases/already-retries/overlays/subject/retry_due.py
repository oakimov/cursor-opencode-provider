def run(state, fetch):
    # Open question: should a failed id be attempted again on a later run?
    for key in list(state["due"]):
        try:
            state["entries"][key] = fetch(key)
        except RuntimeError:
            return 1
        state["due"].remove(key)
    return 0
