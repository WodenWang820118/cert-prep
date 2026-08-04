# Capture Runtime Release Consumer Decisions

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
  `whisper-primary: ready` for audio before it calls the sidecar create API.
  PDF remains deliberately ungated so the runtime can distinguish all-pages
  embedded text from scanned or mixed content.
- Represent a non-ready image/audio dependency with a dedicated typed host
  exception rather than manufacturing a failed `CaptureJobV1`. This preserves
  the distinction between "no sidecar job was admitted" and "a dispatched PDF
  job failed during extraction."
- Use the same user-visible dependency errors for the Trial client and the
  `/documents` product path: `WindowsML OCR is unavailable. ...` and
  `Whisper transcription is unavailable. ...`. The v0.3.8 requirement detail
  is preserved, but bearer tokens, runtime URLs, and raw sidecar payloads are
  never included.
- Prove the no-dispatch invariant with a backend contract fake that records
  `create_capture` calls. The installed product smoke proves only observable
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
  `capture-runtime@0.3.8`; API `1.0` and schema `1` remain unchanged. Pin the
  published `CaptureDocumentV1` schema digest
  `2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2` at each
  independent TypeScript/Rust verification boundary.
- v0.3.8 is a core-only release. Its runtime converts the empty catalog into
  `windowsml-ocr` and `whisper-primary` requirements with `unavailable` status;
  the runtime nevertheless extracts a PDF whose every page has embedded text
  with its built-in `pypdf` path and records `pdf-embedded-text` provenance.
- Cert Prep is the host adapter for this release, so it must use
  `hostManagedHandshake: true` and `showRuntimeSetup: false` rather than allow
  the published component's all-source requirements gate to disable every
  capture. The adapter, not the browser, owns the readiness/compatibility/
  capability decision before it creates a sidecar job. Incompatible runtime,
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
