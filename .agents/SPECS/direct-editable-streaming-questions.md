# Direct Editable Streaming Questions

## Purpose

Replace the draft-and-approve product flow with direct streaming question
creation: OCR/page parsing can enqueue qwen work, qwen output is persisted as
playable question records as soon as it succeeds, and users can still edit the
question text, choices, answer, rationale, and source fields after generation.

## Non-Goals

- Do not add Kafka or another external broker.
- Do not auto-download Ollama models.
- Do not add compatibility shims for removed approve behavior.
- Do not rename the existing SQLite `question_drafts` table in this slice.
  The table remains the current storage table for editable question records.
- Do not store generated question text in packaged baseline artifacts.

## Interfaces

- Generated suggestions are persisted with `status="approved"` so practice can
  use them immediately.
- Manual `POST /projects/{project_id}/question-drafts` remains as the editable
  question creation API, but it creates playable question records by default.
- `PATCH /projects/{project_id}/question-drafts/{draft_id}` remains the edit API
  for text/choices/answer/rationale/source fields.
- Remove the approval endpoint and generated client method:
  `POST /projects/{project_id}/question-drafts/{draft_id}/approve`.
- Keep streaming job APIs for observability and retry:
  `/documents/{document_id}/draft-jobs` remains a local job-status API for now.
- Packaged streaming baseline measures time to generated editable questions,
  not time to draft review.

## Key Decisions

- Keep the underlying table/API path names for now to avoid a broad OpenAPI and
  migration rename while the product behavior changes.
- Treat `approved` as the persisted "playable editable question" state.
- Delete approval-specific policy, repository, router, store, and test code when
  no longer referenced.
- Keep grounding/source metadata in generated records so edits remain auditable.
- UI copy should say questions/items where possible; avoid asking users to
  approve generated output.

## Edge Cases and Failure Modes

- Missing qwen/Ollama remains a streaming job blocker and must not block OCR.
- Streaming jobs may succeed with zero generated questions for non-question
  pages; baseline pass criteria still requires all eligible jobs terminal and no
  failed/skipped status.
- Editing a generated question should not make it disappear from practice.
- Retry should append or dedupe generated questions without deleting existing
  playable records.
- The packaged close/process cleanup checks remain mandatory.

## Acceptance Criteria

- A freshly generated qwen streaming question is playable without pressing an
  approve button.
- Users can edit and save generated/manual question text and metadata after it
  is playable.
- No UI button or store method performs manual approval.
- Backend OpenAPI no longer exposes an approve endpoint.
- Dead approval-only code is removed.
- Packaged streaming baseline records OCR completion, first generated editable
  question timing, all job completion timing, generated/usable question counts,
  PDF hash/size, runtime metadata, and cleanup evidence.

## Test Plan

- `pnpm nx run exam-prep-backend:test --skip-nx-cache`
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache`
- `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache`
- `pnpm nx run exam-prep:test --skip-nx-cache`
- `pnpm nx run exam-prep:lint --skip-nx-cache`
- `pnpm nx run exam-prep:build --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:lint --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:packaged-streaming-baseline --skip-nx-cache`
- `git diff --check`

## 2026-06-19 Evidence

- Backend direct editable question path: `pnpm nx run exam-prep-backend:test
  --skip-nx-cache` passed, 95 tests; `pnpm nx run exam-prep-backend:lint
  --skip-nx-cache` passed.
- Angular direct-question UX: `pnpm nx run exam-prep:test --skip-nx-cache`
  passed, 41 tests; `pnpm nx run exam-prep:lint --skip-nx-cache` passed.
- Desktop scripts: `pnpm nx run exam-prep-desktop:typecheck-scripts
  --skip-nx-cache` passed; `pnpm nx run exam-prep-desktop:package-qa-test
  --skip-nx-cache` passed, 19 tests; `pnpm nx run
  exam-prep-desktop:lint --skip-nx-cache` passed.
- Packaged direct editable smoke passed:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T16-21-47-129Z/metrics.json`.
  It created a playable question directly, edited and saved it, used it in full
  exam/random quiz flows, cleared wrong-answer review, verified restart
  persistence, and closed with `gracefulExited=true`, `fallbackUsed=false`,
  `exitCode=0`, and no residual app/backend/OCR processes.
- Packaged qwen streaming baseline artifact:
  `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-19T13-33-48-372Z/streaming-baseline.json`.
  It scanned `46/46` pages into `46` chunks, produced `12/12` successful qwen
  editable questions with `qwen3:8b`, recorded first usable qwen question before
  parse completion, and closed with no residual processes.
- Health UX hardening now applies OCR health as soon as its endpoint resolves,
  so PDF scanning is not blocked by slower LLM/model health settling.
