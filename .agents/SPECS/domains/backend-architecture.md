# Backend Architecture Domain

## Purpose

This domain owns backend module boundaries, persistence contracts, generated
client ownership, and behavior-preserving refactor decisions across FastAPI,
SQLite, OCR, runtime installation, question generation, and practice.

## Decisions

- Domain code lives under `cert_prep_backend/domains/<domain>/`.
- Public DTOs are owned by their backend domain. OpenAPI client generation must
  be rerun after route/schema changes.
- SQLite remains backend-owned; Angular must not read or write local files
  directly.
- OCR workers must not write directly to the shared SQLite database. The backend
  processing thread owns idempotent chunk/progress persistence.
- Generated/AI questions must stay editable and user-governed. Older
  approval-only promotion behavior is retired.
- Runtime installation remains exposed through the
  `cert_prep_backend.domains.runtime_installations` package boundary.
- Behavior-preserving refactors should keep external Tauri command, REST, and
  generated client contracts stable unless the spec explicitly says otherwise.
- Practice session selection and attempt lookup share the backend playable
  predicate: approved question text, at least two nonempty choices, answer in
  choices, rationale, and source evidence from citation page or source excerpt.
- Practice sessions persist selected question snapshots when the session is
  created. Attempt grading and wrong-answer review prefer the immutable
  snapshot and fall back to the live draft only for sessions created before the
  snapshot table exists.
- Wrong-answer explanation API is
  `POST /projects/{project_id}/wrong-answers/{attempt_id}/explanation`.
  It must re-resolve the attempt as a current wrong answer in the same project
  before returning grounded fields, provider/model metadata, and fallback state.

## Refactor Evidence

- The SOLID/DDD refactor split Tauri app wiring, commands, backend process
  state, runtime installation, manifests, archive/download helpers, and Windows
  process helpers.
- Angular runtime health logic was separated around snapshot loading, API
  clients, requirement derivation, job views, status chips, and runtime drawer
  view-models.
- Python backend modules were clarified for source document persistence,
  progress/chunks/classification, runtime installers/manifests, deterministic
  parsing, Ollama/reasoning providers, fake providers, and normalization.
- Verification lanes for the refactor included backend pytest/ruff, Angular
  lint/test/build, desktop script typecheck/package-QA tests, cargo tests, and
  packaged production smoke.
- The 2026-07-02 feature-roadmap slice added project-isolation regression
  coverage for documents, chunks, question drafts, practice sessions, practice
  attempts, wrong answers, and wrong-answer explanations. The full backend gate
  passed with 172 pytest tests and ruff.
- OpenAPI generation was rerun for `WrongAnswerExplanationRead` and the
  generated `cert-prep-api` client passed lint, typecheck, and Vitest.
- The 2026-07-02 session-snapshot slice added backend practice and migration
  coverage for grading against stored session question fields and reading the
  latest wrong-answer attempt from the session snapshot; backend lint passed.

## Open Risks

- Backend schema changes require generated client updates and frontend tests.
- Page-level render/OCR failures should stay explicit; do not collapse a
  partial page failure into a misleading zero-chunk document.
- Source excerpts must remain grounded in normalized raw chunk text.
- UTF-8 handling remains important for PDF names, OCR text, SQLite evidence,
  Markdown reports, subprocess stderr, and PowerShell JSON reads.
- Keep stdout protocols for OCR workers clean; third-party logs belong on
  stderr.
