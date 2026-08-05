# Capture Workbench TODO

The implementation cutover is complete. Durable ownership and failure policy
are recorded in `SPECS/domains/capture-runtime-integration.md`.

- [x] Use published `@gx-capture/capture-workbench@0.3.8` for the trial UI.
- [x] Route PDF, image, and audio through Capture Runtime only.
- [x] Remove the local UI prototype and Cert Prep OCR/Whisper/provider paths.
- [x] Keep Tauri lifecycle, authenticated proxy, host structuring, review, and
  document persistence.
- [x] Remove retired runtime installer, health UI, release payload, and Nx
  targets.
- [x] Regenerate the OpenAPI client and add missing-runtime fail-closed tests.
- [ ] Run the real published PDF/image/audio packaged smoke on Windows x64 when
  an engine-bearing runtime release is available. v0.3.8 is core-only.
