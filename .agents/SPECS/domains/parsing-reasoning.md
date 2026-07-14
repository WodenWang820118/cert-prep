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
- LLM provider policy: `auto`; compatible XDNA2 systems prefer `fastflowlm`,
  while unsupported hardware, an old driver, or declined FastFlow terms routes
  onboarding to `ollama`.
- LLM model: `qwen3.5:4b`, with `qwen3.5:2b` as the explicit fallback model.
- Direct CLI test target:
  `pnpm nx run cert-prep-backend:streaming-cli-test`.
- Packaged smoke target:
  `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache`.

The retired pre-WindowsML iGPU product lane must not be revived as a provider,
target, package, runtime manifest, or product-ready evidence path.

## Runtime Node Classification

Current and candidate runtime nodes are classified by platform and accelerator.
Only nodes that satisfy the evidence gates in this spec can be promoted to
product-ready.

OCR nodes:

| Platform | Node ID     | Status                     | Accelerator                                     | Distribution                                |
| -------- | ----------- | -------------------------- | ----------------------------------------------- | ------------------------------------------- |
| Windows  | `windowsml` | default                    | WindowsML-loaded AMD iGPU, CPU fallback visible | zip package extraction to local runtime dir |
| Windows  | `paddle`    | override/debug             | CUDA dGPU or CPU fallback                       | custom zip package or pip dependency        |
| macOS    | `paddle`    | deferred default candidate | CPU first, MPS/Metal deferred                   | platform zip package or local virtualenv    |
| Linux    | `paddle`    | deferred default candidate | CUDA dGPU or CPU fallback, ROCm deferred        | platform zip package or AppImage resource   |

LLM nodes:

| Platform | Provider     | Target model | Status                     | Accelerator                    |
| -------- | ------------ | ------------ | -------------------------- | ------------------------------ |
| Windows  | `fastflowlm` | `qwen3.5:4b` | default                    | OpenAI-compatible local server |
| Windows  | `ollama`     | `qwen3.5:4b` | override                   | local Ollama                   |
| Windows  | `ollama`     | `qwen3.5:9b` | hardware-gated override    | local Ollama                   |
| macOS    | `ollama`     | `qwen3.5:4b` | deferred default candidate | Apple Silicon GPU/CPU          |
| macOS    | `ollama`     | `qwen3.5:9b` | hardware-gated override    | Apple Silicon GPU/CPU          |
| Linux    | `ollama`     | `qwen3.5:4b` | deferred default candidate | Nvidia CUDA/CPU                |
| Linux    | `ollama`     | `qwen3.5:9b` | hardware-gated override    | Nvidia CUDA/CPU                |

Fallback policy:

- `qwen3.5:4b` remains the default low-latency editing/study model.
- `qwen3.5:9b` is a higher-capability explanation candidate, not a silent
  fallback.
- Ollama OOM or timeout on a `9b` request must surface a visible error instead
  of automatically falling back to `4b`.
- Missing local Ollama models can trigger confirmation-gated download jobs.

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
8. Client-side multi-PDF batches call the same upload endpoint once per file.
   Each successful document independently triggers OCR and streaming reasoning;
   failed reasoning remains visible/retryable and must not block OCR, manual
   editing, practice, or wrong-answer review for successfully uploaded files.

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

## WindowsML Package Ownership

- `packages/cert-prep-ocr-windowsml` owns the reusable WindowsML OCR runtime
  implementation.
- Python import root: `cert_prep_ocr_windowsml`.
- Backend app integrations import package-owned runtime code instead of legacy
  backend adapter shims.
- Backend `ocr-windowsml-*` Nx target names remain stable workspace entrypoints,
  but their commands execute package modules directly with `python -m`.
- Backend-specific contracts stay in the backend app. The WindowsML package
  must not import `cert_prep_backend`.
- The first extracted package is implementation-specific rather than a generic
  OCR platform framework; future Intel/Windows and Linux combinations should be
  explicit sibling packages.
- Editable path dependency must be visible to `uv run` from
  `apps/cert-prep-backend`.
- PyInstaller must package the new import root while excluding unrelated
  backend OCR providers.
- Old backend WindowsML shim imports are intentionally unsupported.
- No WindowsML health payload may claim OCR success without WindowsML provider
  health, selected AMD iGPU evidence, and packaged runtime evidence.

## Reasoning Decisions

### Public Alpha Provider And Evidence Contract (2026-07-11)

- One shared runtime policy owns `auto`, the `qwen3.5:4b` primary model, and
  the `qwen3.5:2b` low-resource fallback. Backend selection is authoritative;
  Angular consumes the provider-selection API and packaged scripts consume
  generated release metadata instead of copying defaults.
- Auto-selection does not silently hide missing dependencies. Compatible
  XDNA2 hardware with a missing FastFlow runtime/model remains selected for
  explicit onboarding. Unsupported hardware, an unsupported driver, or
  declined upstream terms selects Ollama. A generation failure never switches
  providers inside the same job; the failed job remains attributed and the UI
  offers an explicit provider change.
- App-managed FastFlow installation is pinned to official v0.9.43: 18,577,840
  bytes, SHA-256
  `0b0ec2c049222bba8e15f1d4d7093f89f2f25a6beeddd03bdb1fcac69002315e`,
  signer thumbprint `EBD8F43D1208A9F34CEC082CE94AD98D67BB2FF9`, and a valid timestamped
  Authenticode signature. Unallowlisted executables and arbitrary PATH/cwd
  resolution fail closed.
- Existing draft job `provider` and `model` fields mean configured values.
  Persisted `effective_provider`, `effective_model`, and `fallback_reason`
  record what actually generated output. Draft inserts, attribution, and job
  success commit atomically.
- Post-job provider health is not generation proof because an owned FastFlow
  server is deliberately released after a job. Production evidence records
  readiness at generation start, effective provider/model, fallback reason,
  and resource release separately.
- `MOCK ITEMS` and practice readiness use one definition: distinct editable
  questions in the selected scope with valid choices and an answer. Full Exam
  and packaged summaries use the same query.

### Public Alpha Recovery And Cancellation Contract (2026-07-11)

- Migration 15 gives practice sessions `active`, `completed`, and `abandoned`
  lifecycle semantics, backfills completed sessions from distinct answered
  questions, and enforces one active session per project. Angular restores the
  ordered attempts and requires an explicit Resume or two-step Abandon choice.
- Migration 16 preserves configured draft provider/model and adds effective
  attribution. Migrations 17 and 18 persist upload/OCR and automatic/manual
  draft operations. Migration 19 persists runtime/model installation jobs so
  cancel and crash recovery are not process-memory-only states.
- Long work uses `queued -> running -> cancel_requested -> canceled`; terminal
  states are irreversible. The cancel/success race is decided under the owning
  lock/transaction, and draft inserts plus success commit atomically.
- Uploads carry `X-Cert-Prep-Operation-Id` so a pre-response AbortController
  cancellation leaves a server-side tombstone. OCR cancellation preserves the
  source PDF for Retry while removing partial chunks/metrics and suppressing
  draft enqueue. Owned runtime/model/helper processes are terminated by process
  tree; non-cancellable commit phases are reported honestly.
- Polling retries transient failures after 1, 2, and 4 seconds. Exhaustion
  stops the spinner and exposes an actionable Retry state; stale responses may
  not overwrite a newer cancel/retry operation.

- On compatible XDNA2 Windows systems, FastFlowLM is the preferred reasoning
  provider and is treated as an OpenAI-compatible local server path. The
  authoritative `auto` policy routes unsupported hardware, old drivers, or
  declined FastFlow terms to Ollama onboarding.
- FastFlowLM is used through its OpenAI-compatible server instead of shelling
  out per prompt. Server mode matches the streaming job and health-check
  architecture.
- Runtime installation remains explicit. Health may detect `flm`, but it must
  not install FastFlowLM or pull `qwen3.5:4b`.
- Keep Ollama available as a supported provider for existing setups and tests.
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
- Packaged production summaries are provider-aware: Ollama still requires
  Nvidia dGPU reasoning evidence, while FastFlowLM requires model health,
  configured/effective model selection, and explicit fallback/blocker metadata.

## FastFlowLM Interfaces

- Backend env:
  - `CERT_PREP_LLM_PROVIDER=fastflowlm`
  - `CERT_PREP_FASTFLOWLM_BASE_URL=http://127.0.0.1:52625/v1`
  - `CERT_PREP_FASTFLOWLM_MODEL=qwen3.5:4b`
  - `CERT_PREP_FASTFLOWLM_FALLBACK_MODELS=qwen3.5:2b`
  - `CERT_PREP_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES=6442450944`
- Runtime expectation:
  - User starts FastFlowLM with `flm serve qwen3.5:4b`.
  - The backend uses `GET /v1/models` and `POST /v1/chat/completions`.
- Existing backend API remains unchanged:
  - `GET /llm/health`
  - `POST /llm/model-downloads`
  - `GET /llm/model-downloads/{job_id}`

FastFlowLM failure modes:

- FastFlowLM not installed: health reports an unavailable runtime.
- FastFlowLM installed but no server is running: health reports a not-running
  reason.
- Server running but `qwen3.5:4b` is not served: health reports
  `model_missing`.
- JSON-mode rejection retries once without `response_format`, then still
  validates grounded JSON before saving questions.
- Invalid model JSON never creates playable questions.

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

Recorded production evidence is optional for local development unless the
recorded production target is used; public Alpha hardware acceptance always
requires a recording. `cert-prep-desktop:packaged-streaming-production-recorded-windowsml`
adds Playwright WebView2 screencast evidence to the same packaged production
smoke and writes timestamped output under
`tmp/cert-prep-desktop/packaged-streaming-production-recorded`. When recording
is enabled, `metrics.json`, `streaming-baseline.json`, `streaming-baseline.md`,
and `production-summary.json` must reference at least one completed non-empty
`.webm` artifact with bytes, SHA-256, capture source, and recording status.
Browser-only Playwright e2e videos are review aids, not packaged production
acceptance evidence.

2026-06-26 packaged gap audit status:

- `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml`
  remained blocked as release evidence even though WindowsML OCR completed
  46/46 pages, produced 46 chunks, one streaming job succeeded, and one usable
  question was generated.
- The blocking product gap is that Full Exam still reported `0 questions in
selected document` for the selected document after the production streaming
  run. Reconcile streaming draft persistence, project/document selection, and
  the practice query path before calling the packaged release gate closed.
- The run did not prove the configured `qwen3.5:4b` FastFlowLM node:
  FastFlowLM was unavailable and model-selection checks were false even though
  the streaming job reached a terminal success state.
- Production summaries must carry `selected_model`, `effective_model`, provider
  health, and fallback/blocker attribution whenever generated questions are
  reported.

2026-07-11 local remediation status:

- The provider-selection API/generated client, exact configured/effective job
  attribution, transactional question persistence, shared practice-ready
  query, session recovery, and cancellation state machines are implemented and
  covered by backend/frontend tests.
- `cert-prep-e2e:e2e-real-backend` runs without `page.route`, starts an
  ephemeral backend with deterministic OCR/LLM fakes, and passed the
  create-answer-restart-Resume-complete-restart flow. Its five browser tests
  also cover real multipart multi-PDF upload, two transient 503 polling
  failures followed by recovery, pre-document-ID upload cancellation with a
  409 tombstone/stale-response guard, and two-step Abandon persisted by the
  practice API.
- The full backend suite passed 238 tests; Angular passed 160 tests; desktop
  Cargo passed 23 tests; package QA tests passed 61 tests; release tooling
  passed 27 Node plus 21 Python tests; mock Playwright passed 13 tests and the
  no-route real-backend project passed 5 tests. The Python 3.12 WindowsML runtime build
  also passed its executable self-test.
- These results retire the code-level causes behind the 2026-06-26 evidence
  inconsistency, but they do not close the packaged B3 gate. Closure still
  requires the exact public candidate SHA on the protected clean-snapshot
  XDNA2 lane: four PDFs, effective FastFlow `qwen3.5:4b`, no provider/model
  fallback, usable questions above zero, Full Exam count above zero, resource
  release, restart/cancel cleanup with individually hashed evidence, and a
  completed-run-bound WebM whose stream/duration/frames pass the protected
  runner's SHA-pinned `ffprobe`.

2026-07-14 local cancellation and integration closeout:

- Commit `175ea89` completed automatic/manual draft, runtime-install, and
  model-install GET/DELETE flows, persisted cancellation recovery, atomic
  cancel-versus-commit behavior, OpenAPI-first schemas, and the regenerated
  TypeScript client. Angular forwards `AbortSignal`, derives honest
  `phase/cancellable` state, and rejects stale operation responses.
- Migration 20 repairs duplicate active document operations before adding the
  partial unique index. Migration 21 keeps immutable draft attribution through
  `source_chunk_id`, uses `ON DELETE SET NULL` for removed chunks, and recovers
  detached jobs. Every migration runs in its own `BEGIN IMMEDIATE` transaction
  so a failed version rolls back completely and can be retried.
- Commit `bfb7ca6` added the isolated no-route real-backend Playwright project.
  Its five local tests cover generation/Full Exam, multi-PDF upload, bounded
  polling recovery, pre-document-ID cancellation with stale-response rejection,
  and persisted session Resume/Abandon behavior.
- Current local verification passed backend lint plus 370 tests with 2 skipped,
  Angular lint plus 221 tests, API 3 tests and typecheck, contracts 4 tests,
  and real-backend Playwright 5 tests.
- This evidence closes the local implementation milestone only. It is not a
  packaged B3 result, hosted CI result, protected hardware result, or
  candidate-bound release claim.

Resource artifacts for packaged runs:

- `metrics.json`
- `streaming-baseline.json`
- `production-summary.json`
- `*.webm` acceptance recordings when the recorded production target is used
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
- Evidence: the former `tests/test_llm.py` coverage now lives in
  `tests/test_llm_draft_parsing.py`, `tests/test_llm_provider_settings.py`,
  `tests/test_fastflowlm_provider.py`, `tests/test_ollama_provider.py`, and
  `tests/test_model_downloads.py`; run those with
  `tests/test_documents_streaming.py` and `tests/test_runtime_installations.py`
  for the provider-boundary slice. `pnpm nx run
cert-prep-backend:streaming-cli-test` passed 33 selected tests; `pnpm nx run
cert-prep-backend:test --skip-nx-cache` passed 162 tests; `pnpm nx run
cert-prep-backend:lint --skip-nx-cache` passed; and `git diff --check`
  passed with CRLF conversion warnings only.

## Multi-PDF Upload And AI-Inferred Practice Evidence

2026-07-07 closeout:

- Multi-PDF source import is complete as a client-side sequential batch over
  `POST /projects/{project_id}/documents`.
- Successful files remain available in the project document library; failed
  files remain visible for retry; the latest successful upload becomes the
  active document.
- Upload-triggered streaming draft generation is document-scoped, and
  generated `ai_inferred` drafts stay editable and playable through the
  existing Draft Review, Full Exam, and Random Quiz paths when they meet the
  playable predicate.
- Verification passed with `pnpm nx run cert-prep:test --skip-nx-cache`,
  `pnpm nx run cert-prep-backend:test --skip-nx-cache`,
  `pnpm nx run cert-prep-e2e:e2e-ci--src/example.spec.ts --skip-nx-cache`, and
  `pnpm nx run cert-prep-e2e:e2e-ci--src/recording.spec.ts --skip-nx-cache`.
  The monolithic `cert-prep-e2e:e2e` run was attempted first and timed out
  before emitting useful Playwright results, so the two atomized e2e targets
  are the recorded acceptance evidence for this closeout.

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

`.agents/TODOS/alpha-launch-readiness.md` remains active until the public OCR
asset, checkout-free MSI/NSIS clean installs, and protected AMD/XDNA2 recorded
acceptance gates pass. Local implementation evidence must not be promoted to a
Public Alpha-ready claim before those external gates close.

Deferred comparator reruns remain user-controlled and should only run after the
target models are intentionally installed.
