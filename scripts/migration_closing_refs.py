"""Conservative closing-reference preflight over newly introduced local history."""
import json
from pathlib import Path
import re
import subprocess
import sys

from migration_state import load_snapshot
from migration_snapshot import SnapshotError

KEYWORD = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b", re.IGNORECASE)
REFERENCE = re.compile(
    r"(?<![A-Za-z0-9_./-])(?:https://github\.com/"
    r"(?P<url_repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/(?P<url_number>[0-9]+)"
    r"|(?:(?P<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+))?#(?P<number>[0-9]+))",
    re.IGNORECASE,
)


def git(repository, *arguments):
    return subprocess.check_output(
        ["git", "-C", str(repository), *arguments], text=True,
        encoding="utf-8", errors="replace", stderr=subprocess.PIPE, timeout=60).strip()


def report(course, primary, snapshot_dir, output):
    manifest, state = load_snapshot(snapshot_dir)
    for repository, key in [(course, "course_sha"), (primary, "primary_sha")]:
        if git(repository, "rev-parse", "refs/heads/main") != manifest[key]:
            raise SnapshotError("Repository main does not match the fresh snapshot")
    existing_commits = set(git(primary, "rev-list", manifest["primary_sha"]).splitlines())
    new_commits = [sha for sha in git(course, "rev-list", "--reverse",
                                     manifest["course_sha"]).splitlines()
                   if sha not in existing_commits]
    issues = {issue["number"]: issue for issue in state["issues"]}
    candidates = []
    for sha in new_commits:
        message = git(course, "show", "--no-patch", "--format=%B", sha)
        if not KEYWORD.search(message):
            continue
        references = []
        for match in REFERENCE.finditer(message):
            repository = match["url_repo"] or match["repo"] or manifest["primary"]
            number = int(match["url_number"] or match["number"])
            issue = issues.get(number) if repository.casefold() == manifest["primary"].casefold() else None
            references.append({
                "text": match[0], "repository": repository, "number": number,
                "relative": not (match["url_repo"] or match["repo"]),
                "primary_issue": ({key: issue[key] for key in
                                   ("id", "node_id", "number", "title", "state", "state_reason")}
                                  if issue is not None else None),
            })
        if references:
            candidates.append({"sha": sha, "message": message, "references": references})
    for repository, key in [(course, "course_sha"), (primary, "primary_sha")]:
        if git(repository, "rev-parse", "refs/heads/main") != manifest[key]:
            raise SnapshotError("Repository changed while generating snapshot preflight")
    result = {
        "schema_version": 1, "primary": manifest["primary"], "course": manifest["course"],
        "primary_sha": manifest["primary_sha"], "course_sha": manifest["course_sha"],
        "newly_introduced_commits": len(new_commits), "candidates": candidates,
    }
    # Exclusive output; no history, refs or task metadata is changed.
    with output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {"report": str(output), "newly_introduced_commits": len(new_commits),
            "candidates": len(candidates)}


def main(args):
    try:
        if len(args) != 4:
            raise SnapshotError("usage: migration-closing-refs.sh COURSE_DIR PRIMARY_DIR BEFORE_SNAPSHOT OUTPUT_JSON")
        print(json.dumps(report(*(Path(arg) for arg in args))))
        return 0
    except (SnapshotError, OSError, ValueError, KeyError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as error:
        print("Historical reference preflight failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

