#!/usr/bin/env python3
"""Show, approve, or post a pull-request review.

show prints the payload and does not call GitHub.
approve records a local approval of those exact bytes and that head.
deny records a local refusal. post with a denial, or with no approval,
does not call GitHub.
post re-reads the approval after it takes the publication lock, and again
after each read-only lookup. That read must be the same pull request,
head, identity, preview digest, and approval generation. A denial or a
different approval is not sent, even when the replacement is valid by
itself. After the reviews lookup, and immediately before it sends, post
reads the pull request again and then re-reads that pinned operation.
It mints a GitHub App installation token and reads the approval once
more. The review author is that app's bot. A client secret, a user
token, and the ambient gh login are not used. A
moved base or head is not sent; refresh the review and approve it again.
A push after that read can still land on the approved commit. A request
that was already sent is not cancelled. A send that does not confirm
delivery is not repeated. A confirmed review id is delivery. A later post
returns that review, or stops when it is not visible, and does not send
another. render checks a structured result and writes the COMMENT payload.
approve and post take that payload file, the same file show froze.
bind records the pull request's base and head. An incomplete result is
not published. post keeps the returned ids.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MARKER = re.compile(r"<!-- cursor-review:([0-9a-f]{64}) -->")
# Values, not the public names of settings. A sentence that names
# CURSOR_API_KEY or copilot.totalNanoAiu is a review comment, not a secret.
SECRET = re.compile(
    r"crsr_[A-Za-z0-9]|gh[pousr]_[A-Za-z0-9]|github_pat_[A-Za-z0-9]|x-access-token|"
    r"AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|"
    r"sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]+",
    re.IGNORECASE,
)
# Home-relative paths and any absolute path, including a Markdown label, an
# angle-bracket file URL, and a path written directly after a colon.
# A public URL is not one: the slash in https:// is followed by another
# slash, and later path segments follow a slash or a host character.
ABSOLUTE = re.compile(
    r"(?:^|[\s\"'`=(\[:<])~(?:/|[A-Za-z0-9_.-]+/)|"
    r"(?:^|[\s\"'`=(\[:<])/(?!/)[^\s\"'`<>|)\]}]+|"
    r"(?:^|[\s\"'`=(\[<])[A-Za-z]:[\\/]|"
    r"(?:^|[\s\"'`=(\[<])file://"
)
PROVEN_REJECTION = re.compile(r"\bHTTP\s+4\d\d\b|validation failed", re.IGNORECASE)
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
        "runtime": payload.get("runtime"),
        "event": "COMMENT",
        "body": stripped,
        "comments": payload.get("comments", []),
        "result": payload.get("result"),
    }
    encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


RESULT_KEYS = {
    "owner", "repo", "pull", "base", "head", "runtime", "outcome",
    "checks", "limitations", "diff", "prior", "findings", "mutations",
}
FINDING_KEYS = {
    "id", "severity", "rule", "title", "explanation", "trigger",
    "consequence", "evidence", "verification", "path", "line", "side",
}
OUTCOMES = {"findings", "clean", "incomplete"}
CHECK_STATUS = {"passed", "failed", "skipped", "unavailable"}
PRIOR_STATUS = {"still_present", "fixed", "regressed", "unverified"}
EVIDENCE = {"reproduced", "source", "unverified"}
SEVERITY_LABEL = {"high": "High", "medium": "Medium", "low": "Low"}
TOKEN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
RULES_PATH = Path(__file__).resolve().parent.parent / ".greptile" / "config.json"


def relative_path(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and not value.startswith("/")
        and "\\" not in value
        and all(part not in ("", ".", "..") for part in value.split("/"))
    )


def rule_severity() -> dict[str, str] | None:
    try:
        data = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    rules = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(rules, list):
        return None
    found: dict[str, str] = {"nit": "low", "important": "medium", "blocker": "high"}
    for rule in rules:
        if not isinstance(rule, dict):
            return None
        identifier = rule.get("id")
        severity = rule.get("severity")
        if not isinstance(identifier, str) or severity not in SEVERITY_LABEL:
            return None
        found[identifier] = severity
    return found


def text_field(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_result(result: dict) -> list[str]:
    problems: list[str] = []
    extra = sorted(set(result) - RESULT_KEYS)
    if extra:
        problems.append("result.keys")
    if not isinstance(result.get("owner"), str) or not NAME.fullmatch(result.get("owner", "")):
        problems.append("owner")
    if not isinstance(result.get("repo"), str) or not NAME.fullmatch(result.get("repo", "")):
        problems.append("repo")
    pull = result.get("pull")
    if not isinstance(pull, int) or isinstance(pull, bool) or pull < 1:
        problems.append("pull")
    for field in ("base", "head"):
        value = result.get(field)
        if not isinstance(value, str) or not SHA.fullmatch(value):
            problems.append(field)
    if result.get("runtime") != "linux":
        problems.append("runtime")
    outcome = result.get("outcome")
    if outcome not in OUTCOMES:
        problems.append("outcome")
    rules = rule_severity()
    if rules is None:
        problems.append("rules")
        rules = {}
    checks = result.get("checks")
    diff_status = None
    adversarial_status = None
    if not isinstance(checks, list) or not checks:
        problems.append("checks")
        checks = []
    else:
        seen: set[str] = set()
        for index, check in enumerate(checks):
            if not isinstance(check, dict) or set(check) != {"name", "status", "detail"}:
                problems.append(f"checks[{index}]")
                continue
            name = check.get("name")
            if not isinstance(name, str) or not TOKEN.fullmatch(name) or name in seen:
                problems.append(f"checks[{index}].name")
            else:
                seen.add(name)
            if check.get("status") not in CHECK_STATUS:
                problems.append(f"checks[{index}].status")
            if not text_field(check.get("detail")):
                problems.append(f"checks[{index}].detail")
            if name == "diff":
                diff_status = check.get("status")
            if name == "adversarial":
                adversarial_status = check.get("status")
    if diff_status is None:
        problems.append("checks.diff")
    # Passing tests is supporting evidence, not an independent review. Keep
    # the reviewer's branch/state analysis explicit in publishable results.
    if outcome in {"clean", "findings"} and adversarial_status not in {"passed", "skipped"}:
        problems.append("checks.adversarial")
    limitations = result.get("limitations")
    if not isinstance(limitations, list):
        problems.append("limitations")
    elif any(not text_field(item) for item in limitations):
        problems.append("limitations")
    anchors: set[tuple] = set()
    diff = result.get("diff")
    if not isinstance(diff, list):
        problems.append("diff")
        diff = []
    else:
        for index, anchor in enumerate(diff):
            if not isinstance(anchor, dict) or set(anchor) != {"path", "line", "side"}:
                problems.append(f"diff[{index}]")
                continue
            if not relative_path(anchor.get("path")):
                problems.append(f"diff[{index}].path")
            line = anchor.get("line")
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                problems.append(f"diff[{index}].line")
            if anchor.get("side") not in ("LEFT", "RIGHT"):
                problems.append(f"diff[{index}].side")
            key = (anchor.get("path"), anchor.get("line"), anchor.get("side"))
            if key in anchors:
                problems.append(f"diff[{index}]")
            anchors.add(key)
    findings = result.get("findings")
    finding_ids: set[str] = set()
    signatures: set[tuple] = set()
    if not isinstance(findings, list):
        problems.append("findings")
        findings = []
    else:
        low = 0
        for index, finding in enumerate(findings):
            if not isinstance(finding, dict) or not set(finding) <= FINDING_KEYS:
                problems.append(f"findings[{index}]")
                continue
            identifier = finding.get("id")
            if not isinstance(identifier, str) or not TOKEN.fullmatch(identifier) or identifier in finding_ids:
                problems.append(f"findings[{index}].id")
            else:
                finding_ids.add(identifier)
            severity = finding.get("severity")
            rule = finding.get("rule")
            if not isinstance(rule, str) or rule not in rules:
                problems.append(f"findings[{index}].rule")
            elif severity != rules.get(rule):
                problems.append(f"findings[{index}].severity")
            if severity == "low":
                low += 1
            for field in ("title", "explanation", "trigger", "consequence"):
                if not text_field(finding.get(field)):
                    problems.append(f"findings[{index}].{field}")
            if finding.get("evidence") not in EVIDENCE:
                problems.append(f"findings[{index}].evidence")
            if "verification" in finding and not text_field(finding.get("verification")):
                problems.append(f"findings[{index}].verification")
            located = "path" in finding or "line" in finding or "side" in finding
            if located and ("path" not in finding or "line" not in finding or "side" not in finding):
                problems.append(f"findings[{index}].path")
            elif located:
                if not relative_path(finding.get("path")):
                    problems.append(f"findings[{index}].path")
                line = finding.get("line")
                if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                    problems.append(f"findings[{index}].line")
                if finding.get("side") not in ("LEFT", "RIGHT"):
                    problems.append(f"findings[{index}].side")
                signature = ("anchored", rule, finding.get("path"), finding.get("line"), finding.get("side"))
            else:
                signature = ("summary", rule, finding.get("title"))
            if signature in signatures:
                problems.append(f"findings[{index}]")
            signatures.add(signature)
        if low > 5:
            problems.append("nits")
    prior = result.get("prior")
    if not isinstance(prior, list):
        problems.append("prior")
        prior = []
    else:
        seen_prior: set[str] = set()
        for index, item in enumerate(prior):
            if not isinstance(item, dict) or set(item) != {"id", "status", "source", "note"}:
                problems.append(f"prior[{index}]")
                continue
            identifier = item.get("id")
            status = item.get("status")
            if not isinstance(identifier, str) or not TOKEN.fullmatch(identifier) or identifier in seen_prior:
                problems.append(f"prior[{index}].id")
            else:
                seen_prior.add(identifier)
            if status not in PRIOR_STATUS:
                problems.append(f"prior[{index}].status")
            if not text_field(item.get("source")) or not text_field(item.get("note")):
                problems.append(f"prior[{index}]")
            present = isinstance(identifier, str) and identifier in finding_ids
            if status in {"still_present", "regressed"} and not present:
                problems.append(f"prior[{index}].status")
            if status in {"fixed", "unverified"} and present:
                problems.append(f"prior[{index}].status")
    mutations = result.get("mutations")
    if not isinstance(mutations, list):
        problems.append("mutations")
    else:
        for index, item in enumerate(mutations):
            if not isinstance(item, dict) or set(item) != {"action", "thread", "body", "evidence"}:
                problems.append(f"mutations[{index}]")
                continue
            if item.get("action") not in {"reply", "resolve"}:
                problems.append(f"mutations[{index}].action")
            if not text_field(item.get("thread")) or not text_field(item.get("body")) or not text_field(item.get("evidence")):
                problems.append(f"mutations[{index}]")
    if outcome == "clean" and (
        findings
        or any(item.get("status") != "fixed" for item in prior if isinstance(item, dict))
        or any(check.get("status") in {"failed", "unavailable"} for check in checks if isinstance(check, dict))
        or diff_status != "passed"
    ):
        problems.append("outcome")
    if outcome == "findings" and (
        not findings
        or any(check.get("status") == "unavailable" for check in checks if isinstance(check, dict))
        or diff_status != "passed"
    ):
        problems.append("outcome")
    if outcome == "incomplete" and diff_status is None:
        problems.append("outcome")
    return problems


def finding_text(finding: dict, *, located: bool) -> str:
    lines = [
        f"{SEVERITY_LABEL[finding['severity']]}: {finding['title'].strip()}",
        "",
        finding["explanation"].strip(),
        "",
        f"Trigger: {finding['trigger'].strip()}",
        f"Impact: {finding['consequence'].strip()}",
        f"Evidence: {finding['evidence']}",
    ]
    verification = finding.get("verification")
    if isinstance(verification, str) and verification.strip():
        lines.extend(["", f"Verify: {verification.strip()}"])
    lines.extend(["", f"Rule: {finding['rule']}"])
    if not located and finding.get("path"):
        lines.extend(["", f"Location: {finding['path']}:{finding['line']} {finding['side']}"])
    return "\n".join(lines)


def public_review(result: dict) -> tuple[str, list[dict]]:
    anchors = {(item["path"], item["line"], item["side"]) for item in result["diff"]}
    comments: list[dict] = []
    outside: list[dict] = []
    for finding in result["findings"]:
        key = (finding.get("path"), finding.get("line"), finding.get("side"))
        if finding.get("path") and key in anchors:
            comments.append({
                "path": finding["path"],
                "line": finding["line"],
                "side": finding["side"],
                "body": finding_text(finding, located=True),
            })
        else:
            outside.append(finding)
    count = len(result["findings"])
    if result["outcome"] == "clean":
        opening = "No actionable findings."
    elif result["outcome"] == "findings":
        opening = "1 actionable finding." if count == 1 else f"{count} actionable findings."
    else:
        opening = "The review is incomplete."
    lines = [opening, "", "Checks:"]
    for check in result["checks"]:
        lines.append(f"- {check['name']}: {check['status']}. {check['detail'].strip()}")
    if result["limitations"]:
        lines.extend(["", "Limitations:"])
        lines.extend(f"- {item.strip()}" for item in result["limitations"])
    if outside:
        lines.extend(["", "Findings outside the current diff:"])
        for finding in outside:
            lines.extend(["", finding_text(finding, located=False)])
    if result["prior"]:
        lines.extend(["", "Earlier findings:"])
        for item in result["prior"]:
            lines.append(f"- {item['id']} ({item['source'].strip()}): {item['status']}. {item['note'].strip()}")
    if result["mutations"]:
        lines.extend(["", "Proposed GitHub actions, not performed:"])
        for item in result["mutations"]:
            lines.append(f"- {item['action']} {item['thread'].strip()}: {item['body'].strip()}")
    lines.extend([
        "",
        f"Runtime: {result['runtime']}.",
        f"Reviewed {result['owner']}/{result['repo']}#{result['pull']} at {result['head']}.",
    ])
    return "\n".join(lines) + "\n", comments


def publication_matches(payload: dict) -> list[str]:
    if "result" not in payload:
        return []
    result = payload.get("result")
    if not isinstance(result, dict):
        return ["result"]
    problems = validate_result(result)
    if problems:
        return problems
    if result.get("outcome") == "incomplete":
        return ["incomplete"]
    for field in ("owner", "repo", "pull", "base", "head", "runtime"):
        if payload.get(field) != result.get(field):
            problems.append(field)
    body, comments = public_review(result)
    current = payload.get("body")
    if not isinstance(current, str) or MARKER.sub("", current).strip() != body.strip():
        problems.append("body")
    if payload.get("comments") != comments:
        problems.append("comments")
    return problems


def interpret_pull(current: object, pull: int) -> tuple[object, object, bool]:
    if not isinstance(current, dict):
        return None, None, False
    number = current.get("number")
    if isinstance(number, bool) or not isinstance(number, int) or number != pull:
        return None, None, False
    head_obj = current.get("head")
    base_obj = current.get("base")
    head = head_obj.get("sha") if isinstance(head_obj, dict) else None
    base = base_obj.get("sha") if isinstance(base_obj, dict) else None
    if not isinstance(head, str) or not SHA.fullmatch(head):
        return None, None, False
    if not isinstance(base, str) or not SHA.fullmatch(base):
        return None, None, False
    return head, base, True


def target_url(url: object, owner: str, repo: str, pull: int) -> bool:
    if not isinstance(url, str) or not url:
        return False
    web = f"https://github.com/{owner}/{repo}/pull/{pull}"
    api = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pull}/"
    return url.startswith(web + "#") or url.startswith(web + "/") or url.startswith(api)


def review_matches(review: dict, owner: str, repo: str, pull: int) -> bool:
    review_id = review.get("id")
    if not isinstance(review_id, int) or isinstance(review_id, bool) or review_id <= 0:
        return False
    # A same-PR discussion comment is not a submitted COMMENT review.
    return (
        review.get("html_url") == f"https://github.com/{owner}/{repo}/pull/{pull}#pullrequestreview-{review_id}"
        or review.get("url") == f"https://api.github.com/repos/{owner}/{repo}/pulls/{pull}/reviews/{review_id}"
    )


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
    if payload.get("runtime") != "linux":
        problems.append("runtime")
    if payload.get("event") != "COMMENT":
        problems.append("event")
    problems.extend(publication_matches(payload))
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
            if not relative_path(comment.get("path")):
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


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def redact_secret(text: str) -> str:
    text = re.sub(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_.-]+", "[redacted]", text)
    text = re.sub(r"\bgithub_pat_[A-Za-z0-9_]+", "[redacted]", text)
    return re.sub(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "[redacted]", text)


def refuse_publication(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(4)


def normalize_pem(value: str) -> bytes:
    text = value.strip().lstrip("\ufeff")
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    text = text.replace("\r\n", "\n")
    if "\\n" in text:
        text = text.replace("\\n", "\n")
    if not text.endswith("\n"):
        text += "\n"
    return text.encode()


def read_private_key() -> bytes:
    file_name = os.environ.get("REVIEW_APP_PRIVATE_KEY_FILE", "").strip()
    inline = os.environ.get("REVIEW_APP_PRIVATE_KEY", "")
    if file_name and inline.strip():
        refuse_publication(
            "Set only one of REVIEW_APP_PRIVATE_KEY and REVIEW_APP_PRIVATE_KEY_FILE. GitHub was not called."
        )
    if file_name:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(file_name, flags)
        except OSError:
            refuse_publication("The GitHub App private key file is unreadable. GitHub was not called.")
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                refuse_publication(
                    "The GitHub App private key file must be a regular file readable only by its owner. GitHub was not called."
                )
            pem = os.read(descriptor, 64 * 1024)
            if os.read(descriptor, 1):
                refuse_publication("The GitHub App private key file is not a usable key. GitHub was not called.")
        finally:
            os.close(descriptor)
        return pem
    if inline.strip():
        return normalize_pem(inline)
    if os.environ.get("REVIEW_APP_CLIENT_SECRET", "").strip():
        refuse_publication(
            "A GitHub App client secret cannot post a review. "
            "Set REVIEW_APP_PRIVATE_KEY to the app private key. GitHub was not called."
        )
    refuse_publication(
        "Review publication needs the GitHub App private key in REVIEW_APP_PRIVATE_KEY. "
        "The agent login was not used. GitHub was not called."
    )


def sign_app_jwt(app_id: str, pem: bytes) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(
        json.dumps({"iat": now - 60, "exp": now + 540, "iss": app_id}, separators=(",", ":")).encode()
    )
    signing = f"{header}.{payload}".encode()
    completed: subprocess.CompletedProcess[bytes] | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="review-app-") as directory:
            key_path = Path(directory) / "key.pem"
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(descriptor, pem if pem.endswith(b"\n") else pem + b"\n")
            finally:
                os.close(descriptor)
            completed = subprocess.run(
                ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
                input=signing,
                capture_output=True,
            )
    except FileNotFoundError:
        refuse_publication("openssl is required to sign the GitHub App request. GitHub was not called.")
    if completed is None or completed.returncode != 0 or not completed.stdout:
        refuse_publication("The GitHub App private key could not sign the request. GitHub was not called.")
    return signing.decode() + "." + b64url(completed.stdout)


def load_app_material() -> tuple[str, bytes]:
    app_id = os.environ.get("REVIEW_APP_ID", "").strip()
    if not re.fullmatch(r"[0-9]+", app_id):
        refuse_publication(
            "Review publication needs REVIEW_APP_ID for the GitHub App. "
            "A user token was not used. GitHub was not called."
        )
    installation = os.environ.get("REVIEW_APP_INSTALLATION_ID", "").strip()
    if installation and not re.fullmatch(r"[0-9]+", installation):
        refuse_publication("REVIEW_APP_INSTALLATION_ID is invalid. GitHub was not called.")
    if shutil.which("openssl") is None:
        refuse_publication("openssl is required to sign the GitHub App request. GitHub was not called.")
    pem = read_private_key()
    if pem.lstrip().startswith((b"ghp_", b"github_pat_", b"gho_", b"ghu_", b"ghr_", b"ghs_")):
        refuse_publication("A user or installation token cannot be the app key. GitHub was not called.")
    if b"PRIVATE KEY" not in pem:
        refuse_publication("REVIEW_APP_PRIVATE_KEY is not a GitHub App private key. GitHub was not called.")
    sign_app_jwt(app_id, pem)
    return app_id, pem


def publisher_env(token: str | None) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("REVIEW_APP_")}
    env.pop("GH_DEBUG", None)
    env["GH_HOST"] = "github.com"
    env["GH_PROMPT_DISABLED"] = "1"
    if token is not None:
        env["GH_TOKEN"] = token
        env["GITHUB_TOKEN"] = token
    return env


def app_api(method: str, endpoint: str, jwt: str, payload: dict | None = None) -> tuple[int, bytes, bytes]:
    # GitHub App JWTs require Bearer, not gh's default token scheme. Keep the
    # header in memory and never forward it through a redirect or an argv value.
    connection = http.client.HTTPSConnection("api.github.com", timeout=30)
    try:
        connection.request(method, "/" + endpoint, body=json.dumps(payload) if payload is not None else None, headers={
            "Authorization": "Bearer " + jwt,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "cursor-provider-review-publisher",
            "X-GitHub-Api-Version": "2026-03-10",
        })
        response = connection.getresponse()
        if response.status not in (200, 201):
            return 1, b"", f"GitHub App request failed (HTTP {response.status}).".encode()
        return 0, response.read(), b""
    except (OSError, http.client.HTTPException):
        return 1, b"", b"GitHub App request failed before authorization was confirmed."
    finally:
        connection.close()


def auth_info() -> None:
    source = next((name for name in ("GH_TOKEN", "GITHUB_TOKEN") if os.environ.get(name)), "gh stored credential/helper")
    json.dump({
        "host": "github.com", "read_source": source,
        "publication_source": "GitHub App installation",
        "environment": {name: bool(os.environ.get(name)) for name in (
            "REVIEW_APP_ID", "REVIEW_APP_INSTALLATION_ID", "REVIEW_APP_PRIVATE_KEY",
            "REVIEW_APP_PRIVATE_KEY_FILE", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST",
        )},
        "required_permissions": {"pull_requests": "write"},
        "permission_verification": "not checked",
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


def gh_api(
    method: str,
    endpoint: str,
    payload: dict | None = None,
    paginate: bool = False,
    token: str | None = None,
) -> tuple[int, bytes, bytes]:
    command = ["gh", "api", "--hostname", "github.com", "--method", method]
    if paginate:
        command.extend(["--paginate", "--slurp"])
    command.append(endpoint)
    data = None
    if payload is not None:
        command.extend(["--input", "-"])
        data = json.dumps(payload).encode()
    completed = subprocess.run(command, input=data, capture_output=True, env=publisher_env(token))
    detail = completed.stderr.decode("utf-8", errors="replace")
    for value in (token, os.environ.get("GH_TOKEN"), os.environ.get("GITHUB_TOKEN")):
        if value:
            detail = detail.replace(value, "[redacted]")
    return completed.returncode, completed.stdout, redact_secret(detail).encode()


def json_object(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw.decode() or "{}")
    except (UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def installation_token(owner: str, repo: str, app_id: str, pem: bytes) -> str:
    jwt = sign_app_jwt(app_id, pem)
    installation = os.environ.get("REVIEW_APP_INSTALLATION_ID", "").strip()
    if not installation:
        code, stdout, stderr = app_api("GET", f"repos/{owner}/{repo}/installation", jwt)
        found = json_object(stdout)
        located = found.get("id") if found else None
        if code != 0 or not isinstance(located, int) or isinstance(located, bool) or located < 1:
            print(
                "The GitHub App installation for this repository was not found. The review was not posted.",
                file=sys.stderr,
            )
            detail = redact_secret(stderr.decode("utf-8", errors="replace")).strip()
            if detail:
                print(detail, file=sys.stderr)
            raise SystemExit(4)
        installation = str(located)
    code, stdout, stderr = app_api("POST", f"app/installations/{installation}/access_tokens", jwt, {
        "repositories": [repo], "permissions": {"pull_requests": "write"},
    })
    if code != 0:
        print("The GitHub App did not authorize the review. The review was not posted.", file=sys.stderr)
        detail = redact_secret(stderr.decode("utf-8", errors="replace")).strip()
        if detail:
            print(detail, file=sys.stderr)
        raise SystemExit(4)
    issued = json_object(stdout)
    token = issued.get("token") if issued else None
    if not isinstance(token, str) or re.fullmatch(r"ghs_[A-Za-z0-9_.-]+", token) is None:
        print("GitHub did not return an app installation token. The review was not posted.", file=sys.stderr)
        raise SystemExit(4)
    permissions = issued.get("permissions") if issued else None
    if not isinstance(permissions, dict) or permissions.get("pull_requests") != "write":
        refuse_publication("The installation token must grant Pull requests: write. The review was not posted.")
    return token


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


def review_with_id(reviews: list[dict], review_id: object) -> dict | None:
    if not isinstance(review_id, int) or isinstance(review_id, bool):
        return None
    for review in reviews:
        if review.get("id") == review_id:
            return review
    return None


def record_visible_review(
    owner: str,
    repo: str,
    pull: int,
    review: dict,
    digest: str,
    checkpoint_path: Path,
    head: str,
    already: bool,
) -> None:
    if not review_matches(review, owner, repo, pull):
        print(
            "The review on GitHub does not match the approved pull request. GitHub was not called again.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    review_id = review.get("id")
    visible: list[dict] = []
    if isinstance(review_id, int) and not isinstance(review_id, bool):
        for comment in comments_of(owner, repo, pull):
            if comment.get("pull_request_review_id") != review_id:
                continue
            url = comment.get("html_url") or comment.get("url") or ""
            if target_url(url, owner, repo, pull):
                visible.append(comment)
    comment_ids = [
        comment.get("id")
        for comment in visible
        if isinstance(comment.get("id"), int) and not isinstance(comment.get("id"), bool)
    ]
    write_checkpoint(
        checkpoint_path,
        {
            "state": "posted",
            "payload_sha256": digest,
            "review_id": review_id,
            "review_url": review.get("html_url") or review.get("url") or "",
            "comment_ids": comment_ids,
            "comment_urls": [comment.get("html_url") or comment.get("url") or "" for comment in visible],
            "owner": owner,
            "repo": repo,
            "pull": pull,
            "head": head,
        },
    )
    if already:
        print("REVIEW_ALREADY_POSTED=1")
    print(f"REVIEW_URL={review.get('html_url') or review.get('url') or ''}")
    for comment in visible:
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
    _raw, payload = load_payload(path)
    match_problems = publication_matches(payload)
    if "incomplete" in match_problems:
        print("The review is incomplete. GitHub was not called.", file=sys.stderr)
        raise SystemExit(2)
    if match_problems:
        print("Review result is incomplete: " + ", ".join(match_problems), file=sys.stderr)
        raise SystemExit(2)
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
    write_record(
        approval_path,
        {
            "decision": "approve",
            "payload_sha256": digest,
            "preview_sha256": preview_sha,
            "identity": identity_of(payload),
            "head": payload["head"],
            "base": payload["base"],
            "runtime": payload.get("runtime"),
            "owner": payload["owner"],
            "repo": payload["repo"],
            "pull": payload["pull"],
        },
    )
    print(f"Approved {digest} at {payload['head']}. GitHub was not called.")


def deny(approval_path: Path) -> None:
    write_record(approval_path, {"decision": "deny"})
    print("Denied. GitHub was not called.")


def publication_paths(approval_path: Path, owner: str, repo: str, pull: int, identity: str) -> tuple[Path, Path]:
    directory = approval_path.parent / ".review-publish"
    directory.mkdir(mode=0o700, exist_ok=True)
    key = hashlib.sha256(f"{owner}/{repo}#{pull}:{identity}".encode()).hexdigest()
    return directory / f"{key}.lock", directory / f"{key}.json"


def read_json_object(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def write_record(path: Path, record: dict) -> None:
    previous = read_json_object(path) if path.is_file() else None
    generation = 0
    if previous is not None and isinstance(previous.get("generation"), int) and not isinstance(previous.get("generation"), bool):
        if previous["generation"] >= 0:
            generation = previous["generation"]
    record = {**record, "generation": generation + 1}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def write_checkpoint(path: Path, record: dict) -> None:
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def checkpoint_state(path: Path) -> str | None:
    if not path.is_file():
        return None
    value = read_json_object(path)
    if value is None:
        return "posting"
    state = value.get("state")
    if state in ("posting", "posted", "rejected"):
        return state
    return "posting"


def authorized_post(payload_path: Path, approval_path: Path) -> tuple[bytes, dict, dict, str]:
    if not approval_path.is_file():
        print("No approval file. GitHub was not called.", file=sys.stderr)
        raise SystemExit(4)
    approval = read_json_object(approval_path)
    if approval is None or approval.get("decision") != "approve":
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
    if payload.get("base") != approval.get("base") or payload.get("runtime") != approval.get("runtime"):
        print("The payload differs from the approved target. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)
    return raw, payload, approval, digest


def operation_key(payload: dict, approval: dict, digest: str) -> tuple:
    return (
        payload.get("owner"),
        payload.get("repo"),
        payload.get("pull"),
        payload.get("base"),
        payload.get("head"),
        payload.get("runtime"),
        approval.get("identity"),
        digest,
        approval.get("generation"),
    )


def require_same_operation(payload_path: Path, approval_path: Path, pinned: tuple) -> None:
    _raw, payload, approval, digest = authorized_post(payload_path, approval_path)
    if operation_key(payload, approval, digest) != pinned:
        print("The approval record was replaced. GitHub was not called.", file=sys.stderr)
        raise SystemExit(5)


def read_pull(owner: str, repo: str, pull: int) -> tuple[object, object, bool]:
    code, stdout, stderr = gh_api("GET", f"repos/{owner}/{repo}/pulls/{pull}")
    if code != 0:
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    try:
        current = json.loads(stdout.decode() or "{}")
    except json.JSONDecodeError:
        return None, None, False
    return interpret_pull(current, pull)


def reject_moved_revision(
    fetched_head: object,
    fetched_base: object,
    readable: bool,
    approved_head: str,
    approved_base: str,
) -> None:
    if not readable or fetched_head != approved_head or fetched_base != approved_base:
        print(
            "The pull request revision changed. Refresh the review and approve it again. GitHub was not called.",
            file=sys.stderr,
        )
        raise SystemExit(6)


def review_body(payload: dict) -> dict:
    return {
        "commit_id": payload["head"],
        "body": payload["body"],
        "event": "COMMENT",
        "comments": [
            {"path": item["path"], "line": item["line"], "side": item["side"], "body": item["body"]}
            for item in payload["comments"]
        ],
    }


def post(payload_path: Path, approval_path: Path) -> None:
    if not approval_path.is_file():
        print("No approval file. GitHub was not called.", file=sys.stderr)
        raise SystemExit(4)
    # The peek only chooses the lock. It is not authorization.
    peek = read_json_object(approval_path)
    if peek is None or peek.get("decision") != "approve":
        print("Approval was not granted. GitHub was not called.", file=sys.stderr)
        raise SystemExit(4)
    try:
        owner, repo, pull = peek["owner"], peek["repo"], int(peek["pull"])
        identity = str(peek["identity"])
    except (KeyError, TypeError, ValueError):
        print("Approval was not granted. GitHub was not called.", file=sys.stderr)
        raise SystemExit(4)
    lock_path, checkpoint_path = publication_paths(approval_path, owner, repo, pull, identity)
    lock = lock_path.open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _raw, payload, approval, digest = authorized_post(payload_path, approval_path)
        if (
            payload.get("owner") != owner
            or payload.get("repo") != repo
            or payload.get("pull") != pull
            or str(approval.get("identity")) != identity
        ):
            print("The approval record was replaced. GitHub was not called.", file=sys.stderr)
            raise SystemExit(5)
        pinned = operation_key(payload, approval, digest)
        post_locked(payload_path, approval_path, payload, approval, digest, pinned, checkpoint_path)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def post_locked(
    payload_path: Path,
    approval_path: Path,
    payload: dict,
    approval: dict,
    digest: str,
    pinned: tuple,
    checkpoint_path: Path,
) -> None:
    owner, repo, pull = payload["owner"], payload["repo"], payload["pull"]
    app_id, pem = load_app_material()
    approved_head = payload["head"]
    approved_base = payload["base"]
    marker = f"<!-- cursor-review:{approval['identity']} -->"
    fetched_head, fetched_base, readable = read_pull(owner, repo, pull)
    require_same_operation(payload_path, approval_path, pinned)
    reject_moved_revision(fetched_head, fetched_base, readable, approved_head, approved_base)
    reviews = reviews_of(owner, repo, pull)
    require_same_operation(payload_path, approval_path, pinned)
    existing = matching_review(reviews, marker)
    if existing is not None:
        record_visible_review(owner, repo, pull, existing, digest, checkpoint_path, approved_head, True)
        return
    journal = read_json_object(checkpoint_path)
    if isinstance(journal, dict) and journal.get("state") == "posted":
        prior = review_with_id(reviews, journal.get("review_id"))
        if prior is not None:
            record_visible_review(owner, repo, pull, prior, digest, checkpoint_path, approved_head, True)
            return
        label = journal.get("review_id")
        shown = label if isinstance(label, int) and not isinstance(label, bool) else "unknown"
        print(f"Confirmed review {shown} is not visible. GitHub was not called again.", file=sys.stderr)
        raise SystemExit(1)
    if checkpoint_state(checkpoint_path) == "posting":
        print("The previous post did not confirm delivery. GitHub was not called again.", file=sys.stderr)
        raise SystemExit(1)
    write_checkpoint(
        checkpoint_path,
        {"state": "posting", "payload_sha256": digest, "head": approved_head, "base": approved_base},
    )
    try:
        # The reviews lookup is the last preparatory read. Fetch the remote
        # revision, mint the installation token, and re-read the pinned
        # approval. A push after this fetch is not covered. A changed
        # revision or approval is not sent.
        fetched_head, fetched_base, readable = read_pull(owner, repo, pull)
        reject_moved_revision(fetched_head, fetched_base, readable, approved_head, approved_base)
        require_same_operation(payload_path, approval_path, pinned)
        token = installation_token(str(owner), str(repo), app_id, pem)
        require_same_operation(payload_path, approval_path, pinned)
    except SystemExit:
        # The request was not sent. Drop the checkpoint so it is not an unsettled delivery.
        checkpoint_path.unlink(missing_ok=True)
        raise
    code, stdout, stderr = gh_api(
        "POST",
        f"repos/{owner}/{repo}/pulls/{pull}/reviews",
        review_body(payload),
        token=token,
    )
    if code != 0:
        if re.search(rb"\bHTTP\s+403\b", stderr, re.IGNORECASE):
            print(
                "GitHub denied the App review request (HTTP 403). Check this installation's "
                "Pull requests: write grant and repository access. No discussion comment was sent.",
                file=sys.stderr,
            )
        recovered = matching_review(reviews_of(owner, repo, pull), marker)
        if recovered is not None:
            record_visible_review(owner, repo, pull, recovered, digest, checkpoint_path, approved_head, True)
            return
        detail = stderr.decode("utf-8", errors="replace")
        if PROVEN_REJECTION.search(detail):
            write_checkpoint(checkpoint_path, {"state": "rejected", "payload_sha256": digest, "head": payload["head"]})
            print(redact_secret(detail), file=sys.stderr)
            raise SystemExit(1)
        print("Delivery is unknown. GitHub was not called again.", file=sys.stderr)
        print(redact_secret(detail), file=sys.stderr)
        raise SystemExit(1)
    try:
        created = json.loads(stdout.decode() or "{}")
    except json.JSONDecodeError:
        created = None
    if not isinstance(created, dict) or not isinstance(created.get("id"), int) or isinstance(created.get("id"), bool):
        print("Delivery is unknown. GitHub was not called again.", file=sys.stderr)
        raise SystemExit(1)
    record_visible_review(owner, repo, pull, created, digest, checkpoint_path, approved_head, False)


def bind(owner: str, repo: str, pull: int, out: Path | None) -> None:
    if not NAME.fullmatch(owner) or not NAME.fullmatch(repo) or isinstance(pull, bool) or pull < 1:
        print("The pull request target is invalid. GitHub was not called.", file=sys.stderr)
        raise SystemExit(2)
    code, stdout, stderr = gh_api("GET", f"repos/{owner}/{repo}/pulls/{pull}")
    if code != 0:
        print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        raise SystemExit(1)
    try:
        current = json.loads(stdout.decode() or "{}")
    except json.JSONDecodeError:
        current = None
    head, base, readable = interpret_pull(current, pull)
    if not readable:
        print("The pull request revision is unreadable. GitHub was not called.", file=sys.stderr)
        raise SystemExit(2)
    revision = {"owner": owner, "repo": repo, "pull": pull, "base": base, "head": head, "runtime": "linux"}
    if out is None:
        json.dump(revision, sys.stdout, indent=2)
        sys.stdout.write("\n")
        print("Recorded the pull request revision. GitHub was not called.", file=sys.stderr)
        return
    if out.exists():
        recorded = read_json_object(out)
        if recorded is None:
            print("The review file is not a JSON object. GitHub was not called.", file=sys.stderr)
            raise SystemExit(2)
        same = (
            recorded.get("owner") == owner
            and recorded.get("repo") == repo
            and recorded.get("pull") == pull
            and recorded.get("base") == base
            and recorded.get("head") == head
            and recorded.get("runtime") == "linux"
        )
        if not same:
            print(
                "The pull request revision changed. Refresh the review and approve it again. GitHub was not called.",
                file=sys.stderr,
            )
            raise SystemExit(6)
        print("Revision matches the recorded review. GitHub was not called.")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(revision, indent=2) + "\n", encoding="utf-8")
    print("Recorded the pull request revision. GitHub was not called.")


def render(source: Path, dest: Path) -> None:
    raw, result = load_payload(source)
    refuse_scan(raw, result)
    problems = validate_result(result)
    if problems:
        print("Review result is incomplete: " + ", ".join(problems), file=sys.stderr)
        raise SystemExit(2)
    body, comments = public_review(result)
    payload = {
        "owner": result["owner"],
        "repo": result["repo"],
        "pull": result["pull"],
        "base": result["base"],
        "head": result["head"],
        "runtime": result["runtime"],
        "event": "COMMENT",
        "body": body,
        "comments": comments,
        "result": result,
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    refuse_scan(text.encode(), payload)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, dest)
    print(f"REVIEW_OUTCOME={result['outcome']}", file=sys.stderr)
    if result["outcome"] == "incomplete":
        print("The review is incomplete and cannot be published. GitHub was not called.", file=sys.stderr)
    else:
        print("Rendered the review. GitHub was not called.", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Show or post an approved COMMENT review.")
    parser.add_argument("command", choices=("show", "stamp", "approve", "deny", "post", "render", "bind", "auth-info"))
    parser.add_argument("payload", nargs="?", type=Path)
    parser.add_argument("approval", nargs="?", type=Path)
    parser.add_argument("preview", nargs="?")
    parser.add_argument("extra", nargs="?")
    args = parser.parse_args()
    if args.command == "auth-info":
        auth_info()
    elif args.command == "show":
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
    elif args.command == "render":
        if args.payload is None or args.approval is None:
            parser.error("render requires a result file and an output file")
        render(args.payload, args.approval)
    elif args.command == "bind":
        if args.payload is None or args.approval is None or args.preview is None:
            parser.error("bind requires owner, repo, and pull")
        try:
            pull = int(args.preview)
        except ValueError:
            parser.error("bind pull must be an integer")
        bind(str(args.payload), str(args.approval), pull, Path(args.extra) if args.extra else None)
    else:
        if args.payload is None or args.approval is None:
            parser.error("post requires a payload file and an approval file")
        post(args.payload, args.approval)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        raise SystemExit(0) from None
