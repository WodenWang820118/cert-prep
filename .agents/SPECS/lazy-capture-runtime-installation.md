# Lazy Capture Runtime Installation Spec

## Purpose

Allow Cert Prep Desktop to open its shell and normal local backend without
Capture Runtime. A user explicitly installs and starts the bundled, pinned
Capture Runtime from the Capture Workbench page when they want to capture.

## Contract

- The NSIS installer bundles the pinned Capture Runtime executable, manifest
  and schema (`capture_runtime_bundled` in the package QA resource contract);
  the version comes from `tools/capture-runtime-version.mts`.
- Tauri startup does not launch Capture Runtime, and a missing, removed or
  tampered bundled runtime does not prevent the Angular shell, `/runtime` or
  other non-capture workflows from opening.
- The packaged Python backend may start with no `CERT_PREP_CAPTURE_RUNTIME_*`
  environment values; capture endpoints then fail closed through their
  authenticated backend error policy.
- The explicit install command (`install_capture_runtime` in `commands.rs`, job
  in `backend/launch.rs`) verifies the bundled manifest, executable and schema
  and copies them into a versioned slot under `<app data>/runtimes`
  (`runtime_slots.rs`). The copy is verified in a staging directory, then made
  active by atomically replacing the slot marker
  `runtimes/capture_runtime.current.json`, which records the SHA-256 of the
  bundled manifest. A failed verification leaves the previous copy and marker
  untouched. Install does not launch anything.
- A separate start command (`start_capture_runtime`) launches the installed
  sidecar, then restarts the owned backend with a fresh process-scoped token
  (`restart_owned_backend_with_capture_runtime`). If the restart fails, the old
  backend connection stays valid and the new sidecar is stopped. The token
  stays in Tauri and backend memory; the WebView never receives it or the
  sidecar URL.
- After an app update ships a different bundle, startup sweeps leftover
  staging and retired copies and reinstalls only runtimes the user already
  installed; Capture is never installed without a request. A copy still in use
  is removed by a later sweep. The WebView shows the refresh through
  `runtime_update_status`.
- The desktop reports `missing`, `installed`, `running`, a queued or running
  job, or `failed` with its error, without serializing credentials. The
  Capture Workbench page polls this state (`desktop-runtime.store.ts`) and
  shows `Install Capture Runtime`, then `Start Capture Runtime`, before it
  registers a capture client. Once started it refreshes the cached backend
  configuration and configures the host-managed OCR-only flow.
- Engines are not bundled. After start, `windowsml-ocr` and
  `speech-recognition` install from the runtime's release catalog on request,
  are verified, and live in the machine-wide Capture engine cache, so a
  reinstall or another Capture host reuses them. Runtime slots never touch that
  cache or user data.
- If the backend is supplied by `CERT_PREP_BACKEND_URL`, Cert Prep does not
  restart or reconfigure that external backend.

## Non-goals

- Downloading the runtime executable itself, side-loading engines,
  browser-side sidecar access, fake extraction, or persisting a sidecar token.

## Rejected alternatives

- Starting Capture Runtime in `tauri::setup`: a missing optional runtime would
  become fatal before the UI can explain or repair it.
- Browser-side sidecar setup: it would expose a bearer credential and cross the
  host adapter boundary.

## Acceptance criteria

- A missing or tampered Capture Runtime resource does not prevent shell setup
  or Python backend launch.
- No Capture Runtime process begins before the explicit start action.
- Installation accepts only the pinned manifest, executable and schema, keeps
  the existing installation on validation failure, and reaches `installed`
  (stopped). Start makes the backend-side authenticated connection available
  after a rollback-capable owned-backend restart.
- The capture page shows that Capture Runtime is unavailable with a clear
  action and does not construct a usable capture client first.
- Every PDF/image dispatch requires a ready `windowsml-ocr` requirement and
  persists only `windowsml_ocr`; a missing or non-ready requirement is rejected
  before ingestion.

## Test plan

- Rust tests in `runtime_slots.rs` and `capture_runtime.rs` cover staged
  verification, slot switch and failure, crash leftovers, update refresh and
  engine/user-data preservation; others cover lazy status and the
  no-connection backend environment.
- Angular page and store tests cover missing, installed and running runtime
  actions and configure Capture Workbench only after the desktop reports
  running.
