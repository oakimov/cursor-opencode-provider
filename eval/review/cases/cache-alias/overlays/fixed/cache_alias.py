def fetch(store, subject, role, compute):
    key = (subject, role)
    if key in store:
        return store[key]
    value = compute(subject, role)
    store[key] = value
    return value
