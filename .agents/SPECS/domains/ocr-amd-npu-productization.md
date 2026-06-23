# AMD NPU OCR Productization Slice

Date: 2026-06-23

## Decision

Reintroduce `amd_npu` as an opt-in OCR product lane while keeping `directml`
as the packaged default. The NPU lane is additive and gate-first: it may expose
runtime installation, packaging, probe, and smoke targets, but it must remain
unavailable until strict VitisAI session, real OCR inference, packaged streaming,
routing, and DirectML no-regression gates pass.

## Runtime Shape

- Backend OCR provider: `EXAM_PREP_OCR_PROVIDER=amd_npu`.
- Runtime requirement kind: `amd_npu_ocr`.
- Document extraction method: `amd_npu_ocr`.
- Runtime manifest resource: `amd-npu-ocr-runtime-manifest.json`.
- Packaged runtime entrypoint: `exam-prep-ocr-amd-npu-runtime.exe`.
- Temporary simplification: the experimental `amd_npu` gate no longer requires
  strict NPU-only execution. The current hybrid lane runs a VitisAI NPU
  text-density prepass inside the OCR pipeline, then uses the existing
  PaddleOCR 3.7 DirectML runner for detection and recognition. DirectML remains
  the packaged default.
- Windows ML EP registration must prefer `ExecutionProviderCatalog` and
  `ensure_ready_async()` before falling back to a WindowsApps DLL scan.
- VitisAI NPU readiness must be derived from `OrtEpDevice.device.type == NPU`;
  the Python `OrtEpDevice` object does not expose `device_type` as a top-level
  property.

## Gates

- Hardware smoke gate proves the AMD NPU lane independently of OCR by running a
  deterministic tiny CNN through AMD's documented Windows ML + ONNX Runtime +
  `VitisAIExecutionProvider` pattern. This gate may allow CPU fallback for
  shape/bookkeeping nodes, matching AMD's ResNet sample, but it only passes
  when ORT profiling records `VitisAIExecutionProvider` events.
- Probe gate records Windows ML/VitisAI device visibility and `xrt-smi` evidence.
- Session gate requires both detection and recognition ONNX session creation
  through NPU-preferred Windows ML `VitisAIExecutionProvider`; CPU fallback is
  allowed for unsupported PaddleOCR nodes.
- Inference gate runs the NPU text-density prepass plus synthetic tensors
  through both PaddleOCR ONNX models. It passes when the prepass records
  VitisAI profile events and both PaddleOCR model sessions complete.
- Packaging gate runs runtime self-test and stops if the runtime remains
  unavailable.
- Product gate is provider-aware: `directml` checks DirectML process/iGPU/Nvidia
  avoidance; `amd_npu` checks NPU runtime process, paired AMD iGPU routing,
  Nvidia avoidance, and `xrt-smi` NPU evidence. Missing watts must be recorded
  as `power_watts_available=false`, not treated as an efficiency win.

## Current Status

Implemented the product lane surfaces and strict evidence gates. On the current
AMD Ryzen AI 9 H 365 host, `ocr-amd-npu-probe --ensure-ready` now resolves the
Windows ML catalog VitisAI package:

- EP package:
  `MicrosoftCorporationII.WinML.AMD.NPU.EP.1.8_1.8.62.0_x64__8wekyb3d8bbwe`.
- EP device:
  `VitisAIExecutionProvider`, vendor `AMD`, device type `NPU`, device id `6128`.
- `xrt-smi` sees `NPU Strix` and exposes power data.

The strict NPU-only PP-OCRv6 gate still fails correctly: ONNX Runtime reports
that both `det/inference.onnx` and `rec/inference.onnx` contain graph nodes
assigned to CPU while `session.disable_cpu_ep_fallback=1` is set. With CPU
fallback allowed, both PaddleOCR sessions complete under
`VitisAIExecutionProvider + CPUExecutionProvider`, but profile events for
PP-OCRv6 det/rec remain CPU-only. Therefore the product lane uses a VitisAI NPU
text-density prepass as the NPU-participating OCR stage and DirectML for the
PaddleOCR det/rec text path.

The current `ocr-amd-npu-inference-smoke --ensure-ready
--fail-if-not-inference-ready` passes with:

- `status.state=inference_ready`.
- `npu_prepass.provider_event_counts.VitisAIExecutionProvider=1`.
- `npu_participating_models=["ocr_prepass/text_density"]`.
- `npu_participation_coverage={participating: 1, total: 3}`.
- `paddleocr_model_npu_compute_detected=false`.

The runtime self-test now also passes: `ocr_amd_npu_runtime.py --ocr-self-test`
returns `OCRTEST`, `extraction_method=amd_npu_ocr`, and
`device=amd_npu:vitisai+amd_directml:0`, with fallback metadata recording
`npu_prepass=text_density_vitisai;vitisai_events=1;paddleocr_det_rec=directml`.

The hardware lane is independently proven with `amd-npu-official-smoke`: it
uses the AMD Windows ML ResNet example pattern, explicit VitisAI NPU device
binding, and a deterministic tiny CNN built from Ryzen AI supported ONNX
operators. On this host the smoke records `VitisAIExecutionProvider` profile
events and marks `npu_active`, while also recording CPU events as allowed
fallback. The report now records `directml_provider_in_session=false` and
`nvidia_ep_device_bound=false`; RTX 4060 may appear in device enumeration or
system `nvidia-smi` snapshots, but it is not bound into this ONNX Runtime
session. This confirms the AMD NPU can execute a CNN subgraph; it does not
change the OCR product gate.

PaddleX/PaddleOCR 3.7 also still cannot consume the Windows ML catalog VitisAI
device through plain `engine_config.providers`: catalog registration exposes the
NPU through `get_ep_devices()` / `SessionOptions.add_provider_for_devices()`, but
`get_available_providers()` remains `DmlExecutionProvider` and
`CPUExecutionProvider`. This confirms the product lane needs a custom ONNX
Runtime NPU-only stage runner for Windows ML device binding rather than a pure
PaddleOCR config change.

The first viable replacement-model candidate is AMD's RyzenAI-SW
`Nemotron-OCR-V2` example. AMD documents it as an end-to-end OCR pipeline on
Ryzen AI NPU using BF16 VitisAI compilation, with static ONNX detector,
recognizer, and relational models. It is promising for the recognition stage,
but it cannot be productized before license review because the model is governed
by NVIDIA's Open Model License Agreement while the post-processing scripts are
Apache 2.0.

References:

- AMD Ryzen AI Windows ML EP docs:
  https://ryzenai.docs.amd.com/en/latest/winml/winml_ep.html
- Microsoft Windows ML EP selection:
  https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/select-execution-providers
- Microsoft Windows ML EP registration:
  https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/register-execution-providers
- AMD Ryzen AI model run/provider options:
  https://ryzenai.docs.amd.com/en/latest/modelrun.html
- AMD Ryzen AI Windows ML ResNet example:
  https://ryzenai.docs.amd.com/en/latest/winml/winml_example.html
- AMD Ryzen AI supported operators:
  https://ryzenai.docs.amd.com/en/latest/ops_support.html
- AMD RyzenAI-SW Nemotron OCR v2 example:
  https://github.com/amd/RyzenAI-SW/tree/main/CNN-examples/Nemotron-OCR-V2
