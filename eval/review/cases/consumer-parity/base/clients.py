def legacy(config):
    levels = config["levels"] if config["tunable"] else {}
    return {"choices": [{"id": key, "settings": value} for key, value in levels.items()]}


def modern(config):
    if set(config) != {"levels"}:
        raise ValueError("modern catalog accepts only explicit levels")
    return {"choices": config["levels"]}
