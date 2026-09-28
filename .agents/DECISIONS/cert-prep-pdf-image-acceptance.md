# Cert Prep PDF and Image Acceptance Decision

## Decision

Add image OCR acceptance beside the existing PDF acceptance and reuse the
packaged image runner's lifecycle and process cleanup primitives. Do not
generalize the PDF practice/export flow to images.

All new PDF pages and images use the runtime's OCR-only raster/PaddleOCR path;
embedded extraction, `mixed` arbitration, and LLM route selection are not
consumer behavior. Legacy embedded/mixed records remain readable only.

Require caller-supplied PDF/JPEG truth fixtures and human-maintained expectation
manifests. There is no sibling-checkout fallback. The acceptance gate requires
real OCR terminal evidence, non-empty chunks, CER <=1% for each scanned PDF,
CER <=3% for each photo, and zero missing critical anchors.

Real OCR is sequential across the three consumers because the model footprint
is memory-bound. The producer orchestrator grants one model-enabled slot to
Cert Prep; Cert Prep must prove backend, Capture Runtime, PaddleOCR/model
descendants, and listener cleanup before Law may start. Unit/package QA that
does not load a real model is independent.

Bind acceptance provenance to what the application actually executes. Hash the
supplied installed executable and its adjacent `resources` manifest/core. When
a downloaded runtime directory is supplied, fail unless its manifest and core
identity exactly matches the installed resources (semantic manifest identity
plus byte-identical core), and verify the mirrored OCR worker with the
downloaded engine catalog. Do not describe a supplied path as a fresh install;
the installation workflow owns that claim.

Persist screenshots with Playwright masks on source filenames, OCR text,
generated questions, and result payloads. Keep the in-page redaction stylesheet
for recorded navigation, but treat screenshot-time masks as the fail-closed
privacy boundary.

Keep hosted CI deterministic. A runner that has no installed app, private PDF,
sibling JPEG, or downloaded runtime cannot truthfully execute this gate, so CI
runs hermetic package QA and the real acceptance remains an explicit
artifact-provisioned command.

## Rationale

The PDF flow has assertions that are intentionally PDF-specific, while the
image path already has a source-specific terminal-document contract. A small
image OCR contract gives stronger evidence with less coupling: it proves the
real upload, source hash, page processing, OCR provenance, and non-empty
  extracted text without weakening the existing PDF journey. OCR wording is
  evaluated against the independent truth manifest; normalized CER and critical
  anchors are hard acceptance contracts.

## Rejected Alternatives

- Reusing the static no-text image smoke: proves classification and cleanup,
  but cannot prove OCR parsing.
- Treating image input as a PDF path in the full flow: hides source-kind bugs
  and makes PDF-only UI/export assumptions implicit.
- Replacing Capture Runtime with a fake in acceptance: makes the result
  deterministic but cannot prove the installed OCR artifact.
- Publishing an unmasked screenshot and sanitizing only text artifacts: PNG
  pixels cannot be reliably redacted after capture.
- Claiming the downloaded core from its input hash alone: does not prove the
  installed application executed that core.
