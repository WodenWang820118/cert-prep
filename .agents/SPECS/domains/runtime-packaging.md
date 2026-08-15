# Runtime and packaging domain

## Current contract

Tauri packages the backend runtime and the published Capture Runtime
`0.4.0` Windows x64 assets. Cert Prep does not own an OCR/Whisper provider,
legacy manifest, local provider, or fallback installer.

The release contract pins Capture Runtime API `2.0`, runtime `0.4.0`, and
`CaptureDocument` schema `2`. Package QA and Tauri validate executable bytes,
checksum, manifest, and schema bytes before launch. Capture Runtime owns
requirement validation and publishes the engine catalog consumed by the host
readiness checks.

For local production qualification only, the installer may stage the canonical
assets from `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`. The path is not a
replacement for registry/release lockfile provenance or published-byte
evidence; the independent `cert-prep-desktop` Tauri bundle remains the consumer
artifact.

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
published-byte handshake/requirements checks. The real PDF/image/audio consumer
smoke remains pending for an engine-bearing release; fake extraction is only
backend host-protocol evidence.
