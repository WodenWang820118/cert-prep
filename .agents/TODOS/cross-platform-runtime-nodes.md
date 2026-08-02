# Cross-Platform Runtime Nodes TODO

## Status

Deferred. The current product lane consumes the published Capture Runtime
Windows x64 executable for PDF/image/audio extraction when an engine-bearing
release is available and keeps Ollama for reasoning. v0.3.8 is core-only, so
embedded-text PDF remains available while OCR-dependent PDFs, image, and audio
remain unavailable. Cert Prep does not own an OCR or Whisper provider.

Do not reopen this TODO without a real product requirement for another
platform/runtime node. Any future node must define its own published package,
manifest, readiness/requirements contract, Tauri lifecycle, package QA, and
real smoke evidence before it is added to Cert Prep.
