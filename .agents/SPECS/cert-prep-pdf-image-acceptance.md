# Cert Prep PDF and Image Acceptance Spec

## Purpose

Extend the packaged Cert Prep acceptance gate so it proves both the existing
embedded-text PDF journey and a real image OCR journey against the same fresh
installed desktop executable and Capture Runtime installation.

## Inputs

- `CERT_PREP_ACCEPTANCE_EXE`: non-empty NSIS-installed
  `cert-prep-desktop.exe`. The gate records the executable identity and verifies
  the adjacent installed Capture Runtime resources; freshness is established
  by the installation workflow, not inferred from the path.
- `CERT_PREP_ACCEPTANCE_PDF`: non-empty PDF fixture with embedded text.
- `CERT_PREP_ACCEPTANCE_IMAGE`: non-empty image fixture containing readable
  text. When omitted, use the sibling Capture Workbench fixture
  `C:\software-dev\capture-workbench\test-fixtures\ocr_test_image.jpeg`.
- `CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS`: optional expectation manifest; by
  default read `<image>.expected.json` and record its `rawTextIncludes` anchors
  as non-blocking OCR observations.
- `CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER=fake`: deterministic host structuring
  boundary; extraction must still use the real Capture Runtime.
- `CERT_PREP_CAPTURE_RUNTIME_ROOT`: optional downloaded Capture Runtime release
  directory. When supplied, the gate requires the installed core and manifest
  identity to match this candidate, requires byte-identical core content, and
  validates the OCR worker against the downloaded catalog before serving it to
  the app.

## Key Decisions

- Keep the existing PDF acceptance journey unchanged: review persistence,
  Markdown export, restart persistence, screenshots, and cleanup remain part of
  the PDF proof.
- Run image parsing through the existing packaged app lifecycle, but use a
  source-specific semantic contract instead of PDF-only practice/export steps.
- Require image OCR to reach `ready` with one processed page, text chunks,
  `windowsml_ocr` extraction, a non-empty OCR device, and a SHA-256 matching the
  supplied bytes.
- Record expectation anchors that matched or were missing, but do not fail the
  installed-app gate solely because OCR text differs from the fixture wording.
- Mask OCR text, generated content, project labels, and source filenames in
  every persisted screenshot. Structured semantic evidence remains the source
  of truth for parsing behavior.
- Keep the existing no-text static-image smoke as a separate negative/content
  classification regression; it is not sufficient for this acceptance gate.

## Acceptance Criteria

- Deterministic tests reject missing image input and invalid image terminal
  evidence.
- The PDF acceptance remains fail-closed and passes only with complete cleanup
  and no browser/page/console errors.
- The image acceptance uploads the supplied JPEG through the packaged UI and
  verifies the persisted document API response, not only visible status text.
- PDF and image evidence are isolated below one run directory and the final
  manifest records both source fixtures and all cleanup fields.
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
  `cert-prep-desktop:acceptance-real-recorded` when all three explicit inputs
  are available.

## Non-Goals

- No fake OCR, generated acceptance image, installer change, or producer
  Capture Workbench change.
- A deterministic/package-QA pass does not claim the installed-artifact
  journey passed.
