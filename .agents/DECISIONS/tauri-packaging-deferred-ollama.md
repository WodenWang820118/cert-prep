# Tauri Packaging With Deferred Ollama Pull Decisions

## Decisions

- Package Windows x64 first using the current Rust MSVC and Tauri 2 toolchain.
- Use one GPU-capable Paddle OCR sidecar with runtime `auto` device selection instead of separate CPU/GPU sidecars.
- Add an explicit background Ollama pull job API rather than pulling in health checks or app startup.
- Record raw package QA output under ignored benchmark/artifact paths and keep the human-readable size summary here.

## Rejected Options

- Bundling Ollama model files was rejected because the installer would be very large and model licensing/storage would become a packaging concern.
- CPU-only packaging was rejected because it would not satisfy the GPU-when-available requirement.
- Blocking pull requests were rejected because large model downloads would make the UI feel frozen.

## Size Summary

- Final QA report: `tmp/exam-prep-desktop/package-qa/package-qa.json`.
- Target: Windows x64, `x86_64-pc-windows-msvc`.
- MSI bundle: `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Exam Prep_0.1.0_x64_en-US.msi`, 668,860,416 bytes / 637.88 MB.
- NSIS setup bundle: `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Exam Prep_0.1.0_x64-setup.exe`, 667,949,200 bytes / 637.01 MB.
- Synced sidecar: `apps/exam-prep-desktop/src-tauri/binaries/exam-prep-backend-x86_64-pc-windows-msvc.exe`, 667,203,443 bytes / 636.29 MB.
- Runtime QA: Paddle OCR available, selected `gpu:0`, CUDA available, GPU count `1`, fallback reason `null`.
- LLM QA: Ollama health read-only check reported `gemma4:12b` available; model downloads remain confirmation-gated by the new job API.
