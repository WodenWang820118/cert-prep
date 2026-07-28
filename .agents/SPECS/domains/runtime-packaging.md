# Runtime and packaging domain

## Current contract

Tauri packages the backend runtime and the published Capture Runtime
`0.3.0` Windows x64 assets. Cert Prep does not package an OCR/Whisper payload,
legacy manifest, local provider, or fallback installer.

The release contract pins Capture Runtime API `1.0`, runtime `0.3.0`, and
`CaptureDocumentV1` schema `1`. Package QA and Tauri validate executable bytes,
checksum, manifest, schema bytes, and Capture Runtime's own `windowsml-ocr`
bundle descriptor before launch.

## Lifecycle and security

- Tauri starts the backend and Capture Runtime sidecar with a unique
  process-only token and loopback endpoint.
- Only the backend receives the Capture Runtime URL/token. Angular receives the
  Cert Prep API token and uses authenticated proxy routes.
- Shutdown records and cleans only the owned backend/sidecar PID trees.
- Runtime readiness, requirements, installation, cancellation, and incompatible
  schema/version responses fail closed.

## Release evidence

The release candidate must pass backend/frontend/desktop Nx checks, package QA,
release-tool tests, clean-install contract tests, resource staging checks, and
real PDF/image/audio consumer smoke when the published assets are available.
No source-only build or fake provider is consumer evidence.
