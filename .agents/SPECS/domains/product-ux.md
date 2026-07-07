# Product And UX Domain

## Purpose

Cert Prep is a local-first Windows/Tauri certification-prep app. The core user
journey is: create/select a project, upload a PDF, parse it with OCR when
needed, review editable questions, practice through Full Exam or Random Quiz,
and clear wrong-answer review state through correct attempts.

The production acceptance path is deterministic/manual first. AI reasoning is
optional enrichment and must not block OCR, manual question creation, practice,
or review flows.

## Decisions

- Projects own source PDFs, parsed chunks, editable question records, practice
  sessions, and wrong-answer review state.
- The Angular UI keeps workflow panels for projects, source import, question
  review/editing, practice, and wrong-answer review.
- Runtime status is compact: header chips plus a Manage runtime drawer, not a
  large first-screen checklist.
- Runtime status can be healthy while practice is still blocked by missing
  playable questions. Build, Full Exam, and Random Quiz must surface the
  practice-blocking reason when streamed questions exist but are not selectable.
- Source import uses `language_hint`; `auto` remains the default, while QA uses
  `ja` for the JLPT production PDF.
- Polling is the current async parsing transport. SSE/WebSocket remains a
  future option only if polling becomes visibly expensive or laggy.
- Manual answer/rationale entry is a production fallback, not a debug-only path.
- Full Exam and Random Quiz consume playable editable questions. Older
  approval-gated draft language is superseded.
- A playable question requires approved status, question text, at least two
  nonempty choices, an answer present in the choices, rationale, and either a
  citation page or source excerpt.
- Source PDF, Draft Review, and Full Exam share an explicit active document
  selection. Draft Review defaults to active-document questions and shows active
  counts against the project total.
- Source import supports selecting multiple PDFs in one batch while preserving
  the document library. The client uploads files sequentially, keeps
  selected/uploaded/failed item states visible, treats successful uploads as
  partial success when another file fails, and makes the most recent successful
  document active.
- Wrong-answer AI help is a per-card, single grounded explanation. Provider
  failures fall back to deterministic copy and must not block refresh, manual
  review, or clearing by a later correct attempt.
- Practice sessions persist the selected playable question fields at session
  creation. Attempts and wrong-answer review grade/read from that session-time
  snapshot, with a live-draft fallback only for older sessions.
- Wrong Answers supports focused retry paths: per-card `Retry` starts a
  `review_retry` session for that attempt, and `Start review quiz` starts a
  `review_retry` session for all current wrong answers. Both flows navigate to
  the existing practice runner and use session-time question snapshots.
- Wrong Answers shows compact weak-area metrics from the backend summary:
  current and cleared counts, last wrong date, repeated misses, and source page
  clusters. The summary remains project-scoped and distinguishes current wrong
  answers from cleared history.
- Wrong-answer responses carry `document_id` for per-PDF grouping. Filenames
  remain client-derived from loaded documents instead of duplicating filename
  metadata on the wrong-answer DTO.
- `Mark for review` is removed from the practice runner until there is a real
  persisted user flag. Settings, Account, and footer links remain disabled
  design-parity placeholders.

## Evidence

- Saved parsed exams and runtime UX packaged QA covered Python/PaddleOCR
  readiness, PDF upload, 46 pages / 46 chunks, manual questions, restart
  persistence, Full Exam, Random Quiz, wrong-answer recording, and review
  clearing.
- Production PDF upload QA used the real JLPT PDF under `pdfs/` and confirmed
  the image-only OCR path with `paddle_ocr_gpu` on `gpu:0`.
- UX performance QA showed the app stayed usable during parsing and that manual
  editing/practice remained viable even when Ollama/model state was offline.
- Latest packaged flow smoke evidence is tracked in
  `domains/parsing-reasoning.md` because it now gates first-chunk and reasoning
  behavior.
- The 2026-06-26 packaged UI/backend/design gap audit passed mocked app e2e and
  packaged flow smoke after the smoke harness was aligned with the new
  workbench UI.
- The 2026-07-02 feature-roadmap implementation added deterministic Playwright
  coverage for completing every playable Random Quiz question, completing Full
  Exam questions for the selected PDF, excluding incomplete approved-looking
  drafts, wrong-answer AI/fallback review, two-PDF Full Exam isolation, and
  project-switch state clearing.
- Reference recordings were generated under
  `dist/.playwright/apps/cert-prep-e2e/recordings/` for
  `practice-complete`, `wrong-answer-ai`, and `multi-pdf-isolation`.
- The 2026-07-02 session-snapshot slice keeps grading and wrong-answer review
  stable even if an editable question changes after the session starts.
- The 2026-07-03 review retry slice added per-card retry, all-current-wrong
  review quiz startup, weak-area summary metrics, wrong-answer `document_id`,
  and practice runner snapshot rendering from `PracticeSessionRead.questions`.
- The 2026-07-03 UI placeholder closeout removed the disabled `Mark for
  review` affordance and added focused coverage for answer selection, clearing,
  disabled/busy submit states, navigator state, and disabled shell
  placeholders.
- The 2026-07-07 multi-PDF source-import closeout verified batch selection,
  sequential per-file uploads, failed-file visibility, active-document handoff,
  binary multipart filename matching, selected-PDF Full Exam startup, and
  reference `multi-pdf-isolation` recordings.

## Open Risks

- Large source text previews can make review/edit surfaces tall; a collapsible
  chunk preview or focus mode may be worth a later UX slice.
- Copy/i18n cleanup remains separate from current parsing/reasoning gates.
- Angular initial bundle budget warning is known and not part of the active
  parsing/reasoning TODO.
- Session/debug replay for random seeds should stay backend-testable so UI
  failures can be reproduced without fragile manual clicks.
- The packaged flow smoke currently records `MOCK ITEMS 0` after manual question
  creation. Decide whether that metric is parsed/generated-only or should also
  include manually authored draft questions.
- Bundle and component CSS warning budgets remain noisy after the feature
  roadmap slice, although the production build gate passes.
- Review retry, weak-area metrics, Mark for review policy, and wrong-answer
  document metadata were closed on 2026-07-03. Reopen a new TODO only for a
  persisted user-flag review feature or heavier analytics surface.
