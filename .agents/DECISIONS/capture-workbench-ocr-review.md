# Decision: review OCR before host structuring

The cert-prep integration uses `hostStructuringOwner: "client"` with review
enabled. Capture Workbench owns the review UI and sends only immutable segment
identifiers plus edited text on confirmation. Cert-prep remains the owner of
runtime access, host structuring, CaptureDocument commit, and durable document
storage.

The original OCR is retained in `raw_text`; reviewed text is an overlay in
`text`. This avoids a second file upload and preserves provenance without
changing CaptureDocumentV1 or the sidecar API.
