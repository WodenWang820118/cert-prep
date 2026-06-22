# OCR APU DirectML Spec

## Purpose

Use the AMD Radeon 880M iGPU for OCR work when possible so the Nvidia RTX 4060
can be reserved for larger Ollama reasoning models. The current PaddleOCR GPU
runtime is CUDA-only on this Windows machine, so the AMD path is a separate
ONNX Runtime DirectML production gate rather than a configuration change to
`paddlepaddle-gpu`.

## Non-Goals

- Do not silently use Paddle CUDA or CPU OCR when the packaged DirectML runtime
  is missing or unhealthy. DirectML is the packaged default only through the
  runtime health/install gate.
- Do not silently fall back to CPU for the iGPU lane. CPU OCR is already too
  slow for streaming.
- Do not auto-download models or runtime dependencies during app startup.
- Do not treat a `directml` provider as available when the DirectML runtime is
  missing, corrupt, or failing health checks. A configured DirectML provider
  must report a blocker instead of falling back to CPU.
- Do not remove Nvidia telemetry; it remains the guardrail for reasoning-model
  headroom.

## Interfaces

- Backend dependency extra:
  `ocr-directml`, containing `onnxruntime-directml`.
- Backend OCR provider setting:
  `EXAM_PREP_OCR_PROVIDER=directml`.
- Backend extraction method enum value:
  `directml_ocr`.
- DirectML probe target:
  `pnpm nx run exam-prep-backend:ocr-directml-probe --skip-nx-cache`.
- DirectML model-prep target:
  `pnpm nx run exam-prep-backend:ocr-directml-prepare-models --skip-nx-cache`.
- Reproducible Docker conversion target:
  `pnpm nx run exam-prep-backend:ocr-directml-prepare-models-docker --skip-nx-cache`.
- DirectML session-smoke target:
  `pnpm nx run exam-prep-backend:ocr-directml-session-smoke --skip-nx-cache`.
- DirectML inference-smoke target:
  `pnpm nx run exam-prep-backend:ocr-directml-inference-smoke --skip-nx-cache`.
- DirectML benchmark target:
  `pnpm nx run exam-prep-backend:ocr-directml-benchmark --skip-nx-cache`.
- Packaged DirectML streaming target:
  `pnpm nx run exam-prep-desktop:packaged-streaming-baseline-directml --skip-nx-cache`.
- Probe JSON fields:
  `status.state`, `status.blockers`, `onnxruntime.providers`,
  `dxgi_adapters`, `status.directml_device_id`, `model_artifacts`, and
  `model_contract`.
- Model-prep JSON fields:
  `sources`, `extractions`, `metadata`, `conversions`, `model_artifacts`,
  and `status.blockers`.
- Session-smoke JSON fields:
  `status.state`, `status.session_ready`, `directml_session_smoke.sessions`,
  `directml_session_smoke.session_options`, `directml_session_smoke.errors`,
  and nested probe evidence.
- Model artifact contract for future PP-OCR ONNX runtime:
  - `det_model.onnx`
  - `rec_model.onnx`
  - `rec_char_dict.txt`
  - `pipeline.json`
  - optional `cls_model.onnx`
- Packaged resource summary fields:
  - `gpu_routing_checks.ocr_uses_amd_igpu`
  - `gpu_routing_checks.ocr_avoids_nvidia_dgpu`
  - `gpu_routing_checks.reasoning_uses_nvidia_dgpu`
  - `gpu_routing_checks.gpu_luid_map_usable`

## Key Decisions

- The packaged production preference is `EXAM_PREP_OCR_PROVIDER=directml`.
  Paddle CUDA remains available as an explicit `EXAM_PREP_OCR_PROVIDER=paddle`
  override/debug path.
- The backend accepts an explicit `directml` OCR provider setting and routes it
  through the external DirectML OCR runtime. Missing or unhealthy DirectML
  reports a blocker instead of silently using CPU OCR.
- ONNX Runtime DirectML is the first implementation path because official ONNX
  Runtime docs describe `DmlExecutionProvider` as DirectML acceleration for
  ONNX inference on DirectX 12 hardware.
- DirectML OCR model prep uses official PaddleX PP-OCRv5 mobile detection and
  recognition inference archives as the source of truth. The prep target
  validates SHA-256 and byte size, safely extracts the archives, writes
  `pipeline.json`, and exports `rec_char_dict.txt`; it does not mark the gate
  ready until `det_model.onnx` and `rec_model.onnx` are actually produced.
- ONNX conversion is reproducible through the explicit Docker release-prep
  target using the official PaddleX CPU image. The backend now allows Python
  `3.12` compatibility, so local conversion may use an explicit Python 3.12
  release-prep environment; Docker conversion remains the Windows-safe
  reproducible lane.
- DirectML `device_id` must be selected from DXGI adapter order. On the current
  machine, AMD Radeon 880M is DXGI adapter index `0` and RTX 4060 is index `1`.
- DirectML sessions must set `enable_mem_pattern=false` and
  `execution_mode=ORT_SEQUENTIAL`.
- Current DirectML sessions register `DmlExecutionProvider` followed by
  `CPUExecutionProvider`, so ONNX Runtime may partition unsupported work to CPU
  by provider priority. This mixed fallback behavior is useful for reliability,
  but production routing evidence must still prove OCR residency on the AMD
  iGPU and avoid Nvidia dGPU usage.
- Formal direction as of 2026-06-22: use the DirectML lane's mixed
  `DmlExecutionProvider` + `CPUExecutionProvider` behavior for reliability and
  latency research. The standalone Windows ML/VitisAI NPU OCR lane is retired
  from product/runtime surfaces. Historical Windows ML policy probe artifacts
  remain evidence only and are not Nx targets or production QA gates.
- Inference smoke and benchmark targets are explicit production gates. The
  deterministic smoke currently proves recognition-model inference on AMD
  DirectML; the JLPT page-3 benchmark proves the full det/rec runner is fast
  and anchor-complete before packaged routing is allowed.
- `ready_for_model` means DirectML is available, the AMD DXGI adapter index is
  known, and missing ONNX artifacts are reported explicitly.
- `ready` means DirectML is available, the AMD DXGI adapter index is known, and
  required model artifacts are present.
- `session_ready` means required ONNX model files can create ONNX Runtime
  sessions with `DmlExecutionProvider`. It does not yet mean OCR
  quality/performance is accepted.
- `inference_ready` means deterministic OCR inference returns non-empty text
  with `device=amd_directml`.
- `benchmark_ready` means the JLPT page-3 DirectML benchmark beats the CPU
  baseline and passes required anchors.
- Packaged telemetry is the production gate proving DirectML OCR process
  observation, AMD iGPU residency, Nvidia dGPU avoidance, Ollama reasoning on
  Nvidia, and clean shutdown.

## Edge Cases And Failure Modes

- `onnxruntime-directml` missing or unavailable on the current Python version.
- `DmlExecutionProvider` not listed even though `onnxruntime` imports.
- AMD adapter not visible through Windows video-controller or DXGI metadata.
- DXGI adapter order cannot be mapped, so the DirectML `device_id` cannot be
  pinned to the AMD iGPU.
- Required model files missing or empty.
- Official model archive missing, corrupted, or failing checksum.
- PaddleX/Paddle2ONNX conversion plugin unavailable in the current Python
  runtime.
- Both CPU and DirectML providers exist; the probe must still require
  `DmlExecutionProvider` and AMD DXGI adapter index evidence.
- A DirectML provider may exist without guaranteeing a given PP-OCR ONNX graph
  is supported. Full inference and packaged routing telemetry are required
  gates.
- Session creation may fail even when files exist if the exported ONNX graph
  uses unsupported opsets/operators.
- Windows GPU process counters can be misleading on affected Windows versions,
  so routing gates must cross-check DXGI LUID mapping, process memory, engine
  counters, and Nvidia telemetry rather than relying on one counter family.

## Current Evidence

- DirectML model-prep artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-prepare-models-20260622T010227Z.json`.
- Model-prep status: `ready`.
- Official source archives are present and checksum-verified:
  - `PP-OCRv5_mobile_det_infer.tar`, SHA-256
    `50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58`,
    `4935680` bytes.
  - `PP-OCRv5_mobile_rec_infer.tar`, SHA-256
    `566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414`,
    `16834560` bytes.
- Model-prep wrote `pipeline.json` and `rec_char_dict.txt`
  (`18383` characters) to
  `apps/exam-prep-backend/.benchmarks/ocr-directml-models/`.
- Docker conversion produced:
  - `det_model.onnx`, `4748769` bytes.
  - `rec_model.onnx`, `16517247` bytes.
- `ocr-directml-prepare-models-docker` reproduced conversion through the
  official PaddleX image without changing app startup behavior. A local Python
  `3.12` release-prep environment is now allowed for future PaddleX/Paddle2ONNX
  conversion attempts.
- DirectML probe artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-probe-20260622T010301Z.json`.
- Status: `ready`.
- ONNX Runtime: `onnxruntime-directml 1.24.4`.
- Providers: `DmlExecutionProvider`, `CPUExecutionProvider`.
- DXGI adapter order:
  - `adapter_index=0`: `AMD Radeon(TM) 880M Graphics`, `amd_igpu`
  - `adapter_index=1`: `NVIDIA GeForce RTX 4060 Laptop GPU`, `nvidia_dgpu`
  - `adapter_index=2`: `Microsoft Basic Render Driver`, `software`
- DirectML device id selected for the AMD iGPU: `0`.
- Required model artifacts are present in the repo-local ignored benchmark
  model directory.
- Packaged production OCR now defaults to DirectML through
  `EXAM_PREP_OCR_PROVIDER=directml`. Paddle CUDA remains available as an
  explicit override.
- Session-smoke artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-smoke-20260622T010301Z.json`.
- Session-smoke status: `session_ready`.
- Required det/rec ONNX models create ONNX Runtime sessions with
  `DmlExecutionProvider` pinned to AMD DXGI adapter index `0`. Session options
  are `enable_mem_pattern=false` and `execution_mode=ORT_SEQUENTIAL`.
- Inference-smoke artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-inference-smoke-20260622T010300Z.json`.
- Inference-smoke status: `inference_ready`.
- Deterministic recognition smoke rendered `TEST`, decoded `TEST`, used
  `device=amd_directml`, and reported confidence about `0.967`.
- Benchmark artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-directml-benchmark-20260622T010946Z.json`.
- Benchmark status: `benchmark_ready`.
- JLPT page-3 DirectML benchmark used `DET_INPUT_LONG_SIDE=1152` and dynamic
  recognition width. Warm OCR latency was `1789 ms`, CPU baseline was
  `34900 ms`, text length was `459` chars, and anchors `問題2`, `合併`, `中山`,
  and `加筆` were all present.
- DirectML runtime artifact:
  `apps/exam-prep-backend/dist/ocr-directml-runtime/directml-ocr-runtime-manifest.json`.
- Runtime artifact status: `kind=directml_ocr`,
  `entrypoint=exam-prep-ocr-directml-runtime.exe`, SHA-256
  `ebcea572ff16717e274015455bb85faab7d0f0a6eab3087eb34171344499f028`,
  and `118632683` bytes. The Tauri resource manifest was synced with a local
  `file://` URL for QA. Release builds can publish the same artifact by
  setting `EXAM_PREP_RUNTIME_ASSET_BASE_URL`.
- Runtime install path:
  the DirectML OCR runtime uses explicit install consent, checksum
  verification, manifest `kind=directml_ocr`, DirectML self-test, and a
  health blocker when missing/unhealthy. It does not silently fall back to CPU.
- Packaged DirectML streaming artifact:
  `tmp/exam-prep-desktop/packaged-streaming-baseline/2026-06-22T02-08-02-496Z/streaming-baseline.json`.
- Packaged DirectML streaming status: `passed`.
- Packaged DirectML streaming timings:
  `first_chunk_visible=9708 ms` under the `15000 ms` gate,
  `first_usable_question_visible=50595 ms`,
  `parse_complete_visible=85301 ms`, and `streaming_all_jobs_terminal=130529 ms`.
- Packaged DirectML streaming counts:
  `46/46` pages, `46` chunks, `9/9` streaming jobs succeeded, and
  `9` usable questions generated.
- Packaged GPU routing:
  `windows-resource-summary.json` recorded
  `directml_ocr_process_observed=true`, `ocr_uses_amd_igpu=true`,
  `ocr_avoids_nvidia_dgpu=true`,
  `ocr_nvidia_process_memory_max_bytes=0`,
  `reasoning_uses_nvidia_dgpu=true`, and `gpu_luid_map_usable=true`.
- DirectML OCR process residency:
  AMD iGPU process memory reached `41906176` dedicated bytes and
  `7076143104` shared bytes. Nvidia dGPU process memory for OCR stayed at
  `0` bytes, below the `67108864` byte gate.
- PaddleOCR 3.7 isolated ONNX Runtime probe target:
  `pnpm nx run exam-prep-backend:ocr-paddle37-onnxruntime-probe --skip-nx-cache`.
- PaddleOCR 3.7 isolated artifact:
  `apps/exam-prep-backend/.benchmarks/ocr-paddle37-onnxruntime-probe-20260622T141653Z.json`.
- Probe isolation:
  the target uses `uv run --no-project --python 3.12 --with paddleocr==3.7.0`
  plus Windows ML/WinAppSDK packages, so it does not mutate the backend
  project venv or production runtime defaults.
- PaddleOCR 3.7 model staging:
  existing PP-OCRv5 ONNX artifacts were staged into PaddleX's expected layout:
  `det/inference.onnx`, `det/inference.yml`, `rec/inference.onnx`,
  `rec/inference.yml`, and `rec/ppocr_keys_v1.txt`.
- PaddleOCR 3.7 ONNX Runtime CPU smoke:
  `engine='onnxruntime'`, `providers=['CPUExecutionProvider']`, initialized in
  `499 ms`, inferred in `43 ms`, and decoded `OCRTEST`.
- PaddleOCR 3.7 ONNX Runtime AMD iGPU DML smoke:
  `providers=['DmlExecutionProvider','CPUExecutionProvider']` with
  `provider_options=[{'device_id': 1}, {}]`, initialized in `775 ms`, inferred
  in `287 ms`, decoded `OCRTEST`, and the internal det/rec sessions reported
  `DmlExecutionProvider + CPUExecutionProvider`.
- PaddleOCR 3.7 Windows ML hybrid provider-name attempt:
  Windows ML registration discovered `MIGraphXExecutionProvider` and
  `VitisAIExecutionProvider` EP devices, but PaddleX 3.7's
  `ONNXRuntimeRunner` validates providers against
  `onnxruntime.get_available_providers()`, which still reports only
  `DmlExecutionProvider` and `CPUExecutionProvider`. The hybrid attempt fails
  with provider-unavailable before session creation.
- Replacement assessment:
  PaddleOCR 3.7 is a strong refactor candidate for deleting most custom
  PP-OCR preprocessing/postprocessing in the AMD iGPU DML lane. It is not yet
  a replacement for the explicit Windows ML `add_provider_for_devices()`
  NPU+iGPU lane unless PaddleX exposes EP-device binding or a local wrapper
  patches its runner.

## Acceptance Criteria

- `ocr-directml` resolves on the repo Python runtime without changing the
  default backend install.
- `ocr-directml-probe` writes a machine-readable benchmark artifact.
- Without ONNX OCR models, the probe reports `ready_for_model` when
  `DmlExecutionProvider` exists, the AMD DXGI adapter index is known, and it
  includes `model_artifacts_missing`.
- Without `DmlExecutionProvider`, the probe reports `blocked` and includes
  `directml_provider_unavailable`.
- Unit tests cover provider classification, model-contract validation, and
  default artifact paths, including the required `pipeline.json`.
- Model-prep unit tests cover checksum-backed source archives, safe tar
  extraction, generated `pipeline.json` / `rec_char_dict.txt`, converter
  blocker reporting, forced Docker-mode conversion, and copied ONNX outputs
  when conversion succeeds.
- Session-smoke unit tests cover skipped/missing-model state, session-ready
  state, session-failed state, and blocked DirectML state.
- Inference-smoke unit tests cover skipped, passed, and text-mismatch states.
- Runner unit tests cover dynamic recognition width for long text lines and
  CTC blank/duplicate decoding.
- Existing Paddle OCR tests still pass.
- The explicit `directml` provider health path reports unavailable when the
  runtime is missing/unhealthy and never falls back to CPU OCR.
- Backend QA evidence shows DirectML model prep, probe, session smoke,
  deterministic inference, and JLPT page-3 benchmark gates passing.
- Packaged resource summaries include `gpu_routing_checks` for AMD OCR usage,
  Nvidia OCR avoidance, reasoning-on-Nvidia evidence, and DXGI LUID usability.
- Packaged DirectML streaming baseline passes with `ocr_provider=directml` and
  `ocr_page_workers=1`.
- PaddleOCR 3.7 ONNXRuntime isolated probe passes CPU and AMD iGPU DML
  inference on `OCRTEST`, records internal session providers, and leaves
  production defaults unchanged.
- PaddleOCR 3.7 is not accepted as an NPU+iGPU replacement until it can express
  Windows ML EP-device binding or otherwise prove VitisAI+MIGraphX session
  creation and inference through the high-level OCR pipeline.

## Test Plan

- `uv run pytest tests/test_ocr_directml_prepare_models.py tests/test_ocr_directml_probe.py tests/test_ocr_directml_smoke.py tests/test_ocr_directml_inference_smoke.py tests/test_ocr_directml_runner.py tests/test_ocr_igpu_probe.py tests/test_ocr.py`
- `pnpm nx run exam-prep-backend:ocr-directml-probe --skip-nx-cache`
- `pnpm nx run exam-prep-backend:ocr-directml-prepare-models --skip-nx-cache`
- `pnpm nx run exam-prep-backend:ocr-directml-prepare-models-docker --skip-nx-cache`
- `pnpm nx run exam-prep-backend:ocr-directml-session-smoke --skip-nx-cache`
- `pnpm nx run exam-prep-backend:ocr-directml-inference-smoke --skip-nx-cache`
- `pnpm nx run exam-prep-backend:ocr-directml-benchmark --skip-nx-cache`
- `pnpm nx run exam-prep-backend:ocr-paddle37-onnxruntime-probe --skip-nx-cache`
- `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache`
- `pnpm nx run exam-prep-backend:test --skip-nx-cache`
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:packaged-streaming-baseline-directml --skip-nx-cache`
- `git diff --check`

## References

- ONNX Runtime DirectML Execution Provider:
  https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html
- PaddleOCR Paddle2ONNX reference:
  https://paddlepaddle.github.io/PaddleOCR/main/en/version2.x/legacy/paddle2onnx.html
- PaddleX high-performance inference reference:
  https://paddlepaddle.github.io/PaddleX/3.4/en/pipeline_deploy/high_performance_inference.html
- PaddleOCR 3.x inference engine reference:
  https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/local_inference/inference_engine.en.md
- PaddleX text detection model reference:
  https://paddlepaddle.github.io/PaddleX/3.4/en/module_usage/tutorials/ocr_modules/text_detection.html
- PaddleX text recognition model reference:
  https://paddlepaddle.github.io/PaddleX/3.4/en/module_usage/tutorials/ocr_modules/text_recognition.html
- Windows GPU process memory counter caveat:
  https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/gpu-process-memory-counters-report-wrong-value
