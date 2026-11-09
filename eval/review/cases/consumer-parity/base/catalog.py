import json
import sys

import adapters
import clients


def catalog(consumer, model):
    config = getattr(adapters, consumer)(model)
    return getattr(clients, consumer)(config)


if __name__ == "__main__":
    print(json.dumps(catalog(sys.argv[1], json.loads(sys.argv[2]))))
