import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

# Load the script by path, so the tests run from any working directory
# (`python3 -m unittest scripts/fork-convergence/test_stable_image_ledger.py`
# from the repository root, or plain `python3 test_stable_image_ledger.py`).
SCRIPT = Path(__file__).resolve().with_name("stable_image_ledger.py")
spec = importlib.util.spec_from_file_location("stable_image_ledger", SCRIPT)
if spec is None or spec.loader is None:
    raise ImportError(f"cannot load {SCRIPT}")
ledger = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ledger
spec.loader.exec_module(ledger)

Hunk = ledger.Hunk
check_evidence = ledger.check_evidence
load_resolutions = ledger.load_resolutions
match_hunk = ledger.match_hunk
min_window = ledger.min_window
parse_diff = ledger.parse_diff
significant = ledger.significant

DIFF = """diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,5 @@ function a() {
 const keep = 1;
+// explain the guard
+if (ready) start();
 const tail = 2;
-old();
diff --git a/meta/_journal.json b/meta/_journal.json
index 3333333..4444444 100644
Binary files a/meta/_journal.json and b/meta/_journal.json differ
"""


class FakeTarget:
    def __init__(self, files):
        self.files = files

    def lines(self, path):
        return self.files.get(path)

    def expand(self, path):
        return [p for p in self.files if p.startswith(path)] if path.endswith("/") else [path]


def hunk(path, lines, new_start=1):
    return Hunk(path=path, header="@@ -1,1 +1,1 @@", new_start=new_start, lines=lines)


class ParseDiffTests(unittest.TestCase):
    def test_splits_text_hunks_and_keeps_a_binary_file_as_one_hunk(self):
        hunks = parse_diff(DIFF)
        self.assertEqual([(h.path, h.header, h.binary) for h in hunks], [
            ("src/a.ts", "@@ -10,3 +10,5 @@", False),
            ("meta/_journal.json", "binary", True),
        ])
        self.assertEqual(hunks[0].added(), ["// explain the guard", "if (ready) start();"])
        self.assertEqual(hunks[0].removed(), ["old();"])
        self.assertEqual(hunks[0].added_line_numbers(), [11, 12])


class SignificanceTests(unittest.TestCase):
    def test_code_comments_and_punctuation_are_not_evidence(self):
        self.assertFalse(significant("  // reworded comment", "x.ts"))
        self.assertFalse(significant("  # yaml comment", "ci.yml"))
        self.assertFalse(significant("  });", "x.ts"))
        self.assertTrue(significant("if (ready) start();", "x.ts"))

    def test_markdown_headings_stay_evidence(self):
        self.assertTrue(significant("## Unreleased", "CHANGELOG.md"))


class MinWindowTests(unittest.TestCase):
    def test_returns_the_tightest_span_holding_every_needle(self):
        lines = ["a", "x", "b", "x", "a", "b"]
        self.assertEqual(min_window(lines, ["a", "b"]), (5, 6))

    def test_ignores_whitespace_differences(self):
        self.assertEqual(min_window(["  if (x)   y();"], ["if (x) y();"]), (1, 1))

    def test_returns_none_when_a_needle_is_absent(self):
        self.assertIsNone(min_window(["a", "b"], ["a", "c"]))


class MatchHunkTests(unittest.TestCase):
    def test_present_when_added_lines_are_close_together_in_the_mapped_file(self):
        target = FakeTarget({"src/a.ts": ["x", "if (ready) start();", "y"]})
        outcome = match_hunk(target, hunk("src/a.ts", [("+", "if (ready) start();"), ("+", "// note")]))
        self.assertTrue(outcome["matched"])
        self.assertEqual((outcome["path"], outcome["span"]), ("src/a.ts", (2, 2)))

    def test_unmatched_lists_the_missing_lines(self):
        target = FakeTarget({"src/a.ts": ["first();"]})
        outcome = match_hunk(target, hunk("src/a.ts", [("+", "first();"), ("+", "second();")]))
        self.assertFalse(outcome["matched"])
        self.assertEqual(outcome["missing"], ["second();"])
        self.assertIn("1/2 added lines found in src/a.ts", outcome["detail"])

    def test_lines_scattered_beyond_the_window_do_not_match(self):
        far = ["first();"] + ["filler"] * 100 + ["second();"]
        target = FakeTarget({"src/a.ts": far})
        outcome = match_hunk(target, hunk("src/a.ts", [("+", "first();"), ("+", "second();")]))
        self.assertFalse(outcome["matched"])

    def test_split_file_matches_in_an_alternate_module(self):
        target = FakeTarget({
            "server/src/services/heartbeat.ts": ["shell();"],
            "server/src/services/heartbeat/queue.ts": ["admit(run);"],
        })
        outcome = match_hunk(target, hunk("server/src/services/heartbeat.ts", [("+", "admit(run);")]))
        self.assertTrue(outcome["matched"])
        self.assertEqual(outcome["path"], "server/src/services/heartbeat/queue.ts")

    def test_removal_counts_as_present_only_when_the_removed_lines_are_gone(self):
        removal = hunk("src/a.ts", [(" ", "keep();"), ("-", "old();")])
        self.assertTrue(match_hunk(FakeTarget({"src/a.ts": ["keep();"]}), removal)["matched"])
        self.assertFalse(match_hunk(FakeTarget({"src/a.ts": ["keep();", "old();"]}), removal)["matched"])

    def test_binary_hunk_never_matches_mechanically(self):
        binary = Hunk(path="meta/_journal.json", header="binary", binary=True)
        self.assertFalse(match_hunk(FakeTarget({}), binary)["matched"])


class ResolutionTests(unittest.TestCase):
    def write(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, handle)
        handle.close()
        self.addCleanup(Path(handle.name).unlink)
        return Path(handle.name)

    def test_a_dropped_hunk_must_name_a_known_decision(self):
        path = self.write({"decisions": [], "resolutions": [
            {"path": "a", "hunks": ["binary"], "status": "dropped", "ref": "r", "note": "n"}]})
        with self.assertRaises(SystemExit):
            load_resolutions(path)

    def test_a_hunk_cannot_have_two_notes(self):
        note = {"path": "a", "hunks": ["binary"], "status": "present", "ref": "r", "note": "n"}
        path = self.write({"decisions": [], "resolutions": [note, note]})
        with self.assertRaises(SystemExit):
            load_resolutions(path)

    def test_evidence_must_exist_on_the_target(self):
        target = FakeTarget({"src/a.ts": ["portedGuard();"]})
        note = {"evidence": [{"path": "src/a.ts", "contains": "portedGuard"},
                             {"path": "src/a.ts", "contains": "missingGuard"},
                             {"path": "src/b.ts", "contains": "x"}]}
        self.assertEqual(check_evidence(target, note), [
            "src/a.ts lacks 'missingGuard'", "src/b.ts is absent"])


if __name__ == "__main__":
    unittest.main()
