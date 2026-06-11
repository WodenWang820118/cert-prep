# Tauri Packaging With Deferred Runtimes Spec

## Purpose

Package the Exam Prep app as a Windows x64 Tauri app that includes the Angular UI and a lite backend sidecar. Ollama, `gemma4:12b`, and PaddleOCR must stay outside the initial installer and be installed only after explicit user confirmation at the point of use.

## Non-Goals

- Do not bundle Ollama models into the installer.
- Do not bundle Ollama, PaddleOCR, PaddlePaddle, or OCR model payloads into the initial installer.
- Do not auto-install runtimes or auto-pull models during startup, health checks, upload, or draft generation.
- Do not add cross-platform packaging in this slice.

## Interfaces

- `GET /llm/health` remains read-only and reports provider/model availability.
- `GET /runtime/requirements` reports availability for `ollama`, `ollama_model`, and `paddle_ocr`.
- `POST /runtime/installations/{kind}` starts an explicit runtime/model installation job.
- `GET /runtime/installations/{job_id}` polls queued/running/waiting/succeeded/failed state, byte progress, detail, timestamps, and error text.
- `POST /llm/model-downloads` and `GET /llm/model-downloads/{job_id}` remain compatibility wrappers around the `ollama_model` runtime job.
- Tauri launches the sidecar with `EXAM_PREP_OCR_PROVIDER=paddle` and `EXAM_PREP_OCR_RUNTIME_MODE=external`.
- Tauri bundles only the lite backend sidecar plus the OCR runtime manifest; the OCR runtime ZIP/EXE is a separate release asset.
- Packaged QA writes raw diagnostics and artifact sizes to ignored benchmark output, then records the final size summary in decisions.

## Key Decisions

- Supersede the previous bundled GPU Paddle sidecar decision with a deferred PaddleOCR runtime artifact.
- Keep Ollama install and model pull logic behind explicit backend job APIs so the frontend can enforce confirmation.
- Verify OCR runtime artifacts with SHA-256 before extraction into per-user app data.
- Use Windows x64 as the packaging target for this pass.

## Edge Cases and Failure Modes

- If Ollama is missing, the UI prompts for the official Windows installer only when local AI generation is requested.
- If Ollama is installed but not running, health reports `ollama_not_running` without launching installers.
- If `gemma4:12b` is missing, the model pull starts only after user confirmation.
- If image-only PDF import needs OCR and PaddleOCR is missing, the backend returns `paddle_runtime_missing` so the UI can prompt and retry.
- Embedded-text PDFs do not require PaddleOCR.
- If a pull job for the same configured provider/model is already queued or running, return the existing job instead of starting a duplicate.
- If an OCR artifact hash check fails, the install job fails and leaves the active runtime unchanged.
- If the official Ollama installer requires user interaction, the job reports `waiting_for_user` and the UI offers status refresh.

## Acceptance Criteria

- Health checks and startup never install Ollama, pull models, or install PaddleOCR.
- Model pull starts only after user confirmation triggers the model job.
- PaddleOCR install starts only after an OCR-needed flow hits a missing runtime and the user confirms.
- UI can poll and display queued/running/waiting/succeeded/failed install states.
- Tauri build includes only the lite sidecar in `externalBin` and records installer, sidecar, OCR artifact, and browser bundle sizes.
- Initial installer size gate warns above 150 MB and fails above 250 MB unless explicitly documented.
- Verification commands in the TODO pass or have a documented environment blocker.

## Test Plan

- Backend tests cover no implicit install, explicit install success/failure, duplicate running job reuse, unsupported provider response, hash mismatch, image-only OCR missing, and OpenAPI schema generation.
- Frontend tests cover confirmation cancel, confirmation start, polling/progress display, and use-time prompts.
- Desktop/package verification runs Nx build/cargo/package targets plus the packaged QA size script.
