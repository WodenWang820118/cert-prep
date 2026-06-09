# Local Exam Prep Desktop App TODO

- [ ] Phase 1: Add planning artifacts.
  Verify: review `.agents/SPECS/exam-prep.md`, `.agents/TODOS/exam-prep.md`, and `.agents/DECISIONS/exam-prep.md`.
  Commit: `docs: add exam prep implementation plan`

- [ ] Phase 2: Migrate workspace to pnpm.
  Verify: `pnpm install --frozen-lockfile`; `pnpm nx show projects --json`; existing lint/test/typecheck targets.
  Commit: `chore: migrate workspace to pnpm`

- [ ] Phase 3: Scaffold app, backend, and desktop shells.
  Verify: `pnpm nx test exam-prep`; `pnpm nx build exam-prep`; `pnpm nx run exam-prep-backend:test`; `pnpm nx run exam-prep-desktop:cargo-test`.
  Commit: `feat: scaffold exam prep app shells`

- [ ] Phase 4: Add backend domain, storage, auth, and project CRUD.
  Verify: `pnpm nx run exam-prep-backend:test`; `pnpm nx run exam-prep-backend:lint`.
  Commit: `feat: add exam project storage backend`

- [ ] Phase 5: Add PDF ingestion and AI draft extraction.
  Verify: `pnpm nx run exam-prep-backend:test`; optional live Ollama smoke when Ollama is running.
  Commit: `feat: extract cited question drafts from PDFs`

- [ ] Phase 6: Add Angular full practice loop.
  Verify: `pnpm nx test exam-prep`; `pnpm nx build exam-prep`; `pnpm nx e2e exam-prep-e2e`.
  Commit: `feat: add exam prep practice workflow`

- [ ] Phase 7: Integrate Tauri sidecar runtime and packaging.
  Verify: `pnpm nx build exam-prep`; `pnpm nx run exam-prep-backend:test`; `pnpm nx run exam-prep-desktop:cargo-test`; Tauri dev/build smoke where host dependencies allow.
  Commit: `feat: integrate desktop sidecar runtime`

- [ ] Phase 8: Run guardrail review and cleanup.
  Verify: grill-me/second-opinion review, `git status --short`, and final verification summary.

