# Exam Prep Backend DDD Refactor TODO

- [x] Add characterization tests and planning artifacts.
  Verify: `pnpm nx run exam-prep-backend:test --skipNxCache`

- [x] Add `domains/<domain>` package skeleton and split API schemas into domain packages without compatibility shims.
  Verify: `pnpm nx run exam-prep-backend:test --skipNxCache`

- [x] Move source document ingestion, PDF extraction, OCR ports, storage, and repository behavior into `domains/source_documents`.
  Verify: `pnpm nx run exam-prep-backend:test --skipNxCache`

- [x] Move mock exam provider contracts, parsing, draft repository, generation, and approval policy into `domains/mock_exams`.
  Verify: `pnpm nx run exam-prep-backend:test --skipNxCache`

- [x] Move practice session, attempt, and wrong-answer behavior into `domains/practice`.
  Verify: `pnpm nx run exam-prep-backend:test --skipNxCache`

- [x] Regenerate OpenAPI client and run final gates.
  Verify: `pnpm nx run exam-prep-backend:generate-openapi-client`; `pnpm nx run exam-prep:test`; `pnpm nx run exam-prep:build`; `pnpm nx run exam-prep-backend:lint`; `pnpm nx run exam-prep-backend:python-version-check`

- [x] Run `grill-me` Codex implementation review and fix blockers.
  Verify: reviewer reports no blocking findings.
