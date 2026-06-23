# WinML Package Extraction Spec

## Purpose

Move the WindowsML OCR runtime implementation out of `apps/cert-prep-backend` and into a reusable package under `packages/` so future hardware and OS lanes can be added as sibling runtime packages instead of growing backend app internals.

## Non-Goals

- Do not redesign OCR provider selection or the source-document domain.
- Do not move desktop app startup, Rust environment plumbing, or runtime-installation UI flows.
- Do not change default OCR provider behavior, packaged artifact names, or production evidence semantics.
- Do not add Intel or Linux implementations in this slice.

## Interfaces

- New package root: `packages/cert-prep-ocr-windowsml`.
- Python import root: `cert_prep_ocr_windowsml`.
- Backend app import surface:
  - `cert_prep_ocr_windowsml.runtime.WindowsMLRuntimeOCRProvider`
  - `cert_prep_ocr_windowsml.runtime.WindowsMLOCRRunner`
  - `cert_prep_ocr_windowsml.npu_prepass`
- WindowsML diagnostics and model preparation CLIs move from backend scripts into the package, with backend script shims preserving existing Nx command paths.
- The package owns WindowsML OCR runtime dataclasses and provider-unavailable exception for runtime-side use. Backend integration continues to communicate through the existing JSON runtime contract.

## Key Decisions

- The package is a Python package tracked by Nx via `project.json` and run-command targets, not an `@nx/js` generated library. The available JS generator does not match the Python runtime implementation being extracted.
- The backend keeps its `ocr-windowsml-*` targets as compatibility entrypoints for existing scripts, but their implementation imports from the package.
- Backend-specific contracts stay in the backend app. The WindowsML package should not import `cert_prep_backend`.
- The first package name is implementation-specific (`cert-prep-ocr-windowsml`) rather than a generic platform framework, keeping future Intel/Windows and Linux combinations as explicit packages.

## Edge Cases and Failure Modes

- Editable path dependency must be visible to `uv run` from `apps/cert-prep-backend`.
- PyInstaller must package the new import root and still exclude unrelated backend OCR providers.
- Existing tests that monkeypatch WindowsML internals need updated import paths.
- Existing script imports such as `runtime.windowsml.ocr_windowsml_probe` must continue to work through compatibility shims.
- No WindowsML health payload may claim reasoning/OCR success without the existing DirectML and provider-health evidence.

## Acceptance Criteria

- `pnpm nx show projects --json` includes `cert-prep-ocr-windowsml`.
- Backend WindowsML runtime code imports from `cert_prep_ocr_windowsml`, not `cert_prep_backend.domains.source_documents.adapters.windowsml`.
- Existing backend Nx targets for WindowsML probe, prepare, smoke, inference smoke, NPU smoke, benchmark, and runtime build still resolve.
- Existing backend unit tests for WindowsML runner/probe/prepare/smoke pass through `pnpm nx run cert-prep-backend:test`.
- `pnpm nx run cert-prep-backend:lint` passes.

## Test Plan

- Run package-level tests with `pnpm nx run cert-prep-ocr-windowsml:test`.
- Run focused backend WindowsML tests through `pnpm nx run cert-prep-backend:test`.
- Run backend lint through `pnpm nx run cert-prep-backend:lint`.
- Run `pnpm nx show projects --json` to confirm the package is part of the workspace graph.
