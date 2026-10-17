"""Snapshot CLI, canonical state and offline differences. No mutation operations."""
from datetime import datetime, timezone
import json
from pathlib import Path
from subprocess import TimeoutExpired
import sys

from migration_snapshot import PAIRS, VALUE_KEYS, SnapshotError, read_inventory

RAW_FILES = ("issues.json", "subissues.json", "project.json",
             "settings-primary.json", "settings-course.json")


def canonical(inventory, primary):
    issues = []
    for issue in inventory["issues.json"]:
        issues.append({key: issue.get(key) for key in (
            "id", "node_id", "number", "title", "body", "state", "state_reason")})
        issues[-1]["assignees"] = sorted(row["login"] for row in issue.get("assignees", []))
        issues[-1]["labels"] = sorted(row["name"] for row in issue.get("labels", []))
    project = inventory["project.json"]
    fields = sorted((field for field in project["fields"] if field["dataType"] in VALUE_KEYS),
                    key=lambda field: field["id"])
    items = []
    for item in project["items"]:
        content = item.get("content") or {}
        if content.get("__typename") != "Issue" or content["repository"]["nameWithOwner"] != primary:
            continue
        values = {value["field"]["id"]: value for value in item["fieldValues"]["nodes"]}
        items.append({
            "id": item["id"], "issue_id": content["id"], "is_archived": item["isArchived"],
            "fields": [{"id": field["id"], "type": field["dataType"],
                        "value": values.get(field["id"], {}).get(VALUE_KEYS[field["dataType"]])}
                       for field in fields],
        })
    if {row["issue_id"] for row in inventory["subissues.json"]} != {row["node_id"] for row in issues}:
        raise SnapshotError("Incomplete issue relations")
    return {
        "repository_id": inventory["settings-primary.json"]["repository"]["id"],
        "issues": sorted(issues, key=lambda row: row["number"]),
        "relations": sorted(inventory["subissues.json"], key=lambda row: row["issue_id"]),
        "project": {"id": project["id"], "items": sorted(items, key=lambda row: row["id"])},
    }


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def snapshot(primary, course, output):
    if PAIRS.get(primary) != course:
        raise SnapshotError("Unknown primary/course repository pair")
    output.mkdir(parents=True, exist_ok=False)
    inventory = read_inventory(primary, course)
    for name, value in inventory.items():
        write_json(output / name, value)
    state = canonical(inventory, primary)
    write_json(output / "state.json", state)
    manifest = {
        "schema_version": 1, "complete": True, "primary": primary, "course": course,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "primary_id": inventory["settings-primary.json"]["repository"]["id"],
        "course_id": inventory["settings-course.json"]["repository"]["id"],
        "primary_sha": inventory["settings-primary.json"]["main"]["object"]["sha"],
        "course_sha": inventory["settings-course.json"]["main"]["object"]["sha"],
        "project_id": state["project"]["id"],
    }
    # Success marker comes last; partial snapshots cannot be compared.
    write_json(output / "manifest.json", manifest)
    return {"snapshot": str(output), "complete": True}


def load_snapshot(directory):
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("schema_version") != 1 or manifest.get("complete") is not True
            or PAIRS.get(manifest.get("primary")) != manifest.get("course")):
        raise SnapshotError("Incomplete or unsupported snapshot")
    inventory = {name: json.loads((directory / name).read_text(encoding="utf-8")) for name in RAW_FILES}
    state = json.loads((directory / "state.json").read_text(encoding="utf-8"))
    if state != canonical(inventory, manifest["primary"]):
        raise SnapshotError("Canonical state does not match snapshot data")
    if (manifest["primary_id"] != state["repository_id"]
            or manifest["course_id"] != inventory["settings-course.json"]["repository"]["id"]
            or manifest["project_id"] != state["project"]["id"]):
        raise SnapshotError("Snapshot identity mismatch")
    return manifest, state


def differences(before, after, key, output_key):
    previous = {row[key]: row for row in before}
    current = {row[key]: row for row in after}
    result = []
    for identity in sorted(previous.keys() | current.keys()):
        left, right = previous.get(identity), current.get(identity)
        if left != right:
            row = {output_key: identity, "before": left, "after": right}
            if key == "id" and (right or left).get("number") is not None:
                row["number"] = (right or left)["number"]
            result.append(row)
    return result


def compare(before_dir, after_dir):
    before_manifest, before = load_snapshot(before_dir)
    after_manifest, after = load_snapshot(after_dir)
    for key in ("primary", "course", "primary_id", "course_id", "project_id"):
        if before_manifest[key] != after_manifest[key]:
            raise SnapshotError("Snapshots belong to different repositories or projects")
    diff = {
        "issues": differences(before["issues"], after["issues"], "id", "id"),
        "relations": differences(before["relations"], after["relations"], "issue_id", "issue_id"),
        "project": differences(before["project"]["items"], after["project"]["items"], "id", "item_id"),
    }
    return diff, int(any(diff.values()))


def main(args):
    compare_mode = bool(args and args[0] == "compare")
    try:
        if len(args) == 4 and args[0] == "snapshot":
            result = snapshot(args[1], args[2], Path(args[3]))
            code = 0
        elif len(args) == 3 and compare_mode:
            result, code = compare(Path(args[1]), Path(args[2]))
        else:
            raise SnapshotError("usage: migration-state.sh snapshot PRIMARY COURSE OUTPUT | compare BEFORE AFTER")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code
    except (SnapshotError, OSError, ValueError, KeyError, TypeError, TimeoutExpired) as error:
        print("Snapshot error: " + str(error), file=sys.stderr)
        return 2 if compare_mode else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
