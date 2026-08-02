# Capture Runtime Release Consumer Decisions

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
