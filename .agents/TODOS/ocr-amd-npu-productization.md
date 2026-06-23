# AMD NPU OCR Productization TODO

## Active

- Keep `amd-npu-official-smoke` as the hardware proof that the AMD NPU can run
  a VitisAI CNN subgraph. Treat this as baseline hardware evidence.
- Productize the hybrid OCR lane incrementally: NPU text-density prepass is the
  NPU-participating OCR stage; PaddleOCR det/rec remain on DirectML until a
  VitisAI-friendly OCR model is selected.
- Find or produce VitisAI-friendly OCR detection and recognition models for
  Windows ML NPU: the current PP-OCRv6 medium det/rec ONNX graphs bind to the
  VitisAI NPU device, but profile events remain CPU-only even when CPU fallback
  is allowed.
- Implement the custom NPU-only stage runner around
  `SessionOptions.add_provider_for_devices()`; PaddleOCR/PaddleX 3.7
  `engine_config.providers` cannot use the Windows ML catalog VitisAI device
  because `get_available_providers()` does not list the dynamic EP.
- Add license review for any replacement OCR recognition model before it can
  become a packaged candidate.
- Run DirectML packaged production baseline after every NPU runtime change.
- Only promote `packaged-streaming-production-amd-npu` after it processes the
  full 46-page fixture and records NPU/iGPU routing evidence.
- If PP-OCRv6 detection/recognition still cannot record VitisAI events, switch
  to an NPU-friendly OCR model candidate with explicit license review before
  claiming det/rec NPU acceleration.

## Candidate Track

- First NPU-friendly candidate: AMD RyzenAI-SW `Nemotron-OCR-V2`.
  AMD documents this as a BF16 VitisAI NPU OCR pipeline with detector,
  recognizer, and relational models, including static ONNX shapes and an
  end-to-end NPU pipeline script. The recognizer model is especially relevant
  as a replacement for the current PP-OCRv6 recognition target.
- License blocker: AMD notes the model is governed by the NVIDIA Open Model
  License Agreement, while post-processing scripts are Apache 2.0. Complete
  license review before adding model downloads, packaging, or default routing.
- Implementation sketch: keep PaddleOCR/DirectML as the baseline lane; add an
  experimental NPU-only candidate runner that uses Windows ML
  `add_provider_for_devices()` for Nemotron detector and recognizer, then
  records VitisAI profile events before considering full OCR post-processing.

## Evidence Captured

- `amd-npu-official-smoke --ensure-ready --fail-if-not-npu-active`: passes on
  this host with `VitisAIExecutionProvider` profile events from a deterministic
  tiny CNN. CPU events are recorded and allowed for this hardware smoke because
  AMD's official Windows ML ResNet sample uses NPU-preferred execution rather
  than strict CPU-disabled execution. The latest report records
  `provider_event_counts.VitisAIExecutionProvider=20`,
  `directml_provider_in_session=false`, and `nvidia_ep_device_bound=false`;
  RTX 4060 appears only in enumeration/system snapshots, not as the bound
  ONNX Runtime provider for the smoke.
- `ocr-amd-npu-inference-smoke --ensure-ready --fail-if-not-inference-ready`:
  passes under the hybrid participation policy. Evidence:
  `npu_prepass.provider_event_counts.VitisAIExecutionProvider=1`,
  `npu_participating_models=["ocr_prepass/text_density"]`,
  `npu_participation_coverage={participating: 1, total: 3}`, and
  `paddleocr_model_npu_compute_detected=false`.
- `ocr_amd_npu_runtime.py --ocr-self-test`: passes with `OCRTEST`,
  `extraction_method=amd_npu_ocr`, `device=amd_npu:vitisai+amd_directml:0`,
  and fallback metadata
  `npu_prepass=text_density_vitisai;vitisai_events=1;paddleocr_det_rec=directml`.
- `ocr-amd-npu-probe --ensure-ready`: NPU is visible through Windows ML catalog
  VitisAI EP, device type `NPU`, device id `6128`; `xrt-smi` sees `NPU Strix`.
- Strict diagnostic `ocr-amd-npu-session-smoke --ensure-ready --strict-npu`: blocked by
  `amd_npu_cpu_fallback_detected`; both `det/inference.onnx` and
  `rec/inference.onnx` report graph nodes assigned to CPU while CPU fallback is
  disabled.
- PaddleOCR det/rec NPU profile: with CPU fallback allowed, both PP-OCRv6 ONNX
  sessions complete under `VitisAIExecutionProvider + CPUExecutionProvider`,
  but their provider profile counts remain CPU-only.
