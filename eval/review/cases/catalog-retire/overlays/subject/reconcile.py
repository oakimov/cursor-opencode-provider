def reconcile(record, live, usable):
    if not usable:
        return dict(record), "unusable"
    kept = {key: value for key, value in record.items() if key in set(live)}
    return kept, "ok"
