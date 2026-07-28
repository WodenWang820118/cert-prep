# Cert Prep Capture Workbench integration

`/capture-workbench-trial` is the Cert Prep entry point for the published
`@gx-capture/capture-workbench@0.3.0` component. It supports PDF, image, and
audio sources and delegates extraction to the published Capture Runtime.

Cert Prep keeps the authenticated backend client, host structuring, review
confirmation, durable document/chunk persistence, Markdown export, and
project handoff. Tauri keeps sidecar launch, token isolation, manifest/schema/
checksum verification, and PID-scoped cleanup.

The browser never calls Capture Runtime directly. A missing or incompatible
runtime fails closed. After confirmation, raw Japanese/OCR/transcript content
is retained in `document_chunks.raw_text`; reviewed or Traditional Chinese text
is retained in `document_chunks.text`.

The real smoke must use the published runtime release directory and verify
authenticated readiness, review confirmation, raw provenance, completed chunks,
Markdown export, and cleanup. It must not use the deleted Cert Prep OCR/Whisper
packages or a fake fallback path.
