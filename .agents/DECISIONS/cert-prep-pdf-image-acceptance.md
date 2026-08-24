# Cert Prep PDF and Image Acceptance Decision

## Decision

Add image OCR acceptance beside the existing PDF acceptance and reuse the
packaged image runner's lifecycle and process cleanup primitives. Do not
generalize the PDF practice/export flow to images.

Use `capture-workbench/test-fixtures/ocr_test_image.jpeg` as the local default
when the sibling checkout is present. Its adjacent expectation manifest is the
non-blocking text reference (`rawTextIncludes: ["snow man"]`); callers may
provide another image and expectation manifest through environment variables.
The acceptance gate requires real OCR terminal evidence and non-empty chunks,
while text-anchor mismatches are recorded as evidence rather than treated as a
runtime failure.

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
runtime/model output and is therefore diagnostic rather than a hard acceptance
contract.

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
