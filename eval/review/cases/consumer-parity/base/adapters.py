def legacy(model):
    return {
        "tunable": model["tunable"],
        "levels": {level["id"]: dict(level["settings"]) for level in model["levels"]},
    }


def modern(model):
    return {"levels": [
        {"id": level["id"], "settings": dict(level["settings"])}
        for level in model["levels"]
    ]}
