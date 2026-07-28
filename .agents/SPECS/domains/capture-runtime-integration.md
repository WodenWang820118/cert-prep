# Capture Runtime integration boundary

## Current ownership

Cert Prep consumes the published `capture-runtime@0.3.0` Windows x64 executable,
manifest, checksum, and `CaptureDocumentV1` schema `1`. It also consumes the
published `@gx-capture/capture-workbench@0.3.0` Web Component for source import,
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
- Capture Workbench owns runtime setup UI. Cert Prep exposes authenticated
  requirements/install/cancel proxy routes without duplicating setup screens.

## Persistence boundary

After review confirmation, the host maps the validated `CaptureDocumentV1` into
the existing document/chunk model. `document_chunks.raw_text` retains the
Japanese/OCR/transcript source, while `document_chunks.text` stores the
reviewed or Traditional Chinese text. Existing extraction and transcription
columns remain readable for historical documents; new production writes come
only from Capture Runtime.

## Desktop and release boundary

Tauri stages and verifies only the backend runtime and Capture Runtime assets,
including Capture Runtime's own `windowsml-ocr` bundle descriptor. It injects
the sidecar URL/token only into the backend child, records both process trees,
and performs PID-scoped cleanup. Cert Prep's retired OCR manifest, executable,
installer, environment variables, and package targets are not release inputs.

## Verification floor

The closeout requires backend/frontend/desktop Nx checks, package QA, release
contract tests, OpenAPI regeneration, fail-closed unavailable tests, real
PDF/image/audio consumer smoke where the published assets are available, and a
final search proving no retired Cert Prep provider or fallback path remains.
