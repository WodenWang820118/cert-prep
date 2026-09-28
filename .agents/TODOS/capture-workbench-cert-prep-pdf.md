# Cert Prep packaged engine smoke TODO

The packaged Cert Prep image OCR journey passed against published Capture
Runtime 0.4.2 on 2026-09-27. OCR acceptance details live in the
[real PDF/image acceptance TODO](cert-prep-pdf-image-acceptance.md); this file
tracks the remaining packaged engine legs, including audio, which is a separate
Capture Runtime lane.

- [ ] Run the PDF and audio legs of the packaged Cert Prep smoke against
  published 0.4.2 on Windows x64 after explicit consent and engine
  installation; record SSE replay, review, page provenance, durable chunks,
  Markdown export, anchors, and cleanup evidence.
  Real model-enabled journeys are sequential across the three consumers; prove
  all owned backend/capture/Paddle/model PIDs and listener ports are clear before
  handing the slot to LAW.
  Keep this independent Cert Prep Tauri smoke separate from source-import or
  registry prototypes, deterministic fixtures, and the Capture Workbench app.
