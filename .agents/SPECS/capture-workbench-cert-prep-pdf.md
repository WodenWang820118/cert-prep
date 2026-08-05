# Cert Prep Capture Workbench integration

`/capture-workbench-trial` is the Cert Prep entry point for the published
`@gx-capture/capture-workbench@0.3.8` component. It retains the PDF, image,
and audio source contract, but v0.3.8's published runtime is core-only: no OCR
or STT engine bundle is downloadable, so real capture is disabled through its
unavailable requirements.

Cert Prep keeps the authenticated backend client, host structuring, review
confirmation, durable document/chunk persistence, Markdown export, and
project handoff. Tauri keeps sidecar launch, token isolation, manifest/schema/
checksum verification, and PID-scoped cleanup.

The browser never calls Capture Runtime directly. A missing or incompatible
runtime fails closed. After confirmation, raw Japanese/OCR/transcript content
is retained in `document_chunks.raw_text`; reviewed or Traditional Chinese text
is retained in `document_chunks.text`.

The published-byte smoke verifies authenticated readiness, the exact
unavailable WindowsML/Whisper requirements, and cleanup. A fake provider may
exercise only the existing backend host protocol. The real PDF/image/audio
smoke, review confirmation, provenance, chunks, and Markdown export stay
pending until an engine-bearing runtime release exists.
