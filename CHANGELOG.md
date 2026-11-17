# Changelog

## Unreleased

- Add a semantic conversation rail with inert capped hover/focus previews displayed outside the rail's scrolling region, loaded-history coverage, and keyboard/touch access. Turn activation uses the existing disclosure and confirms the selected native summary's viewport intersection rather than the containing message. No API, schema, or reading-state behavior changes.
- Place narrow native conversation navigation above the composer in its existing sticky dock, sharing composer growth and mobile-nav/safe-area offsets instead of an independent fixed height. Keep the stationary preview above the rail without resizing the dock or covering the composer.
- Keep historical conversation navigation consistent with the native transcript: preserve useful replies and activity, use neutral activity or agent-identity summaries, and do not restore obsolete execution status labels.
- Keep navigation coverage partial while native plan or transcript history is pending or failed, and report complete coverage only after those history owners recover.
- Converge the fork's former release line `zay/stable-image` into `zay/main`. Each stable change was ported as its own reviewed pull request (#27, #29 to #35, #37, #39, #40), or is recorded as superseded by upstream or as dropped by decision. `scripts/fork-convergence/stable_image_ledger.py` lists every hunk of the stable diff with its outcome and evidence. The final merge records `zay/stable-image` as an ancestor of `zay/main` without changing any file.
- Ship the stable one-time schedule migration as `0381_issue_one_time_schedules` with identical bytes, so a database that applied it as `0306` recognises it by content hash and does not run it again.
- Keep upstream's policy for local CLI runs that time out: the usage they streamed stays a pending receipt instead of being charged, so stable #26 and #28 are not carried over.
