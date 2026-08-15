# Parsing and reasoning domain

## Ownership

Capture Runtime owns PDF/image/audio extraction, OCR, Whisper, runtime
requirements, readiness, and extraction failures. This domain owns only Cert
Prep's Ollama reasoning, study profile, question generation, and practice
readiness after a validated CaptureDocument has been persisted.

## Reasoning contract

- The supported provider is Ollama with the fixed `qwen3.5:4b` study profile.
- `auto` resolves to that local provider/profile; there is no alternate model
  or provider fallback.
- CPU execution is an explicit execution mode with an explicit warning. It is
  not a provider or model fallback.
- Generated questions remain editable and require source evidence before they
  become playable.
- Parsed blocks are completed independently: grounded completions are persisted
  as playable questions, while blocks that cannot be completed are retained as
  operation-level `needs_review` annotations with their source order, question
  number, page, excerpt, and reason. A partial completion must not be replaced
  by a broad prompt or another provider.
- Reasoning failure does not corrupt or remove a successfully persisted source
  document or its raw capture provenance.

## Source boundary

The documents pipeline validates the uploaded envelope locally, then routes PDF,
image, and audio to `CertPrepCaptureCoordinator` and `CaptureRuntimeClient`.
Only the sidecar-validated v2 `CaptureDocument` enters host structuring and
SQLite persistence. See `capture-runtime-integration.md` for the capture
contract and fail-closed policy.

## Recovery

Document cancellation, retry, timeout, and runtime-unavailable states are
durable and explicit. Raw/result validation, review confirmation, and process
cleanup must complete before the capture job is removed. Draft-generation jobs
remain isolated by project and document and retain their existing restart and
wrong-answer recovery contracts.

## Verification

Use the backend/frontend/desktop Nx tests, package QA, release contract tests,
real Capture Runtime consumer smoke, and `git diff --check`. Do not add a Cert
Prep extraction provider, health endpoint, runtime installer, package, or
fallback to satisfy a failed smoke.
