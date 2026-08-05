# Lazy Capture Runtime Installation Spec

## Purpose

Allow Cert Prep Desktop to open its shell and normal local backend without
Capture Runtime. A user explicitly installs/starts the bundled, pinned
Capture Runtime from Capture Workbench when they want to debug or use capture.

## Contract

- Tauri startup does not load, verify, or launch Capture Runtime.
- The packaged Python backend may start with no `CERT_PREP_CAPTURE_RUNTIME_*`
  environment values; capture endpoints then remain unavailable through their
  existing authenticated backend failure policy.
- An explicit desktop install command verifies the bundled
  manifest/executable/schema and atomically stages the exact bytes below Cert
  Prep app data without launching it. A separate start command launches the
  staged sidecar, then restarts the owned backend with fresh private connection
  data. If restart fails, the old backend connection remains valid and the new
  sidecar is stopped.
- The command reports `missing`, `installed`, `running`, queued/running job,
  or failed state without serializing Capture Runtime credentials.
- Capture Workbench polls that desktop state. It shows the explicit install or
  start action before loading the custom-element capture client. Once started, it
  refreshes the cached Cert Prep backend configuration and configures the
  normal host-managed embedded-text-PDF flow.

## Non-goals

- Changing capture-workbench `0.3.8`, adding a runtime download, side-loading
  WindowsML/Whisper assets, browser-side sidecar access, fake extraction, or
  persisting a sidecar token.

## Acceptance criteria

- A missing/tampered Capture Runtime resource does not prevent Cert Prep shell
  setup or Python backend launch.
- No Capture Runtime process begins before the explicit start action.
- Explicit installation accepts only the pinned manifest, executable, and
  schema, leaves the existing installation intact on validation failure, and
  reaches the durable `installed` (stopped) state. Explicit start makes the
  backend-side authenticated Capture Runtime connection available after a
  rollback-capable owned-backend restart.
- The capture page tells a desktop user Capture Runtime is unavailable and
  presents a clear action; it does not construct a usable capture client first.
- Existing v0.3.8 embedded-text PDF flow still requires `pdf-embedded-text` on
  CPU. OCR/STT/image/audio/scanned-PDF support remains fail-closed.

## Test plan

- Rust unit tests cover staged asset verification/copy, lazy status, and the
  no-connection backend environment.
- Angular page/store tests cover missing/installed/running runtime copy/start
  actions and only configure
  Capture Workbench after the desktop reports running.
- Focused desktop Cargo and Angular Nx targets exercise the changed contracts.
