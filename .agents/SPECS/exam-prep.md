# Local Exam Prep Desktop App Spec

## Purpose

Build a local-first desktop app for exam preparation. Users create exam projects, import text-based past-paper PDFs, use Ollama with `gemma4:12b` to extract cited multiple-choice question drafts, approve those drafts into practice questions, complete practice sessions, and review wrong answers.

## Non-Goals

- Do not bundle Ollama or Gemma 4 12B in v1.
- Do not support scanned/image-only PDFs in v1; detect and report them as unsupported.
- Do not auto-promote AI-generated questions into active practice.
- Do not modify or remove the existing shop/API sample projects during v1 implementation.
- Do not support free-text or essay grading in v1.

## Architecture

- `apps/exam-prep`: Angular standalone desktop UI.
- `apps/exam-prep-e2e`: Playwright e2e project.
- `apps/exam-prep-desktop`: Tauri v2 desktop wrapper.
- `apps/exam-prep-backend`: Python FastAPI sidecar.
- `libs/exam/*`: focused Angular domain/API/ui libraries when useful.

The Python backend owns persistence, PDF storage, parsing, and Ollama access. Angular talks only to the backend HTTP API. Tauri launches the sidecar, chooses an ephemeral local port, passes app-data paths, and provides the backend base URL/token to Angular.

## Interfaces

- Backend binds to `127.0.0.1`.
- Backend requires a per-session bearer token supplied by Tauri.
- SQLite lives under `EXAM_PREP_DATA_DIR`.
- Uploaded PDFs are stored content-addressed by SHA-256.
- FastAPI OpenAPI is the source of truth for the API contract.
- Error responses use `{ "code": string, "message": string, "details"?: object }`.

Core domain entities:

- `ExamProject`: user-created project such as JLPT N1 or bar exam.
- `SourceDocument`: imported PDF metadata and content hash.
- `DocumentChunk`: extracted text tied to document/page/chunk id.
- `QuestionDraft`: AI-extracted candidate with citation, answer, choices, rationale, and validation status.
- `Question`: approved multiple-choice practice question.
- `PracticeSession`: question set taken by the user.
- `Attempt`: one submitted answer.
- `WrongAnswerReview`: review queue derived from incorrect attempts.

Question drafts cannot be approved unless they include a document id, page number, chunk id, source excerpt, choices, answer key, and rationale.

## Key Decisions

- Use `pnpm@10.33.2` and run Nx via `pnpm nx ...`.
- Use FastAPI, Pydantic, SQLite, pytest, ruff, PyMuPDF, and the official Ollama Python client.
- Use deterministic fake LLM providers in tests; live `gemma4:12b` checks are smoke/manual.
- Use Angular signals/services for UI state and standalone components.
- Use Tauri sidecar lifecycle for desktop packaging; do not expose filesystem writes to Angular.

## Edge Cases And Failure Modes

- Ollama not installed or not running: health/model endpoint reports actionable setup guidance.
- `gemma4:12b` missing: report model-missing and show `ollama pull gemma4:12b`.
- PDF has no selectable text: reject import with scanned-PDF/OCR-later status.
- AI output fails schema/citation validation: keep draft invalid and block approval.
- Backend token missing or invalid: return `401` with error envelope.
- App data directory missing: create it at backend startup.

## Acceptance Criteria

- A user can create an exam project.
- A user can import one selectable-text PDF into a project.
- The backend extracts page/chunk text and stores the original PDF by hash.
- The app generates cited multiple-choice question drafts via a fake provider in automated tests.
- A user can approve drafts into active questions.
- A user can complete a practice session and submit answers.
- Incorrect attempts appear in wrong-answer review.
- The desktop app can launch the Python backend sidecar and load the Angular UI.

## Test Plan

- Backend unit/API tests with pytest for domain services, persistence, auth, PDF extraction, fake LLM extraction, and approval rules.
- Angular service/component tests for project, import, draft review, practice, and wrong-answer UI state.
- Playwright e2e for the full create/import/approve/practice/review loop with deterministic data.
- Tauri Rust tests for sidecar command construction and configuration.
- Verification commands are tracked in `.agents/TODOS/exam-prep.md`.
