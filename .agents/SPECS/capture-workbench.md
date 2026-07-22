# Capture Workbench consumer boundary

## Purpose

Consume the independently versioned Capture Workbench artifacts for PDF OCR,
image OCR, and audio transcription without starting a second semantic Ollama
provider inside Cert Prep.

## Contract

- Install a published, pinned `@wodenwang820118/capture-angular` version; do
  not use a workspace alias or retain a private UI fork.
- Tauri starts both the Cert Prep backend and the matching `capture-runtime`
  sidecar. Only the backend receives the process-scoped sidecar URL and bearer
  token.
- Until a published release exists, packaging requires explicit
  `CERT_PREP_CAPTURE_RUNTIME_MANIFEST_PATH` and
  `CERT_PREP_CAPTURE_RUNTIME_ARTIFACT_PATH`, plus the matching
  `CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_PATH` staging input. There is no sibling
  checkout, workspace alias, or implicit development-path fallback.
- The staged manifest is pinned to Windows x64 runtime `0.1.0`, API `1.0`, and
  `CaptureDocumentV1` schema `1`; resource preparation and Tauri both verify
  the executable and schema file names, the executable's bounded integer byte
  count (`1..536870912`), SHA-256 provenance, and the canonical schema bytes
  against Cert Prep's independent pinned digest before spawning the
  executable, then repeat the
  version/schema check through the authenticated readiness handshake.
- The same manifest must contain
  `runtimeRequirements["windowsml-ocr"]` with an HTTPS `artifactUrl`, a plain
  matching `.zip` `artifactFileName`, bounded `bytes` (`1..536870912`), and a
  lowercase SHA-256. The URL is canonical HTTPS with no user info, query,
  fragment, non-default port, path traversal, encoded separators, or ADS path.
  Tauri clears the inherited environment, restores only an explicit Windows
  process-bootstrap allowlist, and passes verified
  `CAPTURE_WINDOWSML_BUNDLE_URL`, `CAPTURE_WINDOWSML_BUNDLE_SHA256`, and
  `CAPTURE_WINDOWSML_BUNDLE_BYTES` values to the host-only sidecar.
- Tauri passes `CERT_PREP_CAPTURE_RUNTIME_URL`,
  `CERT_PREP_CAPTURE_RUNTIME_TOKEN`,
  `CERT_PREP_CAPTURE_RUNTIME_VERSION`,
  `CERT_PREP_CAPTURE_RUNTIME_API_VERSION`, and
  `CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION` only to the backend child
  process. None of these fields are added to the WebView `backend_config`.
- The backend creates and polls capture jobs, retrieves `RawCaptureV1`, calls
  the existing Cert Prep Ollama provider through its own
  `CaptureStructuringProvider` adapter, and submits the candidate back to the
  sidecar for strict validation.
- Runtime requirements and installation jobs are proxied through authenticated
  `/capture-runtime/*` backend routes. The browser uses the Cert Prep token;
  the Capture Runtime token remains process-only.
- Only a sidecar-validated `CaptureDocumentV1` may become a completed document.
  Raw extraction is diagnostic-only and never triggers UI completion.
- The existing document upload URL, SQLite rows, operation polling, chunks,
  crop behavior, and historical documents remain stable.
- The component continues to expose width, height, density, colors, labels,
  enabled sources, progress, cancel, JSON output, and text projection.
- The component is configured with `structuringMode: 'host'` and
  `hostStructuringOwner: 'client'`; it polls the Cert Prep client while the
  backend invokes the existing provider. No raw payload or provider seam is
  required in the WebView.

## Boundaries

- Capture Workbench owns source sniffing, PDF rendering, image normalization,
  WindowsML OCR, Whisper STT, capture runtime requirements, capture job state,
  and canonical validation.
- Cert Prep retains its reasoning Ollama process, study profile, question
  generation, semantic explanation, and real-time Q&A.
- Cert Prep must not launch the Workbench isolated Ollama in host mode. The
  isolated Workbench Ollama exists only for standalone development and clean
  installation verification.
- The Capture sidecar is launched with `CAPTURE_STRUCTURING_PROVIDER=host`, a
  unique 256-bit bearer token, and an ephemeral loopback port. Its child
  environment allowlists only Windows bootstrap variables before injecting
  verified Capture settings; inherited Cert Prep/Ollama credentials,
  model-store settings, proxies, and cloud credentials are absent. Shutdown
  targets only the two recorded backend/sidecar PID trees rather than process
  image names.
- Host-only readiness advertises only `structuringModes: ["host"]`; its setup
  contract exposes only WindowsML and Whisper requirements and rejects Ollama
  runtime/model installation requests. Tauri aligns the sidecar upload, PDF
  page, and image-pixel ceilings with the existing Cert Prep source limits.
- Browser code never receives the sidecar bearer token and never invokes the
  reasoning provider directly.
- After parity, remove Cert Prep capture OCR, capture Whisper, capture runtime
  installation, inactive Ollama OCR, and the local `capture-ui` prototype. Do
  not keep a production compatibility shim or dual-provider fallback.

## Acceptance

- Runtime/client major and schema handshake rejects incompatible artifacts.
- Provider output that changes digest, raw text, locators, coverage, or order
  reaches terminal `failed/structuring`; `/result` remains unavailable while
  `/raw` is diagnostic-only.
- Existing documents, crop uploads, retries, cancellation, chunks, study
  generation, semantic explanations, and real-time Q&A pass regression tests.
- A process isolation test proves Capture Workbench sidecar resources never
  terminate or mutate the Cert Prep reasoning Ollama process/model store.
