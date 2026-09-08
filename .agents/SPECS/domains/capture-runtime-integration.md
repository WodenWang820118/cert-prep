# Capture Runtime integration boundary

## Current ownership

Cert Prep currently consumes the published `capture-runtime@0.4.1` Windows x64
executable, manifest, checksum, and `CaptureDocument` schema `2`. The target
0.4.2 cutover consumes the matching published executable, Web Component,
generated SDK, manifest, `CaptureDocument` schema `2`, and the separate OCR
projection schema `3`; no local sibling fallback is allowed.
It also consumes the
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
- The 0.4.2 SDK must add a typed capture-bound page/segment OCR projection.
  Cert Prep and Law consume that projection without reconstructing provider
  routing. Every PDF page and image is rasterized and recognized by canonical
  PaddleOCR; embedded and mixed extraction are legacy read-only values, never
  new writes.

### Authenticated privacy-safe OCR summary

- Cert Prep exposes one additive project-scoped read interface at
  `GET /projects/{project_id}/capture-workbench/captures/{capture_id}/ocr-summary`.
  It resolves the durable review session, reads the matching runtime operation
  and typed OCR projection through the SDK, validates capture/source/schema
  identity, maps an allowlisted summary, and finally reloads the same
  project-scoped session before returning. It never reads raw capture data,
  structures or commits a capture, invokes a provider, or writes durable state.
- `projectionSchemaVersion: 3` identifies the Capture Runtime OCR projection.
  It is deliberately distinct from `CaptureDocument` schema `2`; the summary
  interface does not claim or require a schema-3 `CaptureDocument`.
- A pending review session with runtime `awaiting_structuring` and a completed
  projection returns `200`. A pending or failed review session with an exact
  runtime-failed/projection-failed pair also returns `200` privacy-safe failure
  evidence. Early pending runtime states return `409`; confirming, completed,
  and canceled review sessions return `410`.
- Missing, deleted, and cross-project captures share the same `404` response.
  Transport unavailability returns `503`. Authentication, protocol,
  compatibility, stable-projection absence, and identity/schema drift return a
  sanitized `502` without forwarding runtime diagnostics.
- The summary exposes only host capture identity, projection status and page
  count, per-page status/normalized character count/box count/confidence/typed
  failure, and resolved or unavailable runtime/model/device/profile/contract
  provenance. Typed failures contain only `code` and `retryable`. Raw text, box
  text, polygons, filenames, paths, runtime capture ids, bearer tokens, warnings,
  and free-form failure messages are excluded.
- Normalized character counts follow the shared privacy-safe evidence rule:
  Unicode NFKC, CRLF normalization, Unicode whitespace collapse, trim, then
  Unicode code-point count. Runtime page confidence is preserved rather than
  recomputed.

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

After review confirmation, the host maps the validated schema-2 `CaptureDocument`
into the existing document/chunk model. Every new PDF/image page persists
`windowsml_ocr`; legacy `embedded` and `mixed` rows remain readable but are not
created by the 0.4.2 consumer. `document_chunks.raw_text` retains the
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
The target engine-bearing `0.4.2` contract verifies the runtime manifest, checksum,
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
