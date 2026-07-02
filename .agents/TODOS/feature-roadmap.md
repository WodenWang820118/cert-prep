# Feature TODO Roadmap

Date: 2026-07-02

## Purpose

This TODO tracks the next product-feature slices after the UI/function audit.
Keep `.agents/TODOS/ui-function-alignment-audit.md` as the audit record; use
this file as the implementation backlog for complete practice, wrong-answer
review, AI explanation, multi-PDF workflows, and project isolation.

## Current State

- The existing Playwright flow covers one mocked project, one PDF, one playable
  draft, Random Quiz, one wrong attempt, and Review navigation.
- Practice supports Random Quiz and Full Exam modes. Full Exam already builds
  payloads from a selected ready document with playable question counts.
- Backend documents, chunks, drafts, practice sessions, and wrong answers are
  structurally project-scoped, and uploaded PDFs are stored under a project
  upload directory.
- The frontend `SourceImportStore` keeps a document list, but the Source PDF
  and Draft Review surfaces still behave like a latest/current-document
  workbench rather than a visible project document library.
- Wrong Answers review displays current wrong answers, rationale, and source
  evidence. There is no AI mistake-discussion API, store state, or UI yet.

## Priority TODOs

### 1. Complete parsed-question practice e2e

Goal: every parsed/generated playable question can be answered end to end.

Acceptance criteria:

- Define an answerable question as having question text, at least two choices,
  a nonempty answer that appears in the choices, rationale, and citation/page
  or source excerpt evidence.
- Add Playwright coverage for Random Quiz completing all playable questions,
  including answer submission, session progress/completion, and wrong-answer
  recording.
- Add Playwright coverage for Full Exam completing all playable questions from
  the selected document.
- Add a mocked e2e case where incomplete approved-looking drafts are excluded
  from Random Quiz and Full Exam instead of appearing as broken questions.
- Keep unit coverage for store-level eligibility rules so the UI and backend
  cannot drift on what counts as playable.

Likely touchpoints:

- `apps/cert-prep-e2e/src/example.spec.ts`
- `apps/cert-prep-e2e/src/support/mock-api.ts`
- `apps/cert-prep-e2e/src/support/practice-flow.ts`
- `apps/cert-prep/src/app/stores/practice/*`

### 2. Wrong-answer review plus AI explanation

Goal: reviewing mistakes stays deterministic, while AI provides optional
grounded help.

Acceptance criteria:

- Keep the existing wrong-answer review and clearing policy as the base:
  a later correct attempt clears the item.
- Add a per-card "Discuss mistake with AI" action for Wrong Answers.
- Implement v1 as a single grounded explanation, not persistent chat.
- Ground the explanation in the wrong-answer record: question, selected answer,
  correct answer, rationale, citation page, and source excerpt.
- AI availability must never block manual review, retry, or clearing.
- When AI is unavailable, show deterministic fallback copy that keeps the card
  usable and explains that local AI is not ready.
- Add component and e2e assertions for populated wrong-answer cards: recorded
  count, page chip, selected answer, correct answer, rationale, source excerpt,
  refresh disabled state, and footer guidance.

Likely touchpoints:

- `apps/cert-prep-backend/src/cert_prep_backend/routers/practice.py`
- `apps/cert-prep-backend/src/cert_prep_backend/domains/practice/*`
- `apps/cert-prep/src/app/stores/wrong-answer-review.store.ts`
- `apps/cert-prep/src/app/components/wrong-answer-review/*`

### 3. Multiple PDFs per project and project isolation

Goal: one project can intentionally work with multiple PDFs, while projects
remain isolated.

Acceptance criteria:

- Add a visible project document library/selector to Source PDF and Draft
  Review so users can select any uploaded PDF in the current project.
- Preserve active document selection across Source PDF, Draft Review, Full Exam,
  chunk preview, parse status, and draft generation/retry actions.
- Default Draft Review to the active document.
- If "all project questions" remains available, make it an explicit mode with
  clear counts so drafts from another document are not mistaken as current.
- Add e2e coverage for two PDFs in one project: each PDF has distinct questions,
  selecting either document sends the expected Full Exam `document_id`, and the
  other document's questions are not shown in that session.
- Add backend regression tests for cross-project isolation: documents, chunks,
  drafts, practice sessions, and wrong answers from project A do not appear or
  resolve under project B.
- Add e2e coverage for project switching: prior document, draft, practice, and
  review state disappears, and subsequent API calls use only the selected
  project id.

Likely touchpoints:

- `apps/cert-prep/src/app/stores/source-import/*`
- `apps/cert-prep/src/app/components/source-import-panel/*`
- `apps/cert-prep/src/app/stores/draft-review/*`
- `apps/cert-prep-backend/tests/test_documents_upload.py`
- `apps/cert-prep-backend/tests/test_question_drafts.py`
- `apps/cert-prep-backend/tests/test_practice.py`

## Additional Product TODOs

- Add a review retry loop: retry one wrong question or start a Review Quiz from
  all current wrong answers.
- Add weak-area summary metrics: repeated misses, last wrong date, source page
  clusters, and cleared count.
- Decide whether the disabled "Mark for review" practice action becomes a real
  saved flag or is removed. If promoted, separate user-flagged items from
  incorrect-attempt items in Review.
- Decide whether wrong-answer responses should include `document_id` and
  filename for per-PDF grouping/filtering.

## API And Interface Notes

No public API change is required to create this TODO. Future implementation
slices should explicitly decide:

- whether to add a wrong-answer AI explanation endpoint;
- whether `GET /projects/{project_id}/question-drafts` gets a `document_id`
  filter or the frontend owns active-document filtering;
- whether wrong-answer records are enriched with source document metadata.

Generated OpenAPI client updates are required for any backend route or schema
change.

## Verification Gates

Doc-only updates:

- Review the diff for clarity and non-duplication with
  `.agents/TODOS/ui-function-alignment-audit.md`.
- `git diff --check`

Future feature slices:

- `pnpm nx run cert-prep:test --skip-nx-cache`
- `pnpm nx run cert-prep-e2e:e2e --skip-nx-cache`
- `pnpm nx run cert-prep:lint --skip-nx-cache`
- `pnpm nx run cert-prep-e2e:lint --skip-nx-cache`
- `pnpm nx run cert-prep:build`

## Assumptions

- AI mistake discussion v1 is a single grounded explanation, not persistent
  chat.
- Backend multi-PDF and project scoping are close enough structurally that the
  roadmap should emphasize UI selection and explicit isolation tests first.
- This TODO remains active until completed slices are folded into the relevant
  `.agents/SPECS` domain documents.
