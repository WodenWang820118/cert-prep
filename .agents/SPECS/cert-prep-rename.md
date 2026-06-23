# Cert Prep Rename Spec

## Purpose
Unify the workspace-facing product name to `cert-prep` across Nx projects, app/package directories, Python import roots, frontend API naming, desktop packaging metadata, scripts, and docs.

## Non-Goals
- Do not change OCR, LLM, document parsing, practice, or runtime installation behavior.
- Do not introduce old-name compatibility packages unless a verification blocker proves one is needed.
- Do not redesign the recently extracted WindowsML package architecture.

## Interfaces
- Nx project names become `cert-prep`, `cert-prep-e2e`, `cert-prep-backend`, `cert-prep-desktop`, and `cert-prep-ocr-windowsml`.
- App roots use `apps/cert-prep*`.
- The WindowsML package root uses `packages/cert-prep-ocr-windowsml`.
- Python import roots become `cert_prep_backend` and `cert_prep_ocr_windowsml`.
- Frontend generated API names become `CertPrep*` and file names become `cert-prep-api*`.
- User-visible title text becomes `Cert Prep`.

## Key Decisions
- Prefer a full internal rename over mixed compatibility shims so new work does not keep spreading the old slug.
- Preserve command entrypoints by updating the root package scripts to the new Nx project names.
- Keep evidence/output folders under `tmp/cert-prep-desktop` for new runs; old ignored local evidence is not migrated.

## Edge Cases and Failure Modes
- Nx project references can stay stale in `dependsOn`, Playwright webServer commands, root scripts, or Tauri hooks.
- Python package renames can miss dynamic strings such as `uvicorn module:function` entrypoints.
- Desktop manifests may contain generated local file URLs that need source-controlled names updated without requiring a full package QA run.
- OpenAPI generated TypeScript can keep old class/interface names unless regenerated or rewritten consistently.

## Acceptance Criteria
- `pnpm nx show projects --json` lists only `cert-prep*` for first-party app/runtime projects.
- Source-controlled files do not contain legacy app slug variants outside ignored local evidence.
- Backend tests pass through the new `cert-prep-backend` target.
- WindowsML package tests and lint pass through the new `cert-prep-ocr-windowsml` target.
- Frontend test/build targets resolve under `cert-prep`.
- Desktop script tests and Rust cargo tests resolve under `cert-prep-desktop`.

## Test Plan
- `pnpm nx show projects --json`
- `uv lock` from `apps/cert-prep-backend`
- `pnpm nx run cert-prep-ocr-windowsml:test`
- `pnpm nx run cert-prep-ocr-windowsml:lint`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-backend:lint`
- `pnpm nx run cert-prep:test`
- `pnpm nx run cert-prep:build`
- `pnpm nx run cert-prep-desktop:typecheck-scripts`
- `pnpm nx run cert-prep-desktop:package-qa-test`
- `pnpm nx run cert-prep-desktop:cargo-test`
