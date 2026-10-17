"""Historical message preflight with real local Git objects, no GitHub transport."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from migration_state import canonical, write_json

PRIMARY = "Cringe-Driven-Development-Team/frontend"
COURSE = "frontend-park-mail-ru/2026_2_Cringe_Driven_Development"


class HistoricalReferences(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cdd closing refs ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.course, self.primary = self.root / "course", self.root / "primary"
        self.git(self.course, "init", "-q", "--initial-branch=main")
        self.shared = self.commit(self.course, "shared\n\nCloses #99")
        self.git(self.root, "clone", "-q", str(self.course), str(self.primary))
        self.primary_sha = self.commit(self.primary, "task repository")
        self.snapshot = self.root / "before"
        self.snapshot.mkdir()
        self.output = self.root / "closing-report.json"
        self.gh_calls = self.root / "gh-calls"
        (self.root / "bin").mkdir()
        gh = self.root / "bin/gh"
        gh.write_text('#!/bin/sh\necho contacted > "$GH_CALLS"\nexit 99\n')
        gh.chmod(0o755)
        self.env = dict(os.environ, PATH=str(gh.parent) + os.pathsep + os.environ["PATH"],
                        GH_CALLS=str(self.gh_calls))

    def git(self, directory, *args):
        directory.mkdir(exist_ok=True)
        return subprocess.check_output(
            ["git", "-C", str(directory), "-c", "user.name=History Test",
             "-c", "user.email=history@example.invalid", *args], text=True).strip()

    def commit(self, directory, message):
        self.git(directory, "commit", "-q", "--allow-empty", "-m", message)
        return self.git(directory, "rev-parse", "HEAD")

    def save_snapshot(self):
        course_sha = self.git(self.course, "rev-parse", "main")
        inventory = {
            "issues.json": [{"id": 120, "node_id": "ISSUE_12", "number": 12,
                             "title": "Existing task", "body": "Acceptance", "state": "open",
                             "state_reason": None, "assignees": [], "labels": []}],
            "subissues.json": [{"issue_id": "ISSUE_12", "parent_id": None, "sub_issue_ids": []}],
            "project.json": {"id": "PROJECT", "fields": [], "items": []},
            "settings-primary.json": {"repository": {"id": 1}, "main": {"object": {"sha": self.primary_sha}}},
            "settings-course.json": {"repository": {"id": 2}, "main": {"object": {"sha": course_sha}}},
        }
        for name, value in inventory.items():
            write_json(self.snapshot / name, value)
        write_json(self.snapshot / "state.json", canonical(inventory, PRIMARY))
        write_json(self.snapshot / "manifest.json", {
            "schema_version": 1, "complete": True, "primary": PRIMARY, "course": COURSE,
            "primary_id": 1, "course_id": 2, "primary_sha": self.primary_sha,
            "course_sha": course_sha, "project_id": "PROJECT",
        })

    def run_cli(self):
        before = [self.git(repo, "show-ref") for repo in [self.course, self.primary]]
        result = subprocess.run(["bash", str(ROOT / "scripts/migration-closing-refs.sh"),
                                 str(self.course), str(self.primary), str(self.snapshot), str(self.output)],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual([self.git(repo, "show-ref") for repo in [self.course, self.primary]], before)
        self.assertFalse(self.gh_calls.exists())
        return result

    def test_new_history_reports_sha_message_and_existing_task_collisions(self):
        messages = [
            "feat: imported\n\nCloses #12, #34",
            "FIXES\n#12",
            "Resolved Cringe-Driven-Development-Team/frontend#12; other/team#12",
            "closes https://github.com/Cringe-Driven-Development-Team/frontend/issues/12",
            "docs: Part of #12",
            "docs: prefixes #12",
        ]
        shas = [self.commit(self.course, message) for message in messages]
        self.save_snapshot()
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.output.read_text())
        self.assertEqual(report["newly_introduced_commits"], 6)
        self.assertEqual([row["sha"] for row in report["candidates"]], shas[:4])
        self.assertEqual(report["candidates"][0]["message"].strip(), messages[0])
        refs = report["candidates"][0]["references"]
        self.assertEqual([ref["number"] for ref in refs], [12, 34])
        self.assertEqual(refs[0]["primary_issue"]["id"], 120)
        self.assertEqual(refs[0]["primary_issue"]["state"], "open")
        self.assertIsNone(refs[1]["primary_issue"])
        qualified = report["candidates"][2]["references"]
        self.assertEqual(qualified[0]["repository"], PRIMARY)
        self.assertIsNone(qualified[1]["primary_issue"])
        self.assertEqual(report["candidates"][3]["references"][0]["primary_issue"]["id"], 120)

    def test_already_present_commit_is_not_reported(self):
        self.save_snapshot()
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.output.read_text())
        self.assertEqual(report["newly_introduced_commits"], 0)
        self.assertEqual(report["candidates"], [])

    def test_stale_snapshot_stops_before_report(self):
        self.save_snapshot()
        self.commit(self.course, "Closes #12")
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertIn("snapshot", result.stderr.lower())

    def test_existing_report_is_not_overwritten(self):
        self.save_snapshot()
        self.output.write_text("keep original")
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_text(), "keep original")

    def test_ordinary_reference_without_keyword_is_not_a_closing_candidate(self):
        self.commit(self.course, "Part of #12")
        self.save_snapshot()
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.output.read_text())
        self.assertEqual(report["newly_introduced_commits"], 1)
        self.assertEqual(report["candidates"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

