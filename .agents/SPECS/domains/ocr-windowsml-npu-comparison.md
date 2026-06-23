# WindowsML OCR NPU Comparison Notes

Date: 2026-06-23
Scope: Read-only comparison between `C:\software-dev\win-ml-example` and this `exam-prep` workspace.

## Purpose

This note is for the `exam-prep` agent. It compares the dedicated `win-ml-example`
NPU proof harness with the current `exam-prep` WindowsML OCR implementation, then
lists checks and recommendations for verifying whether OCR inference is really
scheduled on the NPU.

No heavy `exam-prep` prepare, packaging, or benchmark target was rerun for this
note. Observations are based on source inspection, Nx resolved target inspection,
existing `.agents` planning notes, and existing local benchmark/production
artifacts.

## Short Conclusion

Seeing little or no real NPU activity during `exam-prep` OCR inference is expected
with the current product path.

The current product OCR lane is:

- Public provider/runtime: `windowsml` / `windowsml_ocr`.
- Full PaddleOCR detection and recognition: ONNX Runtime with
  `DmlExecutionProvider` plus `CPUExecutionProvider`.
- NPU participation: a small internal `text-density` prepass that attempts
  `VitisAIExecutionProvider` evidence when available.

Therefore, successful OCR in the product lane currently proves WindowsML/DML
AMD iGPU routing, not full PaddleOCR det/rec NPU scheduling. The NPU evidence is
separate and should only be claimed when ORT profile data shows
`VitisAIExecutionProvider` node events.

## Current Repo: win-ml-example

Workspace: `C:\software-dev\win-ml-example`

Resolved Nx project:

- `winml-npu-demo`

Important files:

- `packages/winml-npu-demo/project.json`
- `packages/winml-npu-demo/pyproject.toml`
- `packages/winml-npu-demo/src/winml_npu_demo/inference.py`
- `packages/winml-npu-demo/src/winml_npu_demo/winml_runtime.py`
- `packages/winml-npu-demo/src/winml_npu_demo/profiles.py`
- `packages/winml-npu-demo/src/winml_npu_demo/diagnostics.py`

Key behavior:

- Uses `onnxruntime-windowsml==1.24.6.202605042033`.
- Uses Windows App SDK / Windows ML packages.
- Runs an official SqueezeNet ONNX model, not OCR.
- `run` prefers NPU but allows fallback.
- `run-npu` calls Windows ML EP readiness/registration and fails unless NPU
  scheduling is proven.
- NPU proof is based on ORT profile provider node counts, not just provider
  visibility or Task Manager.
- `observe-npu` keeps a sustained inference loop running after warm-up so Task
  Manager can be watched, but the JSON report remains the source of truth.

The proof logic is stricter than `exam-prep`:

- It bootstraps Windows App SDK.
- It queries `ExecutionProviderCatalog`.
- It can call `ensure_ready_async()`.
- It registers provider libraries with ONNX Runtime.
- It sets `OrtExecutionProviderDevicePolicy`, such as `PREFER_NPU`.
- It enables ORT profiling.
- It parses profile events and only accepts NPU scheduling when profiled node
  execution appears on a discovered/catalog NPU provider.
- If `--require-npu` is used and scheduling is not proven, the CLI exits
  non-zero.

Recommended baseline commands from that repo:

```powershell
npm exec nx run winml-npu-demo:diagnose
npm exec nx run winml-npu-demo:run-npu
npm exec nx run winml-npu-demo:observe-npu
```

Report fields to inspect:

- `npu_scheduled`
- `npu_status_reason`
- `npu_provider_names`
- `profile_provider_node_counts`
- `registration.providers`
- `diagnostics.onnxruntime.ep_devices`

## exam-prep Current Product OCR Path

Workspace: `C:\software-dev\cert-prep`

Resolved projects include:

- `exam-prep-backend`
- `exam-prep-desktop`
- `exam-prep-e2e`
- `exam-prep`

Important source files:

- `apps/exam-prep-backend/pyproject.toml`
- `apps/exam-prep-backend/src/exam_prep_backend/ocr_windowsml_runtime.py`
- `apps/exam-prep-backend/src/exam_prep_backend/domains/source_documents/adapters/external_windowsml.py`
- `apps/exam-prep-backend/src/exam_prep_backend/domains/source_documents/adapters/windowsml/runtime.py`
- `apps/exam-prep-backend/src/exam_prep_backend/domains/source_documents/adapters/windowsml/device.py`
- `apps/exam-prep-backend/src/exam_prep_backend/domains/source_documents/adapters/windowsml/npu_prepass.py`
- `apps/exam-prep-backend/scripts/runtime/windowsml/ocr_windowsml_probe.py`
- `apps/exam-prep-backend/scripts/runtime/windowsml/ocr_windowsml_smoke.py`
- `apps/exam-prep-backend/scripts/runtime/windowsml/ocr_windowsml_inference_smoke.py`
- `apps/exam-prep-backend/scripts/runtime/windowsml/ocr_windowsml_benchmark.py`
- `.agents/SPECS/domains/ocr-amd-npu-productization.md`
- `.agents/SPECS/domains/parsing-reasoning.md`

Current product decision:

- Standalone `amd_npu` OCR productization is retired.
- WindowsML is the only packaged accelerated OCR runtime lane.
- Public surfaces are `EXAM_PREP_OCR_PROVIDER=windowsml`,
  runtime kind `windowsml_ocr`, and extraction method `windowsml_ocr`.
- AMD/VitisAI names remain only as internal hardware evidence.

Current full OCR implementation:

```python
PaddleOCR(
    ...,
    engine="onnxruntime",
    engine_config={
        "providers": ["DmlExecutionProvider", "CPUExecutionProvider"],
        "provider_options": [{"device_id": self._windowsml_device_id()}, {}],
        "enable_mem_pattern": False,
        "execution_mode": "sequential",
    },
)
```

That means the main PaddleOCR detection/recognition path is DML/iGPU plus CPU
fallback. It is not a VitisAI/NPU-only det/rec path.

Current NPU participation path:

- `WindowsMLNpuPrepass` runs before full PaddleOCR.
- It uses `npu-prepass/text-density.onnx`.
- It attempts `VitisAIExecutionProvider` or uses WindowsML policy selection.
- It enables ORT profiling.
- It summarizes `VitisAIExecutionProvider`, `CPUExecutionProvider`, and
  `DmlExecutionProvider` profile events.
- Evidence is folded into `fallback_reason`, for example:
  `npu_prepass=text_density_vitisai;vitisai_events=...;cpu_events=...`.
- If VitisAI events are missing, it records unavailable evidence, for example:
  `npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=5`.

## Existing Local Evidence Observed

The latest inspected packaged WindowsML production artifact was:

`tmp/exam-prep-desktop/packaged-streaming-production/2026-06-23T02-57-52-542Z/production-summary.json`

It showed:

- OCR completed expected pages: `46/46`.
- OCR chunks present.
- `windowsml_ocr_process_observed: true`.
- `ocr_uses_amd_igpu: true`.
- `ocr_avoids_nvidia_dgpu: true`.
- `windowsml_npu_prepass_evidence.available: false`.
- `ocr_device: amd_windowsml:0`.
- `fallback_reason: npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=5`.
- `vitisai_events: 0`.
- `cpu_events: 5`.
- `xrt-smi` detected NPU Strix hardware and reported driver/firmware metadata.

Interpretation:

- Product OCR succeeded on WindowsML/AMD iGPU.
- The NPU hardware existed.
- The inspected packaged production run did not prove NPU execution for the
  prepass, and it did not prove full PaddleOCR det/rec NPU execution.

The latest inspected WindowsML inference smoke artifact was:

`apps/exam-prep-backend/.benchmarks/ocr-windowsml-inference-smoke-20260623T033646Z.json`

It showed:

- ONNX Runtime providers: `DmlExecutionProvider`, `CPUExecutionProvider`.
- Session smoke requested DML/CPU.
- Deterministic OCR inference passed.
- `provider_result.device: amd_windowsml:0`.
- `provider_result.fallback_reason:
  npu_prepass_unavailable=vitisai_events_missing;vitisai_events=0;cpu_events=5`.
- AMD iGPU resource and compute observed.
- Nvidia dGPU avoided for OCR.

Interpretation:

- This artifact supports DML/iGPU OCR readiness.
- It does not support a claim that OCR inference ran on the NPU.

## Why Task Manager May Be Misleading

Task Manager can be useful for observation, but it is not enough to prove NPU
scheduling.

Reasons:

- WindowsML setup and VitisAI warm-up can be CPU-heavy before NPU inference.
- Very short inference may be too brief to visibly register.
- DML/iGPU activity may appear under GPU counters, not NPU.
- Hardware detection via `xrt-smi` or `Get-PnpDevice` only proves the device
  exists, not that ORT scheduled nodes to it.
- CPU fallback can hide unsupported ops unless profile provider counts are
  checked.

Use ORT profile provider counts as the authority.

## Recommended Checks for exam-prep Agent

Start with resolved targets, not guessed `project.json` fragments:

```powershell
pnpm nx show projects --json
pnpm nx show project exam-prep-backend --json
pnpm nx show project exam-prep-desktop --json
```

Check the current product WindowsML lane:

```powershell
pnpm nx run exam-prep-backend:ocr-windowsml-probe --skip-nx-cache
pnpm nx run exam-prep-backend:ocr-windowsml-session-smoke --skip-nx-cache
pnpm nx run exam-prep-backend:ocr-windowsml-inference-smoke --skip-nx-cache
pnpm nx run exam-prep-backend:ocr-windowsml-benchmark --skip-nx-cache
pnpm nx run exam-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache
```

Interpret these fields:

- `providers`
- `providers_requested`
- `provider_mix.provider_counts`
- `provider_result.fallback_reason`
- `windowsml_npu_prepass_evidence`
- `gpu_routing_checks.ocr_uses_amd_igpu`
- `gpu_routing_checks.ocr_avoids_nvidia_dgpu`
- `xrt_smi_summary.npu_detected`
- `windowsml_npu_hardware_observation.evidence_scope`

Do not count NPU as used unless one of these is true:

- ORT profile provider counts include `VitisAIExecutionProvider` node events for
  the specific inference stage being claimed.
- A strict NPU proof target reports `npu_scheduled: true` from profile evidence.

Treat these as insufficient by themselves:

- `NPU Strix` detected by `xrt-smi`.
- `VitisAIExecutionProvider` visible in a catalog.
- `DmlExecutionProvider` activity.
- AMD iGPU GPU counters.
- A successful OCR result.
- `PREFER_NPU` policy without profile evidence.

## Recommendations

### 1. Keep Product Language Precise

Use wording like:

- "WindowsML OCR"
- "AMD iGPU accelerated OCR"
- "NPU prepass evidence when available"

Avoid wording like:

- "OCR runs on NPU"
- "NPU OCR ready"
- "PaddleOCR NPU inference"

unless `VitisAIExecutionProvider` node events are present for the claimed OCR
stage.

### 2. Port the win-ml-example Proof Gate into exam-prep

The `win-ml-example` proof pattern is the right template for a strict gate:

- Bootstrap Windows App SDK.
- Query Windows ML `ExecutionProviderCatalog`.
- Optionally call `ensure_ready_async()`.
- Register provider libraries.
- Capture `ort.get_ep_devices()`.
- Enable ORT profiling.
- Parse profile provider counts.
- Set `npu_scheduled` only when profiled nodes ran on a NPU provider.
- Fail the strict target when `--require-npu` is requested and scheduling is not
  proven.

This can be an internal diagnostic target first. It should not change product
defaults.

### 3. Separate Three Evidence Lanes

Keep these lanes separate in artifacts and UI copy:

1. OCR correctness and latency.
2. DML/iGPU routing and Nvidia avoidance.
3. NPU participation or NPU scheduling.

Do not let lane 1 or 2 imply lane 3.

### 4. If Full OCR NPU Is Required, Do Not Depend on PaddleOCR Wrapper Alone

The PaddleOCR 3.7 wrapper currently validates provider names through
`onnxruntime.get_available_providers()` and the current product path uses
DML/CPU. For full NPU det/rec, evaluate a lower-level runner:

- Direct ORT sessions for det and rec.
- Static input shapes where possible.
- QDQ int8 or other NPU-friendly model variants.
- Explicit VitisAI provider/device binding.
- CPU fallback disabled for strict proof.
- ORT profile provider counts required before acceptance.

This should stay experimental until accuracy, latency, and provider node counts
all pass.

### 5. Preserve Current Product Default Until NPU Proof Is Stronger

The current WindowsML/DML product path has useful evidence:

- Full OCR can complete expected pages.
- AMD iGPU routing can be observed.
- Nvidia avoidance can be checked.
- Product packaging and UI can remain stable.

Do not reintroduce `amd_npu` as a public provider/runtime unless a separate
product decision reverses the current `.agents` decision and strict NPU evidence
passes.

## Suggested Acceptance Criteria for Future NPU Work

A future "NPU OCR" slice should require all of the following:

- `ort.get_ep_devices()` or Windows ML catalog shows the target NPU EP/device.
- `ensure_ready_async()` or equivalent approved setup completed when required.
- A strict NPU session can be created without CPU fallback.
- ORT profile provider counts show `VitisAIExecutionProvider` node events for
  the claimed model/stage.
- OCR output remains correct on deterministic and real PDF fixtures.
- Latency beats the accepted CPU baseline.
- The report distinguishes:
  - hardware available,
  - provider registered,
  - session created,
  - nodes scheduled,
  - OCR correctness,
  - production readiness.
- UI/product copy does not claim broader NPU coverage than the evidence proves.

## One-Line Handoff

`exam-prep` currently has a solid WindowsML/DML AMD iGPU OCR product lane with an
internal NPU prepass, but it should not be described as full NPU OCR inference
until ORT profile evidence shows actual `VitisAIExecutionProvider` node execution
for the OCR stage being claimed.
