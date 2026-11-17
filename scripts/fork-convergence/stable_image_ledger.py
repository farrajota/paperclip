#!/usr/bin/env python3
"""Port ledger for the zay/stable-image -> zay/main convergence.

Lists every hunk of `git diff BASE STABLE` and says where it ended up on a
target ref (zay/main, or a branch based on it):

- present: the hunk's added lines are found on the target. The lines are
  attributed with `git blame` to the zay/main merge that brought them.
- superseded: the added lines are on the target, but every one of them was
  already there before the convergence series started (PRE_CONVERGENCE), so
  the stable change was made redundant by upstream or the fork's earlier line.
- by note: hunks that do not match mechanically (adapted ports, renamed or
  split files, deliberate drops) are resolved by an evidence note in
  stable-image-ledger-resolutions.json, with status present, superseded or
  dropped.

A hunk that matches nothing and has no note is reported as UNRESOLVED and the
script exits 1. A note that names no hunk, or names a hunk that already
matches mechanically, is also an error, so the notes cannot drift from the
diff. Only git and the Python standard library are used.

Usage, from the repository root:
    python3 scripts/fork-convergence/stable_image_ledger.py \
        [--target origin/zay/main] [--output ledger.md]
"""
import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

BASE = "563d8eba062380647767589f38df4346200e2009"
STABLE = "6b3abb1b5d2a16f17c07fc24ad9175220bd88c5d"
# Parent of the cutover merge (PR #27): zay/main before the first port.
PRE_CONVERGENCE = "e6ea8496ffb616e78bc4d8207a1b38b722d6237f"
DEFAULT_TARGET = "origin/zay/main"
RESOLUTIONS_FILE = Path(__file__).with_name("stable-image-ledger-resolutions.json")

# Stable paths that live elsewhere on zay/main. Upstream moved the feature
# map and the story, and the scheduling migration was renamed to 0381 with
# identical bytes (plan section 4).
PATH_MAP = {
    "feature-map/tasks.md": "maps/feature-map/tasks.md",
    "feature-map/task-coordination.md": "maps/feature-map/task-coordination.md",
    "packages/db/src/migrations/0306_issue_one_time_schedules.sql":
        "packages/db/src/migrations/0381_issue_one_time_schedules.sql",
    "ui/storybook/stories/task-chat-mobile-follow.stories.tsx":
        "ui/storybook/stories/tasks/task-chat-mobile-follow.stories.tsx",
}

# Extra files searched when the hunk is not found in the mapped path.
# Upstream split heartbeat.ts into modules and moved the issue-monitor helpers
# out of the routes. A path ending in "/" means every file under it.
ALTERNATE_PATHS = {
    "server/src/services/heartbeat.ts": ["server/src/services/heartbeat/"],
    "server/src/routes/issues.ts": ["server/src/services/issue-monitors.ts"],
}

HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
PR_MERGE = re.compile(r"^Merge pull request #(\d+)")
STATUSES = ("present", "superseded", "dropped")


@dataclass
class Hunk:
    path: str
    header: str
    new_start: int = 0
    lines: list = field(default_factory=list)  # (tag, text), tag in " +-"
    binary: bool = False

    @property
    def key(self):
        return f"{self.path} {self.header}"

    def added(self):
        return [text for tag, text in self.lines if tag == "+"]

    def removed(self):
        return [text for tag, text in self.lines if tag == "-"]

    def new_side_length(self):
        return sum(1 for tag, _ in self.lines if tag in " +")

    def added_line_numbers(self):
        numbers, line_no = [], self.new_start
        for tag, _ in self.lines:
            if tag == "+":
                numbers.append(line_no)
            if tag in " +":
                line_no += 1
        return numbers


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: "
                         f"{result.stderr.decode('utf-8', 'replace').strip()}")
    return result.stdout.decode("utf-8", "replace")


def parse_diff(text):
    """Split `git diff` output into hunks; a binary file is one hunk."""
    hunks, path, current = [], None, None
    for raw in text.split("\n"):
        if raw.startswith("diff --git "):
            path, current = raw.split(" b/", 1)[1], None
        elif raw.startswith("Binary files "):
            if path is None:
                raise ValueError(f"binary marker before any file header: {raw}")
            hunks.append(Hunk(path=path, header="binary", binary=True))
        elif raw.startswith("@@"):
            if path is None:
                raise ValueError(f"hunk header before any file header: {raw}")
            match = HUNK_HEADER.match(raw)
            if not match:
                raise ValueError(f"unparsable hunk header in {path}: {raw}")
            current = Hunk(path=path, header=match.group(0), new_start=int(match.group(3)))
            hunks.append(current)
        elif current is not None and raw[:1] in (" ", "+", "-"):
            current.lines.append((raw[0], raw[1:]))
        # "\ No newline at end of file" and file headers carry no content.
    return hunks


def normalize(line):
    return " ".join(line.split())


SLASH_COMMENT_SUFFIXES = (".ts", ".tsx", ".js", ".mjs")
HASH_COMMENT_SUFFIXES = (".yml", ".yaml", ".sh")


def significant(line, path=""):
    """Whether a line counts as evidence for its hunk.

    Lines with no letter or digit (braces, blank lines) prove nothing, and in
    code a comment line does not change behaviour, so a port that reworded a
    comment still matches on its code lines.
    """
    stripped = line.strip()
    if path.endswith(SLASH_COMMENT_SUFFIXES) and stripped.startswith(("//", "/*", "*")):
        return False
    if path.endswith(HASH_COMMENT_SUFFIXES) and stripped.startswith("#"):
        return False
    return re.search(r"[A-Za-z0-9]", line) is not None


def min_window(file_lines, needles):
    """Smallest 1-based (first, last) span of file_lines holding every needle.

    Lines are compared after whitespace normalisation. Returns None when a
    needle does not occur at all.
    """
    wanted = {normalize(n) for n in needles}
    events = [(i, text) for i, text in enumerate((normalize(l) for l in file_lines), 1)
              if text in wanted]
    if {text for _, text in events} != wanted:
        return None
    best, counts, covered, left = None, {}, 0, 0
    for pos, text in events:
        counts[text] = counts.get(text, 0) + 1
        if counts[text] == 1:
            covered += 1
        while covered == len(wanted):
            start = events[left][0]
            if best is None or pos - start < best[1] - best[0]:
                best = (start, pos)
            left_text = events[left][1]
            counts[left_text] -= 1
            if counts[left_text] == 0:
                covered -= 1
            left += 1
    return best


def window_limit(hunk):
    """How far apart the found lines may be and still count as this hunk."""
    size = hunk.new_side_length()
    return max(2 * size, size + 40)


class Target:
    """Read access to the target ref, with blame-based merge attribution."""

    def __init__(self, ref):
        self.ref = ref
        self.sha = git("rev-parse", ref).strip()
        self.files = {}
        self.blames = {}
        self.introduced_by = {}
        self.merges = []
        first_parents = git("rev-list", "--first-parent", "--reverse",
                            f"{PRE_CONVERGENCE}..{self.sha}").split()
        previous = PRE_CONVERGENCE
        for index, commit in enumerate(first_parents):
            for introduced in git("rev-list", f"{previous}..{commit}").split():
                self.introduced_by[introduced] = index
            subject = git("log", "-1", "--format=%s", commit).strip()
            self.merges.append((commit, subject))
            previous = commit

    def lines(self, path):
        if path not in self.files:
            exists = subprocess.run(["git", "cat-file", "-e", f"{self.sha}:{path}"],
                                    capture_output=True, check=False).returncode == 0
            self.files[path] = (git("show", f"{self.sha}:{path}").split("\n")
                                if exists else None)
        return self.files[path]

    def expand(self, path):
        if not path.endswith("/"):
            return [path]
        return git("ls-tree", "-r", "--name-only", self.sha, "--", path).split()

    def blame_commit(self, path, line_no):
        if path not in self.blames:
            commits, current = {}, None
            for raw in git("blame", "--porcelain", self.sha, "--", path).split("\n"):
                match = re.match(r"^([0-9a-f]{40}) \d+ (\d+)", raw)
                if match:
                    current = match.group(1)
                    commits[int(match.group(2))] = current
            self.blames[path] = commits
        return self.blames[path][line_no]

    def describe(self, merge_index):
        commit, subject = self.merges[merge_index]
        pr = PR_MERGE.match(subject)
        if pr:
            return f"PR #{pr.group(1)}, merge {commit[:9]}"
        return f"commit {commit[:9]} on {self.ref} ({subject})"


def candidate_paths(target, path):
    mapped = PATH_MAP.get(path, path)
    paths = [mapped]
    for extra in ALTERNATE_PATHS.get(path, []):
        paths.extend(p for p in target.expand(extra) if p not in paths)
    return paths


def match_hunk(target, hunk):
    """Mechanical match. Returns a dict describing the outcome."""
    if hunk.binary:
        return {"matched": False, "detail": "binary in git diff (-diff attribute)"}
    added = [line for line in hunk.added() if significant(line, hunk.path)]
    candidates = candidate_paths(target, hunk.path)
    if not added:
        removed = [line for line in hunk.removed() if significant(line, hunk.path)]
        if not removed:
            return {"matched": False, "detail": "no significant line (only comments or punctuation)"}
        # A removal is checked only in the file the hunk maps to.
        path = candidates[0]
        file_lines = target.lines(path)
        if file_lines is None:
            return {"matched": False, "detail": f"removal-only hunk; {path} is absent"}
        span = min_window(file_lines, removed)
        if span is not None and span[1] - span[0] <= window_limit(hunk):
            return {"matched": False,
                    "detail": f"removed lines still at {path}:{span[0]}"}
        return {"matched": True, "kind": "removal", "path": path,
                "detail": f"removed lines absent from {path}"}
    best = (0, None, list(dict.fromkeys(normalize(a) for a in added)))
    for path in candidates:
        file_lines = target.lines(path)
        if file_lines is None:
            continue
        span = min_window(file_lines, added)
        if span is not None and span[1] - span[0] <= window_limit(hunk):
            return {"matched": True, "kind": "lines", "path": path, "span": span,
                    "needles": added, "file_lines": file_lines}
        present = {normalize(l) for l in file_lines}
        missing = [a for a in dict.fromkeys(normalize(a) for a in added) if a not in present]
        found = len({normalize(a) for a in added}) - len(missing)
        if best[1] is None or found > best[0]:
            best = (found, path, missing)
    total = len({normalize(a) for a in added})
    if best[0] == 0:
        existing = [c for c in candidates if target.lines(c) is not None]
        if not existing:
            where = f"{candidates[0]} is absent"
        elif len(existing) == 1:
            where = f"in {existing[0]}"
        else:
            where = f"in {existing[0]} and {len(existing) - 1} other candidate files"
        return {"matched": False, "detail": f"0/{total} added lines found {where}",
                "missing": best[2]}
    return {"matched": False, "missing": best[2],
            "detail": f"{best[0]}/{total} added lines found in {best[1]}"}


def attribute(target, outcome):
    """Latest zay/main merge that brought any matched line, or None if all
    matched lines predate the convergence series."""
    span, path = outcome["span"], outcome["path"]
    wanted = {normalize(n) for n in outcome["needles"]}
    latest = None
    for line_no in range(span[0], span[1] + 1):
        if normalize(outcome["file_lines"][line_no - 1]) not in wanted:
            continue
        index = target.introduced_by.get(target.blame_commit(path, line_no))
        if index is not None and (latest is None or index > latest):
            latest = index
    return latest


def pre_existing_commits(target, outcome):
    """Distinct commits that wrote the matched lines, in file order."""
    span, path = outcome["span"], outcome["path"]
    wanted = {normalize(n) for n in outcome["needles"]}
    commits = []
    for line_no in range(span[0], span[1] + 1):
        if normalize(outcome["file_lines"][line_no - 1]) in wanted:
            commit = target.blame_commit(path, line_no)
            if commit not in commits:
                commits.append(commit)
    return commits


def stable_commits(hunk, stable_introduced):
    """Stable-only commits that wrote the hunk's added lines (git blame)."""
    if hunk.binary or not hunk.added():
        return []
    ranges = []
    for number in hunk.added_line_numbers():
        if ranges and ranges[-1][1] == number - 1:
            ranges[-1][1] = number
        else:
            ranges.append([number, number])
    args = ["blame", "--porcelain"]
    for start, end in ranges:
        args += ["-L", f"{start},{end}"]
    commits = []
    for raw in git(*args, STABLE, "--", hunk.path).split("\n"):
        match = re.match(r"^([0-9a-f]{40}) \d+ \d+", raw)
        if match and match.group(1) in stable_introduced and match.group(1) not in commits:
            commits.append(match.group(1))
    return commits


def load_resolutions(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    decisions = {d["id"]: d for d in data["decisions"]}
    notes = {}
    for entry in data["resolutions"]:
        label = f"{entry['path']} {entry['hunks']}"
        if entry["status"] not in STATUSES:
            raise SystemExit(f"unknown status {entry['status']!r} for {label}")
        if entry["status"] == "dropped" and entry.get("decision") not in decisions:
            raise SystemExit(f"dropped hunk {label} must name a known decision")
        if entry.get("decision") and entry["decision"] not in decisions:
            raise SystemExit(f"unknown decision {entry['decision']!r} for {label}")
        for header in entry["hunks"]:
            key = f"{entry['path']} {header}"
            if key in notes:
                raise SystemExit(f"duplicate resolution for {key}")
            notes[key] = entry
    return decisions, notes


def check_evidence(target, note):
    """Each note names lines that must exist on the target, so a note cannot
    claim a port that is not there. Returns the failures."""
    failures = []
    for item in note.get("evidence", []):
        file_lines = target.lines(item["path"])
        if file_lines is None:
            failures.append(f"{item['path']} is absent")
            continue
        if not any(item["contains"] in line for line in file_lines):
            failures.append(f"{item['path']} lacks {item['contains']!r}")
    return failures


def evidence_locations(target, note):
    places = []
    for item in note.get("evidence", []):
        file_lines = target.lines(item["path"]) or []
        for number, line in enumerate(file_lines, 1):
            if item["contains"] in line:
                places.append(f"{item['path']}:{number}")
                break
    return places


def escape(text):
    return text.replace("|", "\\|").replace("\n", " ")


def build_ledger(target_ref, resolutions_path):
    decisions, notes = load_resolutions(resolutions_path)
    target = Target(target_ref)
    diff = git("-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff",
               "--no-textconv", "--no-renames", "-U3", BASE, STABLE)
    hunks = parse_diff(diff)
    stable_introduced = set(git("rev-list", f"{BASE}..{STABLE}").split())
    stable_prs = {}
    previous = BASE
    for commit in git("rev-list", "--first-parent", "--reverse", f"{BASE}..{STABLE}").split():
        subject = git("log", "-1", "--format=%s", commit).strip()
        pr = PR_MERGE.match(subject)
        for introduced in git("rev-list", f"{previous}..{commit}").split():
            stable_prs[introduced] = f"#{pr.group(1)}" if pr else commit[:9]
        previous = commit

    rows, errors, used_notes = [], [], set()
    counts = {}
    for number, hunk in enumerate(hunks, 1):
        outcome = match_hunk(target, hunk)
        note = notes.get(hunk.key)
        sources = stable_commits(hunk, stable_introduced)
        source_text = ", ".join(f"{c[:9]} ({stable_prs.get(c, '?')})" for c in sources) or "-"
        if outcome["matched"]:
            if note is not None:
                used_notes.add(hunk.key)
                errors.append(f"stale note: {hunk.key} matches mechanically; remove the note")
            if outcome["kind"] == "removal":
                status, how = "present", "mechanical"
                where = outcome["detail"]
            else:
                merge = attribute(target, outcome)
                location = f"{outcome['path']}:{outcome['span'][0]}"
                if merge is None:
                    status, how = "superseded", "mechanical"
                    blamed = ", ".join(c[:9] for c in pre_existing_commits(target, outcome))
                    where = (f"lines already at {location} before the convergence "
                             f"(blame {blamed})")
                else:
                    status, how = "present", "mechanical"
                    where = f"at {location} ({target.describe(merge)})"
        elif note is not None:
            used_notes.add(hunk.key)
            status, how = note["status"], "note"
            decision = f" [decision {note['decision']}]" if note.get("decision") else ""
            places = evidence_locations(target, note)
            seen = f" Evidence at {', '.join(places)}." if places else ""
            where = (f"{note['ref']}{decision}: {note['note']}{seen} "
                     f"(mechanical: {outcome['detail']})")
            for failure in check_evidence(target, note):
                errors.append(f"evidence missing for {hunk.key}: {failure}")
        else:
            status, how = "UNRESOLVED", "-"
            where = outcome["detail"]
            errors.append(f"unresolved: {hunk.key} ({outcome['detail']})")
        counts[(status, how)] = counts.get((status, how), 0) + 1
        rows.append((number, hunk, source_text, status, how, where, outcome))
    for key in notes:
        if key not in used_notes:
            errors.append(f"orphan note: {key} names no hunk of the diff")
    return target, hunks, rows, counts, decisions, errors


def render(target, hunks, rows, counts, decisions, errors):
    out = [
        "# zay/stable-image port ledger",
        "",
        "Generated by `scripts/fork-convergence/stable_image_ledger.py`; do not edit by hand.",
        "Re-run from the repository root with `python3 scripts/fork-convergence/stable_image_ledger.py "
        "--target <ref> --output scripts/fork-convergence/stable-image-ledger.md`; evidence notes are in "
        "`scripts/fork-convergence/stable-image-ledger-resolutions.json`.",
        "",
        f"- Diff: `git diff -U3 --no-renames {BASE[:9]} {STABLE[:9]}` (merge base .. zay/stable-image tip)",
        f"- Target: `{target.ref}` at `{target.sha[:9]}`",
        f"- Convergence series: first-parent commits after `{PRE_CONVERGENCE[:9]}`",
        f"- Hunks: {len(hunks)}",
        "",
        "## Summary",
        "",
        "| Status | How | Hunks |",
        "|---|---|---|",
    ]
    for (status, how), count in sorted(counts.items()):
        out.append(f"| {status} | {how} | {count} |")
    out += ["", "## Decisions", ""]
    for decision in decisions.values():
        out.append(f"- `{decision['id']}` ({decision['date']}): {decision['text']}")
    if errors:
        out += ["", "## Errors", ""] + [f"- {escape(e)}" for e in errors]
    out += ["", "## Hunks", "",
            "| # | Path | Hunk | Stable source | Status | How | Evidence |",
            "|---|---|---|---|---|---|---|"]
    for number, hunk, source_text, status, how, where, _ in rows:
        out.append(f"| {number} | `{hunk.path}` | `{hunk.header}` | {source_text} | "
                   f"{status} | {how} | {escape(where)} |")
    return "\n".join(out) + "\n"


def explain(rows):
    out = []
    for number, hunk, _, status, how, _, outcome in rows:
        if outcome["matched"]:
            continue
        out.append(f"## {number} {hunk.key} [{status}/{how}] {outcome['detail']}")
        out.extend(f"    missing: {line}" for line in outcome.get("missing", []))
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser(
        description="Port ledger for the zay/stable-image -> zay/main convergence.")
    parser.add_argument("--target", default=DEFAULT_TARGET)
    parser.add_argument("--resolutions", type=Path, default=RESOLUTIONS_FILE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--explain", action="store_true",
                        help="print the added lines not found for each unmatched hunk")
    args = parser.parse_args()
    target, hunks, rows, counts, decisions, errors = build_ledger(args.target, args.resolutions)
    text = render(target, hunks, rows, counts, decisions, errors)
    if args.explain:
        text = explain(rows)
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
