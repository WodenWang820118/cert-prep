# Async Parsing UX Flow Spec

## Purpose

Make long PDF imports feel alive and complete the user journey from parsing to
manual question review, practice, and wrong-answer cleanup in the packaged
Tauri app.

## Interfaces

- `POST /projects/{project_id}/documents` returns a `processing` document after
  storing the PDF and starts background extraction.
- `GET /projects/{project_id}/documents/{document_id}` returns the current
  document summary for polling.
- Upload accepts `language_hint`, defaulting to `auto`.
- `DocumentRead` includes `language_hint`.
- Draft editing uses the existing `PATCH /projects/{project_id}/question-drafts/{draft_id}`.

## Key Decisions

- Use polling, not WebSocket/SSE.
- Persist page-level parsing progress in SQLite after each processed page.
- Manual answer and rationale editing is the v1 production path.
- Gemma enrichment remains optional and is not required for this slice.

## Acceptance Criteria

- A real image-only PDF upload returns quickly with `status=processing`.
- UI shows parsing stage, page progress, chunks count, and available chunks
  while OCR is still running.
- Project, wrong-answer refresh, and already available draft actions are not
  globally disabled by parsing.
- Manual drafts can be edited, saved, approved, practiced, answered wrong, and
  later cleared by answering correctly.
- Packaged Tauri verification records screenshots and timing metrics.

## Test Plan

- Backend pytest for async upload/progress, language hint, stale processing
  recovery, draft update/approval, and practice wrong-answer lifecycle.
- Angular unit tests for polling, scoped busy behavior, draft editing, and
  source panel progress.
- Packaged Tauri build plus Playwright CDP production run against the real PDF.
