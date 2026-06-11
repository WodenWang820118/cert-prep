# Tauri Packaging With Deferred Runtimes Decisions

## Decisions

- Package Windows x64 first using the current Rust MSVC and Tauri 2 toolchain.
- Supersede the bundled GPU Paddle OCR sidecar with a lite backend sidecar plus optional PaddleOCR runtime artifact.
- Keep only `exam-prep-backend-x86_64-pc-windows-msvc.exe` in Tauri `externalBin`.
- Ship an OCR runtime manifest in Tauri resources and publish `exam-prep-ocr-runtime-x86_64-pc-windows-msvc.zip` as a separate release asset.
- Add explicit runtime installation job APIs rather than installing Ollama, pulling models, or installing PaddleOCR from health checks or app startup.
- Record raw package QA output under ignored benchmark/artifact paths and keep the human-readable size summary here.

## Rejected Options

- Bundling Ollama model files was rejected because the installer would be very large and model licensing/storage would become a packaging concern.
- Bundling PaddleOCR in the initial sidecar was rejected because the prior package was about 637 MB and made every install pay the OCR cost.
- CPU-only OCR runtime packaging was rejected because it would not satisfy the GPU-auto requirement for the optional OCR runtime artifact.
- Blocking pull requests were rejected because large model downloads would make the UI feel frozen.

## Size Summary

- Final QA report: `tmp/exam-prep-desktop/package-qa/package-qa.json`.
- Target: Windows x64, `x86_64-pc-windows-msvc`.
- Previous bundled baseline: MSI about 637.88 MB, NSIS about 637.01 MB, bundled sidecar about 636.29 MB.
- Current MSI bundle: `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Exam Prep_0.1.0_x64_en-US.msi`, 49,299,456 bytes / 47.02 MB.
- Current NSIS setup bundle: `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Exam Prep_0.1.0_x64-setup.exe`, 48,254,842 bytes / 46.02 MB.
- Lite synced sidecar: `apps/exam-prep-desktop/src-tauri/binaries/exam-prep-backend-x86_64-pc-windows-msvc.exe`, 45,577,793 bytes / 43.47 MB.
- Optional OCR runtime ZIP: `apps/exam-prep-backend/dist/ocr-runtime/exam-prep-ocr-runtime-x86_64-pc-windows-msvc.zip`, 663,364,398 bytes / 632.63 MB.
- OCR runtime manifest: `apps/exam-prep-backend/dist/ocr-runtime/ocr-runtime-manifest.json`, SHA-256 `f1c27a61c4bd13dd10567d8b8ca712360d18ae416990c335b17a281596134f42`.
- Angular browser output: `dist/apps/exam-prep/browser`, 1,373,475 bytes / 1.31 MB.
- Size gate: passed, largest initial artifact 47.02 MB under the 150 MB warning threshold and 250 MB failure threshold.
- Runtime QA: sidecar health passed; OCR health reports `paddle_runtime_missing` in external mode until the optional runtime is installed.
- LLM QA: read-only health reported `ollama_not_running`; install/model jobs remain confirmation-gated.
