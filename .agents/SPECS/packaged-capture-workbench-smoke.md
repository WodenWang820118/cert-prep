# Packaged Capture Workbench Smoke Spec

## Purpose

Prove a fresh NSIS-installed Cert Prep Desktop executable can install the OCR
requirement, complete the Capture Workbench scanned-PDF flow, and persist it
across an app restart without exposing Capture Runtime credentials or leaving
owned processes behind.

Run it directly (it has no Nx target):
`node apps/cert-prep-desktop/scripts/packaged-capture-workbench-smoke.mts`.
Its unit tests run in `cert-prep-desktop:package-qa-test`.

## Current state

The harness starts Capture Runtime and waits for the native Start to succeed,
then checks that the restarted backend answers with new credentials and the
old ones are rejected. While OCR is not installed it runs the
dependency-negative cases, then installs the OCR requirement, reloads so the
OCR preflight admits imports, and only then waits for the picker and runs the
scanned-PDF flow. This order has not been verified on an installed app yet;
that run is open work in
[capture-workbench-cert-prep-pdf.md](../TODOS/capture-workbench-cert-prep-pdf.md).
The trial page offers PDF and image only; a successful packaged transcription
belongs to the Build page's source-library import path, not to this smoke.
The real OCR proof on the packaged app is `cert-prep-desktop:acceptance-real`
([acceptance spec](cert-prep-pdf-image-acceptance.md)).
`acceptance-real` covers JPEG and scanned PDF text recognition.
`acceptance-real-recorded` records the same OCR journey; speech recognition and
Cert-owned Ollama require separate installed-app journeys with actual device
evidence.

## Inputs

- `--exe`: existing installed `cert-prep-desktop.exe`.
- `--out-dir`: a non-existent evidence directory.
- `--app-data-dir`: a non-existent isolated app-data directory.
- `--cdp-port`: positive loopback CDP port.
- `--pdf`: a caller-supplied raster/scanned PDF truth fixture. The harness
  rejects embedded text operators and never generates a born-digital PDF. There
  is no sibling-checkout fallback; a missing fixture is a gate failure.

## Constraints

- Launch only `--exe`; never build, install or launch a loose development
  binary, and do not alter production app code or the Capture Workbench
  repository.
- Reuse the packaged-flow lifecycle and process-residue primitives instead of
  copying process ownership or normal-close logic.
- Set `CERT_PREP_LLM_PROVIDER=fake` for host structuring only. Reject fake
  extraction configuration and verify the real sidecar provenance.
- Do not set `CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND`: the harness
  first proves the shell and `/runtime` work with no owned backend or Capture
  Runtime, then installs the Python backend through the consent UI.
- Write evidence only below `--out-dir`. API URLs, bearer credentials, raw
  response bodies and process command lines are never persisted; raw metadata
  is reduced to source id/digest, extractor engine and device, and durable
  document state.

## Acceptance criteria

- Pure unit tests validate argument isolation and evidence redaction.
- With fresh app data, the desktop shell and `/runtime` open before the Python
  backend is installed, and no owned Capture Runtime process or listener exists
  through backend readiness.
- Capture Workbench first reports Capture Runtime missing. `Install Capture
  Runtime` ends at `installed` with `running: false` and does not start a
  process, listener or backend restart. `Start Capture Runtime` starts the
  owned sidecar, restarts the owned backend with fresh configuration, and makes
  the prior backend authorization unusable.
- The harness installs `text-recognition`; only then is the PDF picker enabled.
  Every page must be processed by the runtime OCR; embedded extraction and LLM
  route selection are not valid paths.
- The UI review edit, confirmation, durable ready document and Markdown
  download succeed. An authenticated request proves raw engine `text-recognition`
  and a recognized OCR device; the document and every page report
  `text_recognition`.
- Normal close leaves owned processes and listener ports at zero. Relaunching
  with the same app data reports installed-but-stopped and no Capture Runtime
  process until a second explicit Start, after which the document is visible.
- Final closeout records PID, creation time and image path for owned processes
  and leaves zero owned residue.

## Non-goals

- Fake extraction, product source changes, installer changes, or deletion of
  evidence artifacts.
