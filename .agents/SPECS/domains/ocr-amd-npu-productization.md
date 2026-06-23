# WindowsML OCR NPU Participation Slice

Date: 2026-06-23

## Decision

Retire the standalone `amd_npu` OCR product lane. WindowsML is now the only
packaged accelerated OCR runtime lane, exposed as:

- Backend OCR provider: `EXAM_PREP_OCR_PROVIDER=windowsml`.
- Runtime requirement kind: `windowsml_ocr`.
- Document extraction method: `windowsml_ocr`.
- Runtime manifest resource: `windowsml-ocr-runtime-manifest.json`.
- Packaged runtime entrypoint: `exam-prep-ocr-windowsml-runtime.exe`.

AMD/VitisAI NPU support remains an internal WindowsML hardware capability, not a
separate provider, installer, UI runtime, or package target. The current OCR
pipeline tries a VitisAI text-density prepass under the WindowsML runtime, then
runs PaddleOCR 3.7 detection and recognition through the WindowsML ONNX Runtime
runner. Missing or failed NPU prepass evidence does not create an `amd_npu`
fallback path; the public result still reports `windowsml_ocr`.

PaddleOCR must remain at least 3.7 everywhere:

- `ocr-cpu`: `paddleocr>=3.7.0,<4.0.0`.
- `ocr-gpu`: `paddleocr>=3.7.0,<4.0.0`.
- `ocr-windowsml`: `paddleocr==3.7.0`.

## Runtime Shape

- `onnxruntime-directml` is removed from product dependencies and build targets.
- `onnxruntime-windowsml` is the Windows accelerated OCR runtime dependency.
- Desktop defaults to `windowsml`, with `paddle` allowed as an explicit override.
- Product package targets build and ship only the WindowsML OCR runtime
  manifest/resource for OCR. The legacy Paddle GPU OCR runtime remains a
  backend/dev capability and is not bundled into the default packaged product.
- Desktop passes `EXAM_PREP_OCR_WINDOWSML_DEVICE_POLICY=PREFER_NPU` by default.
- Backend accepts `ocr_windowsml_device_policy` and passes it to the packaged
  WindowsML runtime.
- WindowsML runtime passes `--windowsml-device-policy` into the internal NPU
  prepass helper.
- The low-level helper still uses AMD/VitisAI names because the WindowsML NPU EP
  is `VitisAIExecutionProvider`; those names are hardware evidence, not product
  surface.

## Gates

- Public API gate: no `amd_npu` OCR provider, `amd_npu_ocr` runtime kind, or
  `amd_npu_ocr` extraction method.
- Packaging gate: no `build-ocr-runtime-amd-npu`, `build-amd-npu`,
  `sync-amd-npu-runtime-manifest`, or `packaged-streaming-production-amd-npu`
  target.
- Package artifact gate: default Tauri/package QA targets depend on
  `build-windowsml` and `sync-windowsml-runtime-manifest`, not the legacy
  `sync-runtime-manifest` Paddle GPU runtime path.
- Dependency gate: `uv.lock` exposes only `ocr-cpu`, `ocr-gpu`, and
  `ocr-windowsml`; PaddleOCR resolves to 3.7+.
- Evidence gate: WindowsML OCR results may record
  `npu_prepass=text_density_vitisai;vitisai_events=...` while keeping
  `extraction_method=windowsml_ocr`.
- Strict NPU proof gate:
  `pnpm nx run exam-prep-backend:ocr-windowsml-npu-smoke --skip-nx-cache`
  writes `ocr-windowsml-npu-smoke-*.json` and exits non-zero unless ORT profile
  provider counts show NPU provider node execution for the text-density
  prepass.
- Production summary gate: packaged WindowsML production summaries keep
  `windowsml_npu_prepass_evidence` as observation only. Missing prepass
  scheduling is `attempted_not_scheduled`, not an OCR production failure.
- No-regression gate: backend tests, Angular tests/lint, Tauri tests, desktop
  package QA scripts, and `git diff --check` must pass.

## Current Status

Implemented in the working tree:

- Removed backend public `amd_npu` provider selection and runtime installation
  surfaces.
- Removed the standalone AMD NPU packaged runtime entrypoint.
- Removed backend and desktop AMD NPU product/package Nx targets.
- Kept VitisAI/NPU helper code only as WindowsML internal participation
  evidence.
- Added a WindowsML runtime unit test proving NPU prepass evidence is merged
  into a `windowsml_ocr` OCR result.
- Added a strict WindowsML NPU smoke target for prepass scheduling proof.
- Updated packaged production summaries to schema v2 so WindowsML OCR success
  is not conflated with NPU prepass scheduling.
- Regenerated the OpenAPI client after removing `amd_npu_ocr` from backend
  enums.

## Deferred

- Rename remaining low-level AMD/VitisAI helper names only after benchmark and
  diagnostic script names no longer depend on them. Until then, treat those
  names as hardware evidence, not product surface.
- Evaluate NPU-friendly OCR model candidates only after license review and only
  as internal WindowsML stages.
- Keep `xrt-smi` power/efficiency reporting as hardware metadata. Missing watts
  or detected hardware must never be interpreted as proof that OCR ran on NPU.

## References

- Microsoft WindowsML repository:
  https://github.com/microsoft/WindowsML
- Microsoft WindowsML execution provider registration:
  https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/register-execution-providers
- Microsoft WindowsML migration/distribution docs:
  https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/migrate-to-windows-ml
  https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/distributing-your-app
- AMD Ryzen AI WindowsML EP docs:
  https://ryzenai.docs.amd.com/en/latest/winml/winml_ep.html
