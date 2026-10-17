"""Read-only GitHub transport and complete migration inventory."""
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

PAIRS = {
    "Cringe-Driven-Development-Team/frontend":
        "frontend-park-mail-ru/2026_2_Cringe_Driven_Development",
    "Cringe-Driven-Development-Team/backend":
        "go-park-mail-ru/2026_2_Cringe_Driven_Development",
}
OWNER = "Cringe-Driven-Development-Team"
PROJECT_NUMBER = 1
VALUE_KEYS = {"SINGLE_SELECT": "optionId", "ITERATION": "iterationId",
              "TEXT": "text", "NUMBER": "number", "DATE": "date"}
READ_ONLY_TYPES = {"TITLE", "ASSIGNEES", "LABELS", "LINKED_PULL_REQUESTS", "MILESTONE",
                   "REPOSITORY", "REVIEWERS", "PARENT_ISSUE", "SUB_ISSUES_PROGRESS",
                   "CREATED", "UPDATED", "CLOSED", "TRACKED_BY", "TRACKS", "ISSUE_TYPE"}


class SnapshotError(Exception):
    """An incomplete or inconsistent inventory must not be marked successful."""


class GitHub:
    def __init__(self):
        self.query = Path(__file__).with_name("migration-project.graphql").read_text(encoding="utf-8")

    def api(self, path, *args, optional_404=False):
        result = subprocess.run(["gh", "api", path, *args], capture_output=True,
                                text=True, timeout=60)
        if result.returncode:
            if optional_404 and "(HTTP 404)" in result.stderr:
                return None
            raise SnapshotError("Cannot read " + path + ": " + result.stderr.strip()[:240])
        try:
            return json.loads(result.stdout)
        except ValueError as error:
            raise SnapshotError("Invalid JSON from " + path) from error

    def pages(self, path, key=None):
        pages = self.api(path, "--paginate", "--slurp")
        if not isinstance(pages, list) or not pages:
            raise SnapshotError("Incomplete REST pages: " + path)
        if key is None:
            if not all(isinstance(page, list) for page in pages):
                raise SnapshotError("Invalid REST collection: " + path)
            return [entry for page in pages for entry in page]
        total = pages[0].get("total_count")
        if type(total) is not int or total < 0:
            raise SnapshotError("Missing REST total: " + path)
        if not all(page.get("total_count") == total and isinstance(page.get(key), list) for page in pages):
            raise SnapshotError("Inconsistent REST pages: " + path)
        entries = [entry for page in pages for entry in page[key]]
        if len(entries) != total:
            raise SnapshotError("Incomplete REST collection: " + path)
        return entries

    def graphql(self, operation, **variables):
        args = ["-f", "query=" + self.query, "-f", "operationName=" + operation]
        for key, value in variables.items():
            if value is not None:
                args.extend(["-F" if type(value) is int else "-f", key + "=" + str(value)])
        response = self.api("graphql", *args)
        if response.get("errors") or not isinstance(response.get("data"), dict):
            raise SnapshotError("GraphQL query failed: " + operation)
        return response["data"]


def collect_connection(fetch, key=lambda node: node["id"]):
    """Check cursor progress, totals and duplicate nodes for every nested collection."""
    nodes = []
    seen = set()
    cursor = None
    expected = None
    while True:
        page = fetch(cursor)
        total = page.get("totalCount")
        info = page.get("pageInfo", {})
        if type(total) is not int or total < 0 or not isinstance(page.get("nodes"), list):
            raise SnapshotError("Incomplete GraphQL collection")
        if expected is None:
            expected = total
        if total != expected or type(info.get("hasNextPage")) is not bool:
            raise SnapshotError("Inconsistent GraphQL collection")
        nodes.extend(page["nodes"])
        if not info["hasNextPage"]:
            break
        cursor = info.get("endCursor")
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise SnapshotError("Incomplete GraphQL cursor chain")
        seen.add(cursor)
    if len(nodes) != expected or len({key(node) for node in nodes}) != expected:
        raise SnapshotError("Incomplete or duplicated GraphQL collection")
    return nodes


def secret_names(entries):
    # Secret endpoints return metadata, but never persist an unexpected value field.
    allowed = {"name", "created_at", "updated_at", "visibility"}
    return [{key: value for key, value in entry.items() if key in allowed} for entry in entries]


def repository_settings(api, repo):
    prefix = "repos/" + repo
    repository = api.api(prefix)
    if repository.get("full_name") != repo or repository.get("default_branch") != "main":
        raise SnapshotError("Repository identity/default branch changed: " + repo)
    rules = api.pages(prefix + "/rulesets?includes_parents=true&per_page=100")
    result = {
        "repository": repository,
        "main": api.api(prefix + "/git/ref/heads/main"),
        "actions": api.api(prefix + "/actions/permissions"),
        "rulesets": [api.api(prefix + "/rulesets/" + str(rule["id"])) for rule in rules],
        "branch_protection": api.api(prefix + "/branches/main/protection", optional_404=True),
        "collaborators": api.pages(prefix + "/collaborators?affiliation=all&per_page=100"),
        "secrets": secret_names(api.pages(prefix + "/actions/secrets?per_page=100", "secrets")),
        "organization_secrets": secret_names(api.pages(prefix + "/actions/organization-secrets?per_page=100", "secrets")),
        "variables": api.pages(prefix + "/actions/variables?per_page=100", "variables"),
        "organization_variables": api.pages(prefix + "/actions/organization-variables?per_page=100", "variables"),
        "environments": [],
    }
    for row in api.pages(prefix + "/environments?per_page=100", "environments"):
        env_path = prefix + "/environments/" + quote(row["name"], safe="")
        details = api.api(env_path)
        policy = details.get("deployment_branch_policy") or {}
        result["environments"].append({
            "environment": details,
            "branch_policies": api.pages(env_path + "/deployment-branch-policies?per_page=100", "branch_policies")
            if policy.get("custom_branch_policies") else [],
            "secrets": secret_names(api.pages(env_path + "/secrets?per_page=100", "secrets")),
            "variables": api.pages(env_path + "/variables?per_page=100", "variables"),
        })
    sha = result["main"].get("object", {}).get("sha", "")
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise SnapshotError("Missing main SHA: " + repo)
    return result


def project_inventory(api, primary):
    project_id = None

    def project_page(operation, cursor):
        nonlocal project_id
        project = api.graphql(operation, owner=OWNER, number=PROJECT_NUMBER, cursor=cursor)["organization"]["projectV2"]
        if not project or not project.get("id"):
            raise SnapshotError("Project is unavailable")
        if project_id is not None and project_id != project["id"]:
            raise SnapshotError("Project identity changed")
        project_id = project["id"]
        return project

    fields = collect_connection(lambda cursor: project_page("ProjectFields", cursor)["fields"])
    for field in fields:
        if field["dataType"] not in VALUE_KEYS and field["dataType"] not in READ_ONLY_TYPES:
            raise SnapshotError("Unsupported project field type: " + field["dataType"])
    items = collect_connection(lambda cursor: project_page("ProjectPage", cursor)["items"])
    for item in items:
        content = item.get("content") or {}
        if content.get("__typename") != "Issue" or content["repository"]["nameWithOwner"] != primary:
            continue
        first = item["fieldValues"]

        def values_page(cursor, item=item, first=first):
            if cursor is None:
                return first
            node = api.graphql("ItemValues", item=item["id"], cursor=cursor)["node"]
            if node["id"] != item["id"]:
                raise SnapshotError("Item identity changed")
            return node["fieldValues"]

        values = collect_connection(values_page, key=lambda node: node["field"]["id"])
        item["fieldValues"] = {"nodes": values}
    return {"id": project_id, "fields": fields, "items": items}


def issue_relations(api, primary, issues):
    owner, repo = primary.split("/")
    relations = []
    for issue in issues:
        identity = None
        parent = None

        def page(cursor):
            nonlocal identity, parent
            node = api.graphql("IssueRelations", owner=owner, repo=repo,
                               number=issue["number"], cursor=cursor)["repository"]["issue"]
            if not node or node.get("id") != issue["node_id"]:
                raise SnapshotError("Issue identity changed")
            current_parent = (node.get("parent") or {}).get("id")
            if identity is not None and parent != current_parent:
                raise SnapshotError("Issue parent changed during snapshot")
            identity, parent = node["id"], current_parent
            return node["subIssues"]

        children = collect_connection(page)
        relations.append({"issue_id": identity, "parent_id": parent,
                          "subissue_ids": sorted(child["id"] for child in children)})
    return relations


def read_inventory(primary, course):
    if PAIRS.get(primary) != course:
        raise SnapshotError("Unknown primary/course repository pair")
    api = GitHub()
    primary_settings = repository_settings(api, primary)
    course_settings = repository_settings(api, course)
    issues = [issue for issue in api.pages(
        "repos/" + primary + "/issues?state=all&per_page=100") if "pull_request" not in issue]
    if len({issue["id"] for issue in issues}) != len(issues):
        raise SnapshotError("Duplicated issues in REST pages")
    project = project_inventory(api, primary)
    relations = issue_relations(api, primary, issues)
    return {"issues.json": issues, "subissues.json": relations, "project.json": project,
            "settings-primary.json": primary_settings, "settings-course.json": course_settings}
