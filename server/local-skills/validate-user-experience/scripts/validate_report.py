#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


MODES = {"requirement", "design", "implementation", "release", "incident"}
EVIDENCE_STATUS = {"sufficient", "partial", "insufficient"}
CONCLUSIONS = {"pass", "conditional_pass", "fail", "undetermined"}
SEVERITIES = {"P0", "P1", "P2", "P3", "P4"}
TASK_STATUS = {"success", "partial", "failed", "not_tested"}
CRITICALITY = {"critical", "important", "supporting"}
RULE_TYPES = {"normative", "requirement", "heuristic", "mixed"}
EVIDENCE_TYPES = {"observed", "inferred", "unverified"}
CONFIDENCE = {"high", "medium", "low"}
ISSUE_ID = re.compile(r"^EVA-\d{3,}$")


def nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def nonempty_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def require_string(obj: dict[str, Any], key: str, path: str, errors: list[str]) -> None:
    if not nonempty_string(obj.get(key)):
        errors.append(f"{path}.{key} must be a non-empty string")


def require_enum(
    obj: dict[str, Any], key: str, allowed: set[str], path: str, errors: list[str]
) -> None:
    value = obj.get(key)
    if value not in allowed:
        errors.append(f"{path}.{key} must be one of {sorted(allowed)}, got {value!r}")


def validate_review(data: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    review = data.get("review")
    if not isinstance(review, dict):
        errors.append("review must be an object")
        return {}
    require_string(review, "title", "review", errors)
    require_string(review, "product", "review", errors)
    require_string(review, "summary", "review", errors)
    require_enum(review, "mode", MODES, "review", errors)
    require_enum(review, "evidence_status", EVIDENCE_STATUS, "review", errors)
    require_enum(review, "conclusion", CONCLUSIONS, "review", errors)
    return review


def validate_tasks(data: dict[str, Any], errors: list[str], warnings: list[str]) -> list[dict[str, Any]]:
    tasks = data.get("task_coverage")
    if not isinstance(tasks, list) or not tasks:
        errors.append("task_coverage must be a non-empty list")
        return []
    ids: set[str] = set()
    result = []
    for index, task in enumerate(tasks):
        path = f"task_coverage[{index}]"
        if not isinstance(task, dict):
            errors.append(f"{path} must be an object")
            continue
        result.append(task)
        for key in ("id", "name", "role"):
            require_string(task, key, path, errors)
        task_id = task.get("id")
        if nonempty_string(task_id):
            if task_id in ids:
                errors.append(f"{path}.id duplicates {task_id!r}")
            ids.add(task_id)
        require_enum(task, "criticality", CRITICALITY, path, errors)
        require_enum(task, "status", TASK_STATUS, path, errors)
        if not nonempty_list(task.get("evidence")):
            warnings.append(f"{path}.evidence should be a non-empty list")
        if task.get("status") == "not_tested" and not nonempty_list(task.get("gaps")):
            warnings.append(f"{path} is not_tested but has no gaps explaining why")
    return result


def validate_issues(data: dict[str, Any], errors: list[str], warnings: list[str]) -> list[dict[str, Any]]:
    issues = data.get("issues", [])
    if not isinstance(issues, list):
        errors.append("issues must be a list")
        return []
    ids: set[str] = set()
    required_text = (
        "title",
        "dimension",
        "task_stage",
        "observation",
        "user_perspective",
        "root_cause",
        "user_impact",
        "scope",
        "recommendation",
    )
    result = []
    for index, issue in enumerate(issues):
        path = f"issues[{index}]"
        if not isinstance(issue, dict):
            errors.append(f"{path} must be an object")
            continue
        result.append(issue)
        issue_id = issue.get("id")
        if not nonempty_string(issue_id) or not ISSUE_ID.fullmatch(issue_id):
            errors.append(f"{path}.id must match EVA-001 style")
        elif issue_id in ids:
            errors.append(f"{path}.id duplicates {issue_id!r}")
        else:
            ids.add(issue_id)
        require_enum(issue, "severity", SEVERITIES, path, errors)
        require_enum(issue, "rule_type", RULE_TYPES, path, errors)
        require_enum(issue, "evidence_type", EVIDENCE_TYPES, path, errors)
        require_enum(issue, "confidence", CONFIDENCE, path, errors)
        for key in required_text:
            require_string(issue, key, path, errors)
        if not nonempty_list(issue.get("evidence")):
            errors.append(f"{path}.evidence must be a non-empty list")
        if not nonempty_list(issue.get("acceptance_criteria")):
            errors.append(f"{path}.acceptance_criteria must be a non-empty list")
        if issue.get("evidence_type") == "unverified" and issue.get("confidence") == "high":
            warnings.append(f"{path} is unverified but confidence is high")
    return result


def validate_gates(
    review: dict[str, Any], tasks: list[dict[str, Any]], issues: list[dict[str, Any]], errors: list[str], warnings: list[str]
) -> None:
    conclusion = review.get("conclusion")
    evidence_status = review.get("evidence_status")
    severities = {issue.get("severity") for issue in issues}
    critical_failures = [
        task for task in tasks if task.get("criticality") == "critical" and task.get("status") == "failed"
    ]
    critical_untested = [
        task for task in tasks if task.get("criticality") == "critical" and task.get("status") == "not_tested"
    ]

    if evidence_status == "insufficient" and conclusion != "undetermined":
        errors.append("insufficient evidence requires conclusion=undetermined")
    if conclusion == "undetermined" and evidence_status == "sufficient":
        warnings.append("conclusion is undetermined despite sufficient evidence")
    if conclusion in {"pass", "conditional_pass"} and severities.intersection({"P0", "P1"}):
        errors.append("pass/conditional_pass is not allowed with unresolved P0 or P1 issues")
    if conclusion == "pass" and "P2" in severities:
        errors.append("pass is not allowed with unresolved P2 issues")
    if conclusion in {"pass", "conditional_pass"} and critical_failures:
        errors.append("pass/conditional_pass is not allowed when a critical task failed")
    if conclusion == "pass" and critical_untested:
        errors.append("pass is not allowed when a critical task is not_tested")
    if conclusion == "conditional_pass" and "P2" not in severities:
        warnings.append("conditional_pass has no P2 issue; explain the release conditions")
    if conclusion == "fail" and not severities.intersection({"P0", "P1", "P2"}) and not critical_failures:
        warnings.append("fail has no P0/P1/P2 issue or critical task failure; explain the blocking rule")


def validate_optional_lists(data: dict[str, Any], errors: list[str]) -> None:
    for key in ("positive_evidence", "cross_cutting_risks", "gaps", "retest"):
        value = data.get(key, [])
        if not isinstance(value, list):
            errors.append(f"{key} must be a list")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a structured UX validation report JSON.")
    parser.add_argument("report", type=Path)
    args = parser.parse_args()

    try:
        data = json.loads(args.report.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"ERROR: file not found: {args.report}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON: {exc}", file=sys.stderr)
        return 2

    if not isinstance(data, dict):
        print("ERROR: report root must be an object", file=sys.stderr)
        return 2

    errors: list[str] = []
    warnings: list[str] = []
    review = validate_review(data, errors)
    tasks = validate_tasks(data, errors, warnings)
    issues = validate_issues(data, errors, warnings)
    validate_optional_lists(data, errors)
    validate_gates(review, tasks, issues, errors, warnings)

    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")

    if errors:
        print(f"FAILED: {len(errors)} error(s), {len(warnings)} warning(s)")
        return 1
    print(f"OK: report is valid with {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
