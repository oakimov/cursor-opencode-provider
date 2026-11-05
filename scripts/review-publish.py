#!/usr/bin/env python3
"""Show, approve, or post a pull-request review.

show prints the payload and does not call GitHub.
approve records a local approval of those exact bytes and that head.
deny records a local refusal. post with a denial, or with no approval,
does not call GitHub.
post re-reads the payload and the pull request head. A changed file or a
moved head is refused. The posted event is COMMENT. A later post of the
same payload returns the review that is already on GitHub.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MARKER = re.compile(r"<!-- cursor-review:([0-9a-f]{64}) -->")
# Values, not the public names of settings. A sentence that names
# CURSOR_API_KEY or copilot.totalNanoAiu is a review comment, not a secret.
SECRET = re.compile(
    r"crsr_[A-Za-z0-9]|ghp_[A-Za-z0-9]|github_pat_[A-Za-z0-9]|x-access-token|"
    r"AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|"
    r"sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]+",
    re.IGNORECASE,
)
# Home-relative paths and any absolute path. A public URL is not one: its
# slashes follow a scheme colon or another slash, and the colon in https://
# is not a drive-letter separator.
ABSOLUTE = re.compile(
    r"(?:^|[\s\"'`=(])~(?:/|[A-Za-z0-9_.-]+/)|"
    r"(?:^|[\s\"'`=(])/(?!/)[^\s\"'`)]+|"
    r"(?:^|[\s\"'`=(])[A-Za-z]:[\\/]|"
    r"(?:^|[\s\"'`=(])file://"
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SESSION = re.compile(r"\bbc-[0-9a-f-]{8,}\b|\bses_[A-Za-z0-9]")
BILLING = re.compile(r"credit balance|account balance", re.IGNORECASE)
DIGEST = re.compile(r"^[0-9a-f]{64}$")
GREPTILE_ACCOUNT = re.compile(r"greptile.{0,40}(credit|token|billing|account)|"
                              r"(credit|token|billing).{0,40}greptile", re.IGNORECASE)
SHA = re.compile(r"^[0-9a-f]{40}$")
NAME = re.compile(r"^[A-Za-z0-9_.-]+$")


def load_payload(path: Path) -> tuple[bytes, dict]:
    raw = path.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Payload is not JSON: {error}") from error
    if not isinstance(payload, dict):
        raise SystemExit("Payload must be a JSON object.")
    return raw, payload


def strings_of(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from strings_of(key)
            yield from strings_of(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings_of(item)


def scan(raw: bytes, payload: dict) -> list[str]:
    problems: list[str] = []
    texts = [raw.decode("utf-8", errors="replace"), *strings_of(payload)]
    checks = (
        (SECRET, "secret or credential"),
        (ABSOLUTE, "absolute local path"),
        (EMAIL, "email address"),
        (SESSION, "session identifier"),
        (BILLING, "billing detail"),
        (GREPTILE_ACCOUNT, "Greptile account detail"),
    )
    for text in texts:
        for pattern, label in checks:
            if pattern.search(text):
                problems.append(label)
    return sorted(set(problems))


def identity_of(payload: dict) -> str:
    body = payload.get("body")
    if not isinstance(body, str):
        body = ""
    stripped = MARKER.sub("", body).strip()
    material = {
        "owner": payload.get("owner"),
        "repo": payload.get("repo"),
        "pull": payload.get("pull"),
        "base": payload.get("base"),
        "head": payload.get("head"),
        "event": "COMMENT",
        "body": stripped,
        "comments": payload.get("comments", []),
    }
    encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def validate(payload: dict) -> list[str]:
    problems: list[str] = []
    if not isinstance(payload.get("owner"), str) or not NAME.fullmatch(payload["owner"]):
        problems.append("owner")
    if not isinstance(payload.get("repo"), str) or not NAME.fullmatch(payload["repo"]):
        problems.append("repo")
    pull = payload.get("pull")
    if not isinstance(pull, int) or isinstance(pull, bool) or pull < 1:
        problems.append("pull")
    for field in ("base", "head"):
        value = payload.get(field)
        if not isinstance(value, str) or not SHA.fullmatch(value):
            problems.append(field)
    if payload.get("event") != "COMMENT":
        problems.append("event")
    body = payload.get("body")
    if not isinstance(body, str) or not body.strip():
        problems.append("body")
    else:
        found = MARKER.findall(body)
        if found != [identity_of(payload)]:
            problems.append("marker")
    comments = payload.get("comments")
    if not isinstance(comments, list):
        problems.append("comments")
    else:
        for index, comment in enumerate(comments):
            if not isinstance(comment, dict):
                problems.append(f"comments[{index}]")
                continue
            path = comment.get("path")
            if (
                not isinstance(path, str)
                or not path
                or path.startswith("/")
                or "\\" in path
                or any(part in ("", ".", "..") for part in path.split("/"))
            ):
                problems.append(f"comments[{index}].path")
            line = comment.get("line")
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                problems.append(f"comments[{index}].line")
            if comment.get("side") not in ("LEFT", "RIGHT"):
                problems.append(f"comments[{index}].side")
            text = comment.get("body")
            if not isinstance(text, str) or not text.strip():
                problems.append(f"comments[{index}].body")
    return problems


def refuse_scan(raw: bytes, payload: dict) -> None:
    problems = scan(raw, payload)
    if problems:
        print("Refusing payload: " + ", ".join(problems), file=sys.stderr)
        raise SystemExit(3)


def gh_api(method: str, endpoint: str, payload: dict | None = None, paginate: bool = False) -> tuple[int, bytes, bytes]:
    command = ["gh", "api", "--method", method]
    if paginate:
        command.extend(["--paginate", "--slurp"])
    command.append(endpoint)
    data = None
    if payload is not None:
        command.extend(["--input", "-"])
        data = json.dumps(payload).encode()
    completed = subprocess.run(command, input=data, capture_output=True)
    return completed.returncode, completed.stdout, completed.stderr


def gh_pages(endpoint: str) -> list[dict]:
    code, stdout, stderr = gh_api("GET", endpoint, paginate=True)
    if code != 0:
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    pages = json.loads(stdout.decode() or "[]")
    if isinstance(pages, dict):
        pages = [pages]
    items: list[dict] = []
    for page in pages:
        if isinstance(page, list):
            items.extend(item for item in page if isinstance(item, dict))
        elif isinstance(page, dict):
            items.append(page)
    return items


def reviews_of(owner: str, repo: str, pull: int) -> list[dict]:
    return gh_pages(f"repos/{owner}/{repo}/pulls/{pull}/reviews")


def comments_of(owner: str, repo: str, pull: int) -> list[dict]:
    return gh_pages(f"repos/{owner}/{repo}/pulls/{pull}/comments")


def matching_review(reviews: list[dict], marker: str) -> dict | None:
    for review in reviews:
        body = review.get("body")
        if isinstance(body, str) and marker in body:
            return review
    return None


def print_review(owner: str, repo: str, pull: int, review: dict) -> None:
    url = review.get("html_url") or review.get("url") or ""
    print(f"REVIEW_URL={url}")
    # Creating a review does not return its inline comments. The comments
    # route does, keyed by pull_request_review_id.
    review_id = review.get("id")
    if not isinstance(review_id, int) or isinstance(review_id, bool):
        return
    for comment in comments_of(owner, repo, pull):
        if comment.get("pull_request_review_id") != review_id:
            continue
        print(f"COMMENT_URL={comment.get('html_url') or comment.get('url') or ''}")


def preview_path(path: Path) -> Path:
    return Path(str(path) + ".preview")


def show(path: Path) -> None:
    raw, payload = load_payload(path)
    refuse_scan(raw, payload)
    problems = validate(payload)
    if problems:
        print("Payload is incomplete: " + ", ".join(problems), file=sys.stderr)
        raise SystemExit(2)
    if not raw.endswith(b"\n"):
        print("Payload file must end with a newline so the shown bytes are exact.", file=sys.stderr)
        raise SystemExit(2)
    frozen = preview_path(path)
    temporary = Path(str(frozen) + ".tmp")
    temporary.write_bytes(raw)
    os.chmod(temporary, 0o444)
    os.replace(temporary, frozen)
    os.chmod(frozen, 0o444)
    digest = hashlib.sha256(raw).hexdigest()
    print(f"PREVIEW_SHA256={digest}", file=sys.stderr)
    sys.stdout.buffer.write(raw)


def stamp(path: Path) -> None:
    raw, payload = load_payload(path)
    body = payload.get("body")
    if not isinstance(body, str):
        raise SystemExit("Payload body must be a string.")
    payload["body"] = MARKER.sub("", body).strip()
    payload["event"] = "COMMENT"
    digest = identity_of(payload)
    payload["body"] = f"{payload['body']}\n\n<!-- cursor-review:{digest} -->\n"
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    refuse_scan(text.encode(), payload)
    path.write_text(text, encoding="utf-8")
    frozen = preview_path(path)
    if frozen.exists():
        frozen.chmod(0o644)
        frozen.unlink()
    print(f"Stamped {digest}. GitHub was not called.")


def approve(payload_path: Path, approval_path: Path, preview_sha: str) -> None:
    if not isinstance(preview_sha, str) or not DIGEST.fullmatch(preview_sha):
        print("approve requires the PREVIEW_SHA256 printed by show.", file=sys.stderr)
        raise SystemExit(2)
    raw = payload_path.read_bytes()
    frozen_file = preview_path(payload_path)
    if not frozen_file.is_file():
        print("No preview is frozen. Run show and approve that digest. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)
    frozen = frozen_file.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != preview_sha or hashlib.sha256(frozen).hexdigest() != preview_sha or frozen != raw:
        print("The file is not the preview that was shown. Run show again. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        print("Payload must be a JSON object.", file=sys.stderr)
        raise SystemExit(2) from None
    if not isinstance(payload, dict):
        print("Payload must be a JSON object.", file=sys.stderr)
        raise SystemExit(2)
    refuse_scan(raw, payload)
    problems = validate(payload)
    if problems:
        print("Payload is incomplete: " + ", ".join(problems), file=sys.stderr)
        raise SystemExit(2)
    record = {
        "decision": "approve",
        "payload_sha256": digest,
        "preview_sha256": preview_sha,
        "identity": identity_of(payload),
        "head": payload["head"],
        "owner": payload["owner"],
        "repo": payload["repo"],
        "pull": payload["pull"],
    }
    approval_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"Approved {record['payload_sha256']} at {payload['head']}. GitHub was not called.")


def deny(approval_path: Path) -> None:
    approval_path.write_text(json.dumps({"decision": "deny"}, indent=2) + "\n", encoding="utf-8")
    print("Denied. GitHub was not called.")


def publication_paths(approval_path: Path, owner: str, repo: str, pull: int, identity: str) -> tuple[Path, Path]:
    directory = approval_path.parent / ".review-publish"
    directory.mkdir(mode=0o700, exist_ok=True)
    key = hashlib.sha256(f"{owner}/{repo}#{pull}:{identity}".encode()).hexdigest()
    return directory / f"{key}.lock", directory / f"{key}.json"


def write_checkpoint(path: Path, record: dict) -> None:
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def post(payload_path: Path, approval_path: Path) -> None:
    if not approval_path.is_file():
        print("No approval file. GitHub was not called.", file=sys.stderr)
        raise SystemExit(4)
    approval = json.loads(approval_path.read_text(encoding="utf-8"))
    if not isinstance(approval, dict) or approval.get("decision") != "approve":
        print("Approval was not granted. GitHub was not called.", file=sys.stderr)
        raise SystemExit(4)
    raw, payload = load_payload(payload_path)
    refuse_scan(raw, payload)
    problems = validate(payload)
    if problems:
        print("Payload is incomplete: " + ", ".join(problems), file=sys.stderr)
        raise SystemExit(2)
    digest = hashlib.sha256(raw).hexdigest()
    if (
        digest != approval.get("payload_sha256")
        or digest != approval.get("preview_sha256")
        or identity_of(payload) != approval.get("identity")
    ):
        print("The payload changed after approval. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)
    if payload.get("head") != approval.get("head"):
        print("The approved head does not match the payload. GitHub was not called.", file=sys.stderr)
        raise SystemExit(6)
    owner, repo, pull = payload["owner"], payload["repo"], payload["pull"]
    identity = str(approval["identity"])
    lock_path, checkpoint_path = publication_paths(approval_path, owner, repo, pull, identity)
    lock = lock_path.open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        post_locked(payload, approval, digest, checkpoint_path)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def post_locked(payload: dict, approval: dict, digest: str, checkpoint_path: Path) -> None:
    owner, repo, pull = payload["owner"], payload["repo"], payload["pull"]
    code, stdout, stderr = gh_api("GET", f"repos/{owner}/{repo}/pulls/{pull}")
    if code != 0:
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    current = json.loads(stdout.decode() or "{}")
    head = current.get("head", {}).get("sha") if isinstance(current, dict) else None
    if head != approval.get("head"):
        print(f"The pull request head is {head}, not the approved {approval.get('head')}.", file=sys.stderr)
        raise SystemExit(6)
    marker = f"<!-- cursor-review:{approval['identity']} -->"
    existing = matching_review(reviews_of(owner, repo, pull), marker)
    if existing is not None:
        write_checkpoint(checkpoint_path, {"state": "posted", "payload_sha256": digest, "review_id": existing.get("id")})
        print("REVIEW_ALREADY_POSTED=1")
        print_review(owner, repo, pull, existing)
        return
    body = {
        "commit_id": payload["head"],
        "body": payload["body"],
        "event": "COMMENT",
        "comments": [
            {"path": item["path"], "line": item["line"], "side": item["side"], "body": item["body"]}
            for item in payload["comments"]
        ],
    }
    write_checkpoint(checkpoint_path, {"state": "posting", "payload_sha256": digest, "head": payload["head"]})
    code, stdout, stderr = gh_api("POST", f"repos/{owner}/{repo}/pulls/{pull}/reviews", body)
    if code != 0:
        recovered = matching_review(reviews_of(owner, repo, pull), marker)
        if recovered is not None:
            write_checkpoint(
                checkpoint_path, {"state": "posted", "payload_sha256": digest, "review_id": recovered.get("id")}
            )
            print("REVIEW_ALREADY_POSTED=1")
            print_review(owner, repo, pull, recovered)
            return
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    created = json.loads(stdout.decode() or "{}")
    if not isinstance(created, dict):
        print("GitHub did not return a review.", file=sys.stderr)
        raise SystemExit(1)
    write_checkpoint(checkpoint_path, {"state": "posted", "payload_sha256": digest, "review_id": created.get("id")})
    print_review(owner, repo, pull, created)


def main() -> None:
    parser = argparse.ArgumentParser(description="Show or post an approved COMMENT review.")
    parser.add_argument("command", choices=("show", "stamp", "approve", "deny", "post"))
    parser.add_argument("payload", nargs="?", type=Path)
    parser.add_argument("approval", nargs="?", type=Path)
    parser.add_argument("preview", nargs="?")
    args = parser.parse_args()
    if args.command == "show":
        if args.payload is None:
            parser.error("show requires a payload file")
        show(args.payload)
    elif args.command == "stamp":
        if args.payload is None:
            parser.error("stamp requires a payload file")
        stamp(args.payload)
    elif args.command == "approve":
        if args.payload is None or args.approval is None or args.preview is None:
            parser.error("approve requires a payload file, an approval file, and the shown preview digest")
        approve(args.payload, args.approval, args.preview)
    elif args.command == "deny":
        if args.payload is None:
            parser.error("deny requires an approval file")
        deny(args.payload)
    else:
        if args.payload is None or args.approval is None:
            parser.error("post requires a payload file and an approval file")
        post(args.payload, args.approval)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        raise SystemExit(0) from None
