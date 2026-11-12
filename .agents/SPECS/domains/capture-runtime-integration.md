# Capture Runtime integration boundary

## Current ownership

Cert Prep consumes the published Capture Runtime release pinned in
`tools/capture-runtime-version.json` (`tools/capture-runtime-version.mts` is the
shared facade; `version-check` keeps every mirror in step). The pin covers the
Windows x64 `capture-runtime` executable, its manifest and `CaptureDocument`
schema `2`, the `capture-runtime-client` Python SDK, the
`@gx-capture/capture-workbench-ui` Web Component and the
`capture-sidecar-launcher` crate. Runtime API is `2.0`; the typed OCR projection
is the separate projection schema `3`. No sibling checkout, workspace alias or
development-path fallback is allowed.

| Concern | Owner | Cert Prep rule |
| --- | --- | --- |
| Durable sources, review overrides, export, domain records | Cert Prep | Persist source identity and domain data; runtime jobs are ephemeral. Reconcile durable state on restart; never persist a runtime process as domain state. |
| Extraction, OCR projection, speech recognition | Capture Runtime | The runtime is the sole extractor and OCR projection owner. Cert maps the typed projection and does not recreate it. |
| Compute decision and notice | Capture Runtime | The producer owns adapter selection, mode, reason and the CPU-fallback notice; Cert admits and displays that decision. |
| Engine installation and requirement truth | Capture Runtime | Engines install from the runtime's release catalog after explicit consent, proxied through the backend. Cert bundles no OCR or speech payload. |
| Sidecar process | Tauri host | Launch, token isolation, manifest/schema/checksum verification and PID-scoped cleanup. |
| Reasoning | Cert Prep | Ollama study profile, question generation, explanations. Capture never starts a second production Ollama. |

There is no Cert Prep OCR provider, speech provider, embedded-text extractor,
mixed-result arbitration or provider fallback.

## SDK and typed pull-session boundary

- The pinned SDK is the sole wire authority for discovery, authenticated
  transport, retries, SSE decoding, wire DTOs, v2 ingestion/capture and typed
  pull sessions. Cert adapters may add product upload validation but must not
  recreate the wire protocol.
- Host structuring uses the SDK's typed pull session. The runtime owns batch
  planning, prompt/schema projection, semantic validation and provenance
  reconstruction; Cert passes the runtime-returned prompt/schema to its
  configured provider and submits typed semantic blocks.

## OCR-only source admission and durable mapping

- Every new PDF page and image goes through the runtime's raster OCR
  (`windowsml-ocr` requirement). Cert never reads an embedded PDF text layer,
  arbitrates a mixed result, writes `direct_pdf`, or calls a second OCR route.
- `capture_integration/infrastructure/mapping.py` accepts exactly the producer
  engine `windowsml-ocr` and writes the durable discriminator `windowsml_ocr` on
  the document and every page and chunk. Neither value is inferred from a
  substring.
- Existing `direct_pdf`, `embedded` and `mixed` rows are legacy read-only data:
  displayed and exported by their existing rules, never a new write, route
  selector or source for rewriting OCR evidence.
- Projection pages map in source order to chunks through
  `publish_capture_document`; no page is dropped or reordered. A source digest
  mismatch is rejected before commit. Durable provenance keeps allowlisted
  runtime/model/device/profile fields, never tokens, local paths or raw
  diagnostics. Host structuring state never becomes OCR provenance.
- Audio requires the `speech-recognition` requirement and persists
  time-located transcript segments.

## Compute preflight

Before a PDF or image upload the backend coordinator requires the runtime's
`ocrCompute` preflight (`OcrComputePreflightV2` in `RuntimeReady`) and checks it
is self-consistent: `gpu-dml` carries no reason or notice; `cpu-fallback`
carries `no_compatible_gpu` or `dml_provider_unavailable`, a required notice and
`ocr_cpu_fallback`. A missing or inconsistent preflight is an incompatible
runtime. Cert never probes hardware, ranks adapters or changes the selected
plan. A DirectML failure after a GPU plan was selected fails the capture; the
host never retries on CPU.

## Single production path

- PDF, image and audio uploads use `CertPrepCaptureCoordinator ->
  CaptureRuntimeClient`. The backend checks readiness before creating a
  capture and admits PDF/image only with a ready `windowsml-ocr` requirement and
  audio only with a ready `speech-recognition` requirement.
- Transfer and capture use only the v2 lifecycle: checksum-bound ordered
  ingestion chunks, finalize, start with idempotent uncertain-create recovery by
  client request id, and authenticated replayable SSE with `Last-Event-ID`.
  Snapshot reads are initial/reconnect reconciliation, not progress polling.
- Missing assets, incompatible readiness, missing requirements, runtime errors,
  timeout, cancellation and schema/provenance drift fail closed with a
  machine-readable unavailable or requirement error. Provider output that
  changes digest, raw text, locators, coverage or order ends in
  `failed/structuring`; `/raw` is diagnostic-only and never completes a
  capture.
- The browser holds only the Cert Prep API token. The runtime URL and
  process-scoped token stay in Tauri and the backend.
- Runtime requirements and engine installations are proxied through
  authenticated `/capture-runtime/*` routes (`ready`,
  `requirements`, `installations`); an installation needs `consent: true` and a
  UUID `X-Idempotency-Key`.

## Capture Workbench page

`/capture-workbench-trial` hosts the published Web Component with
`enabledSources: ['pdf', 'image', 'audio']`, `structuringMode: 'host'`,
`hostStructuringOwner: 'component'`, `hostManagedHandshake: true` and
`showRuntimeSetup: false`. Its `CertPrepCaptureClient` calls the authenticated
backend at `/projects/{project_id}/capture-workbench/captures`; the browser never
calls Capture Runtime. The client and structuring provider are cold RxJS
Observables: unsubscribing closes only that backend SSE listener and never
cancels the runtime capture; cancel is a separate authenticated action.

Review happens before host structuring. A capture pauses for review and the
user may edit only existing segment text. Confirmation sends the capture id,
client request id and review contract, never the source or raw text again. The
backend validates provenance, structures, commits the `CaptureDocument` to the
runtime and persists it. Before confirmation the document stays processing with
no usable chunks. Review sessions expire after 1800 seconds and are cleaned up
on completion, cancellation, expiry and restart recovery.

## Authenticated OCR summary

`GET /projects/{project_id}/capture-workbench/captures/{capture_id}/ocr-summary`
reads the durable review session, the matching runtime operation and its typed
OCR projection, validates capture/source/schema identity, maps an allowlisted
summary and reloads the session before returning. It never reads raw capture
data, structures, commits, calls a provider or writes durable state.

- A pending review with a completed projection, or an exact runtime-failed and
  projection-failed pair, returns `200`. Early pending states return `409`;
  confirming, completed and canceled sessions return `410`. Missing, deleted
  and cross-project captures share one `404`; transport failure is `503`;
  authentication, protocol, compatibility, missing projection and identity
  drift return a sanitized `502`.
- The summary exposes host capture identity, projection status and page count,
  per-page status, normalized character count, box count, confidence and typed
  failure (`code`, `retryable`), plus resolved or unavailable provenance. Raw
  text, polygons, filenames, paths, runtime capture ids, tokens and free-form
  messages are excluded. Character counts use NFKC, CRLF normalization,
  whitespace collapse, trim, then code-point count.

## Event delivery

The host proxy shows a terminal snapshot only after the durable review session
is terminal. A runtime terminal seen while the session is active advances the
durable event cursor and is held behind comment heartbeats and bounded session
reloads. Host `captureId` and `ingestionId` stay the review session id and
durable document id. The in-process event registry is only a wake-up signal;
every wait reloads the session from the database.

## Persistence boundary

After confirmation the host maps the validated `CaptureDocument` into the
document/chunk model. `document_chunks.raw_text` keeps the original OCR text or
Japanese transcript; `document_chunks.text` keeps the reviewed or Traditional
Chinese text. Review overrides are validated against immutable runtime raw
segments and applied in the local mapping layer. Capture Runtime never writes
Cert SQLite.

## Desktop boundary

Tauri verifies the runtime manifest, checksum, schema bytes and executable
byte count against the pinned values before launch. The sidecar runs with a
cleared environment plus a Windows bootstrap allowlist, a unique bearer token,
an ephemeral loopback port, `CAPTURE_EXTRACTION_PROVIDER=runtime`,
`CAPTURE_STRUCTURING_PROVIDER=host`, and upload, PDF-page and image-pixel
ceilings aligned with Cert's source limits. Only the backend child receives
`CERT_PREP_CAPTURE_RUNTIME_URL`, `_TOKEN`, `_VERSION`, `_API_VERSION` and
`CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION`; none enter the WebView
configuration. Shutdown terminates only the recorded backend and sidecar PID
trees, never by image name, and never touches an external Ollama. Installation
and start are explicit user actions; see
[lazy-capture-runtime-installation.md](../lazy-capture-runtime-installation.md).

## Verification floor

Backend, frontend and desktop Nx checks, package QA, release contract tests,
OpenAPI regeneration, fail-closed unavailable tests and the published-byte
handshake/requirements smoke (`cert-prep-desktop:capture-runtime-consumer-smoke`).
A local candidate may be staged from `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`
for qualification; that is not published-release evidence. During a Capture
release the producer dispatches `.github/workflows/capture-candidate-gate.yml`
(`tools/capture-candidate-gate.mts`): candidate identity is content (contract
and archive hashes, package provenance, loaded runtime and worker identity),
never a URL or port, and installs with `direct_url` or local-path provenance are
rejected. The independent
Cert Prep Tauri bundle, not the Capture Workbench app, is the consumer artifact.
Real OCR on the packaged app is `cert-prep-desktop:acceptance-real`
([acceptance spec](../cert-prep-pdf-image-acceptance.md)); deterministic
fixtures and protocol fakes prove only the host protocol.
