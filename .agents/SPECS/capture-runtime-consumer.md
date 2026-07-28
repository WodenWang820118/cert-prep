# Capture Runtime release consumer spec

`cert-prep` consumes `capture-runtime@0.3.0` as a published Windows x64
executable. It does not import the runtime as Python, link a workspace package,
or retain a local extraction provider.

## Contract

- Runtime API: `1.0`.
- Runtime version: `0.3.0`.
- `CaptureDocumentV1` schema: `1`.
- Consumer assets: executable, checksum, `capture-runtime-manifest.json`, and
  the schema file.
- The manifest must contain a valid, non-placeholder `windowsml-ocr` descriptor
  owned by Capture Runtime.
- Requirements/readiness/install/cancel are proxied through the authenticated
  backend; the sidecar token never reaches Angular/WebView.

## Failure policy

Missing or malformed assets, checksum/byte drift, incompatible handshake,
unavailable requirements, sidecar failure, timeout, and cancellation are
terminal/unavailable states. Cert Prep never falls back to an OCR or Whisper
provider of its own.

## Evidence

The installer contract, package QA, Tauri contract tests, backend coordinator
tests, and the real consumer smoke must prove staging, authenticated readiness,
raw/result validation, host structuring, cleanup, and rejection of tampered or
missing runtime assets.
