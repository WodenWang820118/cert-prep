# Async Parsing UX Flow Decisions

- Use a daemon thread and SQLite progress updates for local-first async parsing.
  This is enough for the packaged app and avoids adding a queue service.
- Poll every 1500 ms from the Angular store. This matches existing runtime and
  model polling behavior.
- Store `language_hint` on documents now, even if OCR model selection is a
  later refinement.
- Manual drafts stay `draft` until the user provides answer and rationale.
- Practice sessions only use approved drafts, preserving the existing data
  safety rule.
