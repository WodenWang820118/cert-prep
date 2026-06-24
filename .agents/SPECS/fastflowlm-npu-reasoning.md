# FastFlowLM NPU Reasoning Spec

## Purpose

Run the default `qwen3.5:4b` reasoning model through FastFlowLM's NPU-oriented
OpenAI-compatible server when the app is configured for FastFlowLM.

## Non-Goals

- Do not revive the retired standalone AMD NPU OCR provider.
- Do not auto-install FastFlowLM from health checks or app startup.
- Do not auto-download model files from health checks or app startup.
- Do not remove the existing Ollama provider path.

## Interfaces

- Backend env:
  - `CERT_PREP_LLM_PROVIDER=fastflowlm`
  - `CERT_PREP_FASTFLOWLM_BASE_URL=http://127.0.0.1:52625/v1`
  - `CERT_PREP_FASTFLOWLM_MODEL=qwen3.5:4b`
  - `CERT_PREP_FASTFLOWLM_FALLBACK_MODELS=qwen3.5:2b`
  - `CERT_PREP_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES=6442450944`
- FastFlowLM runtime expectation:
  - User starts FastFlowLM with `flm serve qwen3.5:4b`.
  - The backend uses `GET /v1/models` and `POST /v1/chat/completions`.
- Existing backend API remains unchanged:
  - `GET /llm/health`
  - `POST /llm/model-downloads`
  - `GET /llm/model-downloads/{job_id}`

## Key Decisions

- Implement FastFlowLM as a provider in the mock-exams domain because prompts,
  grounding, and draft validation remain domain-specific.
- Treat FastFlowLM as OpenAI-compatible HTTP, not as an Ollama-compatible API.
- Health reports `fastflowlm_missing` when `flm` is unavailable and
  `fastflowlm_not_running` when the local OpenAI-compatible endpoint is down.
- Desktop and packaged-smoke launches can select the provider with
  `CERT_PREP_LLM_PROVIDER`, defaulting the new production path to FastFlowLM.

## Edge Cases And Failure Modes

- FastFlowLM not installed: health is unavailable and no model download starts.
- FastFlowLM installed but no server: health is unavailable with a runtime
  not-running reason.
- Server running but `qwen3.5:4b` not served: health reports `model_missing`.
- Available system RAM below the configured `qwen3.5:4b` threshold: health and
  generation skip the 4B primary when possible and try served fallback
  `qwen3.5:2b` without auto-pulling it.
- JSON-mode request rejected: generation retries once without `response_format`
  and still validates returned JSON before saving drafts.
- Invalid model JSON never creates playable questions.

## Acceptance Criteria

- `CERT_PREP_LLM_PROVIDER=fastflowlm` creates a FastFlowLM provider with
  configured model `qwen3.5:4b`.
- `/llm/health` distinguishes missing FastFlowLM runtime from missing model.
- Draft generation can parse an OpenAI-compatible chat-completion response into
  grounded editable questions.
- Low available RAM can select served fallback `qwen3.5:2b` and exposes the
  RAM reason through `fallback_reason`.
- Desktop launch env and packaged smoke args can select FastFlowLM without
  hardcoded Ollama.
- Runtime UI labels FastFlowLM accurately and does not show "Ollama ready" for
  FastFlowLM failures.

## Test Plan

- Direct CLI gate:
  `pnpm nx run cert-prep-backend:streaming-cli-test`.
- Backend pytest for settings, provider health, and OpenAI-compatible draft
  generation stays in the direct CLI lane for fast development feedback,
  including low-RAM fallback to `qwen3.5:2b`.
- Desktop script tests for provider args and env surface.
- Angular component/store tests for FastFlowLM runtime-missing UI.
- Rust cargo tests for Tauri backend env selection.
- Packaged gate:
  `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache`.

## Closeout Evidence

- FastFlowLM installed from the official Windows installer; local `flm.exe`
  reports `FLM v0.9.43`.
- Local runtime:
  - `flm list` includes `qwen3.5:4b`.
  - `flm serve qwen3.5:4b --port 52625` listens on `127.0.0.1:52625`.
  - Direct OpenAI-compatible chat completion against
    `http://127.0.0.1:52625/v1/chat/completions` succeeds.
- Backend packaged health:
  - `/health` reports packaged mode `ok`.
  - `/llm/health` reports provider `fastflowlm`, configured/effective model
    `qwen3.5:4b`, and `available: true`.
- Packaged production evidence:
  - Command:
    `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache`.
  - Artifact:
    `tmp/cert-prep-desktop/packaged-streaming-production/2026-06-24T10-41-20-877Z/production-summary.json`.
  - Result: `status: passed`, `error_count: 0`, selected/effective model
    `qwen3.5:4b`, `fallback_reason: null`, 46/46 OCR pages, one
    document-capped streaming job succeeded, and Full Exam started from the
    streamed question.
  - Pipeline evidence: the first usable question appeared after parse
    completion (`first_usable_after_parse_complete: true`), matching the
    current OCR-complete-then-reasoning contract.
  - Routing evidence: WindowsML OCR observed
    `cert-prep-ocr-windowsml-runtime.exe` on AMD iGPU and avoided Nvidia dGPU
    process memory (`ocr_nvidia_process_memory_max_bytes: 0`).
  - Process evidence: packaged app cleanup was graceful with no app/backend/OCR
    residue; the smoke-started FastFlowLM PID was stopped after the run.
