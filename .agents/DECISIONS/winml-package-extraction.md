# WinML Package Extraction Decisions

## Refactor Analysis

- Task size pressure: medium to high because the slice crosses Python package layout, backend runtime scripts, Nx targets, and tests.
- Refactoring risk: medium.
- Preparatory refactor needed?: yes, but only to isolate WindowsML implementation code from backend imports.
- Current-scope refactor candidates: WindowsML runtime/provider modules, NPU prepass helpers, model preparation/probe/smoke CLIs, PyInstaller entrypoint.
- Cleanup to avoid: generic OCR platform registry, Intel/Linux implementations, desktop Rust/TS rework, unrelated runtime-installation UI changes.
- Suggested implementation slices: package scaffold, runtime module move, script shim compatibility, backend build import updates, focused verification.
- Behavior-preservation checks: existing WindowsML unit tests and backend lint; project graph includes package.
- Review/checkpoint needs: keep backend targets stable so existing root scripts and packaging lanes remain callable.
- Decision: normal implementation with a narrow package extraction; do not invoke a broad refactor worker.

## Chosen Shape

Create `packages/cert-prep-ocr-windowsml` as a Python package with its own `pyproject.toml`, `project.json`, source tree, and tests. The backend app depends on it through a local editable/path dependency. Backend scripts under `apps/cert-prep-backend/scripts/runtime/windowsml` become compatibility shims where needed so current Nx targets remain stable.

## Rejected Options

- `@nx/js:library`: rejected because the extracted code is Python runtime and diagnostics code.
- Generic `packages/cert-prep-ocr-platform`: rejected for this slice because future hardware/OS combinations are still speculative and a broad framework would increase coupling.
- Move desktop Rust/TS WindowsML environment handling now: rejected because it is app integration behavior, not the reusable WinML implementation.
