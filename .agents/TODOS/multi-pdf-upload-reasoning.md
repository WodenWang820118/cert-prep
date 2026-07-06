# Multi-PDF Upload And AI-Inferred Practice TODO

## Status

Implemented.

This slice turns source import from a single-PDF action into a bounded batch
workflow while keeping the existing single-document backend API and streaming
question-generation pipeline.

## Defaults

- Keep `POST /projects/{project_id}/documents` as the only upload endpoint for
  v1 batch upload.
- Upload PDFs sequentially from the Angular client.
- Treat batch upload as partial-success: failed files stay visible, while
  successful files continue parsing and question generation.
- Keep AI-inferred answers editable and user-governed through the existing
  `answer_key_source = ai_inferred` draft records.
- Do not block OCR, manual editing, practice, or wrong-answer review on LLM
  health or reasoning success.

## Implemented Work Packages

- Completed: Batch source-import UI
  - Allow multiple selected PDF files.
  - Render selected/uploaded/failed file states without hiding the active
    project document library.
  - Keep language hint and OCR-health upload gating behavior.
  - Verify: `pnpm nx run cert-prep:test`

- Completed: Batch upload store orchestration
  - Replace single selected-file state with a batch selection model.
  - Call the existing single-file upload API once per file.
  - Enforce client-side sequential upload concurrency.
  - Keep successful documents in the project document library and make the most
    recent success active.
  - Preserve partial failures with retry-ready state.
  - Verify: `pnpm nx run cert-prep:test`

- Completed: AI-inferred practice readiness
  - Keep using existing streaming draft jobs after document parsing.
  - Ensure `ai_inferred` drafts that meet the playable predicate appear in
    Draft Review and practice modes.
  - Ensure missing/skipped/failed reasoning jobs remain visible and retryable.
  - Verify: `pnpm nx run cert-prep-backend:test`

- Completed: Regression and acceptance coverage
  - Add Angular unit/component coverage for multi-file upload, partial failure,
    active-document selection, and OCR-only gating.
  - Extend mocked Playwright API for multiple upload calls.
  - Add e2e coverage for batch uploading two PDFs and starting Full Exam from
    the selected PDF only.
  - Add backend document-isolation coverage only if the current tests do not
    already prove sequential multi-upload isolation.
  - Verify: `pnpm nx run cert-prep-e2e:e2e`

## Final Verification

- `pnpm nx run cert-prep:test`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-e2e:e2e`
- `pnpm nx run cert-prep:build`
- `git diff --check -- .agents apps libs`
