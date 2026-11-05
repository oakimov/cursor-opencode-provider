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
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

MARKER = re.compile(r"<!-- cursor-review:([0-9a-f]{64}) -->")
SECRET = re.compile(
    r"crsr_|ghp_|github_pat_|x-access-token|AKIA[0-9A-Z]{8}|-----BEGIN |"
    r"CURSOR_API_KEY|sk-[A-Za-z0-9]|xox[baprs]-",
    re.IGNORECASE,
)
ABSOLUTE = re.compile(
    r"(?:^|[\s\"'`=(])/(?:home|Users|tmp|private|opt|var|workspace|cursor|root)/|"
    r"[A-Za-z]:[\\/]|file://"
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SESSION = re.compile(r"\bbc-[0-9a-f-]{8,}\b|\bses_[A-Za-z0-9]")
BILLING = re.compile(r"nanoAiu|credit balance|invoice", re.IGNORECASE)
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


def reviews_of(owner: str, repo: str, pull: int) -> list[dict]:
    code, stdout, stderr = gh_api("GET", f"repos/{owner}/{repo}/pulls/{pull}/reviews", paginate=True)
    if code != 0:
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    pages = json.loads(stdout.decode() or "[]")
    if isinstance(pages, dict):
        pages = [pages]
    reviews: list[dict] = []
    for page in pages:
        if isinstance(page, list):
            reviews.extend(item for item in page if isinstance(item, dict))
        elif isinstance(page, dict):
            reviews.append(page)
    return reviews


def matching_review(reviews: list[dict], marker: str) -> dict | None:
    for review in reviews:
        body = review.get("body")
        if isinstance(body, str) and marker in body:
            return review
    return None


def print_review(review: dict) -> None:
    url = review.get("html_url") or review.get("url") or ""
    print(f"REVIEW_URL={url}")
    comments = review.get("comments")
    if isinstance(comments, list):
        for comment in comments:
            if isinstance(comment, dict):
                print(f"COMMENT_URL={comment.get('html_url') or comment.get('url') or ''}")


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
    print(f"Stamped {digest}. GitHub was not called.")


def approve(payload_path: Path, approval_path: Path) -> None:
    raw, payload = load_payload(payload_path)
    refuse_scan(raw, payload)
    problems = validate(payload)
    if problems:
        print("Payload is incomplete: " + ", ".join(problems), file=sys.stderr)
        raise SystemExit(2)
    record = {
        "decision": "approve",
        "payload_sha256": hashlib.sha256(raw).hexdigest(),
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
    if digest != approval.get("payload_sha256") or identity_of(payload) != approval.get("identity"):
        print("The payload changed after approval. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)
    if payload.get("head") != approval.get("head"):
        print("The approved head does not match the payload. GitHub was not called.", file=sys.stderr)
        raise SystemExit(6)
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
        print("REVIEW_ALREADY_POSTED=1")
        print_review(existing)
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
    code, stdout, stderr = gh_api("POST", f"repos/{owner}/{repo}/pulls/{pull}/reviews", body)
    if code != 0:
        recovered = matching_review(reviews_of(owner, repo, pull), marker)
        if recovered is not None:
            print("REVIEW_ALREADY_POSTED=1")
            print_review(recovered)
            return
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    created = json.loads(stdout.decode() or "{}")
    if not isinstance(created, dict):
        print("GitHub did not return a review.", file=sys.stderr)
        raise SystemExit(1)
    print_review(created)


def main() -> None:
    parser = argparse.ArgumentParser(description="Show or post an approved COMMENT review.")
    parser.add_argument("command", choices=("show", "stamp", "approve", "deny", "post"))
    parser.add_argument("payload", nargs="?", type=Path)
    parser.add_argument("approval", nargs="?", type=Path)
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
        if args.payload is None or args.approval is None:
            parser.error("approve requires a payload file and an approval file")
        approve(args.payload, args.approval)
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
