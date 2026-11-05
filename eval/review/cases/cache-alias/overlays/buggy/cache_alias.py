def fetch(store, subject, role, compute):
    if subject in store:
        return store[subject]
    value = compute(subject, role)
    store[subject] = value
    return value
