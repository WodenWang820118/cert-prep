# Lazy Capture Runtime Installation Decision

## 2026-08-02

- The Cert Prep desktop shell and Python backend start without a Capture
  Runtime connection. Capture Runtime is optional at process startup, so a
  missing, removed, or tampered bundled runtime must not prevent the Angular
  shell, `/runtime`, or other non-capture workflows from opening.
- Keep the pinned `capture-runtime@0.3.8` executable, manifest, and schema in
  the NSIS installer resources. Do not download a different release, alter the
  immutable v0.3.8 catalog, side-load engines, or make OCR/STT available.
- Only an explicit Capture Workbench **install** action may verify and copy
  those bundled bytes to the user app-data runtime directory. A separate
  **start** action may launch the sidecar and restart the Cert Prep backend
  with a newly generated process-scoped sidecar token.
  The token stays in Tauri/backend process memory; the WebView never receives
  it or the sidecar URL.
- Capture Workbench must show a clear unavailable state and a distinct
  `Install Capture Runtime` action followed by `Start Capture Runtime` after a
  successful prior install. It must not register a usable capture client until
  the backend has restarted with the authenticated sidecar connection.
- If the installed backend is supplied by `CERT_PREP_BACKEND_URL`, Cert Prep
  must not silently restart or reconfigure that external backend; it remains a
  host-managed integration boundary.

## Rejected alternatives

- Starting Capture Runtime in `tauri::setup`: this makes a missing optional
  runtime fatal before the product UI can explain or repair it.
- Browser-side direct sidecar setup: it would expose a bearer credential and
  crosses the established host adapter boundary.
- Making the v0.3.8 requirements installable: its public release is core-only;
  `windowsml-ocr` and `whisper-primary` must remain unavailable and fail
  closed.
