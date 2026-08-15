# Capture Workbench review handoff

The Cert Prep route consumes the published Workbench package. When the runtime
has the required engine assets, PDF/image sources pass through the backend-owned
v2 ingestion and capture lifecycle, stream progress over replayable SSE, and
pause at `awaiting_confirmation` with a validated partial capture.

The browser can edit only existing segment text. Confirmation sends the capture
id, client request id, and review contract; it never sends the PDF or raw text
again. The backend validates provenance, owns host structuring and persistence,
commits the completed v2 `CaptureDocument` to the runtime, and emits it through
the Workbench completion event.

Before confirmation the source document remains processing and has no usable
ready chunks. After confirmation, `document_chunks.raw_text` contains the
original Capture Runtime text and `document_chunks.text` contains the reviewed
overlay. Pending runtime jobs and review sessions are cleaned up on completion,
cancellation, expiry, and backend shutdown recovery.
