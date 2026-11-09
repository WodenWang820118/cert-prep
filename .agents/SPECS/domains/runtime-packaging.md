# Runtime and packaging domain

## Current contract

The independent `cert-prep-desktop` Tauri bundle is the consumer artifact. Its
NSIS installer bundles the Python backend runtime (ZIP and manifest) and the
published Capture Runtime Windows x64 executable, manifest and
`CaptureDocument` schema `2` pinned in `tools/capture-runtime-version.json`.
Packaging stages the versioned Capture release explicitly
(`cert-prep-desktop:install-capture-runtime`) before resource preparation; there
is no sibling checkout, workspace alias or development-path fallback. Cert Prep
owns no OCR or speech provider, engine payload or fallback installer: Capture
Runtime installs its engines from its own release catalog.

Package QA and Tauri validate executable bytes, checksum, manifest and schema
bytes before launch, and the runtime's authenticated readiness handshake
repeats the version and schema check. Capture Runtime owns requirement
validation and the engine catalog.

For local production qualification only, the installer may stage the assets
from `CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY`. That is not registry or
published-byte evidence. The Capture Workbench desktop app and source-import
prototypes are not Cert Prep consumer artifacts.

Runtimes the user installs are copied into versioned slots under
`<app data>/runtimes`; see
[lazy-capture-runtime-installation.md](../lazy-capture-runtime-installation.md).

Only Windows x64 is supported. Another platform or runtime node needs a real
product requirement first, and then its own published package, manifest,
readiness contract, Tauri lifecycle, package QA and real smoke evidence.

## Lifecycle and security

- Tauri starts the installed backend (the Python runtime installs through a
  consent UI), and the Capture Runtime sidecar only after explicit install and
  start actions, each with a unique process-only token and loopback endpoint.
- Only the backend receives the Capture Runtime URL and token. Angular receives
  the Cert Prep API token and uses authenticated proxy routes.
- Shutdown records and cleans only the owned backend and sidecar PID trees.
- Runtime readiness, requirements, installation, cancellation and incompatible
  schema/version responses fail closed.

## Release evidence

`pnpm ci:local` (before every merge) and the weekly `ci.yml` run lint, tests,
packaging, the Capture Runtime install and the Tauri host checks. During a Capture release the producer runs Cert's
`capture-candidate-gate.yml`. `release-alpha.yml` reruns the checks on the exact
release source, verifies the Capture release attestation, runs the
published-byte consumer smoke and the built-binary stack check, and then
clean-installs the NSIS candidate ([release tooling](../../../tools/release/README.md)).
Real OCR on the packaged app is `cert-prep-desktop:acceptance-real`; its
model-enabled journey is sequential across consumers and must release all owned
PIDs and listeners before the next consumer starts. Readiness checks and fake
extraction are not OCR or speech evidence.
