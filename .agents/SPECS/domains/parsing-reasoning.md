# Parsing And Reasoning Domain

## Purpose

This domain owns OCR parsing performance, use-while-parsing UX, editable
question creation, streaming reasoning jobs, model-health gating, hardware
telemetry, and artifact-backed QA evidence for packaged desktop flows.

## Current Product Lane

- OCR provider: `windowsml`.
- OCR runtime package: `packages/cert-prep-ocr-windowsml`.
- OCR runtime artifact kind: `windowsml_ocr`.
- OCR runtime process: `cert-prep-ocr-windowsml-runtime.exe`.
- OCR device goal: WindowsML-loaded AMD iGPU, with CPU fallback kept visible in
  health/evidence when unsupported operators require it.
- LLM provider: `fastflowlm`.
- LLM model: `qwen3.5:4b`, with `qwen3.5:2b` as the explicit fallback model.
- Direct CLI test target:
  `pnpm nx run cert-prep-backend:streaming-cli-test`.
- Packaged smoke target:
  `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache`.

The retired pre-WindowsML iGPU product lane must not be revived as a provider,
target, package, runtime manifest, or product-ready evidence path.

## Pipeline Contract

1. The desktop/backend starts OCR only when a file upload requires parsing.
2. WindowsML OCR runs PaddleOCR on the AMD iGPU lane and emits page/chunk
   progress.
3. Reasoning waits for OCR completion, then checks the FastFlowLM model health.
4. If model health is blocked, the run records a visible blocker and does not
   silently install or pull models.
5. If model health is clear, FastFlowLM generates/editable questions through
   the streaming draft workflow.
6. After OCR and reasoning jobs reach terminal states, the packaged smoke must
   close the OCR and reasoning background processes.
7. New uploads are the trigger to start the OCR and reasoning processes again.

No Kafka or external broker is used for the first local-first streaming
implementation. The current design uses a SQLite-backed job queue/outbox and
bounded local workers.

## OCR Decisions

- `CERT_PREP_OCR_PAGE_WORKERS` defaults to `1`.
- Worker count `2` is only a measured option if same-build packaged QA improves
  wall time by at least 20%, keeps counts stable, improves first chunk, and
  stays under resource gates.
- Generic Paddle CUDA remains an override/debug path and is expected to favor
  Nvidia `gpu:0` on this Windows laptop.
- Pure CPU OCR must stay visible as fallback evidence, not a silent default for
  the iGPU lane.
- PaddleOCR NPU, NPU prepass, WindowsML device-policy proof paths, and old
  iGPU provider surfaces are retired.

## Reasoning Decisions

- FastFlowLM is the current Windows reasoning provider and is treated as an
  OpenAI-compatible local server path.
- FastFlowLM checks available system RAM before selecting the default 4B model;
  if RAM is below the configured threshold, it tries served fallback
  `qwen3.5:2b` and records the reason in model health.
- Reasoning output is optional enrichment and must not auto-download models,
  auto-approve questions, or expose hidden chain-of-thought.
- UI copy should say `Reasoning model` rather than hardcoding one model
  identity.
- Larger model comparator runs remain user-controlled research gates and should
  not be treated as startup defaults.
- Reasoning comparator work must collect RAM/VRAM residency evidence before
  parameter reduction, scored bakeoff reruns, or default-model changes.

## Direct Editable Questions

The approval-gated draft flow is retired. Generated/manual records are playable
editable questions immediately while preserving compatibility through the same
storage path where practical.

Closed scope:

- Backend generated/manual questions are playable immediately.
- Approval endpoint/client/store/button code was removed without compatibility
  shims.
- Angular review/editor flows treat records as editable questions.
- Packaged smoke/baseline records editable-question timing and skips old
  deterministic approval flow in streaming baseline mode.
- Approval-only code and stale active copy references were removed or
  retargeted.

## Evidence Gates

Direct CLI evidence is the fast development gate. It must prove the backend
pipeline contract without building or launching the packaged desktop app:

- Streaming reasoning jobs wait until OCR has finished parsing the uploaded
  document.
- FastFlowLM health/model blockers are recorded before generation, without
  auto-installing or pulling models.
- Low-RAM FastFlowLM fallback selects `qwen3.5:2b` when served and exposes a
  RAM-specific `fallback_reason`.
- FastFlowLM OpenAI-compatible draft generation still validates grounded JSON.
- WindowsML/iGPU policy tests keep the retired pre-WindowsML iGPU lane from
  becoming product evidence again.

Packaged product evidence is the release gate. It must prove these separately
after the WindowsML desktop package is built:

- OCR provider health reports `windowsml` and a selected AMD iGPU device when
  available.
- OCR model/runtime artifacts are present, checksum-verified, and installed only
  through explicit runtime consent.
- Resource telemetry observes `cert-prep-ocr-windowsml-runtime.exe` and records
  whether OCR used the AMD iGPU and avoided Nvidia dGPU residency.
- Reasoning provider health reports configured/effective FastFlowLM model,
  fallback model list, and blocker/fallback reason.
- Streaming jobs reach terminal states, usable questions are generated, and Full
  Exam can start from streamed questions.
- Process cleanup reports graceful close where possible and no residual smoke
  processes after final close.

Resource artifacts for packaged runs:

- `metrics.json`
- `streaming-baseline.json`
- `production-summary.json`
- `windows-dxgi-adapters.json`
- `windows-resource-sampling.csv`
- `windows-resource-summary.json`
- `nvidia-smi.csv`

## Retired Surfaces

Do not use or recreate these in current OCR work:

- standalone AMD NPU OCR provider/runtime/package paths
- WindowsML NPU prepass
- WindowsML device-policy proof flags
- old iGPU provider targets or runtime manifests
- backend shim/re-export paths for package-owned OCR runtimes

FastFlowLM reasoning NPU notes are separate from OCR and do not imply any
PaddleOCR NPU implementation.

## Provider Boundary Refactor Evidence

2026-06-25 backend LLM provider refactor:

- Shared primary/fallback model state now lives in `model_fallback.py` and is
  composed by both Ollama and FastFlowLM providers.
- Shared compact JSON, answer, confidence, fast-first prompt, and error
  normalization now lives in `response_parsing.py`.
- FastFlowLM HTTP, owned-server lifecycle, executable resolution, and RAM probes
  are split into focused backend-domain modules; FastFlowLM no longer imports
  helpers from `ollama_transport.py`.
- Streaming and runtime-installation dispatch use provider capabilities for
  reasoning, fast-first generation, resource release, generation startup, and
  streaming kwargs instead of concrete provider or provider-name checks.
- Evidence: `pnpm nx run cert-prep-backend:test -- tests/test_llm.py
  tests/test_documents_streaming.py tests/test_runtime_installations.py` passed
  72 tests; `pnpm nx run cert-prep-backend:streaming-cli-test` passed 33
  selected tests; `pnpm nx run cert-prep-backend:test --skip-nx-cache` passed
  162 tests; `pnpm nx run cert-prep-backend:lint --skip-nx-cache` passed; and
  `git diff --check` passed with CRLF conversion warnings only.

## Verification

- Orientation:
  `pnpm nx show projects --json`
- Fast direct CLI streaming gate:
  `pnpm nx run cert-prep-backend:streaming-cli-test`
- WindowsML package:
  `pnpm nx run cert-prep-ocr-windowsml:lint`
  `pnpm nx run cert-prep-ocr-windowsml:test`
- Backend:
  `pnpm nx run cert-prep-backend:lint`
  `pnpm nx run cert-prep-backend:test`
- Desktop scripts:
  `pnpm nx run cert-prep-desktop:typecheck-scripts`
  `pnpm nx run cert-prep-desktop:package-qa-test`
- Packaged product smoke:
  `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache`

## Active Backlog

No active parsing/reasoning TODO file remains at this checkpoint.

Deferred comparator reruns remain user-controlled and should only run after the
target models are intentionally installed.
