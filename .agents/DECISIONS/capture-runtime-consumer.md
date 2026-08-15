# Capture Runtime Release Consumer Decisions

## 2026-08-13 streaming v2 cutover

- Replace the capture public seam in one breaking cutover: v2 ingestion,
  capture start, replayable SSE, partial/result reads, host structure
  commit/failure, cancel, and delete. Do not retain legacy capture DTOs, routes,
  polling, or dual-transport compatibility.
- Treat SSE as an authenticated fail-closed protocol. Validate media type,
  UTF-8, required `id`/`event`/`data` framing, canonical capture and sequence
  identity, event-name agreement, monotonic ordering, bounded input, and
  terminal close. Resume only with `Last-Event-ID`.
- A disconnected Python listener or Angular unsubscribe closes the listener but
  does not cancel the runtime capture. Explicit cancellation remains separate.
- Keep the browser on the Cert Prep authenticated proxy and RxJS Observables;
  the process-scoped Capture Runtime URL/token remain backend-only.

## 2026-08-06 local 0.3.11 consumer qualification

- Move the cert-prep runtime and generated package expectations to `0.3.11`.
  Keep the currently published `capture-sidecar-launcher` crate at `0.3.10`
  as a separate compatibility pin until a `0.3.11` crate is actually
  published; the consistency checker must not equate launcher and runtime
  versions.
- Accept an explicit local release directory through
  `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY` for candidate staging and the
  handshake smoke. It copies only the canonical runtime assets, does not
  create a public URL, and does not count as published-release evidence.
- Consumer evidence must come from cert-prep's own `cert-prep-desktop` Tauri
  app and its bundle. The Capture Workbench app is a producer/reference and is
  not a cert-prep consumer test surface.
- The producer release directory now identifies `0.3.11` with executable SHA-256
  `2209fcd363da36cca74c58603c023aec703a15b69f8ecfbce277d664056a9a61` and the
  canonical schema SHA-256. The available local npm pack files still identify
  `0.3.10`, so no complete 0.3.11 package-consumer result is claimed until
  cert-prep refreshes its lockfiles from real registries.

## 2026-08-04

- Adopt the canonical engine-bearing `capture-runtime@0.3.9` release for the
  Cert Prep consumer. The host and smoke contracts must expose all three
  source kinds (`pdf`, `image`, and `audio`) and the two published engine
  requirements (`windowsml-ocr` and `whisper-primary`); requirement status is
  one of the published lifecycle states, not an invented `installing` value.
- Keep engine installation behind explicit consent. A fresh 0.3.9 runtime may
  report `installable` or another non-ready status until its asset is installed;
  image/audio admission remains backend-owned and requires the corresponding
  requirement to be `ready`.
- The packaged and real-PDF smoke contracts now validate the 0.3.9 source
  surface and engine-bearing requirement IDs. Their negative cases accept the
  release-specific dependency detail for image/audio and preserve the generic
  `Source extraction failed.` result for scanned or mixed PDFs when no OCR
  asset has been installed. The legacy 0.3.8 OCR reclassification remains a
  historical regression case only.
- Keep the real WindowsML/Whisper positive capture as a separate active gate:
  the published 0.3.9 assets prove availability, but Cert Prep has not yet
  recorded an end-to-end installed-engine image/audio capture.

## 2026-08-02

- Enforce source admission in the backend coordinator as well as the published
  Web Component client. The coordinator verifies the requested capture kind
  after the handshake, then requires `windowsml-ocr: ready` for image and
  `whisper-primary: ready` for audio before it opens a sidecar ingestion.
  PDF remains deliberately ungated so the runtime can distinguish all-pages
  embedded text from scanned or mixed content.
- Represent a non-ready image/audio dependency with a dedicated typed host
  exception rather than manufacturing a failed runtime capture. This preserves
  the distinction between "no capture was admitted" and "a dispatched PDF
  capture failed during extraction."
- Use the same user-visible dependency errors for the Trial client and the
  `/documents` product path: `WindowsML OCR is unavailable. ...` and
  `Whisper transcription is unavailable. ...`. The v0.3.8 requirement detail
  is preserved, but bearer tokens, runtime URLs, and raw sidecar payloads are
  never included.
- Prove the no-dispatch invariant with a backend contract fake that records
  ingestion/capture starts. The installed product smoke proves only observable
  behavior: PDF-only host UI, explicit dependency failures, OCR-dependent PDF
  terminal failure, no durable fake output, sanitized evidence, and clean
  process/listener shutdown.
- Treat v0.3.8's PDF `extraction_failed` as OCR dependency unavailability only
  after a fresh requirements read finds exactly one non-ready
  `windowsml-ocr` requirement. This reflects the published runtime's observed
  core-only behavior for both scanned and mixed PDFs without globally
  reclassifying malformed PDF failures or weakening future engine-bearing
  releases.
- Every terminal `CaptureRuntimeJobError` must also terminalize the durable
  document operation. The async worker may log and contain the exception, but
  it must never leave the operation in `running/processing` after the sidecar
  has already failed.

## 2026-07-23

- Use release artifacts rather than a source checkout, npm package, or Python
  wheel. This preserves the independent sidecar product boundary.
- Keep installation explicit. `prepare-runtime-resources` and Tauri build only
  consume an already verified staging directory.
- Pin cert-prep to the canonical `gx-capture/capture-workbench` release
  `capture-runtime@0.4.0`; API `2.0` and schema `2` are the hard-cut contract. Pin the
  published `CaptureDocument` schema digest
  `850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335` at each
  independent TypeScript/Rust verification boundary.
- v0.3.8 is a core-only release. Its runtime converts the empty catalog into
  `windowsml-ocr` and `whisper-primary` requirements with `unavailable` status;
  the runtime nevertheless extracts a PDF whose every page has embedded text
  with its built-in `pypdf` path and records `pdf-embedded-text` provenance.
- Cert Prep is the host adapter for this release, so it must use
  `hostManagedHandshake: true` and `showRuntimeSetup: false` rather than allow
  the published component's all-source requirements gate to disable every
  capture. The adapter, not the browser, owns the readiness/compatibility/
  capability decision before it opens a sidecar ingestion. Incompatible runtime,
  API, schema, or host-structuring handshakes block every source and must not
  call the sidecar create API.
- The v0.3.8 product surface is intentionally narrow: admit only PDF input and
  represent it as "embedded-text PDF only." The host-owned UI explicitly shows
  image and audio as unavailable and explains that PDF may work only when all
  pages contain embedded text. The host policy accepts image only when
  `windowsml-ocr` is `ready` and audio only when `whisper-primary` is `ready`;
  neither is ready in v0.3.8. Every PDF is sent to the runtime without browser
  scanned-PDF classification. If a page requires OCR, the sidecar failure is
  terminal and Cert Prep must present a clear
  "OCR unavailable in v0.3.8" error. There is no OCR/STT fallback or model
  side-load.
- Do not change Capture Workbench's generic requirement-to-source mapping for
  this consumer exception. A future release is needed only if the shared
  contract must distinguish embedded-text PDF from OCR-dependent PDF before
  capture; the current product repair belongs to the Cert Prep host adapter.
- Use fake extraction only after authenticating the published sidecar's
  readiness and unavailable requirements, to exercise the Cert Prep backend
  host protocol. It is not real extraction evidence. A non-fake all-pages
  embedded-text PDF is the positive v0.3.8 product proof; WindowsML/Whisper
  positive PDF/image/audio proof remains pending for an engine-bearing release.
- Preserve all pre-existing dirty Angular package, lockfile, UI trial, and CI
  changes in cert-prep.

## 2026-08-05 modular package boundary

- Generated Python contracts are the consumer API; do not restore a
  compatibility re-export for the deleted hand mirror.
- Keep local package sources only as a temporary pre-publication bridge. The
  strict release checker is the permanent guard that prevents a path-based
  artifact from being mistaken for registry provenance.
- Mappers fail closed at the raw/result seam. Unknown kinds, invalid locator
  geometry, schema/version drift, and malformed timestamps are protocol
  errors rather than lossy domain objects.
