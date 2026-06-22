# Parallel Parsing And Reasoning TODO

Status: active backlog only. Completed OCR health and first-chunk gate evidence
has been merged into `.agents/SPECS/domains/parsing-reasoning.md`.

## 1. Reasoning Model RAM Observation

- [x] Produce RAM/VRAM residency evidence for `qwen3:14b`,
  `deepseek-r1:14b`, and `gemma4:12b` before another scored bakeoff,
  parameter reduction, or default-model change.
  - Current local state on 2026-06-21:
    - `ollama list` includes `gemma4:12b` at `7.6 GB` and does not include
      `qwen3:14b` or `deepseek-r1:14b`.
    - `ollama ps` shows no loaded model.
    - Local GPUs are `AMD Radeon(TM) 880M Graphics` and
      `NVIDIA GeForce RTX 4060 Laptop GPU`.
    - Windows exposes `GPU Adapter Memory`, `GPU Process Memory`, and
      `GPU Engine` counters for adapter-level evidence.
  - Current bakeoff blocker:
    `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260621T052159Z.json`
    recorded `qwen3:14b=missing_model`, `deepseek-r1:14b=missing_model`, and
    `gemma4:12b=request_failed` with `json_error=ReadTimeout`.
  - Latest RAM observation:
    `apps/exam-prep-backend/.benchmarks/reasoning-memory-20260621T083447Z.json`
    recorded `qwen3:14b=missing_model`,
    `deepseek-r1:14b=missing_model`, and `gemma4:12b=completed`.
    `gemma4:12b` reported `latency_ms=41266`; `ollama ps` showed
    `8.4 GB`, `100% GPU`, and `CONTEXT=8192` during load/run/idle samples.
    The artifact is ignored by git under `/apps/exam-prep-backend/.benchmarks/`.
  - Current fixed bakeoff options:
    `temperature=0`, `num_ctx=8192`, and `num_predict=4096`; do not reduce
    parameters until memory evidence exists.
  - Plan:
    1. Keep model installation user-controlled. Do not pull models
       automatically.
    2. For each installed comparator, record before/load/run/idle memory
       snapshots with `ollama list`, `ollama ps`, Ollama process RSS, Windows
       GPU adapter/process/engine counters, and `nvidia-smi` when available.
    3. Record missing-model blockers for uninstalled comparators.
    4. Save evidence as `.benchmarks/reasoning-memory-*.json` or equivalent
       markdown/json evidence before tuning parameters.
    5. Leave scored bakeoff and default-model decisions blocked until memory
       evidence and intentionally installed comparator models are available.
  - Verify:
    `pnpm nx run exam-prep-backend:reasoning-memory --skip-nx-cache --args="--timeout-seconds 60"`
    `pnpm nx run exam-prep-backend:test --skip-nx-cache`
    `pnpm nx run exam-prep-backend:lint --skip-nx-cache`
    `ollama list`
    `ollama ps`
    `Get-Counter -ListSet GPU*`
    `git diff --check`

## 2. AMD APU-First Streaming Utilization

- [x] Validate that packaged streaming parse/draft can run OCR through
  `AMD Radeon(TM) 880M Graphics` with ONNX Runtime DirectML while preserving
  Nvidia GPU headroom for Ollama reasoning.
  - Current constraints:
    - Packaged streaming smoke now emits Windows resource telemetry in addition
      to legacy Nvidia `nvidia-smi.csv`.
    - Windows `GPU Engine` utilization can emit implausible one-sample spikes;
      summary code filters per-engine utilization outside `0..100`.
    - Current OCR GPU path is `paddlepaddle-gpu --device gpu:0`, which is
      expected to favor CUDA/Nvidia on this Windows laptop.
    - AMD iGPU acceleration likely requires explicit feasibility work around
      DirectML, OpenVINO, ONNX Runtime, or another supported OCR/compute path.
    - Do not make pure CPU OCR the default fallback without evidence; existing
      page-3 benchmark evidence was about `34.9s` warm OCR on CPU versus about
      `0.59s` warm OCR on `gpu:0`.
  - Latest evidence:
    - Passed artifact:
      `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-21T10-37-19-351Z/streaming-baseline.json`.
      The closeout now writes `metrics.json`, `streaming-baseline.json`, and a
      finalized `windows-resource-summary.json`.
    - Closeout hardening:
      pre-cleanup artifacts are written before best-effort cleanup, Windows
      process snapshot/close/taskkill helpers have timeouts, and sampler stop
      writes `sampler_stop` evidence instead of blocking the final report.
    - `windows-dxgi-adapters.json` mapped adapter LUIDs to
      `AMD Radeon(TM) 880M Graphics`, `NVIDIA GeForce RTX 4060 Laptop GPU`,
      and `Microsoft Basic Render Driver`.
    - Finalized summary mapped three known DXGI adapters and one unmapped
      runtime LUID (`gpu_luid_map_status=partial`); sampler cleanup reported
      `forced_count=0`, `error_count=0`, and `duration_ms=27`.
    - Global AMD adapter activity was observable after spike filtering:
      `max_compute_percent=99.582`,
      `avg_engine_utilization_percent=0.066`, and
      `max_3d_percent=22.811`.
    - Target-process GPU memory tells the routing story more clearly:
      `exam-prep-ocr-runtime.exe` appeared only on `nvidia_dgpu`, with max
      dedicated process memory of `323796992` bytes and `1953300480` bytes
      across two OCR runtime PIDs. `ollama.exe` had only trivial GPU process
      memory (`4096` bytes total on AMD, `368640` bytes total on Nvidia).
    - Nvidia `nvidia-smi.csv` still showed meaningful dGPU use:
      the target-process Windows counters and Nvidia summary both still point
      at Nvidia as the active OCR GPU path.
    - Streaming gates passed:
      `first_chunk_visible=2043`, `first_usable_question_visible=44616`,
      `parse_complete_visible=91172`, `streaming_all_jobs_terminal=181978`,
      and all baseline checks were `true`.
    - iGPU Paddle probe:
      `apps/exam-prep-backend/.benchmarks/ocr-igpu-probe-20260622T001432Z.json`
      recorded `state=needs_alternative_backend`. Windows detected both
      `AMD Radeon(TM) 880M Graphics` and
      `NVIDIA GeForce RTX 4060 Laptop GPU`, but Paddle reported
      `compiled_with_cuda=true`, `compiled_with_rocm=false`,
      `available_devices=["gpu:0"]`, and `custom_device_types=[]`.
      A separate DirectML lane is required for AMD iGPU OCR work.
    - DirectML feasibility spec:
      `.agents/SPECS/domains/ocr-apu-directml.md`.
    - DirectML model prep:
      `apps/exam-prep-backend/.benchmarks/ocr-directml-prepare-models-20260622T010227Z.json`
      recorded `state=ready`. The explicit Docker release-prep target
      `ocr-directml-prepare-models-docker` reproduced PP-OCRv5 mobile det/rec
      conversion from checksum-verified official PaddleX source archives into
      `det_model.onnx` (`4748769` bytes) and `rec_model.onnx`
      (`16517247` bytes). It also wrote `pipeline.json` and
      `rec_char_dict.txt` (`18383` characters). No startup auto-download or
      runtime default changed.
    - DirectML probe:
      `apps/exam-prep-backend/.benchmarks/ocr-directml-probe-20260622T010301Z.json`
      recorded `state=ready`. `onnxruntime-directml 1.24.4` is
      available, providers include `DmlExecutionProvider` and
      `CPUExecutionProvider`, and DXGI metadata selects the AMD 880M iGPU as
      DirectML `device_id=0`; RTX 4060 is adapter index `1`.
    - DirectML session smoke:
      `apps/exam-prep-backend/.benchmarks/ocr-directml-smoke-20260622T010301Z.json`
      recorded `state=session_ready`. Required det/rec ONNX files create
      ONNX Runtime sessions with `DmlExecutionProvider` pinned to AMD DXGI
      adapter index `0`; session options are `enable_mem_pattern=false` and
      `execution_mode=ORT_SEQUENTIAL`.
    - DirectML inference smoke:
      `apps/exam-prep-backend/.benchmarks/ocr-directml-inference-smoke-20260622T010300Z.json`
      recorded `state=inference_ready`. The deterministic recognition smoke
      rendered `TEST`, decoded `TEST`, used `device=amd_directml`, and reported
      confidence about `0.967`.
    - DirectML benchmark:
      `apps/exam-prep-backend/.benchmarks/ocr-directml-benchmark-20260622T010946Z.json`
      recorded `state=benchmark_ready` on JLPT page 3. Warm DirectML OCR was
      `1789 ms` versus the CPU baseline `34900 ms`; `問題2`, `合併`, `中山`,
      and `加筆` anchors were all present. The runner uses dynamic recognition
      width and `DET_INPUT_LONG_SIDE=1152`, producing `459` chars.
    - Desktop telemetry now tracks `exam-prep-ocr-directml-runtime.exe` and
      writes `gpu_routing_checks` for `ocr_uses_amd_igpu`,
      `ocr_avoids_nvidia_dgpu`, `reasoning_uses_nvidia_dgpu`, and
      `gpu_luid_map_usable`.
    - Explicit backend `EXAM_PREP_OCR_PROVIDER=directml` is now the packaged
      default, guarded by DirectML runtime health/install checks. It does not
      silently fall back to CPU OCR.
    - Packaged DirectML runtime:
      `apps/exam-prep-backend/dist/ocr-directml-runtime/directml-ocr-runtime-manifest.json`
      now records `kind=directml_ocr`,
      `entrypoint=exam-prep-ocr-directml-runtime.exe`, SHA-256
      `ebcea572ff16717e274015455bb85faab7d0f0a6eab3087eb34171344499f028`,
      and `118632683` bytes. The Tauri resource manifest was synced with a
      local `file://` URL for QA; release builds can publish the same artifact
      by setting `EXAM_PREP_RUNTIME_ASSET_BASE_URL`.
    - Runtime install/health:
      DirectML OCR is installed through the runtime manager with explicit
      consent, checksum verification, manifest `kind=directml_ocr`, and
      self-test. Missing/unhealthy DirectML reports a blocker instead of
      silently falling back to CPU OCR. Paddle CUDA remains an explicit
      `EXAM_PREP_OCR_PROVIDER=paddle` override/debug path.
    - Packaged DirectML streaming production evidence:
      `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-22T02-08-02-496Z/streaming-baseline.json`
      recorded `status=passed`, `ocr_provider=directml`,
      `ocr_page_workers=1`, `qwen3:8b`, `46/46` pages, `46` chunks,
      `first_chunk_visible=9708 ms` under the `15000 ms` gate,
      `first_usable_question_visible=50595 ms`,
      `parse_complete_visible=85301 ms`, and `9/9` streaming jobs succeeded.
    - Packaged GPU routing proof:
      `windows-resource-summary.json` for the same run recorded
      `directml_ocr_process_observed=true`, `ocr_uses_amd_igpu=true`,
      `ocr_avoids_nvidia_dgpu=true`,
      `ocr_nvidia_process_memory_max_bytes=0`,
      `reasoning_uses_nvidia_dgpu=true`, and
      `gpu_luid_map_usable=true`. The DirectML OCR process showed AMD iGPU
      process residency up to `41906176` dedicated bytes and
      `7076143104` shared bytes, with no Nvidia dGPU residency.
    - Closeout note:
      A follow-up rerun after sampler hardening hit `ENOSPC` while writing QA
      artifacts, not an app failure. The successful raw telemetry was
      deterministically re-finalized with the updated named-process LUID gate.
      Old generated QA/build artifacts were removed, preserving the successful
      2026-06-22 evidence run.
  - Closed plan:
    1. Keep the new packaged streaming resource telemetry for CPU utilization,
       process RSS, DXGI adapter metadata, AMD adapter memory/engine counters,
       Nvidia utilization, Nvidia VRAM, and named target-process GPU memory.
    2. Keep closeout hardening in place so telemetry finalization cannot leave
       a completed UI flow without `metrics.json` and
       `streaming-baseline.json`.
    3. Align resource samples to parse start, first chunk, first usable
       question, parse completion, and streaming completion.
    4. Use target-process telemetry rather than global adapter activity when
       deciding whether OCR is routed to AMD or Nvidia.
    5. Package the DirectML OCR runtime and model assets as an explicit
       artifact with SHA-256, byte size, entrypoint, manifest kind, and install
       consent; do not download it during app startup.
    6. Run packaged streaming with `--ocr-provider directml --ocr-page-workers 1`
       and require process-level evidence that DirectML OCR uses AMD iGPU and
       stays under the Nvidia OCR residency gate.
    7. Keep this separate from the existing Paddle CUDA runtime.
    8. Do not silently fall back to pure CPU for the iGPU lane; prior CPU OCR
       evidence is too slow for streaming.
    9. Do not change Nvidia routing, OCR worker defaults, model defaults, or
       model parameters until telemetry supports the change.
  - Verify:
    `pnpm nx run exam-prep-backend:ocr-igpu-probe --skip-nx-cache`
    `pnpm nx run exam-prep-backend:ocr-directml-prepare-models --skip-nx-cache`
    `pnpm nx run exam-prep-backend:ocr-directml-prepare-models-docker --skip-nx-cache`
    `pnpm nx run exam-prep-backend:ocr-directml-probe --skip-nx-cache`
    `pnpm nx run exam-prep-backend:ocr-directml-session-smoke --skip-nx-cache`
    `pnpm nx run exam-prep-backend:ocr-directml-inference-smoke --skip-nx-cache`
    `pnpm nx run exam-prep-backend:ocr-directml-benchmark --skip-nx-cache`
    `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache`
    `uv run pytest tests/test_ocr_directml_prepare_models.py tests/test_ocr_directml_probe.py tests/test_ocr_directml_smoke.py tests/test_ocr_directml_inference_smoke.py tests/test_ocr_directml_runner.py tests/test_ocr_igpu_probe.py tests/test_ocr.py`
    `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache`
    `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`
    `git diff --check`
    `pnpm nx run exam-prep-desktop:packaged-streaming-baseline-directml --skip-nx-cache`
