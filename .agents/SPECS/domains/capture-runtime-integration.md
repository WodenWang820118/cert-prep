# Capture Runtime integration boundary

## Current ownership

Cert Prep consumes the published `capture-runtime@0.4.1` Windows x64 executable,
manifest, checksum, and `CaptureDocument` schema `2`. It also consumes the
published `@gx-capture/capture-workbench-ui@0.4.1` Web Component and generated
`@gx-capture/capture-runtime-client@0.4.1` package for source import,
runtime setup, review, cancellation, retry, and completion UI.

Cert Prep owns only the authenticated proxy, Tauri sidecar lifecycle, host
structuring, document persistence, and the existing study/reasoning features.
There is no Cert Prep OCR provider, Whisper provider, runtime installer, or
provider fallback path.

## SDK and typed pull-session boundary

- The pinned Capture Runtime SDK is the sole wire authority for runtime
  discovery, authenticated transport, retries, SSE decoding, wire DTOs, v2
  ingestion/capture, and typed pull-session calls. Cert Prep's adapter may keep
  product upload validation and collection wrappers, but it must not recreate
  the runtime wire protocol.
- Host structuring uses the SDK's typed pull-session. Capture Runtime owns batch
  planning, prompt/schema projection, semantic validation, and provenance
  reconstruction. Cert Prep passes only the runtime-returned prompt/schema to
  its configured provider and submits typed semantic blocks through the SDK;
  raw segments, locators, source text, and engine provenance remain runtime
  owned.

## Single production path

- PDF, image, and audio uploads use
  `CertPrepCaptureCoordinator -> CaptureRuntimeClient`.
- The backend checks the pinned readiness contract before creating a capture.
- Source transfer and capture execution use only the v2 ingestion/capture
  lifecycle. The backend opens and finalizes checksum-bound ordered ingestions,
  starts captures with idempotent uncertain-create recovery, and consumes
  authenticated replayable SSE with `Last-Event-ID`. It does not poll for
  normal progress; snapshot reads are limited to initial/reconnect
  reconciliation.
- Missing runtime assets, incompatible readiness, missing requirements, runtime
  errors, timeout, cancellation, and schema/provenance drift fail closed with a
  machine-readable unavailable or requirement error.
- The browser receives only the Cert Prep API token. The Capture Runtime URL and
  process-scoped token remain Tauri/backend-only.
- The published Angular client remains RxJS Observable-based. Unsubscribe aborts
  only its backend SSE listener and never sends runtime cancellation; explicit
  cancel remains a separate authenticated action.
- The authenticated host proxy exposes terminal snapshots/events only after the
  durable review session reaches its terminal state. A runtime terminal observed
  while the host session is active advances the durable event cursor but is held
  behind comment heartbeats and bounded session reloads; host terminal replay then
  uses that monotonic cursor. Host `captureId` and `ingestionId` remain the review
  session id and durable document id across runtime-backed snapshots and results.
  The in-process event registry is only a bounded condition/revision wake-up
  signal: it retains no per-session identity or terminal state, and every wait
  reloads the durable review session so concurrent and late listeners recover
  from the database.
- Capture Runtime owns requirement truth. For engine-bearing v0.4.1, Cert Prep
  hides the component runtime-setup surface while exposing authenticated
  requirements/install/cancel proxy routes without exposing the sidecar token.
  Image and audio remain gated on the corresponding ready requirements.

## Persistence boundary

After review confirmation, the host maps the validated v2 `CaptureDocument` into
the existing document/chunk model. `document_chunks.raw_text` retains the
Japanese/OCR/transcript source, while `document_chunks.text` stores the
reviewed or Traditional Chinese text. Existing extraction and transcription
columns remain readable for historical documents; new production writes come
only from Capture Runtime.

Mapping, review, and persistence are consumer-local. Cert Prep validates review
overrides against immutable runtime raw segments, applies them in its local
mapping layer, and writes SQLite only after host confirmation. Capture Runtime
never writes Cert Prep SQLite and does not own Cert Prep review decisions.

## Desktop and release boundary

Tauri stages and verifies only the backend runtime and Capture Runtime assets.
The engine-bearing `0.4.1` contract verifies the runtime manifest, checksum,
schema, and executable bytes before launch. It injects
the sidecar URL/token only into the backend child, records both process trees,
and performs PID-scoped cleanup. Cert Prep's retired OCR manifest, executable,
installer, environment variables, and package targets are not release inputs.

## Verification floor

The closeout requires backend/frontend/desktop Nx checks, package QA, release
contract tests, OpenAPI regeneration, fail-closed unavailable tests, and a
published-byte handshake/requirements smoke. A local candidate may be staged
from `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`, but that is not published
release evidence. The independent Cert Prep Tauri bundle, not the Capture
Workbench app, is the consumer artifact. The real PDF OCR/audio consumer smoke
is an opt-in model-enabled gate for the engine-bearing `0.4.1` release.
Source-import or registry prototypes and deterministic fixtures prove
distribution or host protocol only; they do not close the real engine smoke.
