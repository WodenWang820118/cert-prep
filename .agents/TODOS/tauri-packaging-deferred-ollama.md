# Tauri Packaging With Deferred Ollama Pull TODO

- [x] Add backend model-download job API and tests.
  Verify: `pnpm nx run exam-prep-backend:test`

- [x] Regenerate Angular OpenAPI client after backend schema changes.
  Verify: `pnpm nx run exam-prep-backend:generate-openapi-client`

- [x] Add Angular confirmation/progress UI for model download.
  Verify: `pnpm nx run exam-prep:test`

- [x] Adjust GPU-capable sidecar packaging lane and add packaged QA/size script.
  Verify: `pnpm nx run exam-prep-desktop:cargo-test`

- [x] Build the Windows x64 Tauri package and record artifact sizes.
  Verify: `pnpm nx run exam-prep-desktop:build-gpu`

- [x] Run final lint/build checks and grill-me review.
  Verify: backend lint/version checks, frontend build, desktop package QA.
