# Decision: review OCR before host structuring

The cert-prep integration uses `hostStructuringOwner: "component"` with review
enabled. Capture Workbench owns the review UI and sends only immutable segment
identifiers plus edited text on confirmation. Cert-prep remains the owner of
runtime access and durable storage; the component invokes the
`CertPrepCaptureClient` structuring provider, which proxies backend-owned host
structuring and CaptureDocument commit without exposing sidecar credentials.

The original OCR is retained in `raw_text`; reviewed text is an overlay in
`text`. This avoids a second file upload and preserves provenance without
changing the v2 CaptureDocument contract or the sidecar API.
