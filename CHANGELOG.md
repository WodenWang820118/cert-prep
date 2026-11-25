# Changelog

## 0.1.0-alpha.1 - Unreleased

- Store and return source kinds as `pdf`, `image`, and `recording`.
  Existing source records are migrated when the database opens.
- Rename `CERT_PREP_MAX_UPLOAD_BYTES` to `CERT_PREP_MAX_PAGE_SOURCE_UPLOAD_BYTES`
  and `CERT_PREP_MAX_AUDIO_UPLOAD_BYTES` to `CERT_PREP_MAX_RECORDING_UPLOAD_BYTES`.
  Update configurations that set either upload limit. The old variables are ignored.
- Renamed `CERT_PREP_RUNTIME_INSTALL_TIMEOUT_SECONDS` to
  `CERT_PREP_LLM_INSTALL_TIMEOUT_SECONDS`.
- Rename the project question collection from `/question-drafts` to
  `/questions` and its edit path parameter from `draft_id` to `question_id`.
  Under `/projects/{project_id}/documents/{document_id}`, rename `/drafts` to
  `/questions`, `/draft-jobs` to `/question-jobs`, and `/draft-operations`
  to `/question-generations`. SSE event names change from `draft-jobs` and
  `draft-operation` to `question-jobs` and `question-generation`.
- Questions no longer have an approval status or rejection reason.
  The answer key source value `pdf` becomes `source`, and the document
  field `exam_item_count` becomes `question_count`.
- Rename `CERT_PREP_AUTO_GENERATE_EXAM_ON_UPLOAD` and
  `CERT_PREP_AUTO_GENERATE_EXAM_LIMIT` to `CERT_PREP_WRITE_QUESTIONS_ON_UPLOAD`
  and `CERT_PREP_WRITE_QUESTIONS_ON_UPLOAD_LIMIT`. Rename
  `CERT_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD`,
  `CERT_PREP_STREAMING_DRAFT_GENERATION_STRATEGY`,
  `CERT_PREP_STREAMING_DRAFT_GENERATION_PAGE_LIMIT`, and
  `CERT_PREP_STREAMING_DRAFT_WORKERS` to `CERT_PREP_QUESTION_JOBS_ON_UPLOAD`,
  `CERT_PREP_QUESTION_JOBS_STRATEGY`, `CERT_PREP_QUESTION_JOBS_CHUNK_LIMIT`,
  and `CERT_PREP_QUESTION_JOB_WORKERS`, respectively. Old names are not aliases.
- Migration 33 renames `question_drafts`, `draft_generation_jobs`,
  `manual_draft_generation_operations`, and `runtime_installation_jobs` to
  `questions`, `question_generation_jobs`, `manual_question_generations`,
  and `llm_installation_jobs`, and recomputes each source's `question_count`.
  Questions their author rejected are deleted, with their practice attempts;
  questions with any other status, awaiting approval included, become ordinary
  questions. Only releases before Cert Prep wrote statuses other than approved.
- `question_count` is always the source's total number of questions:
  generating questions again no longer records only the new ones, and a run
  that clears the source's text no longer sets it to 0.
- Serve capture reviews at `/projects/{project_id}/capture-reviews`. Report missing
  Capture engines as `capture_requirement_unavailable` and failed reviews as
  `capture_review_failed` with their stored cause.
- Record extraction provenance at publication and mark historical projections
  `reconstructed`. Review ingestion IDs come from Capture when available.
- Return the Desktop runtime installation release identity as `artifact`.
- Define the public unsigned Windows alpha release contract.
- Bundle the backend runtime and move WindowsML OCR to a verified release
  download.

Pending before the public Alpha release:

- Complete local runtime/model onboarding and provider attribution evidence.
- Complete resumable sessions, cancellation, and visible polling recovery.
- Pass installer-content, fresh-install, SBOM/license, and recorded hardware
  acceptance gates.
