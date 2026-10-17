"""Exercise the real snapshot CLI with the external gh executable replaced."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PRIMARY = "Cringe-Driven-Development-Team/frontend"
COURSE = "frontend-park-mail-ru/2026_2_Cringe_Driven_Development"


def connection(nodes):
    return {"nodes": nodes, "totalCount": len(nodes),
            "pageInfo": {"hasNextPage": False, "endCursor": None}}


def project_response(field, value):
    return {"data": {"organization": {"projectV2": {"id": "PROJECT_TEST", field: value}}}}


FAKE_GH = r'''#!/usr/bin/env python3
import json, os, pathlib, re, sys
args = sys.argv[1:]
if not args or args.pop(0) != "api":
    sys.exit("Only gh api is allowed")
path = args.pop(0)
fields, flags = {}, set()
while args:
    arg = args.pop(0)
    if arg in ("-f", "-F"):
        key, value = args.pop(0).split("=", 1)
        fields[key] = value
    elif arg in ("--paginate", "--slurp"):
        flags.add(arg)
    else:
        sys.exit("Unexpected argument: " + arg)
fixture = json.loads(pathlib.Path(os.environ["FIXTURE"]).read_text())
with open(os.environ["CALLS"], "a") as log:
    log.write(path + " " + fields.get("operationName", "") + "\n")
if path == "graphql":
    query = fields.get("query", "")
    if "mutation" in query:
        sys.exit("Snapshot sent a mutation")
    operation = fields["operationName"]
    if operation == "ProjectPage" and "archivedStates: [ARCHIVED, NOT_ARCHIVED]" not in query:
        sys.exit("Snapshot omitted archived cards")
    key = operation + ":" + fields.get("cursor", "start")
    if operation == "IssueRelations":
        key = operation + ":" + fields["number"] + ":" + fields.get("cursor", "start")
    if operation == "ItemValues":
        key = operation + ":" + fields["item"] + ":" + fields.get("cursor", "start")
    payload = fixture["graphql"][key]
    if operation in ("ProjectPage", "ItemValues"):
        if operation == "ProjectPage":
            values = [value for item in payload["data"]["organization"]["projectV2"]["items"]["nodes"]
                      for value in item["fieldValues"]["nodes"]]
        else:
            values = payload["data"]["node"]["fieldValues"]["nodes"]
        computed = {"ProjectV2ItemFieldUserValue", "ProjectV2ItemFieldRepositoryValue",
                    "ProjectV2ItemFieldLabelValue", "ProjectV2ItemFieldPullRequestValue"}
        for value in values:
            name = value.get("__typename", "")
            if name in computed and not re.search(r"\bon\s+" + name + r"\s*\{[^{}]*\bfield\s*\{", query):
                # Observed GitHub behavior: these objects do not implement FieldValueCommon.
                value.pop("field", None)
else:
    if fields:
        sys.exit("REST writes are forbidden")
    if "?" in path and flags != {"--paginate", "--slurp"}:
        sys.exit("Paginated endpoint read incompletely")
    payload = fixture["rest"][path]
if isinstance(payload, dict) and "_error" in payload:
    print("gh: failure (HTTP " + str(payload["_error"]) + ")", file=sys.stderr)
    sys.exit(1)
print(json.dumps(payload))
'''


class MigrationStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cdd-state-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "bin").mkdir()
        gh = self.root / "bin/gh"
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.fixture_path = self.root / "fixture.json"
        self.calls = self.root / "calls"
        self.env = dict(os.environ)
        for key in ("GH_TOKEN", "GITHUB_TOKEN", "TOKEN", "COURSE_SYNC_SSH_KEY"):
            self.env.pop(key, None)
        self.env.update(PATH=str(self.root / "bin") + os.pathsep + self.env["PATH"],
                        FIXTURE=str(self.fixture_path), CALLS=str(self.calls))
        self.fixture = self.make_fixture()
        self.save()

    def make_fixture(self):
        rest = {}
        for index, repo in enumerate((PRIMARY, COURSE), 10):
            prefix = "repos/" + repo
            rest[prefix] = {"id": index, "full_name": repo, "default_branch": "main"}
            rest[prefix + "/git/ref/heads/main"] = {"object": {"sha": "a" * 40}}
            rest[prefix + "/actions/permissions"] = {"enabled": True, "allowed_actions": "all"}
            rest[prefix + "/rulesets?includes_parents=true&per_page=100"] = [[]]
            rest[prefix + "/branches/main/protection"] = {"_error": 404}
            rest[prefix + "/collaborators?affiliation=all&per_page=100"] = [[]]
            rest[prefix + "/environments?per_page=100"] = [{
                "total_count": 1, "environments": [{"name": "production"}]}]
            rest[prefix + "/environments/production"] = {
                "name": "production", "protection_rules": [],
                "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}}
            rest[prefix + "/environments/production/deployment-branch-policies?per_page=100"] = [{
                "total_count": 1, "branch_policies": [{"id": 1, "name": "main", "type": "branch"}]}]
            for suffix in ("actions/secrets", "actions/organization-secrets",
                           "environments/production/secrets"):
                rest[prefix + "/" + suffix + "?per_page=100"] = [{
                    "total_count": 1, "secrets": [{"name": "TEST_SECRET", "value": "must-not-be-saved"}]}]
            for suffix in ("actions/variables", "actions/organization-variables",
                           "environments/production/variables"):
                rest[prefix + "/" + suffix + "?per_page=100"] = [{"total_count": 0, "variables": []}]
        issues = [
            {"id": 12, "node_id": "ISSUE_12", "number": 12, "title": "Frontend. Feature",
             "body": "Acceptance", "state": "open", "state_reason": None,
             "assignees": [{"login": "denis"}, {"login": "valentin"}],
             "labels": [{"name": "feature"}, {"name": "ready"}], "updated_at": "old"},
            {"id": 13, "node_id": "ISSUE_13", "number": 13, "title": "Frontend. Other",
             "body": "", "state": "closed", "state_reason": "completed",
             "assignees": [], "labels": [], "updated_at": "old"},
            {"id": 90, "node_id": "PR_90", "number": 90, "pull_request": {"url": "https://example.invalid/pr"}}]
        rest["repos/" + PRIMARY + "/issues?state=all&per_page=100"] = [issues]
        fields = [
            {"id": "F_STATUS", "name": "Status", "dataType": "SINGLE_SELECT",
             "options": [{"id": "READY", "name": "Ready"}, {"id": "DONE", "name": "Done"}]},
            {"id": "F_SPRINT", "name": "Sprint", "dataType": "ITERATION",
             "configuration": {"iterations": [{"id": "S1", "title": "Sprint 1"}], "completedIterations": []}},
            {"id": "F_NUMBER", "name": "Estimate", "dataType": "NUMBER"},
            {"id": "F_TEXT", "name": "Note", "dataType": "TEXT"},
            {"id": "F_DATE", "name": "Due", "dataType": "DATE"}]
        values = [
            {"__typename": "ProjectV2ItemFieldSingleSelectValue", "field": {"id": "F_STATUS"}, "optionId": "READY"},
            {"__typename": "ProjectV2ItemFieldIterationValue", "field": {"id": "F_SPRINT"}, "iterationId": "S1"},
            {"__typename": "ProjectV2ItemFieldTextValue", "field": {"id": "F_TEXT"}, "text": ""},
            {"__typename": "ProjectV2ItemFieldDateValue", "field": {"id": "F_DATE"}, "date": "2026-10-17"}]
        items = []
        for number, repo, archived in ((12, PRIMARY, False), (13, PRIMARY, True), (22, "Cringe-Driven-Development-Team/infra", False)):
            items.append({"id": "ITEM_" + str(number), "isArchived": archived,
                          "content": {"__typename": "Issue", "id": "ISSUE_" + str(number),
                                      "repository": {"nameWithOwner": repo}},
                          "fieldValues": connection(copy.deepcopy(values))})
        graphql = {"ProjectFields:start": project_response("fields", connection(fields)),
                   "ProjectPage:start": project_response("items", connection(items))}
        for number in (12, 13):
            graphql["IssueRelations:" + str(number) + ":start"] = {"data": {"repository": {"issue": {
                "id": "ISSUE_" + str(number),
                "parent": {"id": "EXTERNAL_PARENT"} if number == 12 else None,
                "subIssues": connection([{"id": "EXTERNAL_CHILD"}] if number == 12 else [])}}}}
        return {"rest": rest, "graphql": graphql}

    def save(self):
        self.fixture_path.write_text(json.dumps(self.fixture))

    def cli(self, *args):
        return subprocess.run(["bash", str(ROOT / "scripts/migration-state.sh"), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def snapshot(self, name):
        target = self.root / name
        result = self.cli("snapshot", PRIMARY, COURSE, target)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((target / "manifest.json").is_file())
        return target

    def test_import_side_effects_are_reported(self):
        before = self.snapshot("before")
        issue = self.fixture["rest"]["repos/" + PRIMARY + "/issues?state=all&per_page=100"][0][0]
        issue.update(state="closed", state_reason="completed")
        values = self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]["items"]["nodes"][0]["fieldValues"]["nodes"]
        values[0]["optionId"] = "DONE"
        values[1]["iterationId"] = "S2"
        self.save()
        after = self.snapshot("after")
        calls = self.calls.read_text()
        result = self.cli("compare", before, after)
        self.assertEqual(result.returncode, 1, result.stderr)
        diff = json.loads(result.stdout)
        self.assertEqual(diff["issues"][0]["number"], 12)
        self.assertEqual(diff["issues"][0]["before"]["state"], "open")
        self.assertEqual(diff["issues"][0]["after"]["state_reason"], "completed")
        item = diff["project"][0]
        self.assertEqual(item["item_id"], "ITEM_12")
        fields = {field["id"]: field["value"] for field in item["after"]["fields"]}
        self.assertEqual(fields["F_STATUS"], "DONE")
        self.assertEqual(fields["F_SPRINT"], "S2")
        self.assertEqual(self.calls.read_text(), calls, "compare contacted GitHub")

    def test_order_and_updated_at_are_ignored(self):
        before = self.snapshot("before")
        issues = self.fixture["rest"]["repos/" + PRIMARY + "/issues?state=all&per_page=100"][0]
        issues.reverse()
        for issue in issues:
            issue["updated_at"] = "new"
            issue.get("assignees", []).reverse()
            issue.get("labels", []).reverse()
        self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]["items"]["nodes"].reverse()
        self.save()
        after = self.snapshot("after")
        result = self.cli("compare", before, after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"issues": [], "relations": [], "project": []})

    def test_missing_page_or_failed_api_is_incomplete(self):
        original = copy.deepcopy(self.fixture)
        self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]["items"]["totalCount"] = 999
        self.save()
        result = self.cli("snapshot", PRIMARY, COURSE, self.root / "incomplete")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse((self.root / "incomplete/manifest.json").exists())
        self.fixture = original
        self.fixture["rest"]["repos/" + COURSE + "/actions/permissions"] = {"_error": 403}
        self.save()
        result = self.cli("snapshot", PRIMARY, COURSE, self.root / "denied")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse((self.root / "denied/manifest.json").exists())

    def test_unchanged_relations_are_preserved(self):
        before = self.snapshot("before")
        state = json.loads((before / "state.json").read_text())
        self.assertEqual(len(state["issues"]), 2)
        relation = next(row for row in state["relations"] if row["issue_id"] == "ISSUE_12")
        self.assertEqual(relation["parent_id"], "EXTERNAL_PARENT")
        self.assertEqual(relation["subissue_ids"], ["EXTERNAL_CHILD"])
        self.assertTrue(next(row for row in state["project"]["items"] if row["id"] == "ITEM_13")["is_archived"])
        self.assertNotIn("must-not-be-saved", (before / "settings-primary.json").read_text())
        after = self.snapshot("after")
        self.assertEqual(self.cli("compare", before, after).returncode, 0)
        (after / "state.json").unlink()
        self.assertEqual(self.cli("compare", before, after).returncode, 2)

    def test_empty_project_field_is_not_zero(self):
        before = self.snapshot("before")
        item = self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]["items"]["nodes"][0]
        item["fieldValues"]["nodes"].append({
            "__typename": "ProjectV2ItemFieldNumberValue", "field": {"id": "F_NUMBER"}, "number": 0})
        item["fieldValues"]["totalCount"] += 1
        self.save()
        after = self.snapshot("after")
        result = self.cli("compare", before, after)
        self.assertEqual(result.returncode, 1, result.stderr)
        change = json.loads(result.stdout)["project"][0]
        before_values = {field["id"]: field["value"] for field in change["before"]["fields"]}
        after_values = {field["id"]: field["value"] for field in change["after"]["fields"]}
        self.assertIsNone(before_values["F_NUMBER"])
        self.assertEqual(after_values["F_NUMBER"], 0)

    def test_unrelated_repository_changes_are_ignored(self):
        before = self.snapshot("before")
        item = self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]["items"]["nodes"][2]
        item["fieldValues"]["nodes"][0]["optionId"] = "DONE"
        self.save()
        after = self.snapshot("after")
        self.assertEqual(self.cli("compare", before, after).returncode, 0)

    def test_nested_pagination_is_complete(self):
        project = self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]
        item = project["items"]["nodes"][0]
        remaining = item["fieldValues"]["nodes"][1:]
        item["fieldValues"]["nodes"] = item["fieldValues"]["nodes"][:1]
        item["fieldValues"]["pageInfo"] = {"hasNextPage": True, "endCursor": "values2"}
        self.fixture["graphql"]["ItemValues:ITEM_12:values2"] = {
            "data": {"node": {"id": "ITEM_12", "fieldValues": {
                "nodes": remaining, "totalCount": 4,
                "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}
        self.save()
        target = self.snapshot("paged")
        state = json.loads((target / "state.json").read_text())
        values = {field["id"]: field["value"] for field in state["project"]["items"][0]["fields"]}
        self.assertEqual(values["F_SPRINT"], "S1")
        self.assertEqual(values["F_TEXT"], "")
        self.assertEqual(values["F_DATE"], "2026-10-17")

    def test_derived_issue_field_query_contract(self):
        values = self.fixture["graphql"]["ProjectPage:start"]["data"]["organization"]["projectV2"]["items"]["nodes"][0]["fieldValues"]
        values["nodes"].append({"__typename": "ProjectV2ItemFieldUserValue", "field": {"id": "F_ASSIGNEES"}})
        values["totalCount"] += 1
        self.save()
        target = self.snapshot("derived")
        state = json.loads((target / "state.json").read_text())
        self.assertEqual(state["issues"][0]["assignees"], ["denis", "valentin"])

    def test_unsupported_custom_field_is_not_silently_omitted(self):
        fields = self.fixture["graphql"]["ProjectFields:start"]["data"]["organization"]["projectV2"]["fields"]
        fields["nodes"].append({"id": "F_NEW", "name": "New field", "dataType": "MULTI_SELECT"})
        fields["totalCount"] += 1
        self.save()
        target = self.root / "unsupported"
        result = self.cli("snapshot", PRIMARY, COURSE, target)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("Unsupported project field type", result.stderr)
        self.assertFalse((target / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
