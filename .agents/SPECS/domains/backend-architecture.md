# Backend Architecture Domain

## Purpose

This domain owns backend module boundaries, persistence contracts, generated
client ownership, and behavior-preserving refactor decisions across FastAPI,
SQLite, OCR, runtime installation, question generation, and practice.

## Decisions

- Domain code lives under `cert_prep_backend/domains/<domain>/`.
- Shared platform modules can stay in place when they serve multiple domains.
- Public DTOs are owned by their backend domain. OpenAPI client generation must
  be rerun after route/schema changes.
- Endpoint paths and JSON field names stay stable unless a spec explicitly
  authorizes a contract change.
- Status-like fields may receive OpenAPI enum polish while preserving existing
  serialized string values.
- Historically string-backed fields can use enum-or-string DTO annotations so
  OpenAPI documents known values without rejecting legacy/custom strings.
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
- Practice sessions support `review_retry` mode. `PracticeSessionCreate` accepts
  optional `wrong_attempt_ids`; omitted means all current wrong answers for the
  project, while a provided list narrows retry to those current wrong-answer
  attempts.
- `PracticeSessionRead` includes `questions`, a session snapshot DTO with
  question text, choices, answer, rationale, citation page, source excerpt, and
  nullable `document_id`. `question_ids` remains for compatibility.
- `WrongAnswerRead` includes nullable `document_id`, and the project-scoped
  wrong-answer summary endpoint is
  `GET /projects/{project_id}/wrong-answers/summary`.
- Mixed PDF/static-image upload remains a client-side batch workflow over the
  existing single-document boundary. Backend v1 keeps
  `POST /projects/{project_id}/documents` as the only upload endpoint; its
  multipart field, operation header, status codes, response DTOs, and error
  envelope remain unchanged. PNG, JPEG/JPG, and static WebP are additive
  accepted inputs, with no database migration, `DocumentRead.media_type`, or
  image-specific endpoint/service. Chunks, generated drafts, practice
  selection, attempts, and wrong-answer review stay scoped by `document_id`.
- `source_preparation.py` owns trusted content detection and normalized OCR
  input. Source storage/repository helpers use source-file terminology, retain
  original bytes and SHA-256, choose private suffixes from detected content,
  and revalidate stored content on Retry. Legacy `.pdf` paths remain readable.
- Rolling back this additive input support does not require database or chunk
  cleanup, but an older backend cannot retry image documents created by the
  newer version.

## DDD And SOLID Refactor Policy

Accepted:

- Use `cert_prep_backend/domains/<domain>/` instead of layer-only package
  names.
- Keep generated mock exam drafts as `approved` when that is the current tested
  behavior.
- Remove schema and non-schema compatibility facades after callers move to
  domain modules.
- Use `pnpm nx ...` for verification.
- Require a second-opinion implementation review before closing broad backend
  refactor slices when requested by the active plan.

Deferred:

- ORM adoption.
- SQLite schema redesign.
- Frontend UX changes bundled into backend refactors.
- TypeScript generated-client literal-union support.
- Live LLM/OCR smoke checks as required automated gates.

Guardrails:

- No catch-all `utils.py` or god service.
- No large unrelated cleanup.
- No direct Angular filesystem or SQLite access.
- No live provider calls in deterministic tests.
- Every behavior move must be covered by characterization tests or existing API
  tests.
- Behavior-preserving refactors must keep REST/OpenAPI, Tauri command, and
  package QA JSON contracts stable unless the owning spec says otherwise.

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
- The 2026-07-03 review retry slice added SQLite migration 14 for nullable
  `practice_session_questions.document_id`, backend coverage for
  `review_retry`, generated OpenAPI/client updates, and aggregation coverage
  for current wrong counts, cleared counts, repeated misses, and
  document/page clusters.
- The 2026-07-07 multi-PDF closeout kept the REST contract stable and verified
  per-file uploads in one project, document-scoped chunks, upload-triggered
  streaming draft generation, and per-document `ai_inferred` drafts.
- The 2026-07-17 static-image source closeout kept the same REST, SQLite, and
  generated-client wire contracts while adding content-authoritative
  PDF/PNG/JPEG/WebP preparation. Backend tests covered raw-byte hash/storage,
  defensive decode, normalization, page-one OCR/chunks, Retry/cancel, and
  document/draft isolation; OpenAPI regeneration produced no TypeScript wire
  drift, and WindowsML package tests continued to accept normalized PNG input.

## Open Risks

- Backend schema changes require generated client updates and frontend tests.
- Page-level render/OCR failures should stay explicit; do not collapse a
  partial page failure into a misleading zero-chunk document.
- Source excerpts must remain grounded in normalized raw chunk text.
- UTF-8 handling remains important for PDF names, OCR text, SQLite evidence,
  Markdown reports, subprocess stderr, and PowerShell JSON reads.
- Keep stdout protocols for OCR workers clean; third-party logs belong on
  stderr.
