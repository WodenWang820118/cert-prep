# Capture Runtime Release Consumer TODO

- [ ] Add v0.3.8 negative product cases for image, audio, and scanned/mixed
  PDFs. Image is admitted only with `windowsml-ocr: ready`, audio only with
  `whisper-primary: ready`, and every PDF goes to the sidecar without browser
  scanned-PDF classification. The unavailable path must surface an explicit
  WindowsML/Whisper or OCR-required error, never fake output or fallback text,
  and never claim OCR/STT support.
  Verify: `pnpm nx run cert-prep-backend:test --skip-nx-cache` and
  `pnpm nx run cert-prep:capture-workbench-real-pdf-smoke --skip-nx-cache`

- [ ] Run real WindowsML/Whisper positive capture only when an engine-bearing
  runtime release exists; keep that evidence separate from the v0.3.8
  embedded-text product E2E.
  Verify: publish an engine-bearing release, then run its exact-release smoke.
