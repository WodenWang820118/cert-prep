# Parsing And Reasoning Domain

## Purpose

This domain owns OCR parsing performance, use-while-parsing UX, editable
question creation, streaming qwen research, reasoning-model memory/bakeoff
evidence, APU-first streaming telemetry, and artifact-backed QA evidence for
those flows.

## Current Decisions

- `EXAM_PREP_OCR_PAGE_WORKERS` defaults to `1`.
- Worker count `2` is only a measured option if the same-build packaged QA run
  improves wall time by at least 20%, keeps counts stable, improves first chunk,
  and stays under GPU memory gates.
- Deterministic/manual parsing remains the production acceptance path.
- Reasoning model output is optional enrichment and must not auto-download
  models, auto-approve questions, or expose hidden chain-of-thought.
- UI copy should say `Reasoning model` rather than hardcoding a single model
  identity.
- Default Ollama model is `qwen3.5:4b`; default fallback is `qwen3.5:2b`.
- Larger 12B/14B reasoning comparator runs remain user-controlled research
  gates and should not be treated as the current startup default.
- Reasoning comparator work must collect RAM/VRAM residency evidence before
  parameter reduction, scored bakeoff reruns, or default-model changes.
- Nvidia GPU headroom should be preserved for larger Ollama reasoning models.
  Packaged OCR now prefers AMD DirectML through an explicit runtime health gate;
  Paddle CUDA remains an override/debug path.
- No Kafka or external broker is used for the first local-first streaming
  implementation. The current design uses a SQLite-backed job queue/outbox and
  bounded local workers.

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
- Approval-only code and stale active copy references were removed or retargeted.

## Streaming Qwen Prototype

The streaming parse-to-qwen research/prototype is complete for the local-first
slice.

Evidence:

- Packaged live qwen artifact:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-19T08-37-53-476Z/metrics.json`.
- QA override model: `qwen3:8b`; default packaged model remained `qwen3:14b`.
- First streamed qwen draft visible: `22,301 ms`.
- First usable question visible: `22,301 ms`.
- Parse complete visible: `25,394 ms`.
- Close/process cleanup reported graceful close and empty residual processes.
- Dedicated packaged streaming baseline:
  `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-19T13-33-48-372Z/streaming-baseline.json`.

## OCR Health And First-Chunk Evidence

Latest packaged smoke:

- Command:
  `pnpm nx run exam-prep-desktop:packaged-flow-smoke --skip-nx-cache --args="--ocr-page-workers 1 --skip-gpu-sampling"`.
- Artifact:
  `tmp/exam-prep-desktop/packaged-flow-smoke/2026-06-21T05-59-55-867Z/metrics.json`.
- OCR settled from active checking to `paddle / gpu:0`.
- Artifact text contained no `OCR unknown`, `Unknown`, `status unavailable`, or
  `PaddleOCR status unavailable` observation.
- First visible chunk: `2,612 ms`.
- First-chunk gate: `first_chunk_gate_ms=15000`,
  `first_chunk_under_gate=true`.
- Mid-parse UI showed source text while parsing continued:
  `8/46 pages / 8 chunks / 15s`.
- Final OCR completion: `46 pages / 46 chunks`.
- Parse complete visible: `86,214 ms`.
- Restart and final close reported `gracefulExited=true`,
  `fallbackUsed=false`, `exitCode=0`, and empty residual process lists.

Verification for the 2026-06-21 slice:

- `pnpm nx run exam-prep:test --skip-nx-cache` passed.
- `pnpm nx run exam-prep:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-backend:test --skip-nx-cache` passed.
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache` passed.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache` passed.
- Packaged flow smoke passed with worker count `1` and GPU sampling skipped.
- `git diff --check` passed with only line-ending normalization warnings.

## Reasoning Model Memory And Bakeoff

Latest live bakeoff artifact:

- `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260621T052159Z.json`.
- `qwen3:14b`: `missing_model`.
- `deepseek-r1:14b`: `missing_model`.
- `gemma4:12b`: `request_failed`, `json_error=ReadTimeout`.

No candidate produced full scored comparator evidence in the latest run. The
default model decision remains unchanged.

Current local model state on 2026-06-21:

- `ollama list` includes `gemma4:12b` at `7.6 GB` and does not include
  `qwen3:14b` or `deepseek-r1:14b`.
- `ollama ps` shows no loaded model.
- Local GPUs are `AMD Radeon(TM) 880M Graphics` and
  `NVIDIA GeForce RTX 4060 Laptop GPU`.
- Windows exposes `GPU Adapter Memory`, `GPU Process Memory`, and `GPU Engine`
  counters for adapter-level evidence.

Current bakeoff options are `temperature=0`, `num_ctx=8192`, and
`num_predict=4096`. Do not reduce parameters until RAM/VRAM evidence exists.

Closed RAM/VRAM observation:

- Target:
  `pnpm nx run exam-prep-backend:reasoning-memory --skip-nx-cache`.
- Artifact:
  `apps/exam-prep-backend/.benchmarks/reasoning-memory-20260621T083447Z.json`.
- `qwen3:14b`: `missing_model`.
- `deepseek-r1:14b`: `missing_model`.
- `gemma4:12b`: `completed`, `latency_ms=41266`; `ollama ps` showed
  `8.4 GB`, `100% GPU`, and `CONTEXT=8192` during load/run/idle samples.
- This closes the local RAM observation TODO for the installed comparator set:
  missing comparator models are recorded as explicit blockers, and `gemma4:12b`
  has residency evidence.
- Deferred model gate: rerun memory and scored bakeoff evidence after
  intentionally installing `qwen3:14b` and `deepseek-r1:14b`, or after changing
  the comparator set. Do not tune parameters or change defaults before that
  follow-up evidence exists.

## APU-First Streaming Utilization

The local packaged production gate is closed for AMD DirectML OCR: parse/draft
streaming can run OCR through `AMD Radeon(TM) 880M Graphics` while preserving
Nvidia GPU headroom for Ollama reasoning.

Current constraints:

- Packaged streaming smoke now emits Windows resource telemetry alongside
  Nvidia `nvidia-smi.csv`.
- Windows `GPU Engine` counters can emit implausible one-sample utilization
  spikes; summary code filters per-engine utilization outside `0..100`.
- Current OCR GPU path is `paddlepaddle-gpu --device gpu:0`, which is expected
  to favor CUDA/Nvidia on this Windows laptop.
- AMD iGPU acceleration likely requires explicit feasibility work around
  DirectML, OpenVINO, ONNX Runtime, or another supported OCR/compute path.
- Pure CPU OCR should not become the default fallback without evidence; existing
  page-3 benchmark evidence was about `34.9s` warm OCR on CPU versus about
  `0.59s` warm OCR on `gpu:0`.

Latest APU telemetry evidence:

- Passed artifact:
  `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-21T10-37-19-351Z/streaming-baseline.json`.
  The closeout now writes `metrics.json`, `streaming-baseline.json`, and a
  finalized `windows-resource-summary.json`.
- Closeout hardening writes pre-cleanup artifacts before best-effort cleanup,
  bounds Windows process snapshot/close/taskkill helpers, and records sampler
  stop evidence instead of blocking final report generation.
- Resource artifacts include Nvidia `nvidia-smi.csv`, Windows
  `windows-dxgi-adapters.json`, `windows-resource-sampling.csv`, and
  `windows-resource-summary.json`.
- DXGI mapping identified `AMD Radeon(TM) 880M Graphics`,
  `NVIDIA GeForce RTX 4060 Laptop GPU`, and `Microsoft Basic Render Driver`.
- Finalized summary mapped three known DXGI adapters and one unmapped runtime
  LUID (`gpu_luid_map_status=partial`); sampler cleanup reported
  `forced_count=0`, `error_count=0`, and `duration_ms=27`.
- Global AMD adapter counters showed activity after spike filtering:
  `max_compute_percent=99.582`, `avg_engine_utilization_percent=0.066`, and
  `max_3d_percent=22.811`.
- Named target-process GPU memory is the routing gate. In the latest run,
  `exam-prep-ocr-runtime.exe` appeared only on `nvidia_dgpu`, with max
  dedicated process memory of `323796992` bytes and `1953300480` bytes across
  two OCR runtime PIDs. `ollama.exe` had only trivial GPU process memory
  (`4096` bytes total on AMD, `368640` bytes total on Nvidia).
- Nvidia `nvidia-smi.csv` still showed meaningful dGPU use:
  the target-process Windows counters and Nvidia summary both still point at
  Nvidia as the active OCR GPU path.
- Streaming gates passed:
  `first_chunk_visible=2043`, `first_usable_question_visible=44616`,
  `parse_complete_visible=91172`, `streaming_all_jobs_terminal=181978`, and all
  baseline checks were `true`.
- iGPU Paddle probe:
  `apps/exam-prep-backend/.benchmarks/ocr-igpu-probe-20260622T001432Z.json`
  recorded `state=needs_alternative_backend`. Windows detected both
  `AMD Radeon(TM) 880M Graphics` and `NVIDIA GeForce RTX 4060 Laptop GPU`, but
  Paddle reported `compiled_with_cuda=true`, `compiled_with_rocm=false`,
  `available_devices=["gpu:0"]`, and `custom_device_types=[]`.
  A separate DirectML lane is now required for AMD iGPU OCR work.
- DirectML probe:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-probe-20260622T010301Z.json`
  recorded `state=ready`. `onnxruntime-directml 1.24.4` is
  available, providers include `DmlExecutionProvider` and
  `CPUExecutionProvider`. DXGI metadata selects the AMD 880M iGPU as DirectML
  `device_id=0`; RTX 4060 is adapter index `1`.
- DirectML model prep:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-prepare-models-20260622T010227Z.json`
  recorded `state=ready`. The explicit Docker release-prep target reproduced
  PP-OCRv5 mobile det/rec conversion into `det_model.onnx` and
  `rec_model.onnx` from checksum-verified official source archives.
- DirectML session smoke:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-smoke-20260622T010301Z.json`
  recorded `state=session_ready`, with det/rec ONNX sessions pinned to the
  AMD DXGI adapter index and DirectML session options
  `enable_mem_pattern=false`, `execution_mode=ORT_SEQUENTIAL`.
- DirectML inference/benchmark gates:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-inference-smoke-20260622T010300Z.json`
  recorded `state=inference_ready`, and
  `apps/exam-prep-backend/.benchmarks/ocr-directml-benchmark-20260622T010946Z.json`
  recorded `state=benchmark_ready`. JLPT page-3 warm OCR was `1789 ms` versus
  CPU baseline `34900 ms`, with anchors `問題2`, `合併`, `中山`, and `加筆`
  all present.
- Desktop resource summaries now track `exam-prep-ocr-directml-runtime.exe` and
  emit `gpu_routing_checks` for AMD OCR usage, Nvidia OCR avoidance,
  reasoning-on-Nvidia residency, and DXGI LUID usability.
- DirectML runtime artifact:
  `apps/exam-prep-backend/dist/ocr-directml-runtime/directml-ocr-runtime-manifest.json`
  records `kind=directml_ocr`,
  `entrypoint=exam-prep-ocr-directml-runtime.exe`, SHA-256
  `ebcea572ff16717e274015455bb85faab7d0f0a6eab3087eb34171344499f028`, and
  `118632683` bytes. The Tauri resource manifest was synced with a local
  `file://` URL for QA; release builds can publish the same artifact by setting
  `EXAM_PREP_RUNTIME_ASSET_BASE_URL`.
- DirectML install/health is wired through explicit runtime consent, checksum
  verification, manifest `kind=directml_ocr`, DirectML self-test, and a
  missing/unhealthy blocker. It does not silently fall back to CPU OCR.
- Packaged DirectML streaming artifact:
  `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-22T02-08-02-496Z/streaming-baseline.json`.
- Packaged DirectML streaming passed with `ocr_provider=directml`,
  `ocr_page_workers=1`, `qwen3:8b`, `46/46` pages, `46` chunks,
  `first_chunk_visible=9708 ms` under the `15000 ms` gate,
  `first_usable_question_visible=50595 ms`,
  `parse_complete_visible=85301 ms`, `streaming_all_jobs_terminal=130529 ms`,
  and `9/9` streaming jobs succeeded.
- Packaged GPU routing proof:
  `windows-resource-summary.json` recorded
  `directml_ocr_process_observed=true`, `ocr_uses_amd_igpu=true`,
  `ocr_avoids_nvidia_dgpu=true`,
  `ocr_nvidia_process_memory_max_bytes=0`,
  `reasoning_uses_nvidia_dgpu=true`, and `gpu_luid_map_usable=true`.
- DirectML OCR process residency reached `41906176` AMD dedicated bytes and
  `7076143104` AMD shared bytes, with `0` Nvidia dGPU process bytes for OCR.

Closed APU gate controls:

- Keep packaged baseline closeout hardened so telemetry finalization cannot
  leave a completed UI flow without `metrics.json`,
  `streaming-baseline.json`, Windows resource telemetry, and Nvidia telemetry.
- Keep resource samples aligned to parse start, first chunk, first usable
  question, parse completion, and streaming completion.
- Keep the AMD-capable ONNX Runtime DirectML OCR backend packaged as a separate
  runtime artifact from the Paddle CUDA runtime.
- Keep DirectML release publishing explicit through
  `EXAM_PREP_RUNTIME_ASSET_BASE_URL`; local QA may use `file://` URLs, but
  startup must not auto-download runtime/model assets.
- Keep `ocr_page_workers=1` until same-build packaged evidence supports a
  change.
- Keep routing decisions grounded in named target-process telemetry rather than
  global adapter activity alone.
- Do not silently fall back to pure CPU for the iGPU lane; prior CPU OCR
  evidence is too slow for streaming.
- Do not change reasoning model defaults or parameters until separate
  RAM/VRAM evidence supports the change.

## Streaming Production Practice-Ready Gate

2026-06-22 implementation checkpoint:

- Packaged streaming smoke now supports
  `--verify-streaming-practice-ready`.
- The flag waits for streaming jobs to reach terminal success, then verifies
  Full Exam can start from the generated streamed questions without creating a
  manual smoke question.
- Metrics now record `practice_ready_visible_ms`,
  `practice_first_question_visible_ms`, and
  `practice_ready_from_streamed_questions`.
- `packaged-streaming-production-directml` now defaults to
  `qwen3:14b` with fallbacks `gemma4:12b,qwen3:8b`, DirectML OCR,
  `ocr_page_workers=1`, streaming completion wait, and practice-ready
  verification.
- Production summaries include a `streaming_practice_ready` check while keeping
  configured/effective model, fallback list, and fallback reason fields.
- Transient streaming API poll failures are retained as observations; final
  semantic success is governed by terminal jobs, generated usable questions,
  practice readiness, and cleanup.

Verification passed:

- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache`.
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`.
- `pnpm nx run exam-prep-backend:test --skip-nx-cache`.

Live baseline blocker:

- Ollama preflight
  `Invoke-RestMethod http://127.0.0.1:11434/api/tags` failed with
  `unable to connect to remote server`.
- 2026-06-22 direct packaged production run was executed anyway at user
  request with
  `pnpm nx run exam-prep-desktop:packaged-streaming-production-directml --skip-nx-cache`.
- Tauri packaging succeeded and produced:
  `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Exam Prep_0.1.0_x64_en-US.msi`
  and
  `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Exam Prep_0.1.0_x64-setup.exe`.
- Packaged app smoke launched the real exe and completed DirectML OCR:
  46/46 pages, 46 chunks, first chunk visible in 4076 ms, parse complete in
  69719 ms, graceful app close, and no residual packaged smoke processes.
- Streaming did not produce questions because Ollama was unavailable:
  `llm_health.detail` was `Ollama is not installed.`, effective model was
  `null`, and all 9 jobs ended as `skipped_provider_unavailable`.
- The production artifact preserved configured model `qwen3:14b`, fallback
  list `gemma4:12b,qwen3:8b`, DirectML GPU routing checks, screenshots,
  metrics, resource logs, and the failed practice-ready check.
- Evidence paths:
  - Production summary:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/production-summary.json`.
  - Streaming baseline JSON/MD:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/streaming-baseline.json`
    and
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/streaming-baseline.md`.
  - Metrics JSON:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/metrics.json`.
  - Screenshots:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/*.png`.
  - Windows resource summary:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/windows-resource-summary.json`.
  - Nvidia CSV:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-04-33-152Z/nvidia-smi.csv`.
  - Reasoning memory JSON and reasoning bakeoff JSON: not produced in this run
    because Ollama API was unavailable and model availability could not be
    proven without implicit installs.
- Rerun reasoning memory/bakeoff and the production baseline only after
  Ollama API is reachable and `qwen3:8b` appears in `/api/tags`; model
  installation remains user-controlled and must not be triggered implicitly by
  QA.

2026-06-22 Ollama runtime installer bridge:

- Installed local Ollama runtime through the official `Ollama.Ollama` winget
  package to clear the machine-level blocker; the install placed
  `ollama.exe` at
  `C:\Users\User\AppData\Local\Programs\Ollama\ollama.exe`.
- Backend `OllamaRuntimeInstaller` now prefers the Windows winget package for
  explicit user-confirmed runtime installation, falls back to the existing
  official PowerShell installer script when winget is unavailable, and starts
  `ollama serve` after installation so `/api/tags` becomes reachable.
- Backend `OllamaProvider.health()` now bridges the installed-but-idle case by
  starting the local Ollama API once, then rechecking model availability. It
  does not pull models during health checks.
- Local backend API smoke after the fix:
  `/runtime/requirements` reported Ollama runtime available,
  `/llm/health` reported `model_missing` for configured `qwen3:14b` with
  fallbacks `gemma4:12b,qwen3:8b`, and
  `POST /runtime/installations/ollama` returned `succeeded`.
- At this checkpoint, `/api/tags` became reachable but the model list was still
  empty. The remaining production baseline gate was user-controlled model
  installation, at minimum `qwen3:8b`.
- Verification:
  `pnpm nx run exam-prep-backend:test --skip-nx-cache`.

2026-06-22 Ollama enabled baseline:

- User authorized model download for the production fallback lane. Installed
  `qwen3:8b` through Ollama CLI; `/api/tags` now reports `qwen3:8b` with
  digest `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`,
  size `5225388164`, parameter size `8.2B`, quantization `Q4_K_M`, and
  context length `40960`.
- Backend API health now reports configured model `qwen3:14b`, effective model
  `qwen3:8b`, fallbacks `gemma4:12b,qwen3:8b`, and fallback reason
  `Configured model qwen3:14b is missing; using fallback qwen3:8b.`
- Reasoning evidence:
  - Memory JSON:
    `apps/exam-prep-backend/.benchmarks/reasoning-memory-20260622T073812Z.json`;
    `qwen3:8b` completed in `39342 ms`.
  - Bakeoff JSON:
    `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260622T073913Z.json`;
    `qwen3:8b` completed in `57692 ms`, produced valid JSON, and had 3/3
    citation-valid items.
- Packaged production baseline now passes with fallback model `qwen3:8b`:
  - Production summary:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/production-summary.json`.
  - Streaming baseline JSON/MD:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/streaming-baseline.json`
    and
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/streaming-baseline.md`.
  - Metrics JSON:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/metrics.json`.
  - Screenshots:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/*.png`.
  - Windows resource summary:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/windows-resource-summary.json`.
  - Nvidia CSV:
    `tmp/exam-prep-desktop/packaged-streaming-production/2026-06-22T07-44-50-031Z/nvidia-smi.csv`.
- Production metrics: DirectML OCR completed 46/46 pages with 46 chunks, first
  chunk visible in `9270 ms`, first usable streamed question visible in
  `52859 ms`, parse complete in `96301 ms`, all streaming jobs terminal in
  `141594 ms`, practice ready in `143070 ms`, and first practice question
  visible in `143772 ms`.
- Acceptance checks passed: first usable question appeared before parse
  complete, 9/9 jobs succeeded, 9 usable questions were generated, Full Exam
  practice started from streamed questions, DirectML OCR used AMD iGPU and
  avoided Nvidia dGPU, reasoning used Nvidia dGPU, graceful close succeeded,
  and no residual packaged smoke processes remained.
- Verification:
  - `pnpm nx run exam-prep-backend:reasoning-memory --skip-nx-cache --args="--model qwen3:8b --timeout-seconds 300"`.
  - `pnpm nx run exam-prep-backend:reasoning-bakeoff --skip-nx-cache --args="--model qwen3:8b --timeout-seconds 300"`.
  - `pnpm nx run exam-prep-desktop:packaged-streaming-production-directml --skip-nx-cache`.

2026-06-22 Qwen 3.5 4B default update:

- Default configured Ollama model is now `qwen3.5:4b` across backend settings,
  desktop launch defaults, package QA, packaged streaming targets, and UI/e2e
  test fixtures.
- Default fallback is now the smaller same-family `qwen3.5:2b`; production
  packaged streaming targets no longer reference the previous
  `gemma4:12b,qwen3:8b` fallback chain.
- Local Ollama cleanup completed through the HTTP API because `ollama.exe` was
  not on PATH in the current shell. `DELETE /api/delete` removed `qwen3:8b`,
  and `/api/tags` returned an empty model list afterward.
- User-controlled install remains unchanged: the app should prompt/download
  `qwen3.5:4b` only after explicit consent.

2026-06-22 AMD NPU OCR experimental lane (archived):

- Decision update: standalone AMD NPU OCR is retired from the product/runtime
  path. The formal direction is DirectML mixed execution
  (`DmlExecutionProvider` plus `CPUExecutionProvider`) under the existing
  `directml` OCR provider.
- Removed/retired implementation surfaces:
  - backend `amd_npu` OCR provider selection and `amd_npu_ocr` runtime
    requirement kind
  - packaged `exam-prep-ocr-amd-npu-runtime.exe` build lane
  - desktop `build-amd-npu`, `sync-amd-npu-runtime-manifest`, and
    `packaged-streaming-production-amd-npu` targets
  - package QA AMD NPU runtime manifest/env validation
  - Angular runtime checklist/consent UI for AMD NPU OCR
  - packaged-flow `xrt-smi`, `npu_routing_checks`, and
    `npu_power_or_efficiency_observations` production summary fields
- DirectML production baseline remains the only packaged streaming production
  OCR target. Acceptance still requires 46/46 pages, chunks present, first
  chunk under the UX gate, streamed questions before parse completion,
  practice readiness, DirectML OCR on AMD iGPU, Nvidia avoidance for OCR,
  Ollama reasoning on Nvidia, and clean cleanup.
- The historical evidence below explains why the independent NPU path was not
  accepted: PP-OCRv5 did not pass strict VitisAI NPU-only session gates, mixed
  Windows ML policy sessions still used CPU fallback, and power replacement
  evidence was not available.

Historical AMD NPU OCR research:

- Durable spec:
  `.agents/SPECS/domains/ocr-amd-npu.md`.
- Implemented `EXAM_PREP_OCR_PROVIDER=amd_npu`, runtime requirement kind
  `amd_npu_ocr`, packaged runtime entrypoint
  `exam-prep-ocr-amd-npu-runtime.exe`, and desktop target
  `packaged-streaming-production-amd-npu`.
- AMD NPU runtime follows the official Windows ML
  `ExecutionProviderCatalog` + `VitisAIExecutionProvider` path. Passive health
  and probe paths do not call `EnsureReadyAsync()`; the explicit runtime
  installer path is the only user-approved enablement/download gate.
- Desktop resource sampling now records `xrt-smi-summary.json`,
  `xrt_smi_summary`, `npu_routing_checks`, and
  `npu_power_or_efficiency_observations`. DirectML production checks remain
  provider-aware and are not applied to `amd_npu`.
- Explicit `--ensure-ready` probe artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-probe-20260622T085003Z.json`.
- Probe status: `ready_for_session`. The machine sees
  `NPU Compute Accelerator Device`, `xrt-smi`, `NPU Strix`, and VitisAI NPU
  device id `6128` through ORT `get_ep_devices()`.
- VitisAI package path:
  `C:\Program Files\WindowsApps\MicrosoftCorporationII.WinML.AMD.NPU.EP.1.8_1.8.62.0_x64__8wekyb3d8bbwe\ExecutionProvider\onnxruntime_vitisai_ep.dll`.
- Strict session smoke artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-smoke-20260622T085540Z.json`.
- Session smoke uses ONNX Runtime plugin EP device binding through
  `add_provider_for_devices(...)` and disables CPU fallback with
  `session.disable_cpu_ep_fallback=1`.
- Current blocker: both PP-OCRv5 `det_model.onnx` and `rec_model.onnx` assign
  some nodes to the default CPU EP under VitisAI, so strict NPU-only session
  creation fails with CPU fallback disabled.
- Inference smoke artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-inference-smoke-20260622T085642Z.json`.
- Inference smoke status: skipped, reason `session_failed`.
- Static-shape compatibility target added:
  `pnpm nx run exam-prep-backend:ocr-amd-npu-model-compat --skip-nx-cache`.
- Static-shape compatibility artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-model-compat-20260622T091947Z.json`.
- Static candidate models were generated in
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-static-shape-models` with
  det shape `1x3x1152x864` and rec shape `1x3x48x320`.
- Static-shape candidate session smoke timed out after `180 seconds`, so fixed
  input shapes alone are not accepted as an AMD NPU replacement path. Next
  model work should evaluate QDQ/A8W8 or a smaller NPU-friendly OCR model/export.
- QDQ/A8W8 compatibility implemented in the same target via
  `--candidate-kind static_qdq_a8w8`.
- QDQ/A8W8 compatibility artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-model-compat-20260622T110203Z.json`.
- QDQ/A8W8 candidate models were generated in
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-qdq-a8w8-models` using
  deterministic synthetic calibration with `2` samples. This is compile/session
  evidence only, not an accuracy acceptance.
- QDQ insertion counts: det `560/560` QuantizeLinear/DequantizeLinear nodes;
  rec `568/568` QuantizeLinear/DequantizeLinear nodes.
- QDQ/A8W8 strict session still fails with CPU fallback disabled. VitisAI
  partition observations include `batchnorm`, `quantize-linear`,
  `qlinear-hard-softmax`, `dequantize-linear`, and `const-fix`; the recognizer
  also hits the `qlinear-hard-softmax` channel limit.
- Reference scout target added:
  `pnpm nx run exam-prep-backend:ocr-amd-npu-reference-scout --skip-nx-cache`.
- Reference scout artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-amd-npu-reference-scout-20260622T115426Z.json`.
- Python 3.12 compatibility is now allowed for backend/model-prep tooling:
  `requires-python` is `>=3.12,<3.14`, `uv.lock` resolves `<3.13` and
  `>=3.13`, `ruff` target is `py312`, and Nx `python-version-check` accepts
  Python `3.12` or `3.13`.
- Python 3.12 Quark probe target added:
  `pnpm nx run exam-prep-backend:ocr-amd-npu-reference-scout-python312 --skip-nx-cache`.
- `py -3.12` is available and Quark-compatible by version, but `amd-quark` is
  not installed yet. Next NPU model work should use AMD's Nemotron OCR v2 BF16
  reference compile or install Quark in a Python 3.12 model-prep environment
  with document-derived calibration.
- Windows ML mixed execution research:
  - Added target
    `pnpm nx run exam-prep-backend:ocr-windowsml-policy-mixed-probe --skip-nx-cache`.
  - Provider-matrix artifact:
    `apps/exam-prep-backend/.benchmarks/ocr-windowsml-policy-mixed-probe-20260622T122325Z.json`.
  - Synthetic-inference artifact:
    `apps/exam-prep-backend/.benchmarks/ocr-windowsml-policy-mixed-probe-20260622T122418Z.json`.
  - `onnxruntime-windowsml 1.24.6` exposes
    `SessionOptions.set_provider_selection_policy(...)` and policies including
    `MAX_EFFICIENCY`, `MIN_OVERALL_POWER`, `PREFER_NPU`, `PREFER_GPU`, and
    `MAX_PERFORMANCE`.
  - With VitisAI disabled/not visible in-process, NPU/efficiency policies
    selected CPU only.
  - After user-approved `EnsureReadyAsync()` and VitisAI registration, the
    current PP-OCRv5 det/rec ONNX models created sessions with
    `VitisAIExecutionProvider + CPUExecutionProvider` for
    `MAX_EFFICIENCY`/`MIN_OVERALL_POWER`/`PREFER_NPU`.
  - `PREFER_GPU`/`MAX_PERFORMANCE` created sessions with
    `DmlExecutionProvider + CPUExecutionProvider`.
  - The target confirmed `PREFER_NPU` synthetic zero-input inference for both
    det and rec with `VitisAIExecutionProvider + CPUExecutionProvider`.
  - This is a separate Windows ML policy mixed probe, not a replacement for
    strict NPU-only evidence, because CPU fallback can hide unsupported
    operators and VitisAI emitted compile warnings while sessions and synthetic
    inference still succeeded.
- PaddleOCR 3.7 isolated ONNX Runtime probe:
  - Added target
    `pnpm nx run exam-prep-backend:ocr-paddle37-onnxruntime-probe --skip-nx-cache`.
  - Artifact:
    `apps/exam-prep-backend/.benchmarks/ocr-paddle37-onnxruntime-probe-20260622T141653Z.json`.
  - The target runs in isolated Python 3.12 through `uv run --no-project` with
    `paddleocr==3.7.0`, stages the existing PP-OCRv5 ONNX models into PaddleX's
    `inference.onnx` / `inference.yml` layout, and does not change production
    defaults.
  - CPU ONNXRuntime and AMD iGPU DML ONNXRuntime both decoded `OCRTEST`. The
    DML case reported internal det/rec sessions using
    `DmlExecutionProvider + CPUExecutionProvider`.
  - Windows ML hybrid by provider names failed because PaddleX 3.7 validates
    against `onnxruntime.get_available_providers()` and does not expose
    `SessionOptions.add_provider_for_devices(...)`. Therefore PaddleOCR 3.7 is
    a DML refactor candidate, not yet an NPU+iGPU replacement.
- Power replacement gate is not accepted because the current `xrt-smi` probe
  does not expose watts. Keep DirectML iGPU as the production default.
- Verification at this checkpoint:
  - `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache`.
  - `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`.
  - `pnpm nx run exam-prep-backend:lint --skip-nx-cache`.
  - `pnpm nx run exam-prep-backend:test --skip-nx-cache`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-probe --skip-nx-cache --args="--ensure-ready"`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-session-smoke --skip-nx-cache --args="--ensure-ready"`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-model-compat --skip-nx-cache --args="--ensure-ready --session-timeout-seconds 180"`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-model-compat --skip-nx-cache --args="--candidate-kind static_qdq_a8w8 --ensure-ready --session-timeout-seconds 120 --calibration-samples 2"`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-reference-scout --skip-nx-cache --args="--online"`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-reference-scout-python312 --skip-nx-cache`.
  - `pnpm nx run exam-prep-backend:ocr-amd-npu-inference-smoke --skip-nx-cache --args="--ensure-ready"`.
  - `pnpm nx run exam-prep-backend:ocr-windowsml-policy-mixed-probe --skip-nx-cache --args="--ensure-ready --policy PREFER_NPU --policy PREFER_GPU --session-timeout-seconds 240"`.
  - `pnpm nx run exam-prep-backend:ocr-windowsml-policy-mixed-probe --skip-nx-cache --args="--ensure-ready --policy PREFER_NPU --run-zero-inference --session-timeout-seconds 300"`.
  - `pnpm nx run exam-prep-backend:ocr-paddle37-onnxruntime-probe --skip-nx-cache`.

## Active Backlog

No active parsing/reasoning TODO file remains at this checkpoint.

Deferred gate:

- Optional comparator reruns for `qwen3:14b` and `gemma4:12b` remain
  user-controlled and should only run after those models are intentionally
  installed.

## Retired Risk Notes

- Regenerate the OpenAPI client whenever backend schemas/routes change.
- Do not let optional Ollama/model failures block OCR/manual workflows.
- Keep qwen output editable and user-governed.
- Track page-level OCR/render failures explicitly.
- Ground citations and source excerpts in chunk text.
- Keep project selection and restart persistence in packaged smoke.
