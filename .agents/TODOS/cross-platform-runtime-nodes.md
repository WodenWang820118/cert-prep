# Cross-Platform Runtime Nodes TODO

## Status

Deferred. The current product lane consumes the published Capture Runtime
0.4.1 Windows x64 executable for PDF/image/audio extraction when its
engine-bearing package and real-smoke evidence are available, and keeps Ollama
for reasoning. The historical v0.3.8 release was core-only, so its evidence
covered embedded-text PDF while OCR-dependent PDFs, image, and audio remained
unavailable. Cert Prep does not own an OCR or Whisper provider.

Do not reopen this TODO without a real product requirement for another
platform/runtime node. Any future node must define its own published package,
manifest, readiness/requirements contract, Tauri lifecycle, package QA, and
real smoke evidence before it is added to Cert Prep.
