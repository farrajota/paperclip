# Changelog

## Unreleased

- Add a semantic conversation rail with inert capped hover/focus previews displayed outside the rail's scrolling region, loaded-history coverage, and keyboard/touch access. Turn activation uses the existing disclosure and confirms the selected native summary's viewport intersection rather than the containing message. No API, schema, or reading-state behavior changes.
- Place narrow native conversation navigation above the composer in its existing sticky dock, sharing composer growth and mobile-nav/safe-area offsets instead of an independent fixed height. Keep the stationary preview above the rail without resizing the dock or covering the composer.
- Keep historical conversation navigation consistent with the native transcript: preserve useful replies and activity, use neutral activity or agent-identity summaries, and do not restore obsolete execution status labels.
- Keep navigation coverage partial while native plan or transcript history is pending or failed, and report complete coverage only after those history owners recover.
