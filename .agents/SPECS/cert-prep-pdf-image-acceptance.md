# Cert Prep PDF and Image Acceptance Spec

## Purpose

`cert-prep-desktop:acceptance-real` proves a real image OCR journey and a real
PDF OCR journey against the same installed desktop executable and Capture
Runtime installation. `cert-prep-desktop:acceptance-real-recorded` runs the
same journeys without the pixel baseline comparison. The journey steps are in
the header of `apps/cert-prep-desktop/scripts/acceptance-real.spec.mts`.

The pixel baselines of the privacy-free runtime screens date from an older UI
and need the product owner's review before they are updated
(https://github.com/gx-capture/capture-workbench/issues/241).

## Inputs

- `CERT_PREP_ACCEPTANCE_EXE`: non-empty NSIS-installed
  `cert-prep-desktop.exe`. The gate records the executable identity and verifies
  the adjacent installed Capture Runtime resources; freshness is established
  by the installation workflow, not inferred from the path.
- `CERT_PREP_ACCEPTANCE_PDF`: non-empty real PDF fixture. Every page must be
  raster/scanned; born-digital embedded text is rejected.
- `CERT_PREP_ACCEPTANCE_IMAGE`: non-empty image fixture containing readable
  text. No sibling-checkout fallback is allowed.
- `CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS`: required human truth manifest with
  `schemaVersion: 1`, `kind: pdf`, `cerThreshold: 0.01`, contiguous page
  entries, normalized page text and critical anchors.
- `CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS`: required human truth manifest with
  `schemaVersion: 1`, `kind: image`, `cerThreshold: 0.03`, one page, normalized
  text and critical anchors. Missing anchors are blocking. The canonical
  handwritten JPEG does not meet this CER floor (a known Capture Runtime
  limitation); runs with it are judged by anchors only.
- `CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER=fake`: deterministic host structuring;
  extraction still uses the real Capture Runtime.
- `CERT_PREP_CAPTURE_RUNTIME_ROOT`: optional downloaded Capture Runtime release
  directory. When supplied, the installed core and manifest identity must match
  it byte for byte, and the OCR worker must match the downloaded catalog.
- Real OCR is a sequential resource gate: a model-enabled run must not overlap
  another consumer's real OCR journey. Unit and package QA that load no model
  may run independently.

## Decisions

- Image acceptance sits beside the PDF acceptance and reuses the packaged image
  runner's lifecycle and cleanup primitives. The PDF practice/export flow is not
  generalized to images: PDF assertions are intentionally PDF-specific, and the
  image path has its own terminal-document contract.
- Image OCR must reach `ready` with one processed page, text chunks,
  `windowsml_ocr` extraction, a non-empty OCR device and a SHA-256 matching the
  supplied bytes.
- CER is computed against raw OCR text with one fixed normalization policy.
  Scanned PDF pages must be CER <= 1%, photos/JPEGs CER <= 3%, and critical
  anchors have zero omissions. These are blocking semantic gates, not
  screenshot observations.
- Every PDF page and image must persist `windowsml_ocr`; embedded/mixed
  provenance and LLM extraction routing are rejected.
- Provenance is bound to what the app executes: hash the installed executable
  and its adjacent `resources` manifest and core. A supplied downloaded runtime
  must match those resources exactly; a supplied path is never called a fresh
  install.
- Screenshots use Playwright masks on source filenames, OCR text, generated
  questions and result payloads; screenshot-time masks are the fail-closed
  privacy boundary. Only the privacy-free runtime screens are pixel baselines.
- The no-text static-image smoke stays a separate negative regression; it
  cannot prove OCR.
- Hosted CI runs only hermetic package QA. The real journey needs a locally
  installed app, private fixtures and optionally a downloaded runtime, so it is
  an explicit command.

## Rejected alternatives

- Treating image input as a PDF path in the full flow: hides source-kind bugs.
- Replacing Capture Runtime with a fake: cannot prove the installed OCR
  artifact.
- Sanitizing only text artifacts and publishing unmasked screenshots: PNG
  pixels cannot be reliably redacted after capture.
- Trusting a downloaded core by its input hash alone: does not prove the
  installed app executed that core.

## Acceptance criteria

- Deterministic tests reject missing image input, invalid image terminal
  evidence, missing truth manifests, embedded-text PDF fixtures, CER over
  threshold and missing critical anchors.
- The PDF journey stays fail-closed and passes only with complete cleanup and
  no browser, page or console errors.
- The image journey uploads the supplied file through the packaged UI and
  verifies the persisted document API response, not only visible status text.
- PDF and image evidence are isolated below one run directory, each journey
  uses its own temporary app-data directory, and the final manifest records
  both fixtures and all cleanup fields.
- Before the slot is released, the journey proves backend, Capture Runtime,
  OCR/model descendants and their listener ports are gone.
- Failed image runs still report observed cleanup state, and PDF failures are
  not attributed to the image journey.

## Test plan

- Node unit tests for acceptance input binding and image evidence validation,
  run by `cert-prep-desktop:package-qa-test`.
- The real gate through `cert-prep-desktop:acceptance-real` or
  `cert-prep-desktop:acceptance-real-recorded` when the installed executable,
  raster PDF, image and both truth manifests are available.

## Non-goals

- No fake OCR, generated acceptance image, installer change, or producer
  Capture Workbench change. A package-QA pass does not claim the installed
  journey passed.
