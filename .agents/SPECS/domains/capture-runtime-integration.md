# Capture Runtime integration boundary

## Current ownership

Cert Prep consumes the published `capture-runtime@0.3.8` Windows x64 executable,
manifest, checksum, and `CaptureDocumentV1` schema `1`. It also consumes the
published `@gx-capture/capture-workbench@0.3.8` Web Component for source import,
runtime setup, review, cancellation, retry, and completion UI.

Cert Prep owns only the authenticated proxy, Tauri sidecar lifecycle, host
structuring, document persistence, and the existing study/reasoning features.
There is no Cert Prep OCR provider, Whisper provider, runtime installer, or
provider fallback path.

## Single production path

- PDF, image, and audio uploads use
  `CertPrepCaptureCoordinator -> CaptureRuntimeClient`.
- The backend checks the pinned readiness contract before creating a capture.
- Missing runtime assets, incompatible readiness, missing requirements, runtime
  errors, timeout, cancellation, and schema/provenance drift fail closed with a
  machine-readable unavailable or requirement error.
- The browser receives only the Cert Prep API token. The Capture Runtime URL and
  process-scoped token remain Tauri/backend-only.
- Capture Runtime owns requirement truth. For core-only v0.3.8, Cert Prep hides
  the component runtime-setup surface, exposes PDF only, and makes no engine
  download claim. Authenticated requirements/install/cancel proxy routes remain
  available for a future engine-bearing release without exposing the sidecar
  token.

## Persistence boundary

After review confirmation, the host maps the validated `CaptureDocumentV1` into
the existing document/chunk model. `document_chunks.raw_text` retains the
Japanese/OCR/transcript source, while `document_chunks.text` stores the
reviewed or Traditional Chinese text. Existing extraction and transcription
columns remain readable for historical documents; new production writes come
only from Capture Runtime.

## Desktop and release boundary

Tauri stages and verifies only the backend runtime and Capture Runtime assets.
v0.3.8 publishes no WindowsML OCR or Whisper bundle: the runtime reports
`windowsml-ocr` and `whisper-primary` as unavailable with the published
core-only detail. It injects
the sidecar URL/token only into the backend child, records both process trees,
and performs PID-scoped cleanup. Cert Prep's retired OCR manifest, executable,
installer, environment variables, and package targets are not release inputs.

## Verification floor

The closeout requires backend/frontend/desktop Nx checks, package QA, release
contract tests, OpenAPI regeneration, fail-closed unavailable tests, and a
published-byte handshake/requirements smoke. The v0.3.8 core-only consumer
product E2E proves embedded-text PDF, while backend/client tests prove
fail-closed image/audio behavior. The real
PDF OCR/audio consumer smoke is an opt-in model-enabled gate and remains
pending until an approved engine catalog is published.
