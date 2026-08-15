# Cert Prep Capture Workbench integration

`/capture-workbench-trial` is the Cert Prep entry point for the published
`@gx-capture/capture-workbench-ui@0.4.0` component. It retains the PDF, image,
and audio source contract and gates OCR/STT-dependent sources on the
engine-bearing runtime's authenticated requirement state.

Cert Prep keeps the authenticated backend client, host structuring, review
confirmation, durable document/chunk persistence, Markdown export, and
project handoff. Tauri keeps sidecar launch, token isolation, manifest/schema/
checksum verification, and PID-scoped cleanup.

The browser never calls Capture Runtime directly. It consumes the Cert Prep
backend's SSE proxy through cold RxJS Observables, and unsubscribe disconnects
only that listener. The backend owns v2 ingestion, replay/reconciliation,
host structuring, commit/failure, cancel, and cleanup. A missing or incompatible
runtime fails closed. After confirmation, raw Japanese/OCR/transcript content is
retained in `document_chunks.raw_text`; reviewed or Traditional Chinese text is
retained in `document_chunks.text`.

The published-byte smoke verifies authenticated readiness, requirement state,
and cleanup. A fake provider may exercise only the existing backend host
protocol. Real installed-engine PDF/image/audio capture, review confirmation,
provenance, chunks, and Markdown export remain an explicit evidence gate.
