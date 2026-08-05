# Capture Workbench review handoff

- [x] Install the registry package and use the dedicated cert-prep capture API.
- [x] Pause after OCR and expose segment review/confirm/discard in the package.
- [x] Persist raw OCR plus reviewed text after backend confirmation.
- [x] Return the completed document and review context through the completion event.
- [x] Add pending-session cleanup for cancellation, expiry, and host shutdown.
- [ ] Run the real published PDF/image/audio smoke on the target Windows x64
  machine when an engine-bearing release exists; v0.3.8 is core-only and is not
  OCR/STT evidence.
