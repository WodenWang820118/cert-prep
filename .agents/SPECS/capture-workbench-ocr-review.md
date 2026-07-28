# Capture Workbench review handoff

The Cert Prep route consumes the published Workbench package. For PDF/image
sources it uploads once to the backend review API, receives the Capture Runtime
result, and pauses at `awaiting_confirmation`.

The browser can edit only existing segment text. Confirmation sends the capture
id, client request id, and review contract; it never sends the PDF or raw text
again. The backend validates provenance, owns host structuring and persistence,
and emits the completed `CaptureDocumentV1` through the Workbench completion
event.

Before confirmation the source document remains processing and has no usable
ready chunks. After confirmation, `document_chunks.raw_text` contains the
original Capture Runtime text and `document_chunks.text` contains the reviewed
overlay. Pending runtime jobs and review sessions are cleaned up on completion,
cancellation, expiry, and backend shutdown recovery.
