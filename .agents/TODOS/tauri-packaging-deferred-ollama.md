# Tauri Packaging With Deferred Runtimes TODO

- [x] Add backend model-download job API and tests.
  Verify: `pnpm nx run exam-prep-backend:test`

- [x] Regenerate Angular OpenAPI client after backend schema changes.
  Verify: `pnpm nx run exam-prep-backend:generate-openapi-client`

- [x] Add Angular confirmation/progress UI for model download.
  Verify: `pnpm nx run exam-prep:test`

- [x] Add runtime requirement/install APIs for Ollama, model, and PaddleOCR.
  Verify: `pnpm nx run exam-prep-backend:test`; `pnpm nx run exam-prep-backend:generate-openapi-client`

- [x] Split PaddleOCR out of the initial sidecar into an optional hashed runtime artifact.
  Verify: `pnpm nx run exam-prep-backend:build-sidecar`; `pnpm nx run exam-prep-backend:build-ocr-runtime-gpu`

- [x] Add Angular use-time prompts for Ollama/model/PaddleOCR setup.
  Verify: `pnpm nx run exam-prep:test`; `pnpm nx run exam-prep:lint`

- [x] Adjust lite sidecar packaging lane and add packaged QA/size script.
  Verify: `pnpm nx run exam-prep-desktop:cargo-test`

- [x] Build the Windows x64 Tauri package and record artifact sizes.
  Verify: `pnpm nx run exam-prep-desktop:package-qa`

- [x] Run final lint/build checks.
  Verify: `pnpm nx run exam-prep-backend:lint`; `pnpm nx run exam-prep-backend:test`; `pnpm nx run exam-prep:build`; `pnpm nx run exam-prep-desktop:lint`; `pnpm nx run exam-prep-desktop:cargo-test`
