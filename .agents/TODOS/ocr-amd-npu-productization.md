# WindowsML OCR NPU Participation TODO

## Active

- Keep `windowsml` as the only accelerated OCR product provider/runtime.
- Keep PaddleOCR at least 3.7 in all OCR extras.
- Keep the VitisAI NPU text-density prepass internal to WindowsML OCR; do not
  reintroduce `EXAM_PREP_OCR_PROVIDER=amd_npu`, `amd_npu_ocr`, or a standalone
  AMD NPU package target.
- Run hardware evidence through the WindowsML product lane:
  `packaged-streaming-production-windowsml` should record WindowsML OCR process
  evidence, AMD iGPU routing, RTX/Nvidia avoidance for OCR, and NPU prepass
  evidence when available.
- If the VitisAI prepass stops recording provider events on NPU-capable hosts,
  mark NPU evidence unavailable instead of silently claiming NPU participation.

## Deferred

- Rename the low-level `amd_npu.py` diagnostic helper to a WindowsML NPU helper
  once the remaining benchmark script names are retired or migrated.
- Evaluate NPU-friendly OCR model candidates only after license review and only
  as internal WindowsML stages.
- Revisit `xrt-smi` power/efficiency reporting when watts are available; missing
  watts must remain explicit evidence, not a success condition.

## Verification

- `uv lock`
- `pnpm nx run exam-prep-backend:lint --skip-nx-cache`
- `pnpm nx run exam-prep-backend:test --skip-nx-cache`
- `pnpm nx run exam-prep-backend:generate-openapi-client --skip-nx-cache`
- `pnpm nx run exam-prep:test --skip-nx-cache`
- `pnpm nx run exam-prep:lint --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:typecheck-scripts --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:cargo-test --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:package-qa-test --skip-nx-cache`
- `pnpm nx run exam-prep-desktop:lint --skip-nx-cache`
- `git diff --check`
