# Exam Prep Backend DDD Refactor Spec

## Purpose

Refactor the FastAPI backend into domain packages that make source ingestion, mock exam generation, practice, and projects easier to test and evolve without changing the user-visible workflow.

## Non-Goals

- Do not introduce a new ORM, database migration strategy, or persistence format.
- Do not require live Ollama, PaddleOCR, or GPU dependencies in deterministic tests.
- Do not redesign the Angular UI or endpoint paths during this refactor.

## Architecture

- Domain code lives under `exam_prep_backend/domains/<domain>/`.
- `app.py`, `main.py`, `config.py`, `database.py`, `dependencies.py`, and error-envelope handling remain shared platform code.
- Pre-DDD top-level store/provider modules are removed once their callers move to domain modules.

## Interfaces

- Preserve existing endpoint paths, HTTP methods, status codes, auth behavior, and error envelopes.
- Preserve serialized string values for public statuses and methods.
- API polish is limited to documenting known status-like values in backend/OpenAPI schemas without rejecting legacy/custom strings; frontend-generated client compatibility must be regenerated and verified.

## Acceptance Criteria

- Backend tests, lint, and Python version checks pass through Nx.
- Domain modules are cohesive, small, and grouped by feature.
- Public domain services, ports, and non-obvious policies have useful docstrings.
- Schema DTOs are imported from their owning domain packages; top-level compatibility facades are removed.
- A `grill-me` Codex sub-agent implementation review finds no blocking issues.

## Test Plan

- Add characterization tests before moving behavior.
- Cover source document ingestion, OCR fallback, mock exam parsing/approval, practice attempts, and OpenAPI enum documentation.
- Run `pnpm nx run exam-prep-backend:test`, `pnpm nx run exam-prep-backend:lint`, and `pnpm nx run exam-prep-backend:python-version-check`.
- Run generated client and frontend checks when OpenAPI output changes.
