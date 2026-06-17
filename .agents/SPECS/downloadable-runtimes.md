# Downloadable Runtimes Spec

## Purpose

Package Exam Prep with a lightweight Tauri shell that can start only after a user-approved Python/backend runtime download. After the backend is running, the app surfaces a startup runtime checklist for Ollama, `gemma4:12b`, and PaddleOCR.

## Non-Goals

- Do not install a machine-wide Python interpreter.
- Do not auto-install Python/backend, Ollama, models, or PaddleOCR from startup or health checks.
- Do not bundle Ollama, model files, or PaddleOCR payloads in the initial installer.
- Do not change browser development mode beyond keeping the local backend fallback usable.

## Interfaces

- Tauri exposes `desktop_runtime_status`, `start_python_runtime_installation`, `get_python_runtime_installation`, and the existing `backend_config`.
- `desktop_runtime_status` reports whether the packaged Python/backend runtime is installed and running, plus backend config when ready.
- Runtime artifacts use manifest files with `kind`, `version`, `target`, `entrypoint`, and `artifact` metadata containing file name, SHA-256, byte size, and release asset URL.
- Backend `/health` keeps existing fields and adds `python_version` and `runtime_mode`.
- Existing backend runtime install APIs remain responsible for Ollama, the configured Ollama model, and PaddleOCR.

## Key Decisions

- Treat the Python runtime as the PyInstaller backend executable packaged as a downloadable zip.
- Store installed runtimes under the Tauri app data directory.
- Verify byte size and SHA-256 before extracting any runtime artifact.
- Use release asset URLs injected during packaging; package QA fails when required URLs are missing.
- Keep Angular state split between desktop runtime bootstrap and backend OpenAPI health/runtime state.

## Edge Cases and Failure Modes

- Missing Python/backend runtime lets the UI load and shows the first checklist row as installable.
- Failed backend launch reports an unhealthy runtime state and does not attempt Ollama or OCR checks.
- A second install request for the same active Python runtime job returns the existing job.
- Missing release URL fails the install job with a clear runtime artifact message.
- PaddleOCR manifest and artifact hash/size must match the release asset metadata before install.

## Acceptance Criteria

- Packaged Tauri startup no longer fails just because the Python/backend runtime is absent.
- Backend HTTP calls are gated until the desktop runtime is running.
- The UI shows an ordered startup checklist: Python/backend, Ollama, Gemma, PaddleOCR.
- Gemma download is unavailable until Ollama is installed/running.
- PaddleOCR can be prompted from startup and still from image-only PDF import.
- Package QA validates backend and OCR manifests, URLs, artifact bytes, hashes, and runtime launch.

## Test Plan

- `pnpm nx run exam-prep-backend:test`
- `pnpm nx run exam-prep-backend:generate-openapi-client`
- `pnpm nx run exam-prep:test`
- `pnpm nx run exam-prep:build`
- `pnpm nx run exam-prep-desktop:package-qa-test`
- `pnpm nx run exam-prep-desktop:cargo-test`
