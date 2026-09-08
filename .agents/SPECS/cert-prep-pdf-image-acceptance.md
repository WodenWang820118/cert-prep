# Cert Prep PDF and Image Acceptance Spec

## Purpose

Extend the packaged Cert Prep acceptance gate so it proves both a real PDF
PaddleOCR journey and a real image OCR journey against the same fresh
installed desktop executable and Capture Runtime installation.

## Inputs

- `CERT_PREP_ACCEPTANCE_EXE`: non-empty NSIS-installed
  `cert-prep-desktop.exe`. The gate records the executable identity and verifies
  the adjacent installed Capture Runtime resources; freshness is established
  by the installation workflow, not inferred from the path.
- `CERT_PREP_ACCEPTANCE_PDF`: non-empty real PDF fixture with semantic OCR
  truth expectations. Every page must be raster/scanned; born-digital embedded
  text is rejected by the acceptance input contract.
- `CERT_PREP_ACCEPTANCE_IMAGE`: non-empty image fixture containing readable
  text. No sibling-checkout fallback is allowed.
- `CERT_PREP_ACCEPTANCE_PDF_EXPECTATIONS`: required human truth manifest with
  `schemaVersion: 1`, `kind: pdf`, `cerThreshold: 0.01`, contiguous page
  entries, normalized page text, and critical anchors.
- `CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS`: required human truth manifest with
  `schemaVersion: 1`, `kind: image`, `cerThreshold: 0.03`, one page, normalized
  text, and critical anchors. Missing anchors are blocking.
- `CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER=fake`: deterministic host structuring
  boundary; extraction must still use the real Capture Runtime.
- `CERT_PREP_CAPTURE_RUNTIME_ROOT`: optional downloaded Capture Runtime release
  directory. When supplied, the gate requires the installed core and manifest
  identity to match this candidate, requires byte-identical core content, and
  validates the OCR worker against the downloaded catalog before serving it to
  the app.
- `CERT_PREP_CAPTURE_RUNTIME_PYTHON_WHEEL`: required for a Phase 1
  `local_probe`. The gate re-hashes this explicit wheel, checks its
  `capture-runtime-client` 0.4.2 metadata and embedded contract digest, and
  requires generated `worker_sha256` and `pdf_page_numbers` fields before the
  installed app journey can start. A same-version or producer-directory wheel
  that omits those fields is rejected; its path and raw package contents are
  never persisted in acceptance evidence.
- Real OCR is an orchestrated sequential resource gate. Cert Prep may start a
  model-enabled runtime only in the producer-assigned slot; it must not overlap
  the Law or third project's real OCR journey. Unit/package QA that does not
  load a real model may run independently.

## Key Decisions

- Keep review persistence, Markdown export, restart persistence, screenshots,
  and cleanup as part of the PDF proof while requiring `windowsml-ocr`
  provenance.
- Run image parsing through the existing packaged app lifecycle, but use a
  source-specific semantic contract instead of PDF-only practice/export steps.
- Require image OCR to reach `ready` with one processed page, text chunks,
  `windowsml_ocr` extraction, a non-empty OCR device, and a SHA-256 matching the
  supplied bytes.
- Calculate CER against raw OCR/source truth using one fixed normalization
  policy. Every scanned PDF must be CER <= 1%; every photo/JPEG must be CER <=
  3%; critical anchors must have zero omissions. These are blocking semantic
  gates, not screenshot or reviewed-text observations.
- Every PDF page and image must persist `windowsml_ocr`; embedded/mixed
  provenance and LLM extraction routing are rejected.
- Mask OCR text, generated content, project labels, and source filenames in
  every persisted screenshot. Structured semantic evidence remains the source
  of truth for parsing behavior.
- Keep the existing no-text static-image smoke as a separate negative/content
  classification regression; it is not sufficient for this acceptance gate.

## Acceptance Criteria

- Deterministic tests reject missing image input and invalid image terminal
  evidence.
- Deterministic tests reject missing truth manifests, embedded-text PDF
  fixtures, CER over threshold, and missing critical anchors.
- The PDF acceptance remains fail-closed and passes only with complete cleanup
  and no browser/page/console errors.
- The image acceptance uploads the supplied JPEG through the packaged UI and
  verifies the persisted document API response, not only visible status text.
- PDF and image evidence are isolated below one run directory and the final
  manifest records both source fixtures and all cleanup fields.
- Before the orchestrator releases the slot to Law, the journey must prove
  backend, capture-runtime, PaddleOCR/model descendants, and their listener
  ports are all gone. A successful UI/CER result without this resource proof
  does not release the slot.
- The manifest records the installed executable and bundled runtime hashes. A
  supplied downloaded runtime candidate must exactly match the bundled core,
  and its worker must match the downloaded catalog hash and size.
- Failed image runs still report observed cleanup state, and PDF failures are
  not attributed to the image journey.
- Normal hosted CI runs only hermetic package QA. The real installed-artifact
  journey remains an explicit gate that must receive locally available app,
  PDF, image, and downloaded runtime inputs.

## Test Plan

- Node unit tests for acceptance input binding and image evidence validation.
- Existing package-QA suite through `cert-prep-desktop:package-qa-test`.
- Real gate through `cert-prep-desktop:acceptance-real` or
  `cert-prep-desktop:acceptance-real-recorded` when the installed executable,
  raster PDF, JPEG, and both human truth manifests are available in the
  producer-assigned sequential model slot.

## Non-Goals

- No fake OCR, generated acceptance image, installer change, or producer
  Capture Workbench change.
- A deterministic/package-QA pass does not claim the installed-artifact
  journey passed.
