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
- Live bakeoff candidates are `qwen3:14b`, `deepseek-r1:14b`, and
  `gemma4:12b`.
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

Open reasoning gate:

- RAM/VRAM observation target:
  `pnpm nx run exam-prep-backend:reasoning-memory --skip-nx-cache`.
- Latest artifact:
  `apps/exam-prep-backend/.benchmarks/reasoning-memory-20260621T083447Z.json`.
- `qwen3:14b`: `missing_model`.
- `deepseek-r1:14b`: `missing_model`.
- `gemma4:12b`: `completed`, `latency_ms=41266`; `ollama ps` showed
  `8.4 GB`, `100% GPU`, and `CONTEXT=8192` during load/run/idle samples.
- The latest RAM artifact is local ignored evidence under
  `/apps/exam-prep-backend/.benchmarks/`; rerun after intentionally installing
  the missing comparator models before parameter tuning or scored bakeoff.

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

## Active Backlog

Active TODO:

- `.agents/TODOS/parallel-parsing-reasoning.md`

Current open gate:

- Rerun reasoning memory/bakeoff only after `qwen3:14b` and
  `deepseek-r1:14b` are intentionally installed or the model set changes.

## Retired Risk Notes

- Regenerate the OpenAPI client whenever backend schemas/routes change.
- Do not let optional Ollama/model failures block OCR/manual workflows.
- Keep qwen output editable and user-governed.
- Track page-level OCR/render failures explicitly.
- Ground citations and source excerpts in chunk text.
- Keep project selection and restart persistence in packaged smoke.
