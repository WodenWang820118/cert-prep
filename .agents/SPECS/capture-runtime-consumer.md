# Capture Runtime release consumer spec

`cert-prep` consumes `capture-runtime@0.3.11` as a published Windows x64
executable. It does not import the runtime as Python, link a workspace package,
or retain a local extraction provider.

## Contract

- Runtime API: `1.0`.
- Runtime version: `0.3.11` from the canonical
  `gx-capture/capture-workbench` GitHub Release.
- `CaptureDocumentV1` schema: `1`.
- Consumer assets: executable, checksum, `capture-runtime-manifest.json`, and
  the schema file.
- Published-byte evidence pins the downloaded v0.3.11 executable to the
  SHA-256 recorded by its release manifest and requires the staged
  manifest/checksum to agree before launch. The earlier v0.3.8 hash remains
  historical evidence only.
- The published schema bytes have SHA-256
  `2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2` and
  retain the canonical `gx-capture` schema identifier.
- v0.3.11 publishes the engine-bearing catalog for `windowsml-ocr` and
  `whisper-primary`. Its production extractor still supports a PDF whose every
  page has embedded text, without invoking a model, and must report
  `pdf-embedded-text` provenance. Scanned PDFs/images require ready OCR and
  audio requires ready Whisper after explicit consent.
- Requirements/readiness/install/cancel are proxied through the authenticated
  backend; the sidecar token never reaches Angular/WebView.
- Cert Prep configures the published component with `structuringMode: 'host'`,
  `hostStructuringOwner: 'component'`, `hostManagedHandshake: true`, and
  `showRuntimeSetup: false`, with `enabledSources: ['pdf', 'image', 'audio']`.
  The host UI gates OCR/STT-dependent sources on runtime readiness while the backend adapter performs
  the compatibility and requirement checks immediately before opening each
  sidecar ingestion.
- On v0.3.11 the UI exposes image/audio controls only when the corresponding
  runtime requirement is ready and never claims OCR-dependent PDF support
  without ready OCR. The runtime installs `windowsml-ocr` first and
  `whisper-primary` second after explicit consent; no capture starts until each
  selected dependency is ready. The host adapter verifies the sidecar is ready,
  has the expected service identity, exact runtime release/API major, schema, host
  structuring mode, and requested capture-kind capability. An incompatible
  handshake blocks every source and does not open a sidecar ingestion. It
  then applies a source-aware requirement policy: image is admitted only while
  `windowsml-ocr` is `ready`, audio only while `whisper-primary` is `ready`,
  and otherwise each is rejected before dispatch. Every PDF is dispatched to
  the runtime without browser scanned-PDF classification; an OCR-dependent PDF
  is terminally failed with a clear unavailable-model error if extraction finds
  a page without embedded text. Because the legacy v0.3.8 sidecar reported
  this unavailable-engine path as `extraction_failed`, the coordinator re-reads
  the runtime requirements after that PDF terminal state and maps it to the
  typed OCR dependency error only when the single `windowsml-ocr` requirement
  is explicitly non-ready. A missing, duplicate, or ready requirement preserves
  the original sidecar error rather than guessing.
- Image/audio admission failures preserve the runtime requirement detail and use
  the same product messages across the Trial client and `/documents` path:
  `WindowsML OCR is unavailable. <detail>` and
  `Whisper transcription is unavailable. <detail>`. They are host-side
  failures before a capture ID exists, not fabricated failed runtime captures.
- Source bytes cross the v2 ingestion lifecycle only: open with a source digest,
  upload ordered checksum-bounded chunks with `Content-Range`, `Digest`, and
  stable idempotency keys, finalize, then start the capture. Uncertain open/start
  responses recover through the matching by-client-request lookup.
- Normal capture progress is authenticated replayable SSE from
  `/v2/captures/{id}/events`, not polling. The consumer validates content type,
  UTF-8, framing, capture/sequence identity, event names, monotonic ordering,
  and bounded input before exposing events. Reconnect uses `Last-Event-ID`;
  listener disconnect never cancels the runtime capture. Snapshot, partial,
  raw, and result reads support reconciliation and review, followed by host
  structure commit/failure, cancel, and delete.

## Failure policy

Missing or malformed assets, checksum/byte drift, incompatible handshake,
unsupported capture kind, unavailable requirements, sidecar failure, timeout,
and cancellation are terminal/unavailable states. A scanned or mixed PDF must
not be silently treated as embedded text: when the runtime reaches its unavailable
WindowsML path, Cert Prep maps the terminal sidecar error to the clear
OCR-unavailable product state. Cert Prep never falls back to an OCR or Whisper
provider of its own.

## Evidence

The installer contract, package QA, Tauri contract tests, backend coordinator
tests, and the published-byte consumer smoke must prove staging, authenticated
readiness/requirements, host-protocol compatibility, cleanup, and rejection of
tampered or missing runtime assets. The product E2E must use the published
v0.3.11 executable and a real, non-fake PDF whose every page contains embedded
text; it proves UI selection, backend-to-sidecar capture, review confirmation,
host persistence, and Markdown export with `pdf-embedded-text` provenance.
Its negative cases prove image, audio, and any OCR-dependent PDF fail closed
with no browser sidecar token and no OCR/STT claim. They also prove an
incompatible handshake opens no sidecar ingestion, and that the host-owned UI
states image/audio are unavailable while their requirements are not ready. Fake
extraction may exercise only the backend host protocol. The opt-in
model-enabled smoke proves the core-first install order plus real PDF OCR and
audio time-locator extraction once an approved engine catalog is published.
The backend contract test owns the exact no-dispatch assertion for image/audio;
the installed product smoke does not infer internal sidecar state from a public
error response. The 2026-08-02 fresh-installed v0.3.8 run proved an embedded
PDF reached review, persistence, Markdown export, and relaunch with
`pdf-embedded-text` provenance; image, audio, scanned PDF, and mixed PDF each
reached a durable failed operation, produced zero chunks, and returned no
Markdown. Both app closes left zero owned processes and listener ports.

## Modular package consumer boundary

Cert Prep now imports generated wire DTOs from `capture_contracts`; the former
`capture_workbench/contracts.py` hand mirror is deleted. Raw capture and
document responses cross the Angular client boundary through fail-closed
mappers that reject schema drift, unknown discriminators, invalid locators,
and illegal bounding boxes before domain use. The deterministic client spec
was removed because it was only a local spec fixture.

The package declarations remain version-ranged at `0.3.11`. Once the producer
publishes the matching npm/PyPI/Cargo artifacts, the lockfiles must resolve
from those registries; the permanent consumer consistency target rejects local
path sources in strict release CI and verifies npm, PyPI, Cargo, runtime
declarations, and lockfiles all resolve the same release. The 0.3.11 lockfile
refresh and published-byte proof remain active release gates until those
artifacts exist.

For a local producer candidate, `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`
lets the installer and consumer handshake smoke stage the canonical executable,
checksum, manifest, and schema directly from an existing release directory.
This path is deliberately local-only: it does not alter the canonical public
URL, does not satisfy published-byte evidence, and the independent consumer
bundle is built by `cert-prep-desktop`'s own Tauri app.

When a GitHub runner is unavailable, `pnpm verify:modular-reuse:local` runs the
consumer consistency test locally. After publication, set the repository
variable `CAPTURE_PUBLISHED_0_3_11=true` so the CI job also runs strict source
and clean PyPI install checks.
