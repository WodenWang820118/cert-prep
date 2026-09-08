# Capture Runtime release consumer spec

`cert-prep` consumes a published Windows x64 `capture-runtime` executable. The
currently published pin remains `0.4.1` until the producer publishes the
decision-complete `0.4.2` contract; this spec freezes the `0.4.2` consumer
requirements and must not be used to claim that package is already available.
It does not import the runtime as Python, link a workspace package, or retain a
local extraction provider.

## Contract

- Runtime API: `2.0`.
- Current published runtime version: `0.4.1` from the canonical
  `gx-capture/capture-workbench` GitHub Release.
- Target cutover runtime version: `0.4.2`.
- Target `CaptureDocument` schema: `3`, with the page/segment-bound typed OCR
  projection consumed by Cert Prep and Law.
- Target contract-set and schema digests are producer release inputs; do not
  invent or pin them before the `0.4.2` release exists.
- Consumer assets: executable, checksum, `capture-runtime-manifest.json`, and
  the schema file.
- Published-byte evidence pins the downloaded v0.4.1 executable to the
  SHA-256 recorded by its release manifest and requires the staged
  manifest/checksum to agree before launch. The earlier v0.3.8 hash remains
  historical evidence only.
- The published schema bytes have SHA-256
  `850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335` and
  retain the canonical `gx-capture` schema identifier.
- The target OCR-only candidate requires `windowsml-ocr` for every PDF page and
  image. The runtime rasterizes every page and recognizes it with canonical
  PaddleOCR; embedded extraction and LLM route selection are forbidden. Audio
  requires ready Whisper after explicit consent. A local candidate is not
  evidence that immutable published bytes changed.
- Requirements/readiness/install/cancel are proxied through the authenticated
  backend; the sidecar token never reaches Angular/WebView.
- Cert Prep configures the published component with `structuringMode: 'host'`,
  `hostStructuringOwner: 'component'`, `hostManagedHandshake: true`, and
  `showRuntimeSetup: false`, with `enabledSources: ['pdf', 'image', 'audio']`.
  The host UI gates OCR/STT-dependent sources on runtime readiness while the backend adapter performs
  the compatibility and requirement checks immediately before opening each
  sidecar ingestion.
- The UI exposes image/audio controls only when the corresponding runtime
  requirement is ready and never claims PDF support without ready OCR. The
  runtime installs `windowsml-ocr` first and
  `whisper-primary` second after explicit consent; no capture starts until each
  selected dependency is ready. The host adapter verifies the sidecar is ready,
  has the expected service identity, exact runtime release/API major, schema, host
  structuring mode, and requested capture-kind capability. An incompatible
  handshake blocks every source and does not open a sidecar ingestion. It
  then applies a source-aware requirement policy: PDF and image are admitted
  only while `windowsml-ocr` is `ready`, audio only while `whisper-primary` is
  `ready`, and otherwise each is rejected before dispatch. A generic extraction
  error after a ready OCR preflight preserves the original sidecar error rather
  than being reclassified.
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
  raw, and result reads support reconciliation and review, followed by typed
  pull-session structuring/failure, cancel, and delete. The runtime validates
  and reconstructs the final base document; Cert Prep applies only its local
  review overlay and domain mapping.

## Failure policy

Missing or malformed assets, checksum/byte drift, incompatible handshake,
unsupported capture kind, unavailable requirements, sidecar failure, timeout,
and cancellation are terminal/unavailable states. Any PDF with non-ready OCR
is rejected before sidecar ingestion with the clear OCR-unavailable product
state. Other runtime failures remain their original typed error. Cert Prep
never falls back to an OCR or Whisper provider of its own.

## Phase 2 hardening after the Phase 1 proof

The accepted Phase 1 local-probe record is the fresh installed-app manifest
whose SHA-256 is
`1e001417498de86556de4f9984338cfe62079b84be96f434b5163d10c8925765`.
It records real JPEG and scanned-PDF page-one OCR, `gpu-dml`, one matched
critical anchor per source, durable `windowsml_ocr` page projection, and clean
owned-process/listener shutdown against the producer candidate aggregate
`cc5df53d8244d121c1ee96be250948b329211f78b57f3b32587c7c2c03777e29`.
It is evidence for the already completed Phase 1 checkpoint, not a newly built
installed-artifact result for every later Cert Prep HEAD. A change to an OCR,
packaging, native lifecycle, or app-journey source invalidates only the
affected evidence and requires the corresponding sequential real acceptance
to run again.

Phase 2 optimizes this established OCR-only path. It must not introduce an
embedded-text route, mixed arbitration, a Cert Prep Paddle implementation, or
a fallback that bypasses the capture-runtime projection.

### Deep native modules

The desktop host will concentrate lifecycle policy in two deep modules:

- `DesktopRuntimeSupervisor` is the only product interface for activating,
  observing, replacing, and shutting down the owned Python-backend plus
  Capture Runtime stack. Its implementation uses the published launcher's
  native `OwnedRuntimeSession`; callers never receive a raw Windows Job handle,
  process handle, or bearer token. Each launch attempt creates a distinct
  candidate session. Roots are assigned before user code executes, readiness
  is proven before an atomic active-session swap, and a failed candidate is
  terminated and proven empty without disturbing the previous active session.
- `RuntimeAssetInstaller` owns verified transactional installation and startup
  reconciliation. Durable installed runtime/model assets and caches survive
  normal shutdown. It reconciles only UUID-shaped app-owned staging/backup
  directories and attested app-owned PID, listener, and run-scoped residue; it
  never removes an arbitrary path or kills by process name.

The Python `CertPrepCaptureCoordinator` remains the capture interface for the
application. It consumes the generated client and canonical OCR projection,
then maps and persists Cert Prep-owned records. It must not acquire native
process ownership or duplicate runtime compute selection.

The launcher and Capture Runtime are remote-but-owned dependencies at these
seams. Production uses their native/generated adapters. Deterministic tests may
use an in-memory adapter for protocol outcomes, but Windows process ownership,
inheritance, and termination are verified with real helper processes through
the native interface rather than mocked process trees.

### Compute selection and user notice

Capture Runtime remains the sole owner of GPU inventory and device selection.
Its authenticated preflight must prefer a usable dedicated GPU, otherwise a
usable integrated GPU, and only then report `cpu-fallback`. Both GPU classes
use `gpu-dml`; the selected adapter class and provenance remain visible to Cert
Prep. If neither GPU class is usable, Cert Prep must explicitly notify the
user of CPU fallback before import. A selected DirectML provider that later
fails initialization or inference remains fail-closed and is not silently
retried on CPU.

### Phase 2 test seams and performance evidence

TDD proceeds as vertical slices through three pre-agreed seams only:

1. the native owned-session interface for candidate/active isolation,
   terminate-and-prove, crash handling, and startup reconciliation;
2. the public backend capture interface for authenticated compute preflight,
   OCR projection, durable page records, and typed failures; and
3. the freshly installed application's public PDF/JPEG journey.

Registry, network, and time may use adapters. Internal modules, process
ownership, OCR output, and cleanup are not replaced with mocks. Phase 2 first
records model-ready latency, per-page latency, peak process memory, and
per-adapter GPU memory before changing performance behavior. Real
model-enabled acceptance stays sequential and runs only after the prior app's
owned PIDs, descendants, listeners, and model memory are gone. A one-page
projection is sufficient for the routine real-PDF parse check; complete
documents are OCRed only for an explicitly required accuracy or lifecycle
gate.

Normal close, window close, every readiness failure, runtime-root crash, host
termination, an app-started model descendant, and a pre-existing baseline
process are lifecycle acceptance cases. Owned processes/listeners and
ephemeral residue must reach zero, while the baseline process and durable
runtime/model assets survive. OS crash and power loss are handled by safe
next-start reconciliation rather than an immediate-hook claim.

## Evidence

The installer contract, package QA, Tauri contract tests, backend coordinator
tests, and the published-byte consumer smoke must prove staging, authenticated
readiness/requirements, host-protocol compatibility, cleanup, and rejection of
tampered or missing runtime assets. The product E2E must use the local candidate
executable and a real, non-fake raster/scanned PDF through real PaddleOCR; it proves UI
selection, backend-to-sidecar capture, review confirmation, host persistence,
and Markdown export with `windowsml-ocr` provenance. Its negative cases prove
PDF, image, and audio fail closed when their requirements are not ready, with
no browser sidecar token and no false OCR/STT claim. They also prove an
incompatible handshake opens no sidecar ingestion, and that the host-owned UI
states image/audio are unavailable while their requirements are not ready. Fake
extraction may exercise only the backend host protocol. The opt-in
model-enabled smoke proves the core-first install order plus real PDF OCR and
audio time-locator extraction once an approved engine catalog is published.
The backend contract test owns the exact no-dispatch assertion for PDF/image/audio;
the installed product smoke does not infer internal sidecar state from a public
error response. The 2026-08-02 fresh-installed v0.3.8 embedded-PDF run is
historical only and does not satisfy the OCR-only contract. New evidence must
show PaddleOCR provenance for every PDF page and image, with no embedded or
mixed extraction result.

## Modular package consumer boundary

Cert Prep now imports generated wire DTOs from `capture_runtime_client`; the former
`capture_workbench/contracts.py` hand mirror is deleted. Raw capture and
document responses cross the Angular client boundary through fail-closed
mappers that reject schema drift, unknown discriminators, invalid locators,
and illegal bounding boxes before domain use. The deterministic client spec
was removed because it was only a local spec fixture.

The package declarations and lockfiles must resolve matching `0.4.2` npm,
PyPI, and Cargo artifacts only after those public artifacts exist. The permanent
consumer consistency target rejects local path sources in strict release CI and
verifies npm, PyPI, Cargo, runtime declarations, and lockfiles all resolve the
same release. The 0.4.2 published-byte proof and engine-bearing real smoke are
release gates; the current 0.4.1 pin remains until then.

For a local producer candidate, `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`
lets the installer and consumer handshake smoke stage the canonical executable,
checksum, manifest, and schema directly from an existing release directory.
This path is deliberately local-only: it does not alter the canonical public
URL, does not satisfy published-byte evidence, and the independent consumer
bundle is built by `cert-prep-desktop`'s own Tauri app.

When a GitHub runner is unavailable, `pnpm nx run cert-prep-desktop:capture-runtime-consumer-test`
may run locally against the current published pin. The 0.4.2 cutover remains
blocked until strict source, registry install, schema, and real OCR evidence
all use the same producer release.
