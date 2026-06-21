# Product And UX Domain

## Purpose

Exam Prep is a local-first Windows/Tauri certification-prep app. The core user
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
- Source import uses `language_hint`; `auto` remains the default, while QA uses
  `ja` for the JLPT production PDF.
- Polling is the current async parsing transport. SSE/WebSocket remains a
  future option only if polling becomes visibly expensive or laggy.
- Manual answer/rationale entry is a production fallback, not a debug-only path.
- Full Exam and Random Quiz consume playable editable questions. Older
  approval-gated draft language is superseded.

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

## Open Risks

- Large source text previews can make review/edit surfaces tall; a collapsible
  chunk preview or focus mode may be worth a later UX slice.
- Copy/i18n cleanup remains separate from current parsing/reasoning gates.
- Angular initial bundle budget warning is known and not part of the active
  parsing/reasoning TODO.
- Session/debug replay for random seeds should stay backend-testable so UI
  failures can be reproduced without fragile manual clicks.
