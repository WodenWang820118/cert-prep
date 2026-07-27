# Capture Workbench OCR review handoff

## Contract

The cert-prep Capture Workbench route installs `@gx/capture-workbench@0.3.0`
from the configured npm registry. For PDF/image sources it uploads once to the
backend review API, receives runtime OCR, and pauses at `awaiting_confirmation`.

The browser can edit only existing segment text. Confirmation sends the capture
id, client request id, and review contract; it never sends the PDF or raw OCR
again. The backend validates provenance, owns host structuring and persistence,
and emits the completed CaptureDocument through the Workbench completion event.

## Persistence

Before confirmation the source document remains processing and has no usable
ready chunks. After confirmation, `document_chunks.raw_text` contains the OCR
text and `document_chunks.text` contains the reviewed overlay. The runtime job
and pending review session are cleaned up on completion, cancellation, expiry,
and backend shutdown recovery.

The CaptureDocumentV1 and Capture Runtime contracts are unchanged.
