import sys


def main(amount, limit):
    if amount > limit:
        return 1
    sys.stdout.write(f"{amount}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(int(sys.argv[1]), int(sys.argv[2])))
