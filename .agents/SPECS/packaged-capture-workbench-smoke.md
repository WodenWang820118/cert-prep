# Packaged Capture Workbench Smoke Spec

## Purpose

Prove a fresh NSIS-installed Cert Prep Desktop executable can complete the
published Capture Workbench embedded-text PDF flow and persist it across an
app restart without exposing Capture Runtime credentials or leaving owned
processes behind.

## Inputs

- `--exe`: existing installed `cert-prep-desktop.exe`.
- `--out-dir`: a non-existent evidence directory.
- `--app-data-dir`: a non-existent isolated app-data directory.
- `--cdp-port`: positive loopback CDP port.

## Constraints

- Launch only `--exe`; do not alter production app code or the Capture
  Workbench repository.
- Set `CERT_PREP_LLM_PROVIDER=fake` for host structuring only. Reject fake
  extraction environment configuration and verify the real sidecar provenance.
- Persist redacted evidence only; bearer tokens and API authorization headers
  must never appear in output artifacts.

## Acceptance Criteria

- Pure unit tests validate argument isolation and evidence redaction.
- With fresh app-data, the desktop shell and `/runtime` open before the Python
  backend is installed. The harness uses the visible backend consent flow and
  proves no owned Capture Runtime process/listener exists through backend
  readiness.
- Capture Workbench initially reports Capture Runtime missing. `Install
  Capture Runtime` ends at `installed` with `running: false` and does not start
  a process/listener or restart the backend. A separate `Start Capture Runtime`
  action starts the owned sidecar, restarts the owned backend with fresh
  configuration, and makes prior backend authorization unusable.
- The running desktop shows the embedded-only copy and an enabled picker, then
  accepts a generated valid embedded-text PDF.
- The UI review edit, confirmation, durable ready document, and Markdown
  download succeed. A same-browser authenticated request proves raw engine
  `pdf-embedded-text` and device `cpu` without persisting credentials.
- Normal close leaves owned processes and captured listener ports at zero.
  Relaunching with the same app-data reports installed-but-stopped and no
  Capture Runtime process/listener until a second explicit Start, after which
  the persisted document is visible.
- Final closeout records PID, creation time, and image path for owned processes
  and leaves zero owned process/listener residue.

## Non-goals

- OCR/STT installation, fake extraction, product source changes, installer
  changes, or deletion of evidence artifacts.
