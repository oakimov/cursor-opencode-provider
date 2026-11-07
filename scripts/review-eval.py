#!/usr/bin/env python3
"""Prepare and score a manual review evaluation.

This does not start a Cloud Agent, call a model, or publish a review.
Detection is whatever a fresh reviewer writes into a result file. Until that
file exists, the score is not a measurement of the review procedure.
"""

from __future__ import annotations

import difflib
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "eval" / "review"
CASES = EVAL / "cases"
PRIVATE = EVAL / "private"
BASELINE = EVAL / "baseline"
MARKER = "REVIEW_EVAL_ANSWER"
LIVE_CLAIM = re.compile(r"production incident|\blive model\b|\bin production\b", re.IGNORECASE)

PROMPT = """Review the change in checkout/. The diff against its base is diff.patch.
Follow instructions/SKILL.md and instructions/pr-review.md.
Read the diff, the files it changes, their callers, and instructions/review-rules.md.
Use instructions/SKILL.md as the review procedure.

Evaluation adapter (applies equally to both instruction snapshots):
- Work only inside this mount, starting at its root. Do not inspect its parent.
  checkout/ is the reviewed tree. All finding and contract paths are relative
  to that tree; the provided policy files outside it are review guidance.
- Production policy references are supplied at their usual paths in this mount.
  The three selected review guides are under instructions/ instead of their
  production paths. Apply rules only where their scope matches the change.
  Read incident lessons only if checkout/ supplies them. Current harness
  incident lessons are withheld to avoid importing later adjudication.
- This is an offline local review, not a GitHub publication run. PR binding,
  bot/CI lookups, isolated-check.sh, live credentials, render/stamp/approval/post,
  and production build commands for a different project are not applicable.
  Record that limitation. Run applicable checkout tests with available tools;
  missing required analysis still makes the review incomplete. Do not fetch
  secrets, contact GitHub, or treat a skipped production gate as a pass.
- Write ledger.json and review.json here. Use revision "local" in the ledger
  and head "local" in the result, including for the archived calibration tree.
  The local result has outcome (clean, findings, or incomplete), findings, and
  limits. Each finding has id, title, explanation, trigger, consequence,
  evidence, path, and line. Ledger candidates and findings share ids.
  Use the ledger schema and enums in scripts/review-ledger.py. Record the
  candidate-validation, omission, and failed-work retry passes even with the
  baseline snapshot. For each relevant stateful operation, record the
  two-invocation retry sequence: the forced failure with its persisted state
  and retry promise, then the ordinary entrypoint's actual retry, served data,
  and exit status. A valid ledger is a completion check, not a detection score.
- Before finishing, run from this mount root:
  python3 scripts/review-ledger.py check ledger.json
  python3 scripts/review-ledger.py compare ledger.json review.json
  These tools are supplied here; do not use tools outside the mount. An
  incomplete ledger/result remains incomplete; report its diagnostic.
Stop. Do not post, approve, or merge.
"""


def case_ids() -> list[str]:
    return sorted(path.name for path in CASES.iterdir() if (path / "base").is_dir())


def variants_of(case: str) -> list[str]:
    overlay = CASES / case / "overlays"
    if not overlay.is_dir():
        return []
    return sorted(path.name for path in overlay.iterdir() if path.is_dir())


def copy_tree(source: Path, dest: Path) -> None:
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        target = dest / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())


def build_checkout(case: str, variant: str, dest: Path) -> None:
    base = CASES / case / "base"
    if not base.is_dir():
        raise SystemExit(f"unknown case: {case}")
    known = variants_of(case)
    if variant not in known:
        raise SystemExit(f"unknown variant: {variant}")
    dest.mkdir(parents=True)
    copy_tree(base, dest)
    copy_tree(CASES / case / "overlays" / variant, dest)


def file_text(path: Path) -> list[str]:
    if not path.is_file():
        return []
    return path.read_text(encoding="utf-8").splitlines(keepends=True)


def write_diff(base: Path, tree: Path, dest: Path) -> None:
    paths = set()
    for root in (base, tree):
        for path in root.rglob("*"):
            if path.is_file():
                paths.add(path.relative_to(root).as_posix())
    chunks: list[str] = []
    for relative in sorted(paths):
        old = file_text(base / relative)
        new = file_text(tree / relative)
        if old == new:
            continue
        chunks.extend(difflib.unified_diff(old, new, fromfile=f"a/{relative}", tofile=f"b/{relative}"))
    dest.write_text("".join(chunks), encoding="utf-8")


def tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def skill_files(kind: str) -> dict[str, Path]:
    if kind == "baseline":
        return {
            "SKILL.md": BASELINE / "SKILL.md",
            "pr-review.md": BASELINE / "pr-review.md",
            "review-rules.md": BASELINE / "review-rules.md",
        }
    if kind == "revised":
        return {
            "SKILL.md": ROOT / ".cursor" / "skills" / "review" / "SKILL.md",
            "pr-review.md": ROOT / "docs" / "pr-review.md",
            "review-rules.md": ROOT / "docs" / "review-rules.md",
        }
    raise SystemExit(f"unknown skill: {kind}")


def write_instructions(kind: str, dest: Path) -> str:
    dest.mkdir(parents=True)
    digest = hashlib.sha256()
    for name, source in skill_files(kind).items():
        data = source.read_bytes()
        (dest / name).write_bytes(data)
        digest.update(name.encode())
        digest.update(data)
    return digest.hexdigest()


def write_support(mount: Path) -> str:
    """Copy shared policy and offline validation tools, never grading material."""
    files = [
        "AGENTS.md", "CONTRIBUTING.md", ".greptile/config.json", ".greptile/files.json",
        "docs/cache-log-runbook.md", "docs/host-compat-acceptance.md",
        "scripts/review-ledger.py",
    ]
    files.extend(path.relative_to(ROOT).as_posix() for path in (ROOT / ".cursor/rules").rglob("*") if path.is_file())
    digest = hashlib.sha256(PROMPT.encode())
    for name in sorted(files):
        data = (ROOT / name).read_bytes()
        target = mount / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        digest.update(name.encode())
        digest.update(data)
    return digest.hexdigest()


def git_text(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def harness_metadata() -> dict:
    # An archived check has no Git metadata. Do not borrow an enclosing
    # repository's revision or invent a clean state; the content hashes remain.
    if not (ROOT / ".git").exists():
        return {"harnessHead": None, "harnessDirty": None}
    return {
        "harnessHead": git_text("rev-parse", "HEAD"),
        "harnessDirty": bool(git_text("status", "--porcelain")),
    }


def write_meta(out: Path, payload: dict) -> None:
    (out / "meta.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def prepare_case(case: str, variant: str, skill: str, out: Path) -> None:
    if out.exists():
        raise SystemExit(f"output already exists: {out}")
    mount = out / "mount"
    checkout = mount / "checkout"
    build_checkout(case, variant, checkout)
    write_diff(CASES / case / "base", checkout, mount / "diff.patch")
    skill_sha = write_instructions(skill, mount / "instructions")
    support_sha = write_support(mount)
    (mount / "PROMPT.txt").write_text(PROMPT, encoding="utf-8")
    out.mkdir(parents=True, exist_ok=True)
    write_meta(out, {
        "case": case,
        "variant": variant,
        "skill": skill,
        **harness_metadata(),
        "skillSha256": skill_sha,
        "supportSha256": support_sha,
        "checkoutSha256": tree_hash(checkout),
        "mount": "mount",
    })


def prepare_calibration(skill: str, out: Path) -> None:
    private = json.loads((PRIVATE / "calibration.json").read_text(encoding="utf-8"))
    prepare_revision(skill, out, ROOT, private["revision"], private["base"])


def prepare_revision(skill: str, out: Path, repository: Path, revision: str, base: str) -> None:
    if out.exists():
        raise SystemExit(f"output already exists: {out}")
    for commit in (revision, base):
        available = subprocess.run(
            ["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=repository,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if available.returncode:
            raise SystemExit(
                f"calibration commit unavailable: {commit}; fetch the pinned head and base "
                "as described in eval/review/README.md, then retry"
            )
    # Read both objects before creating output; a shallow checkout may lack either.
    archive = subprocess.check_output(["git", "archive", revision], cwd=repository)
    diff = subprocess.check_output(["git", "diff", "--binary", base, revision], cwd=repository)
    mount = out / "mount"
    checkout = mount / "checkout"
    checkout.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(checkout, filter="data")
    (mount / "diff.patch").write_bytes(diff)
    skill_sha = write_instructions(skill, mount / "instructions")
    support_sha = write_support(mount)
    (mount / "PROMPT.txt").write_text(PROMPT, encoding="utf-8")
    out.mkdir(parents=True, exist_ok=True)
    write_meta(out, {
        "case": "calibration",
        "variant": "subject",
        "skill": skill,
        "revision": revision,
        "base": base,
        **harness_metadata(),
        "skillSha256": skill_sha,
        "supportSha256": support_sha,
        "checkoutSha256": tree_hash(checkout),
        "mount": "mount",
    })


def verify_mount(mount: Path) -> list[str]:
    problems: list[str] = []
    marker = MARKER.encode()
    for path in sorted(mount.rglob("*")):
        relative = path.relative_to(mount)
        if any(part in {"private", "overlays", "ground-truth", "baseline"} for part in relative.parts):
            problems.append(relative.as_posix())
        if path.is_file() and marker in path.read_bytes():
            problems.append(f"marker:{relative.as_posix()}")
    return problems


def blob(finding: dict) -> str:
    return "\n".join(
        str(finding.get(field, ""))
        for field in ("id", "title", "explanation", "trigger", "consequence", "verification", "path")
    )


def groups_hit(text: str, groups: list) -> bool:
    lowered = text.lower()
    return all(any(str(term).lower() in lowered for term in group) for group in groups)


def location_hit(finding: dict, item: dict, text: str) -> bool:
    paths = item.get("paths") or []
    path = finding.get("path") or ""
    if path not in paths and not any(item_path in text for item_path in paths):
        return False
    symbols = item.get("symbols") or []
    symbol_ok = any(symbol in text for symbol in symbols)
    line = finding.get("line")
    lines = item.get("lines")
    if isinstance(line, int) and isinstance(lines, list) and len(lines) == 2:
        if lines[0] <= line <= lines[1]:
            return True
        return symbol_ok
    if symbols and not isinstance(line, int):
        return symbol_ok or path in paths
    return True


def claim_hits(finding: dict, item: dict) -> bool:
    text = blob(finding)
    return location_hit(finding, item, text) and groups_hit(text, item.get("causal") or [])


def score_review(review: dict, truth: dict, ledger: dict | None = None) -> dict:
    findings = [item for item in review.get("findings", []) if isinstance(item, dict)]
    detected: list[str] = []
    partial: list[str] = []
    false_positives: list[dict] = []
    overbroad: list[str] = []
    unadjudicated: list[str] = []
    evidence_mislabel: list[str] = []
    defects = truth.get("defects") or []
    traps = [*(truth.get("nonDefects") or []), *(truth.get("absentDefects") or [])]

    for index, finding in enumerate(findings):
        defect_hits = [item["id"] for item in defects if claim_hits(finding, item)]
        trap_hits = [item["id"] for item in traps if claim_hits(finding, item)]
        partial_hits = [
            item["id"] for item in defects
            if location_hit(finding, item, blob(finding)) and item["id"] not in defect_hits
        ]
        identifier = str(finding.get("id") or index)
        if defect_hits:
            detected.extend(defect_hits)
            if trap_hits:
                overbroad.extend(defect_hits)
            for item in defects:
                if item["id"] in defect_hits and item.get("evidence") == "synthetic":
                    if LIVE_CLAIM.search(blob(finding)):
                        evidence_mislabel.append(item["id"])
        elif trap_hits:
            false_positives.append({"finding": identifier, "claims": trap_hits})
        elif partial_hits:
            partial.append(identifier)
        else:
            unadjudicated.append(identifier)

    detected_ids = set(detected)
    report = {
        "detected": sorted(detected_ids),
        "partial": partial,
        "missed": sorted(item["id"] for item in defects if item["id"] not in detected_ids),
        "falsePositives": false_positives,
        "overbroad": sorted(set(overbroad)),
        "unadjudicated": unadjudicated,
        "evidenceMislabel": sorted(set(evidence_mislabel)),
    }
    if ledger is not None:
        passes = ledger.get("passes") if isinstance(ledger, dict) else None
        report["ledger"] = {
            "candidatesValidated": isinstance(passes, dict) and passes.get("candidatesValidated") is True,
            "omissionsAnalyzed": isinstance(passes, dict) and passes.get("omissionsAnalyzed") is True,
            "failedWorkAnalyzed": isinstance(passes, dict) and passes.get("failedWorkAnalyzed") is True,
        }
    return report


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"expected an object: {path}")
    return value


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(
            "usage: review-eval.py list | prepare --case ID --variant NAME --skill baseline|revised --out DIR"
            " | prepare-calibration --skill baseline|revised --out DIR | verify-mount DIR"
            " | score --case ID --variant NAME --review FILE [--ledger FILE]",
            file=sys.stderr,
        )
        return 2
    command = argv[0]
    if command == "list":
        for case in case_ids():
            truth_path = PRIVATE / f"{case}.json"
            heldout = False
            if truth_path.is_file():
                heldout = bool(load_json(truth_path).get("heldout"))
            print(f"{case}\t{','.join(variants_of(case))}\theldout={str(heldout).lower()}")
        return 0
    if command == "verify-mount":
        problems = verify_mount(Path(argv[1]))
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 1
        print("MOUNT_OK")
        return 0
    if command == "prepare":
        args = dict(zip(argv[1::2], argv[2::2]))
        prepare_case(args["--case"], args["--variant"], args["--skill"], Path(args["--out"]))
        problems = verify_mount(Path(args["--out"]) / "mount")
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 1
        print(Path(args["--out"]) / "mount")
        return 0
    if command == "prepare-calibration":
        args = dict(zip(argv[1::2], argv[2::2]))
        prepare_calibration(args["--skill"], Path(args["--out"]))
        problems = verify_mount(Path(args["--out"]) / "mount")
        if problems:
            print("\n".join(problems), file=sys.stderr)
            return 1
        print(Path(args["--out"]) / "mount")
        return 0
    if command == "score":
        args = dict(zip(argv[1::2], argv[2::2]))
        truth = load_json(PRIVATE / f"{args['--case']}.json")
        variants = truth.get("variants") or {}
        if args["--variant"] not in variants:
            raise SystemExit(f"no answer key for {args['--case']} {args['--variant']}")
        review = load_json(Path(args["--review"]))
        ledger = load_json(Path(args["--ledger"])) if "--ledger" in args else None
        report = score_review(review, variants[args["--variant"]], ledger)
        report["case"] = args["--case"]
        report["variant"] = args["--variant"]
        print(json.dumps(report, indent=2))
        return 0
    print(f"unknown command: {command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
