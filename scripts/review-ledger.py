#!/usr/bin/env python3
"""Validate a private review ledger and compare it with a public result.

The ledger is not a review. A passing check means the three completion passes
were recorded and that actionable candidates name a contract, a trigger, a
causal path, and a violation. It does not mean those claims are true or that
the omission pass found every defect.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

TOKEN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
REVISION = re.compile(r"^(?:local|[0-9a-f]{40})$")
# A path starts with a slash (or ~/) followed by a path character; " / 200" is arithmetic.
ABSOLUTE = re.compile(r"(?:^|[\s\"'`])~?/(?![\s/])")
LIVE_CLAIM = re.compile(r"production incident|\blive model\b|\bin production\b", re.IGNORECASE)

LEDGER_KEYS = {"version", "revision", "behaviors", "candidates", "omissions", "omissionsNone", "retries", "retriesNone", "passes"}
CONTRACT_KEYS = {"path", "line", "note"}
SCENARIO_KEYS = {"id", "category", "applicable", "reason", "expected", "observed", "evidence", "downstream"}
CANDIDATE_KEYS = {
    "id", "behavior", "disposition", "observation", "contract", "trigger",
    "causalPath", "consequence", "violation", "evidenceKind", "setup",
    "provenance", "policyConflict", "citedRequirement",
}
OMISSION_KEYS = {"behavior", "transition", "reason"}
RETRY_KEYS = {"behavior", "operation", "forced", "promise", "persisted", "retried", "consumer", "exit", "verdict"}
RETRY_VERDICTS = {"satisfied", "violated"}
PASS_KEYS = {"candidatesValidated", "omissionsAnalyzed", "failedWorkAnalyzed"}
DISPOSITIONS = {"actionable", "refuted", "policy", "operational", "hypothesis"}
SCENARIO_EVIDENCE = {"reproduced", "source", "synthetic", "native", "live", "mocked", "unverified", "not-run"}
BEHAVIOR_KEYS = {"id", "summary", "contract", "scenarios", "uncovered"}
# A behavior that acquires, starts, delegates, or cleans up a resource records
# who owns what, how it is cancelled, and when its state may be released.
OWNERSHIP_KEYS = {"owner", "resources", "subordinates", "cancellation", "release", "transfer"}
# Each lifecycle path gets a scenario, run or explained as inapplicable.
OWNERSHIP_PATHS = ("ownership-completion", "ownership-nonzero", "ownership-termination", "ownership-early-leader")
# Evidence that did not observe the owned work after the owner returned.
INDIRECT_EVIDENCE = {"source", "mocked", "unverified"}
KINDS = {"synthetic", "source", "native", "live", "unverified"}
SETUPS = {"synthetic", "source", "native", "live"}
PROVENANCE = {"introduced", "preexisting", "unchanged-consumer", "not-applicable"}
HEAD_DISPOSITIONS = {
    "present": {"actionable"},
    "absent": {"refuted"},
    "not-a-defect": {"refuted", "policy", "operational"},
    "unverified": {"hypothesis"},
}


def text_field(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def relative_path(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and not value.startswith("/")
        and not value.startswith("~")
        and "\\" not in value
        and all(part not in ("", ".", "..") for part in value.split("/"))
    )


def walk_strings(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)


def load_json(path: Path) -> tuple[object, list[str]]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), []
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return None, [f"unreadable: {error.__class__.__name__}"]


def check_ownership(ownership: object, scenarios: list, uncovered: list, prefix: str) -> list[str]:
    """Structure and consistency of an ownership record, not proof that owned work stopped."""
    if not isinstance(ownership, dict) or set(ownership) != OWNERSHIP_KEYS:
        return [f"{prefix}.ownership"]
    problems: list[str] = []
    for field in ("owner", "subordinates", "release"):
        if not text_field(ownership.get(field)):
            problems.append(f"{prefix}.ownership.{field}")
    for field in ("resources", "cancellation"):
        value = ownership.get(field)
        if not isinstance(value, list) or not value or any(not text_field(item) for item in value):
            problems.append(f"{prefix}.ownership.{field}")
    if not isinstance(ownership.get("transfer"), str):
        problems.append(f"{prefix}.ownership.transfer")
    gaps = "\n".join(item for item in uncovered if isinstance(item, str))
    for path in OWNERSHIP_PATHS:
        matching = [item for item in scenarios if isinstance(item, dict) and item.get("category") == path]
        if not matching:
            problems.append(f"{prefix}.ownership.{path}")
            continue
        # A path no experiment observed is a recorded gap, not a covered path.
        indirect = any(item.get("applicable") is True and item.get("evidence") in INDIRECT_EVIDENCE for item in matching)
        if indirect and path not in gaps:
            problems.append(f"{prefix}.ownership.{path}.uncovered")
    return problems


def check_assessment(candidate: dict, revision: str, prefix: str) -> list[str]:
    assessment = candidate.get("assessment")
    if not isinstance(assessment, dict) or set(assessment) != {"head", "status", "basis", "elsewhere"}:
        return [f"{prefix}.assessment"]
    problems: list[str] = []
    if assessment.get("head") != revision:
        problems.append(f"{prefix}.assessment.head")
    status = assessment.get("status")
    allowed = HEAD_DISPOSITIONS.get(status) if isinstance(status, str) else None
    if allowed is None:
        problems.append(f"{prefix}.assessment.status")
    elif candidate.get("disposition") not in allowed:
        problems.append(f"{prefix}.assessment.disposition")
    if not text_field(assessment.get("basis")):
        problems.append(f"{prefix}.assessment.basis")
    elsewhere = assessment.get("elsewhere")
    if not isinstance(elsewhere, list):
        return [*problems, f"{prefix}.assessment.elsewhere"]
    seen: set[str] = set()
    for index, comparison in enumerate(elsewhere):
        key = f"{prefix}.assessment.elsewhere[{index}]"
        if not isinstance(comparison, dict) or set(comparison) != {"revision", "status", "basis"}:
            problems.append(key)
            continue
        other = comparison.get("revision")
        if (not isinstance(other, str) or not re.fullmatch(r"[0-9a-f]{40}", other)
                or other == revision or other in seen):
            problems.append(f"{key}.revision")
        else:
            seen.add(other)
        comparison_status = comparison.get("status")
        if not isinstance(comparison_status, str) or comparison_status not in {"fixed", "present", "unverified"}:
            problems.append(f"{key}.status")
        if not text_field(comparison.get("basis")):
            problems.append(f"{key}.basis")
        # A fix implies a defect. An operational/policy dismissal must not
        # substitute another tree's repair for assessing the reviewed head.
        if comparison_status == "fixed" and (not isinstance(status, str) or status not in {"present", "absent"}):
            problems.append(f"{key}.head-status")
    return problems


def check_ledger(ledger: object, *, require_scope: bool = False) -> list[str]:
    problems: list[str] = []
    if not isinstance(ledger, dict):
        return ["ledger"]
    extra = sorted(set(ledger) - LEDGER_KEYS)
    if extra:
        problems.append("ledger.keys")
    version = ledger.get("version", 1)
    if type(version) is not int or version not in (1, 2) or (require_scope and version != 2):
        problems.append("ledger.version")
    if not isinstance(ledger.get("revision"), str) or not REVISION.fullmatch(ledger.get("revision", "")):
        problems.append("revision")
    for value in walk_strings(ledger):
        if ABSOLUTE.search(value):
            problems.append("private-path")
            break

    behaviors = ledger.get("behaviors")
    behavior_ids: set[str] = set()
    unevidenced: set[str] = set()
    if not isinstance(behaviors, list) or not behaviors:
        problems.append("behaviors")
        behaviors = []
    for index, behavior in enumerate(behaviors):
        if not isinstance(behavior, dict) or set(behavior) - {"ownership"} != BEHAVIOR_KEYS:
            problems.append(f"behaviors[{index}]")
            continue
        identifier = behavior.get("id")
        if not isinstance(identifier, str) or not TOKEN.fullmatch(identifier) or identifier in behavior_ids:
            problems.append(f"behaviors[{index}].id")
        else:
            behavior_ids.add(identifier)
        if not text_field(behavior.get("summary")):
            problems.append(f"behaviors[{index}].summary")
        contracts = behavior.get("contract")
        if not isinstance(contracts, list) or not contracts:
            problems.append(f"behaviors[{index}].contract")
        else:
            for contract_index, contract in enumerate(contracts):
                if not isinstance(contract, dict) or set(contract) != CONTRACT_KEYS:
                    problems.append(f"behaviors[{index}].contract[{contract_index}]")
                    continue
                if not relative_path(contract.get("path")):
                    problems.append(f"behaviors[{index}].contract[{contract_index}].path")
                line = contract.get("line")
                if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                    problems.append(f"behaviors[{index}].contract[{contract_index}].line")
                if not text_field(contract.get("note")):
                    problems.append(f"behaviors[{index}].contract[{contract_index}].note")
        scenarios = behavior.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios:
            problems.append(f"behaviors[{index}].scenarios")
            scenarios = []
        evidenced = False
        for scenario_index, scenario in enumerate(scenarios):
            prefix = f"behaviors[{index}].scenarios[{scenario_index}]"
            if not isinstance(scenario, dict) or set(scenario) != SCENARIO_KEYS:
                problems.append(prefix)
                continue
            if not isinstance(scenario.get("id"), str) or not TOKEN.fullmatch(scenario.get("id", "")):
                problems.append(f"{prefix}.id")
            if not text_field(scenario.get("category")):
                problems.append(f"{prefix}.category")
            applicable = scenario.get("applicable")
            if not isinstance(applicable, bool):
                problems.append(f"{prefix}.applicable")
                continue
            evidence = scenario.get("evidence")
            if evidence not in SCENARIO_EVIDENCE:
                problems.append(f"{prefix}.evidence")
            if applicable:
                if text_field(scenario.get("reason")):
                    problems.append(f"{prefix}.reason")
                for field in ("expected", "observed", "downstream"):
                    if not text_field(scenario.get(field)):
                        problems.append(f"{prefix}.{field}")
                if evidence == "not-run":
                    problems.append(f"{prefix}.evidence")
                elif evidence in SCENARIO_EVIDENCE:
                    evidenced = True
            else:
                if not text_field(scenario.get("reason")):
                    problems.append(f"{prefix}.reason")
                if evidence != "not-run":
                    problems.append(f"{prefix}.evidence")
        uncovered = behavior.get("uncovered")
        if not isinstance(uncovered, list) or any(not text_field(item) for item in uncovered):
            problems.append(f"behaviors[{index}].uncovered")
            uncovered = []
        if "ownership" in behavior:
            problems.extend(check_ownership(behavior["ownership"], scenarios, uncovered, f"behaviors[{index}]"))
        if isinstance(identifier, str) and not evidenced:
            unevidenced.add(identifier)

    candidates = ledger.get("candidates")
    candidate_ids: set[str] = set()
    if not isinstance(candidates, list):
        problems.append("candidates")
        candidates = []
    for index, candidate in enumerate(candidates):
        prefix = f"candidates[{index}]"
        expected = CANDIDATE_KEYS | ({"assessment"} if version == 2 else set())
        if not isinstance(candidate, dict) or set(candidate) != expected:
            problems.append(prefix)
            continue
        if version == 2:
            problems.extend(check_assessment(candidate, ledger.get("revision"), prefix))
        identifier = candidate.get("id")
        if not isinstance(identifier, str) or not TOKEN.fullmatch(identifier) or identifier in candidate_ids:
            problems.append(f"{prefix}.id")
        else:
            candidate_ids.add(identifier)
        if candidate.get("behavior") not in behavior_ids:
            problems.append(f"{prefix}.behavior")
        disposition = candidate.get("disposition")
        if disposition not in DISPOSITIONS:
            problems.append(f"{prefix}.disposition")
        if candidate.get("evidenceKind") not in KINDS:
            problems.append(f"{prefix}.evidenceKind")
        if candidate.get("setup") not in SETUPS:
            problems.append(f"{prefix}.setup")
        if candidate.get("provenance") not in PROVENANCE:
            problems.append(f"{prefix}.provenance")
        if not isinstance(candidate.get("policyConflict"), bool):
            problems.append(f"{prefix}.policyConflict")
        kind = candidate.get("evidenceKind")
        setup = candidate.get("setup")
        if kind == "live" and setup != "live":
            problems.append(f"{prefix}.evidenceKind")
        if setup == "synthetic" and kind == "live":
            problems.append(f"{prefix}.setup")
        if disposition == "hypothesis" and kind == "live":
            problems.append(f"{prefix}.disposition")
        actionable = disposition == "actionable"
        if actionable:
            for field in ("contract", "trigger", "causalPath", "consequence", "violation", "observation"):
                if not text_field(candidate.get(field)):
                    problems.append(f"{prefix}.{field}")
            if kind == "unverified":
                problems.append(f"{prefix}.evidenceKind")
            if candidate.get("provenance") == "not-applicable":
                problems.append(f"{prefix}.provenance")
            if candidate.get("policyConflict") is True and not text_field(candidate.get("citedRequirement")):
                problems.append(f"{prefix}.citedRequirement")
            if candidate.get("policyConflict") is False and text_field(candidate.get("citedRequirement")):
                problems.append(f"{prefix}.citedRequirement")
        else:
            if text_field(candidate.get("violation")):
                problems.append(f"{prefix}.violation")
            if not text_field(candidate.get("observation")) or not text_field(candidate.get("consequence")):
                problems.append(f"{prefix}.observation")
            if text_field(candidate.get("citedRequirement")):
                problems.append(f"{prefix}.citedRequirement")
            if candidate.get("provenance") != "not-applicable":
                problems.append(f"{prefix}.provenance")

    omissions = ledger.get("omissions")
    if not isinstance(omissions, list):
        problems.append("omissions")
        omissions = []
    omitted_ids: set[str] = set()
    for index, item in enumerate(omissions):
        if not isinstance(item, dict) or set(item) != OMISSION_KEYS:
            problems.append(f"omissions[{index}]")
            continue
        if item.get("behavior") not in behavior_ids:
            problems.append(f"omissions[{index}].behavior")
        else:
            omitted_ids.add(item["behavior"])
        if not text_field(item.get("transition")) or not text_field(item.get("reason")):
            problems.append(f"omissions[{index}]")
    if not isinstance(ledger.get("omissionsNone"), str):
        problems.append("omissionsNone")
    elif omissions and ledger.get("omissionsNone").strip():
        problems.append("omissionsNone")

    retries = ledger.get("retries")
    if not isinstance(retries, list):
        problems.append("retries")
        retries = []
    for index, item in enumerate(retries):
        prefix = f"retries[{index}]"
        if not isinstance(item, dict) or set(item) != RETRY_KEYS:
            problems.append(prefix)
            continue
        if item.get("behavior") not in behavior_ids:
            problems.append(f"{prefix}.behavior")
        for field in ("operation", "forced", "promise", "persisted", "retried", "consumer", "exit"):
            if not text_field(item.get(field)):
                problems.append(f"{prefix}.{field}")
        if item.get("verdict") not in RETRY_VERDICTS:
            problems.append(f"{prefix}.verdict")
    if not isinstance(ledger.get("retriesNone"), str):
        problems.append("retriesNone")
    elif retries and ledger.get("retriesNone").strip():
        problems.append("retriesNone")

    passes = ledger.get("passes")
    if not isinstance(passes, dict) or set(passes) != PASS_KEYS:
        problems.append("passes")
    else:
        validated = passes.get("candidatesValidated")
        analyzed = passes.get("omissionsAnalyzed")
        retry_analyzed = passes.get("failedWorkAnalyzed")
        if not isinstance(validated, bool) or not isinstance(analyzed, bool) or not isinstance(retry_analyzed, bool):
            problems.append("passes")
        elif analyzed and retry_analyzed and not problems:
            if unevidenced - omitted_ids:
                problems.append("omissions.coverage")
            if not omissions and not text_field(ledger.get("omissionsNone")):
                problems.append("omissionsNone")
            if not retries and not text_field(ledger.get("retriesNone")):
                problems.append("retriesNone")
    return problems


def passes_complete(ledger: dict) -> bool:
    passes = ledger.get("passes")
    return (
        isinstance(passes, dict)
        and passes.get("candidatesValidated") is True
        and passes.get("omissionsAnalyzed") is True
        and passes.get("failedWorkAnalyzed") is True
    )


def public_text(finding: dict) -> str:
    return "\n".join(
        str(finding.get(field, ""))
        for field in ("title", "explanation", "trigger", "consequence", "verification")
    )


def compare_ledger(ledger: object, result: object, *, require_scope: bool = False) -> list[str]:
    problems = check_ledger(ledger, require_scope=require_scope)
    if not isinstance(ledger, dict):
        return problems
    if not isinstance(result, dict):
        return [*problems, "result"]
    head = result.get("head")
    if not isinstance(head, str) or not REVISION.fullmatch(head):
        problems.append("result.head")
    elif ledger.get("revision") != head:
        problems.append("revision.head")
    outcome = result.get("outcome")
    findings = result.get("findings")
    if not isinstance(findings, list):
        findings = []
        problems.append("findings")
    finding_ids = []
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict) or not isinstance(finding.get("id"), str):
            problems.append(f"findings[{index}].id")
            continue
        finding_ids.append(finding["id"])
    actionable = {
        candidate["id"]: candidate
        for candidate in ledger.get("candidates", [])
        if isinstance(candidate, dict) and candidate.get("disposition") == "actionable" and isinstance(candidate.get("id"), str)
    }
    if set(finding_ids) != set(actionable):
        problems.append("findings.candidates")
    if ledger.get("version") == 2:
        expected_fixes = set()
        for identifier, candidate in actionable.items():
            assessment = candidate.get("assessment")
            if not isinstance(assessment, dict) or not isinstance(assessment.get("elsewhere"), list):
                continue
            for comparison in assessment["elsewhere"]:
                if isinstance(comparison, dict) and comparison.get("status") == "fixed":
                    other = comparison.get("revision")
                    if isinstance(other, str):
                        expected_fixes.add((identifier, other))
        external_fixes = result.get("externalFixes", [])
        recorded_fixes = set()
        if not isinstance(external_fixes, list):
            problems.append("externalFixes")
        else:
            for fix in external_fixes:
                if (not isinstance(fix, dict) or set(fix) != {"finding", "revision", "detail"}
                        or not isinstance(fix.get("finding"), str)
                        or not isinstance(fix.get("revision"), str) or not text_field(fix.get("detail"))):
                    problems.append("externalFixes")
                    continue
                pair = (fix["finding"], fix["revision"])
                if pair in recorded_fixes:
                    problems.append("externalFixes.duplicate")
                recorded_fixes.add(pair)
        if recorded_fixes != expected_fixes:
            problems.append("externalFixes.candidates")
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        candidate = actionable.get(finding.get("id"))
        if not isinstance(candidate, dict):
            continue
        if candidate.get("setup") == "synthetic" and LIVE_CLAIM.search(public_text(finding)):
            problems.append(f"findings.{finding.get('id')}.evidence")
    complete = passes_complete(ledger)
    if complete and outcome == "incomplete":
        problems.append("outcome")
    if not complete and outcome in {"clean", "findings"}:
        problems.append("passes")
    if complete and outcome == "clean" and actionable:
        problems.append("outcome")
    if complete and outcome == "findings" and not actionable:
        problems.append("outcome")
    return problems


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in {"check", "compare"}:
        print("usage: review-ledger.py check LEDGER | compare LEDGER RESULT", file=sys.stderr)
        return 2
    ledger_path = Path(argv[1])
    ledger, problems = load_json(ledger_path)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    if argv[0] == "check":
        problems = check_ledger(ledger)
    else:
        if len(argv) != 3:
            print("usage: review-ledger.py compare LEDGER RESULT", file=sys.stderr)
            return 2
        result, load_problems = load_json(Path(argv[2]))
        if load_problems or not isinstance(result, dict):
            print("\n".join(load_problems or ["result"]), file=sys.stderr)
            return 1
        problems = compare_ledger(ledger, result)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        if problems == ["passes"] or (set(problems) <= {"passes", "outcome"} and not passes_complete(ledger)):
            print("LEDGER_INCOMPLETE", file=sys.stderr)
            return 2
        return 1
    if not passes_complete(ledger):
        print("LEDGER_INCOMPLETE", file=sys.stderr)
        return 2
    print("LEDGER_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
