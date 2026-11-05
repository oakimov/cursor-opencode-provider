#!/usr/bin/env python3
"""Finish the approved thread resolutions of an already-posted review.

Run this after `review-publish.py post` confirmed the review but could not
complete every approved resolve action: a failed or unconfirmed resolution, or
a retry `post` refuses. It takes the same approved payload and approval files
and reuses the publisher's resolution machinery, so it re-verifies each thread
before resolving, refuses ambiguous states and reopened threads, never resends
a review, and prints the same `THREAD_RESOLVED=<id>` receipts. It is idempotent:
an already-resolved thread is confirmed, not re-resolved. No reply, comment, or
any other mutation is sent.

    python3 scripts/complete-resolutions.py <payload.json> <approval.json>
"""

from __future__ import annotations

import argparse
import fcntl
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_publisher():
    # Never leave bytecode caches beside the harness scripts.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("review_publish_module", HERE / "review-publish.py")
    if spec is None or spec.loader is None:
        raise SystemExit("The publisher script is unavailable.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Complete the approved resolve actions of a posted review."
    )
    parser.add_argument("payload", type=Path, help="the approved rendered payload")
    parser.add_argument("approval", type=Path, help="the approval record for that payload")
    arguments = parser.parse_args()
    payload_path = arguments.payload
    approval_path = arguments.approval

    publisher = load_publisher()
    _raw, payload, approval, digest = publisher.authorized_post(payload_path, approval_path)
    owner, repo, pull = payload["owner"], payload["repo"], payload["pull"]
    identity = str(approval["identity"])
    if (
        payload.get("owner") != approval.get("owner")
        or payload.get("repo") != approval.get("repo")
        or payload.get("pull") != approval.get("pull")
    ):
        print("The approval record was replaced. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)
    pinned = publisher.operation_key(payload, approval, digest)
    lock_path, checkpoint_path = publisher.publication_paths(approval_path, owner, repo, pull, identity)

    lock = lock_path.open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        marker = f"<!-- cursor-review:{identity} -->"
        existing = publisher.matching_review(publisher.reviews_of(owner, repo, pull), marker)
        journal = publisher.read_json_object(checkpoint_path)
        if existing is None or not isinstance(journal, dict) or journal.get("state") != "posted":
            print("No confirmed review receipt; threads were not resolved.", file=sys.stderr)
            raise SystemExit(1)
        if not publisher.resolution_targets(payload):
            print("No approved resolve actions in this payload.")
            return
        publisher.resolve_threads(payload_path, approval_path, payload, pinned, checkpoint_path)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


if __name__ == "__main__":
    main()
