LIMIT = 20


def accept(parts):
    if sum(parts) > LIMIT:
        raise ValueError("over budget")
    return list(parts)
