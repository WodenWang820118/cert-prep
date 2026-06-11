# Tauri Packaging With Deferred Ollama Pull Spec

## Purpose

Package the Exam Prep app as a Windows x64 Tauri app that includes the Angular UI and a GPU-capable Paddle OCR backend sidecar. The app must only download an Ollama model after explicit user confirmation.

## Non-Goals

- Do not bundle Ollama models into the installer.
- Do not auto-pull models during startup, health checks, upload, or draft generation.
- Do not add cross-platform packaging in this slice.

## Interfaces

- `GET /llm/health` remains read-only and reports provider/model availability.
- `POST /llm/model-downloads` starts a background download job for the configured model.
- `GET /llm/model-downloads/{job_id}` polls job state.
- Tauri launches the sidecar with `EXAM_PREP_OCR_PROVIDER=paddle` and `EXAM_PREP_OCR_DEVICE=auto`.
- Packaged QA writes raw diagnostics and artifact sizes to ignored benchmark output, then records the final size summary in decisions.

## Key Decisions

- Use a single GPU-capable sidecar package and rely on Paddle runtime device selection for GPU/CPU fallback.
- Keep Ollama pull logic behind an explicit backend job API so the frontend can enforce confirmation.
- Use Windows x64 as the packaging target for this pass.

## Edge Cases and Failure Modes

- If Ollama is unavailable, the download job fails without crashing the app.
- If a pull job for the same configured provider/model is already queued or running, return the existing job instead of starting a duplicate.
- If CUDA is unavailable or GPU OCR fails, Paddle OCR falls back to CPU and records the fallback reason.
- If the build machine cannot exercise GPU OCR, packaging still succeeds and runtime QA reports CPU fallback.

## Acceptance Criteria

- Health checks and startup never call Ollama pull.
- Model pull starts only after user confirmation triggers `POST /llm/model-downloads`.
- UI can poll and display queued/running/succeeded/failed download states.
- Tauri build includes the sidecar and records installer/bundle and sidecar sizes.
- Verification commands in the TODO pass or have a documented environment blocker.

## Test Plan

- Backend tests cover no implicit pull, explicit pull success/failure, duplicate running job reuse, unsupported provider response, and OpenAPI schema generation.
- Frontend tests cover confirmation cancel, confirmation start, and polling/progress display.
- Desktop/package verification runs Nx build/cargo/package targets plus the packaged QA size script.
