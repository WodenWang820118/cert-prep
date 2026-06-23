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
- WindowsML diagnostics and model preparation CLIs live in the package. Backend `ocr-windowsml-*` Nx target names remain stable and call package modules directly with `python -m`.
- The package owns WindowsML OCR runtime dataclasses and provider-unavailable exception for runtime-side use. Backend integration continues to communicate through the existing JSON runtime contract.

## Key Decisions

- The package is a Python package tracked by Nx via `project.json` and run-command targets, not an `@nx/js` generated library. The available JS generator does not match the Python runtime implementation being extracted.
- The backend keeps its `ocr-windowsml-*` target names as stable workspace entrypoints, but does not keep backend script/import shims.
- Backend-specific contracts stay in the backend app. The WindowsML package should not import `cert_prep_backend`.
- The first package name is implementation-specific (`cert-prep-ocr-windowsml`) rather than a generic platform framework, keeping future Intel/Windows and Linux combinations as explicit packages.

## Edge Cases and Failure Modes

- Editable path dependency must be visible to `uv run` from `apps/cert-prep-backend`.
- PyInstaller must package the new import root and still exclude unrelated backend OCR providers.
- Existing tests that monkeypatch WindowsML internals import from `cert_prep_ocr_windowsml` and package tooling modules directly.
- Old backend WindowsML shim imports are intentionally unsupported.
- No WindowsML health payload may claim reasoning/OCR success without the existing DirectML and provider-health evidence.

## Acceptance Criteria

- `pnpm nx show projects --json` includes `cert-prep-ocr-windowsml`.
- Backend WindowsML runtime code imports from `cert_prep_ocr_windowsml`, not from legacy backend adapter shims.
- Existing backend Nx targets for WindowsML probe, prepare, smoke, inference smoke, NPU smoke, benchmark, and runtime build still resolve.
- Package-owned WindowsML runner/probe/prepare/smoke tests pass through `pnpm nx run cert-prep-ocr-windowsml:test`.
- `pnpm nx run cert-prep-backend:lint` passes.

## Test Plan

- Run package-level tests with `pnpm nx run cert-prep-ocr-windowsml:test`.
- Run backend tests through `pnpm nx run cert-prep-backend:test` for backend integration behavior.
- Run backend lint through `pnpm nx run cert-prep-backend:lint`.
- Run `pnpm nx show projects --json` to confirm the package is part of the workspace graph.
