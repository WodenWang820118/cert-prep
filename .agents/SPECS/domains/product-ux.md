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
- Wrong-answer AI help is a per-card, single grounded explanation. Provider
  failures fall back to deterministic copy and must not block refresh, manual
  review, or clearing by a later correct attempt.

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
